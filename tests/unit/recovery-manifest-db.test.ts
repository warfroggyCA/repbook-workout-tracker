import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resultRows } from "@/db/result";
import { userProfiles, users } from "@/db/schema";
import {
  assertCanonicalSnapshotTableCoverage,
  CANONICAL_CAPTURE_TABLES,
  RECOVERY_MANIFEST_BY_TABLE,
  RECOVERY_MANIFEST_VERSION,
  RECOVERY_TABLE_MANIFEST,
} from "@/services/recovery-manifest";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("versioned recovery ownership manifest", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("classifies every durable base table exactly once", async () => {
    const tables = resultRows(
      await database.db.execute(sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `)
    ).map((row) => String(row.table_name));
    const manifested = RECOVERY_TABLE_MANIFEST.map((item) => item.table).sort();

    expect(RECOVERY_MANIFEST_VERSION).toBe(14);
    expect(new Set(manifested).size).toBe(manifested.length);
    expect(manifested).toEqual(tables);
    expect(RECOVERY_TABLE_MANIFEST).toHaveLength(65);
    for (const item of RECOVERY_TABLE_MANIFEST) {
      expect(item.ownershipPath.length).toBeGreaterThan(0);
      expect(item.archiveBehavior.length).toBeGreaterThan(0);
      expect(item.permanentDeleteBehavior.length).toBeGreaterThan(0);
      expect(item.retentionClass.length).toBeGreaterThan(0);
      expect(item.restoreOrder.full.length).toBeGreaterThan(0);
      expect(item.restoreOrder.history.length).toBeGreaterThan(0);
      expect(item.integrityChecks.length).toBeGreaterThan(0);
      expect(RECOVERY_MANIFEST_BY_TABLE[item.table]).toBe(item);
    }
    expect(
      RECOVERY_TABLE_MANIFEST.filter((item) => item.capture !== "canonical").map(
        (item) => [item.table, item.capture]
      )
    ).toEqual([
      ["ai_usage_events", "excluded_operational"],
      ["analysis_package_manifests", "excluded_operational"],
      ["expensive_operation_leases", "excluded_operational"],
      ["permanent_delete_grants", "excluded_security"],
    ]);
    expect(RECOVERY_MANIFEST_BY_TABLE.programs).toMatchObject({
      dependencies: ["users"],
      restore: { full: "replace", history: "dependency" },
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.program_versions).toMatchObject({
      dependencies: ["programs"],
      restore: { full: "replace", history: "dependency" },
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.program_drafts).toMatchObject({
      dependencies: ["users", "programs", "program_versions"],
      restore: { full: "replace", history: "preserve" },
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.recommendations).toMatchObject({
      restore: { full: "replace", history: "merge" },
      integrityChecks: expect.arrayContaining(["decision consistency"]),
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.user_decisions).toMatchObject({
      restore: { full: "replace", history: "merge" },
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.adaptation_events).toMatchObject({
      restore: { full: "replace", history: "merge" },
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.contextual_notes).toMatchObject({
      ownership: "direct_user",
      capture: "canonical",
      restore: { full: "replace", history: "replace" },
      retentionClass: "durable_until_protected_permanent_delete",
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.contextual_note_revisions).toMatchObject({
      dependencies: ["users", "contextual_notes"],
      restore: { full: "replace", history: "replace" },
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.completed_sets.integrityChecks).toContain(
      "immutable versioned performed measurement and load semantics",
    );
    expect(RECOVERY_MANIFEST_BY_TABLE.audit_logs).toMatchObject({
      restore: { full: "merge", history: "merge" },
      integrityChecks: expect.arrayContaining([
        "workout-timing version link",
        "monotonic workout-timing restore transition",
      ]),
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.record_versions.integrityChecks).toContain(
      "workout-timing snapshot lineage merge",
    );
    expect(RECOVERY_MANIFEST_BY_TABLE.record_versions.integrityChecks).toContain(
      "effective-row agreement after restore",
    );
    expect(
      RECOVERY_MANIFEST_BY_TABLE.progression_job_input_sessions
    ).toMatchObject({
      dependencies: ["users", "progression_jobs", "workout_sessions"],
      restore: { full: "replace", history: "replace" },
      retentionClass: "durable_until_protected_permanent_delete",
    });
  });

  it("requires canonical capture to match the manifest with no missing or extra table", async () => {
    const [user] = await database.db
      .insert(users)
      .values({ email: `manifest-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId: user.id });
    const payload = await captureUserSnapshot(
      database.db,
      user.id,
      new Date("2026-07-13T18:00:00.000Z"),
      "manifest-test"
    );

    expect(Object.keys(payload.tables).sort()).toEqual(
      [...CANONICAL_CAPTURE_TABLES].sort()
    );
    const missing = structuredClone(payload.tables);
    delete missing.workout_sessions;
    expect(() => assertCanonicalSnapshotTableCoverage(missing)).toThrow(
      /workout_sessions/
    );
    expect(() =>
      assertCanonicalSnapshotTableCoverage({ ...payload.tables, surprise_table: [] })
    ).toThrow(/surprise_table/);
  });
});
