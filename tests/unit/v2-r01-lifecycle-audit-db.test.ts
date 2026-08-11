import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resultRows } from "@/db/result";
import {
  REPBOOK_V2_FIELD_FAMILIES,
  REPBOOK_V2_LIFECYCLE_AUDIT_VERSION,
  assertRepbookV2LifecycleAudit,
} from "@/lib/v2-lifecycle-audit";
import {
  RECOVERY_MANIFEST_VERSION,
  RECOVERY_TABLE_MANIFEST,
} from "@/services/recovery-manifest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("R01 database lifecycle inventory", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("binds every durable table and every v2 field requirement to the migrated schema", async () => {
    expect(REPBOOK_V2_LIFECYCLE_AUDIT_VERSION).toBe(
      "repbook-v2-lifecycle-audit/1",
    );
    expect(RECOVERY_MANIFEST_VERSION).toBe(15);
    expect(() => assertRepbookV2LifecycleAudit()).not.toThrow();

    const baseTables = resultRows(
      await database.db.execute(sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `),
    ).map((row) => String(row.table_name));
    const recoveryTables = RECOVERY_TABLE_MANIFEST.map((entry) =>
      entry.table,
    ).sort();
    expect(recoveryTables).toEqual(baseTables);
    expect(recoveryTables).toHaveLength(66);
    for (const entry of RECOVERY_TABLE_MANIFEST) {
      expect(entry.label.length, `${entry.table}.label`).toBeGreaterThan(0);
      expect(entry.ownershipPath.length, `${entry.table}.ownership`).toBeGreaterThan(0);
      expect(entry.archiveBehavior.length, `${entry.table}.archive`).toBeGreaterThan(0);
      expect(
        entry.permanentDeleteBehavior.length,
        `${entry.table}.permanentDelete`,
      ).toBeGreaterThan(0);
      expect(entry.retentionClass.length, `${entry.table}.retention`).toBeGreaterThan(0);
      expect(entry.integrityChecks.length, `${entry.table}.integrity`).toBeGreaterThan(0);
    }

    const columns = resultRows(
      await database.db.execute(sql`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `),
    );
    const byTable = new Map<string, Set<string>>();
    for (const row of columns) {
      const table = String(row.table_name);
      const fields = byTable.get(table) ?? new Set<string>();
      fields.add(String(row.column_name));
      byTable.set(table, fields);
    }

    const databaseFamilies = REPBOOK_V2_FIELD_FAMILIES.filter(
      (family) => family.durability === "database",
    );
    expect(databaseFamilies.length).toBeGreaterThanOrEqual(9);
    for (const family of databaseFamilies) {
      for (const requirement of family.storage) {
        expect(recoveryTables, `${family.id}.${requirement.table}`).toContain(
          requirement.table,
        );
        const actualFields = byTable.get(requirement.table);
        expect(actualFields, `${family.id}.${requirement.table}`).toBeDefined();
        for (const field of requirement.fields) {
          expect(
            actualFields,
            `${family.id}.${requirement.table}.${field}`,
          ).toContain(field);
        }
      }
    }
  });
});
