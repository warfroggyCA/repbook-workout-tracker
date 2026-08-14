import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

describe("named Program library migration", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => database?.close());

  it("preserves the active Program and permits only versioned saved inactive Programs", async () => {
    database = await createTestDatabaseAtMigration("0081_adaptive_program_schedule");
    const userId = crypto.randomUUID();
    const programId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await database.db.execute(sql`
      INSERT INTO users (id, email)
      VALUES (${userId}::uuid, ${`named-program-${userId}@example.com`})
    `);
    await database.db.execute(sql`
      INSERT INTO programs (id, user_id, name, status, archived_at)
      VALUES (${programId}::uuid, ${userId}::uuid, 'Existing', 'archived', now())
    `);
    await database.db.execute(sql`
      INSERT INTO program_versions (id, program_id, version_no, name)
      VALUES (${versionId}::uuid, ${programId}::uuid, 1, 'Existing')
    `);
    await database.db.execute(sql`
      UPDATE programs
      SET status = 'active', archived_at = NULL, current_version_id = ${versionId}::uuid
      WHERE id = ${programId}::uuid
    `);

    await migrateTestDatabaseThrough(database, "0082_named_program_library");
    await expect(database.db.execute(sql`
      UPDATE programs SET status = 'inactive' WHERE id = ${programId}::uuid
    `)).resolves.toBeDefined();
    await expect(database.db.execute(sql`
      INSERT INTO programs (user_id, name, status)
      VALUES (${userId}::uuid, 'Invalid inactive', 'inactive')
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      UPDATE programs SET status = 'unknown' WHERE id = ${programId}::uuid
    `)).rejects.toThrow();
  }, 30_000);
});
