import { afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

const user = {
  resolvable: "10000000-0000-4000-8000-000000000063",
  ambiguous: "10000000-0000-4000-8000-000000000064",
  orphan: "10000000-0000-4000-8000-000000000065",
  trigger: "10000000-0000-4000-8000-000000000066",
  triggerAmbiguous: "10000000-0000-4000-8000-000000000067",
};

describe("0063 conservative equipment truth bridge", () => {
  let database: TestDatabase | undefined;
  afterEach(async () => database?.close());

  it("uses unique normalized labels first, then a sole remaining compatible pair", async () => {
    database = await createTestDatabaseAtMigration(
      "0062_session_equipment_snapshots",
    );
    await database.client.exec(`
      INSERT INTO users (id, email) VALUES
        ('${user.resolvable}', 'bridge-resolvable@example.test');
      INSERT INTO user_profiles (user_id, unit)
        VALUES ('${user.resolvable}', 'kg');
      INSERT INTO equipment_items (id, user_id, type, label) VALUES
        ('20000000-0000-4000-8000-000000000063', '${user.resolvable}', 'barbell', 'Garage   Olympic Bar'),
        ('20000000-0000-4000-8000-000000000064', '${user.resolvable}', 'barbell', 'Unrelated item wording'),
        ('20000000-0000-4000-8000-000000000065', '${user.resolvable}', 'ez_bar', 'Curl implement');
      INSERT INTO barbell_configs (id, user_id, bar_type, bar_weight, label) VALUES
        ('30000000-0000-4000-8000-000000000063', '${user.resolvable}', 'olympic', 20, ' garage olympic bar '),
        ('30000000-0000-4000-8000-000000000064', '${user.resolvable}', 'olympic', 15, 'Second legacy bar'),
        ('30000000-0000-4000-8000-000000000065', '${user.resolvable}', 'ez', 8, 'Old EZ wording');
    `);

    await migrateTestDatabaseThrough(
      database,
      "0063_equipment_truth_backfill_bridge",
    );

    const rows = await database.client.query<{
      id: string;
      equipment_item_id: string | null;
      unit: string | null;
      loading_kind: string | null;
      shared_plate_pool_compatible: boolean | null;
    }>(`
      SELECT id, equipment_item_id, unit, loading_kind, shared_plate_pool_compatible
      FROM barbell_configs
      WHERE user_id = '${user.resolvable}'
      ORDER BY id
    `);
    expect(rows.rows).toEqual([
      {
        id: "30000000-0000-4000-8000-000000000063",
        equipment_item_id: "20000000-0000-4000-8000-000000000063",
        unit: "kg",
        loading_kind: "olympic",
        shared_plate_pool_compatible: true,
      },
      {
        id: "30000000-0000-4000-8000-000000000064",
        equipment_item_id: "20000000-0000-4000-8000-000000000064",
        unit: "kg",
        loading_kind: "olympic",
        shared_plate_pool_compatible: true,
      },
      {
        id: "30000000-0000-4000-8000-000000000065",
        equipment_item_id: "20000000-0000-4000-8000-000000000065",
        unit: "kg",
        loading_kind: "ez",
        shared_plate_pool_compatible: true,
      },
    ]);
    const snapshots = await database.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM session_equipment_snapshots",
    );
    expect(snapshots.rows[0]?.count).toBe(0);
  });

  it("leaves ambiguous and orphaned legacy rows null and exposes them for repair", async () => {
    database = await createTestDatabaseAtMigration(
      "0062_session_equipment_snapshots",
    );
    await database.client.exec(`
      INSERT INTO users (id, email) VALUES
        ('${user.ambiguous}', 'bridge-ambiguous@example.test'),
        ('${user.orphan}', 'bridge-orphan@example.test');
      INSERT INTO user_profiles (user_id, unit) VALUES
        ('${user.ambiguous}', 'lb'), ('${user.orphan}', 'lb');
      INSERT INTO equipment_items (id, user_id, type, label) VALUES
        ('20000000-0000-4000-8000-000000000066', '${user.ambiguous}', 'barbell', 'First available bar'),
        ('20000000-0000-4000-8000-000000000067', '${user.ambiguous}', 'barbell', 'Second available bar');
      INSERT INTO barbell_configs (id, user_id, bar_type, bar_weight, label) VALUES
        ('30000000-0000-4000-8000-000000000066', '${user.ambiguous}', 'olympic', 45, 'Legacy A'),
        ('30000000-0000-4000-8000-000000000067', '${user.ambiguous}', 'olympic', 35, 'Legacy B'),
        ('30000000-0000-4000-8000-000000000068', '${user.orphan}', 'ez', 18, 'No owned EZ item');
    `);

    await migrateTestDatabaseThrough(
      database,
      "0063_equipment_truth_backfill_bridge",
    );

    const unresolved = await database.client.query<{
      id: string;
      equipment_item_id: string | null;
      unit: string | null;
      loading_kind: string | null;
      shared_plate_pool_compatible: boolean | null;
    }>(`
      SELECT id, equipment_item_id, unit, loading_kind, shared_plate_pool_compatible
      FROM barbell_configs
      ORDER BY id
    `);
    expect(unresolved.rows).toHaveLength(3);
    expect(unresolved.rows.every((row) =>
      row.equipment_item_id === null &&
      row.unit === null &&
      row.loading_kind === null &&
      row.shared_plate_pool_compatible === null
    )).toBe(true);

    const preview = await database.client.query<{ id: string; issue: string }>(`
      SELECT id, issue
      FROM equipment_load_profile_repair_preview
      ORDER BY id
    `);
    expect(preview.rows).toEqual([
      {
        id: "30000000-0000-4000-8000-000000000066",
        issue: "ambiguous_exact_equipment_relationship",
      },
      {
        id: "30000000-0000-4000-8000-000000000067",
        issue: "ambiguous_exact_equipment_relationship",
      },
      {
        id: "30000000-0000-4000-8000-000000000068",
        issue: "missing_compatible_equipment_item",
      },
    ]);
    await expect(database.client.exec(`
      UPDATE equipment_load_profile_repair_preview
      SET issue = 'ignored'
      WHERE id = '30000000-0000-4000-8000-000000000066'
    `)).rejects.toThrow();
  });

  it("bridges an unambiguous old-writer insert but preserves insert ambiguity", async () => {
    database = await createTestDatabaseAtMigration(
      "0063_equipment_truth_backfill_bridge",
    );
    await database.client.exec(`
      INSERT INTO users (id, email) VALUES
        ('${user.trigger}', 'bridge-trigger@example.test'),
        ('${user.triggerAmbiguous}', 'bridge-trigger-ambiguous@example.test');
      INSERT INTO user_profiles (user_id, unit) VALUES
        ('${user.trigger}', 'lb'), ('${user.triggerAmbiguous}', 'kg');
      INSERT INTO equipment_items (id, user_id, type, label) VALUES
        ('20000000-0000-4000-8000-000000000068', '${user.trigger}', 'ez_bar', '18 lb EZ Bar'),
        ('20000000-0000-4000-8000-000000000069', '${user.triggerAmbiguous}', 'barbell', 'Bar one'),
        ('20000000-0000-4000-8000-000000000070', '${user.triggerAmbiguous}', 'barbell', 'Bar two');

      INSERT INTO barbell_configs (id, user_id, bar_type, bar_weight, label)
      VALUES ('30000000-0000-4000-8000-000000000069', '${user.trigger}', 'ez', 18, ' 18 LB  ez bar ');
      INSERT INTO barbell_configs (id, user_id, bar_type, bar_weight, label)
      VALUES ('30000000-0000-4000-8000-000000000070', '${user.triggerAmbiguous}', 'olympic', 20, 'Unknown bar');
    `);

    const rows = await database.client.query<{
      id: string;
      equipment_item_id: string | null;
      unit: string | null;
      loading_kind: string | null;
      shared_plate_pool_compatible: boolean | null;
    }>(`
      SELECT id, equipment_item_id, unit, loading_kind, shared_plate_pool_compatible
      FROM barbell_configs
      WHERE id IN (
        '30000000-0000-4000-8000-000000000069',
        '30000000-0000-4000-8000-000000000070'
      )
      ORDER BY id
    `);
    expect(rows.rows).toEqual([
      {
        id: "30000000-0000-4000-8000-000000000069",
        equipment_item_id: "20000000-0000-4000-8000-000000000068",
        unit: "lb",
        loading_kind: "ez",
        shared_plate_pool_compatible: true,
      },
      {
        id: "30000000-0000-4000-8000-000000000070",
        equipment_item_id: null,
        unit: null,
        loading_kind: null,
        shared_plate_pool_compatible: null,
      },
    ]);
  });
});
