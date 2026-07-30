import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resultRows } from "@/db/result";
import {
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

const BEFORE = "0036_contract_ai_privacy_controls";
const EXPAND = "0037_expand_snapshot_lifecycle";
const PREVIEW = "0038_snapshot_lifecycle_repair_preview";
const CONTRACT = "0039_contract_snapshot_lifecycle";

describe("snapshot lifecycle expand/preview/contract migrations", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => database?.close());

  it("classifies proven origins and blocks ambiguous snapshots until reviewed", async () => {
    database = await createTestDatabaseAtMigration(BEFORE);
    const userId = crypto.randomUUID();
    await database.db.execute(sql`
      INSERT INTO users (id, email)
      VALUES (${userId}::uuid, ${`snapshot-migration-${crypto.randomUUID()}@example.com`})
    `);
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await database.db.execute(sql`
      INSERT INTO data_snapshots (
        id, user_id, name, reason, status, object_path, app_version,
        schema_version, size_bytes, record_counts, plaintext_checksum,
        encryption_algorithm, encryption_key_version, pinned
      ) VALUES
      (
        ${ids[0]}::uuid, ${userId}::uuid, 'Named recovery point', 'manual',
        'failed', ${`snapshots/${userId}/${ids[0]}.wtbk`}, 'test', '15', 0,
        '{}'::jsonb, 'one', 'aes-256-gcm', 'v1', false
      ),
      (
        ${ids[1]}::uuid, ${userId}::uuid,
        'Safety snapshot · before archive · Jul 13, 2026, 2:00 p.m.',
        'before archive', 'failed', ${`snapshots/${userId}/${ids[1]}.wtbk`},
        'test', '15', 0, '{}'::jsonb, 'two', 'aes-256-gcm', 'v1', false
      ),
      (
        ${ids[2]}::uuid, ${userId}::uuid, 'Unclassified historical copy',
        'legacy_job', 'failed', ${`snapshots/${userId}/${ids[2]}.wtbk`},
        'test', '15', 0, '{}'::jsonb, 'three', 'aes-256-gcm', 'v1', false
      )
    `);

    await migrateTestDatabaseThrough(database, EXPAND);
    expect(
      resultRows(
        await database.db.execute(sql`
          SELECT id::text, snapshot_kind
          FROM data_snapshots
          ORDER BY name
        `)
      )
    ).toEqual([
      { id: ids[0], snapshot_kind: "user" },
      { id: ids[1], snapshot_kind: "automatic" },
      { id: ids[2], snapshot_kind: null },
    ]);

    await migrateTestDatabaseThrough(database, PREVIEW);
    expect(
      resultRows(
        await database.db.execute(sql`
          SELECT issue, entity_id
          FROM snapshot_lifecycle_repair_preview
        `)
      )
    ).toEqual([
      { issue: "snapshot.unclassified_origin", entity_id: ids[2] },
    ]);
    await expect(migrateTestDatabaseThrough(database, CONTRACT)).rejects.toThrow(
      "repair preview"
    );

    await database.db.execute(sql`
      UPDATE data_snapshots
      SET snapshot_kind = 'user'
      WHERE id = ${ids[2]}::uuid
    `);
    await migrateTestDatabaseThrough(database, CONTRACT);

    await expect(
      database.db.execute(sql`
        UPDATE data_snapshots
        SET deletion_status = 'deleting',
            deletion_requested_at = now(),
            deletion_lease_id = gen_random_uuid(),
            deletion_lease_expires_at = now() + interval '10 minutes'
        WHERE id = ${ids[0]}::uuid
      `)
    ).rejects.toThrow();
    await expect(
      database.db.execute(sql`
        UPDATE data_snapshots
        SET pinned = true,
            deletion_status = 'deleting',
            deletion_requested_at = now(),
            deletion_lease_id = gen_random_uuid(),
            deletion_lease_expires_at = now() + interval '10 minutes'
        WHERE id = ${ids[1]}::uuid
      `)
    ).rejects.toThrow();
  }, 30_000);
});
