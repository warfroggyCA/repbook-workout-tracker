import { afterEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { loadEquipmentInventoryDocument } from "@/services/equipment-inventory";
import { loadEquipmentLoadProfiles } from "@/services/equipment-load-profiles";
import { validateEquipmentInventoryDocument } from "@/lib/equipment-inventory-contract";

const ids = {
  user: "10000000-0000-4000-8000-000000000060",
  otherUser: "10000000-0000-4000-8000-000000000061",
  olympicBar: "20000000-0000-4000-8000-000000000060",
  secondOlympicBar: "20000000-0000-4000-8000-000000000061",
  ezBar: "20000000-0000-4000-8000-000000000062",
  trapBar: "20000000-0000-4000-8000-000000000063",
  machine: "20000000-0000-4000-8000-000000000064",
  cableShared: "20000000-0000-4000-8000-000000000065",
  cableIndependent: "20000000-0000-4000-8000-000000000066",
  attachment: "20000000-0000-4000-8000-000000000067",
  otherAttachment: "20000000-0000-4000-8000-000000000068",
  foreignPlate: "30000000-0000-4000-8000-000000000060",
  ownedPlate: "30000000-0000-4000-8000-000000000061",
  machineProfile: "40000000-0000-4000-8000-000000000060",
  sharedProfile: "40000000-0000-4000-8000-000000000061",
  independentProfile: "40000000-0000-4000-8000-000000000062",
  attachmentProfile: "40000000-0000-4000-8000-000000000063",
  otherAttachmentProfile: "40000000-0000-4000-8000-000000000064",
};

async function seed(database: TestDatabase) {
  await database.client.exec(`
    INSERT INTO users (id, email) VALUES
      ('${ids.user}', 'equipment-profile@example.test'),
      ('${ids.otherUser}', 'equipment-profile-other@example.test');
    INSERT INTO user_profiles (user_id, unit) VALUES
      ('${ids.user}', 'lb'),
      ('${ids.otherUser}', 'lb');

    INSERT INTO equipment_items (id, user_id, type, label) VALUES
      ('${ids.olympicBar}', '${ids.user}', 'barbell', '45 lb Olympic bar'),
      ('${ids.secondOlympicBar}', '${ids.user}', 'barbell', '35 lb Olympic bar'),
      ('${ids.ezBar}', '${ids.user}', 'ez_bar', '18 lb EZ bar'),
      ('${ids.trapBar}', '${ids.user}', 'trap_bar', 'Trap bar'),
      ('${ids.machine}', '${ids.user}', 'machine', 'Plate-loaded press'),
      ('${ids.cableShared}', '${ids.user}', 'cable', 'Shared cable station'),
      ('${ids.cableIndependent}', '${ids.user}', 'cable', 'Dual cable station'),
      ('${ids.attachment}', '${ids.user}', 'other', 'Rope attachment'),
      ('${ids.otherAttachment}', '${ids.otherUser}', 'other', 'Other rope');

    INSERT INTO plate_inventory (id, user_id, denomination, quantity) VALUES
      ('${ids.ownedPlate}', '${ids.user}', 45, 4),
      ('${ids.foreignPlate}', '${ids.otherUser}', 45, 4);
  `);
}

describe("0060 equipment load profile schema", () => {
  let database: TestDatabase | undefined;
  afterEach(async () => database?.close());

  it("keeps multiple exact same-type bars and the 18 lb EZ bar distinct", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    await database.client.exec(`
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, label
      ) VALUES
        ('${ids.user}', 'olympic', '${ids.olympicBar}', 'lb', 'olympic', true, 45, '45 lb Olympic bar'),
        ('${ids.user}', 'olympic', '${ids.secondOlympicBar}', 'lb', 'olympic', true, 35, '35 lb Olympic bar'),
        ('${ids.user}', 'ez', '${ids.ezBar}', 'lb', 'ez', true, 18, '18 lb EZ bar'),
        ('${ids.user}', 'trap', '${ids.trapBar}', 'lb', 'trap_hex', true, 55, 'Trap bar'),
        ('${ids.user}', 'legacy', NULL, NULL, NULL, NULL, 20, 'Legacy bridge row');
    `);

    const rows = await database.client.query<{ label: string; bar_weight: string }>(`
      SELECT label, bar_weight::text
      FROM barbell_configs
      WHERE user_id = '${ids.user}'
      ORDER BY bar_weight
    `);
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows).toContainEqual({ label: "18 lb EZ bar", bar_weight: "18.00" });

    const management = await loadEquipmentInventoryDocument(database.db, ids.user);
    expect(management?.document.bars.map((bar) => bar.label)).not.toContain("Trap bar");
    expect(management?.document.loadProfiles).toContainEqual({
      equipmentItemId: ids.trapBar,
      profile: expect.objectContaining({
        kind: "plate_loaded_implement",
        loadingKind: "trap_hex",
        emptyWeight: 55,
      }),
    });

    await expect(database.client.exec(`
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, label
      ) VALUES ('${ids.user}', 'olympic', '${ids.olympicBar}', 'lb', 'olympic', true, 45, 'Duplicate')
    `)).rejects.toThrow();

    await expect(database.client.exec(`
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, label
      ) VALUES ('${ids.user}', 'olympic', '${ids.secondOlympicBar}', 'kg', 'olympic', true, 16, 'Wrong-unit bar')
    `)).rejects.toThrow(/unit/i);

    await expect(database.client.exec(`
      UPDATE equipment_items SET type = 'ez_bar'
      WHERE id = '${ids.olympicBar}'
    `)).rejects.toThrow(/profile/i);

    await expect(database.client.exec(`
      INSERT INTO plate_inventory (user_id, denomination, quantity)
      VALUES ('${ids.user}', 0, 2)
    `)).rejects.toThrow();
    await expect(database.client.exec(`
      INSERT INTO plate_inventory (user_id, denomination, quantity)
      VALUES ('${ids.user}', 2.5, 0)
    `)).rejects.toThrow();
    await expect(database.client.exec(`
      INSERT INTO barbell_configs (user_id, bar_type, bar_weight, collar_weight, quantity, label)
      VALUES ('${ids.user}', 'legacy', 0, 0, 1, 'Invalid legacy bridge')
    `)).rejects.toThrow();
    const preview = await database.client.query(`
      SELECT * FROM equipment_load_profile_repair_preview
      WHERE user_id = '${ids.user}'
    `);
    expect(preview.rows).toEqual([
      expect.objectContaining({
        user_id: ids.user,
        entity: "barbell_configs",
        issue: "unsupported_legacy_bar_type",
      }),
    ]);

    await expect(database.client.exec(`
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, label
      ) VALUES ('${ids.otherUser}', 'ez', '${ids.ezBar}', 'lb', 'ez', true, 18, 'Cross owner')
    `)).rejects.toThrow();

    await expect(database.client.exec(`
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, label
      ) VALUES ('${ids.user}', 'ez', '${ids.olympicBar}', 'lb', 'ez', true, 45, 'Wrong type')
    `)).rejects.toThrow();
  });

  it("guards machine geometry, point counts, item ownership, and compatible plates", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    await database.client.exec(`
      INSERT INTO plate_loaded_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty,
        starting_resistance, starting_resistance_unit, loading_point_count,
        balancing_rule, target_entry_meaning
      ) VALUES (
        '${ids.machineProfile}', '${ids.user}', '${ids.machine}', 'known',
        20, 'lb', 2, 'identical_each_point', 'total_system'
      );
      INSERT INTO plate_loaded_machine_compatible_plates (
        machine_profile_id, plate_inventory_id, user_id
      ) VALUES ('${ids.machineProfile}', '${ids.ownedPlate}', '${ids.user}');
    `);

    await expect(database.client.exec(`
      INSERT INTO plate_loaded_machine_compatible_plates (
        machine_profile_id, plate_inventory_id, user_id
      ) VALUES ('${ids.machineProfile}', '${ids.foreignPlate}', '${ids.user}')
    `)).rejects.toThrow();

    await expect(database.client.exec(`
      INSERT INTO plate_loaded_machine_profiles (
        user_id, equipment_item_id, geometry_certainty, starting_resistance,
        starting_resistance_unit, loading_point_count, balancing_rule, target_entry_meaning
      ) VALUES ('${ids.user}', '${ids.olympicBar}', 'known', 20, 'lb', 1, 'single_point', 'total_system')
    `)).rejects.toThrow();

    await expect(database.client.exec(`
      UPDATE plate_loaded_machine_profiles
      SET balancing_rule = 'single_point'
      WHERE id = '${ids.machineProfile}'
    `)).rejects.toThrow();

    await expect(database.client.exec(`
      UPDATE plate_loaded_machine_profiles
      SET starting_resistance_unit = 'kg'
      WHERE id = '${ids.machineProfile}'
    `)).rejects.toThrow(/unit/i);

    const plateUnit = await database.client.query<{ unit: string }>(`
      SELECT unit::text FROM plate_inventory WHERE id = '${ids.ownedPlate}'
    `);
    expect(plateUnit.rows).toEqual([{ unit: "lb" }]);
    await expect(database.client.exec(`
      UPDATE plate_inventory SET unit = 'kg' WHERE id = '${ids.ownedPlate}'
    `)).rejects.toThrow(/unit/i);
    await expect(database.client.exec(`
      UPDATE user_profiles SET unit = 'kg' WHERE user_id = '${ids.user}'
    `)).rejects.toThrow(/equipment|load unit/i);

    await expect(database.client.exec(`
      UPDATE plate_loaded_machine_profiles
      SET geometry_certainty = 'unknown'
      WHERE id = '${ids.machineProfile}'
    `)).rejects.toThrow();
  });

  it("uses shared ordinal 0 and independent ordinals 1 through stack count", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    await database.client.exec(`
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty,
        stack_count, topology, displayed_unit, ratio_status
      ) VALUES
        ('${ids.sharedProfile}', '${ids.user}', '${ids.cableShared}', 'known', 2, 'shared_selection', 'lb', 'unknown'),
        ('${ids.independentProfile}', '${ids.user}', '${ids.cableIndependent}', 'known', 2, 'independent_per_stack', 'lb', 'unknown');

      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES
        ('${ids.user}', '${ids.sharedProfile}', 0, 0, 0),
        ('${ids.user}', '${ids.independentProfile}', 1, 0, 7.5),
        ('${ids.user}', '${ids.independentProfile}', 2, 0, 12.5);
    `);

    for (const [profile, ordinal] of [
      [ids.sharedProfile, 1],
      [ids.independentProfile, 0],
      [ids.independentProfile, 3],
    ] as const) {
      await expect(database.client.exec(`
        INSERT INTO cable_stack_steps (
          user_id, cable_profile_id, stack_index, step_index, displayed_load
        ) VALUES ('${ids.user}', '${profile}', ${ordinal}, 9, 99)
      `)).rejects.toThrow();
    }

    await expect(database.client.exec(`
      UPDATE cable_machine_profiles
      SET stack_count = 1
      WHERE id = '${ids.independentProfile}'
    `)).rejects.toThrow();

    await expect(database.client.exec(`
      UPDATE cable_machine_profiles
      SET geometry_certainty = 'unknown'
      WHERE id = '${ids.sharedProfile}'
    `)).rejects.toThrow();
  });

  it("keeps attachments as distinct owned items and guards compatibility ownership", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    await database.client.exec(`
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty,
        stack_count, topology, displayed_unit, ratio_status
      ) VALUES ('${ids.sharedProfile}', '${ids.user}', '${ids.cableShared}', 'known', 1, 'shared_selection', 'lb', 'unknown');

      INSERT INTO cable_attachment_profiles (
        id, user_id, equipment_item_id, attachment_kind, connection_standard, status
      ) VALUES
        ('${ids.attachmentProfile}', '${ids.user}', '${ids.attachment}', 'rope', 'universal carabiner', 'known'),
        ('${ids.otherAttachmentProfile}', '${ids.otherUser}', '${ids.otherAttachment}', 'rope', NULL, 'unknown');

      INSERT INTO cable_attachment_compatibilities (
        cable_profile_id, attachment_profile_id, user_id
      ) VALUES ('${ids.sharedProfile}', '${ids.attachmentProfile}', '${ids.user}');
    `);

    await expect(database.client.exec(`
      INSERT INTO cable_attachment_profiles (
        user_id, equipment_item_id, attachment_kind
      ) VALUES ('${ids.user}', '${ids.cableIndependent}', 'rope')
    `)).rejects.toThrow();

    await expect(database.client.exec(`
      UPDATE cable_attachment_profiles
      SET connection_standard = '   '
      WHERE id = '${ids.attachmentProfile}'
    `)).rejects.toThrow();

    await expect(database.client.exec(`
      INSERT INTO cable_attachment_compatibilities (
        cable_profile_id, attachment_profile_id, user_id
      ) VALUES ('${ids.sharedProfile}', '${ids.otherAttachmentProfile}', '${ids.user}')
    `)).rejects.toThrow();
  });

  it("includes exact load profiles in the stale-save revision", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      INSERT INTO plate_loaded_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty,
        starting_resistance, starting_resistance_unit, loading_point_count,
        balancing_rule, target_entry_meaning
      ) VALUES (
        '${ids.machineProfile}', '${ids.user}', '${ids.machine}', 'known',
        20, 'lb', 2, 'identical_each_point', 'total_system'
      );
    `);

    const before = await loadEquipmentInventoryDocument(database.db, ids.user);
    await database.client.exec(`
      UPDATE plate_loaded_machine_profiles
      SET starting_resistance = 25, updated_at = now()
      WHERE id = '${ids.machineProfile}'
    `);
    const after = await loadEquipmentInventoryDocument(database.db, ids.user);

    expect(before?.document.baseRevision).toBeTruthy();
    expect(after?.document.baseRevision).toBeTruthy();
    expect(after?.document.baseRevision).not.toBe(before?.document.baseRevision);
  });

  it("keeps an unavailable item's saved exact profile in the lossless management document", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      INSERT INTO barbell_configs (
        id, user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, collar_weight, label
      ) VALUES (
        '40000000-0000-4000-8000-000000000069', '${ids.user}', 'ez',
        '${ids.ezBar}', 'lb', 'ez', true, 18, 0, '18 lb EZ bar'
      );
      UPDATE equipment_items SET available = false WHERE id = '${ids.ezBar}';
    `);

    const loaded = await loadEquipmentInventoryDocument(database.db, ids.user);
    expect(loaded?.document.items.some((item) => item.id === ids.ezBar)).toBe(false);
    expect(loaded?.document.loadProfiles).toContainEqual({
      equipmentItemId: ids.ezBar,
      profile: expect.objectContaining({
        kind: "plate_loaded_implement",
        loadingKind: "ez",
        emptyWeight: 18,
        sharedPlatePoolCompatible: true,
      }),
    });
    expect(loaded && validateEquipmentInventoryDocument(loaded.document).ok).toBe(true);
  });

  it("loads owner-scoped typed profiles without flattening their identities", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, label
      ) VALUES
        ('${ids.user}', 'olympic', '${ids.olympicBar}', 'lb', 'olympic', true, 45, '45 lb Olympic bar'),
        ('${ids.user}', 'olympic', '${ids.secondOlympicBar}', 'lb', 'olympic', true, 35, '35 lb Olympic bar'),
        ('${ids.user}', 'ez', '${ids.ezBar}', 'lb', 'ez', true, 18, '18 lb EZ bar');

      INSERT INTO plate_loaded_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty,
        starting_resistance, starting_resistance_unit, loading_point_count,
        balancing_rule, target_entry_meaning
      ) VALUES (
        '${ids.machineProfile}', '${ids.user}', '${ids.machine}', 'known',
        20, 'lb', 2, 'identical_each_point', 'total_system'
      );
      INSERT INTO plate_loaded_machine_compatible_plates (
        machine_profile_id, plate_inventory_id, user_id
      ) VALUES ('${ids.machineProfile}', '${ids.ownedPlate}', '${ids.user}');

      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty,
        stack_count, topology, displayed_unit, ratio_status
      ) VALUES ('${ids.sharedProfile}', '${ids.user}', '${ids.cableShared}', 'partial', 1, 'shared_selection', 'lb', 'unknown');
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES ('${ids.user}', '${ids.sharedProfile}', 0, 1, 12.5);
      INSERT INTO cable_attachment_profiles (
        id, user_id, equipment_item_id, attachment_kind, connection_standard, status
      ) VALUES ('${ids.attachmentProfile}', '${ids.user}', '${ids.attachment}', 'rope', 'carabiner', 'known');
      INSERT INTO cable_attachment_compatibilities (
        cable_profile_id, attachment_profile_id, user_id
      ) VALUES ('${ids.sharedProfile}', '${ids.attachmentProfile}', '${ids.user}');
    `);

    const profiles = await loadEquipmentLoadProfiles(database.db, ids.user);
    expect(profiles.filter((entry) => entry.profile.kind === "plate_loaded_implement"))
      .toHaveLength(3);
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        equipmentItemId: ids.ezBar,
        profile: expect.objectContaining({
          kind: "plate_loaded_implement",
          loadingKind: "ez",
          emptyWeight: 18,
        }),
      }),
      expect.objectContaining({
        equipmentItemId: ids.machine,
        profile: expect.objectContaining({
          kind: "plate_loaded_machine",
          compatiblePlateIds: [ids.ownedPlate],
        }),
      }),
      expect.objectContaining({
        equipmentItemId: ids.cableShared,
        profile: expect.objectContaining({
          kind: "cable_machine",
          ratioStatus: "unknown",
          compatibleAttachmentItemIds: [ids.attachment],
          stackSteps: [expect.objectContaining({ displayedLoad: 12.5 })],
        }),
      }),
    ]));
  });
});
