import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resultRows } from "@/db/result";
import {
  programs,
  programScheduleVersions,
  programSchedules,
  programVersions,
  scheduledProgramEvents,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplates,
} from "@/db/schema";
import { materializeProgramScheduleWindow } from "@/lib/program-schedule";
import {
  assertCanonicalSnapshotTableCoverage,
  CANONICAL_CAPTURE_TABLES,
  RECOVERY_MANIFEST_BY_TABLE,
  RECOVERY_MANIFEST_VERSION,
  RECOVERY_TABLE_MANIFEST,
} from "@/services/recovery-manifest";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import {
  upgradeSnapshotPayload,
  validateSnapshotPayload,
} from "@/services/snapshot-restore";
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

    expect(RECOVERY_MANIFEST_VERSION).toBe(16);
    expect(new Set(manifested).size).toBe(manifested.length);
    expect(manifested).toEqual(tables);
    expect(RECOVERY_TABLE_MANIFEST).toHaveLength(68);
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
    expect(RECOVERY_MANIFEST_BY_TABLE.program_schedules).toMatchObject({
      dependencies: ["users", "programs"],
      restore: { full: "replace", history: "preserve" },
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.program_schedule_versions).toMatchObject({
      dependencies: [
        "users",
        "program_schedules",
        "programs",
        "program_versions",
      ],
      restore: { full: "replace", history: "preserve" },
    });
    expect(RECOVERY_MANIFEST_BY_TABLE.scheduled_program_events).toMatchObject({
      dependencies: [
        "users",
        "program_schedules",
        "program_schedule_versions",
        "program_versions",
        "workout_templates",
      ],
      restore: { full: "replace", history: "preserve" },
      integrityChecks: expect.arrayContaining(["not performed-work evidence"]),
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
    expect(
      RECOVERY_MANIFEST_BY_TABLE.session_exercises.integrityChecks,
    ).toContain(
      "immutable nullable prescribed-counting tuple bound to an eligible retained repetition metric",
    );
    expect(RECOVERY_MANIFEST_BY_TABLE.audit_logs).toMatchObject({
      restore: { full: "merge", history: "merge" },
      integrityChecks: expect.arrayContaining([
        "workout-timing version link",
        "monotonic workout-timing restore transition",
        "exact Finish command receipt merge",
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

  it("upgrades schema 32 with explicit empty schedule intent and null workout evidence", async () => {
    const [user] = await database.db
      .insert(users)
      .values({ email: `schedule-upgrade-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId: user.id });
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId: user.id,
        timezone: "America/Toronto",
        localDate: "2026-08-14",
        startedAt: new Date("2026-08-14T16:00:00.000Z"),
      })
      .returning({ id: workoutSessions.id });
    const current = await captureUserSnapshot(
      database.db,
      user.id,
      new Date("2026-08-14T16:01:00.000Z"),
      "schedule-recovery-test",
    );
    expect(current.schemaVersion).toBe("38");
    expect(current.tables.program_schedules).toEqual([]);
    expect(current.tables.program_schedule_versions).toEqual([]);
    expect(current.tables.scheduled_program_events).toEqual([]);
    expect(current.tables.workout_sessions).toContainEqual(
      expect.objectContaining({
        id: session.id,
        program_schedule_snapshot: null,
      }),
    );

    const schema32 = structuredClone(current);
    schema32.schemaVersion = "32";
    delete schema32.tables.program_schedules;
    delete schema32.tables.program_schedule_versions;
    delete schema32.tables.scheduled_program_events;
    delete (schema32.tables.workout_sessions[0] as Record<string, unknown>)
      .program_schedule_snapshot;
    const upgraded = upgradeSnapshotPayload(schema32);
    expect(upgraded.schemaVersion).toBe("38");
    expect(upgraded.tables.program_schedules).toEqual([]);
    expect(upgraded.tables.program_schedule_versions).toEqual([]);
    expect(upgraded.tables.scheduled_program_events).toEqual([]);
    expect(upgraded.tables.workout_sessions[0]).toMatchObject({
      id: session.id,
      program_schedule_snapshot: null,
    });
    expect(() => validateSnapshotPayload(upgraded, user.id)).not.toThrow();

    const schema33 = structuredClone(current);
    schema33.schemaVersion = "33";
    const upgraded33 = upgradeSnapshotPayload(schema33);
    expect(upgraded33.schemaVersion).toBe("38");
    expect(() => validateSnapshotPayload(upgraded33, user.id)).not.toThrow();

    const omittedField = structuredClone(current);
    delete (omittedField.tables.workout_sessions[0] as Record<string, unknown>)
      .program_schedule_snapshot;
    expect(() => validateSnapshotPayload(omittedField, user.id)).toThrow(
      /missing Program schedule snapshot state/i,
    );
    const omittedTable = structuredClone(current);
    delete omittedTable.tables.scheduled_program_events;
    expect(() => validateSnapshotPayload(omittedTable, user.id)).toThrow(
      /scheduled_program_events/i,
    );
  });

  it("validates the owner schedule graph separately from self-contained workout history", async () => {
    const [user] = await database.db
      .insert(users)
      .values({ email: `schedule-graph-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId: user.id });
    const programId = crypto.randomUUID();
    const sourceProgramVersionId = crypto.randomUUID();
    const routineId = crypto.randomUUID();
    const routineLineageId = crypto.randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(programs).values({
        id: programId,
        userId: user.id,
        name: "Schedule graph Program",
        status: "archived",
        archivedAt: new Date("2026-08-01T12:00:00.000Z"),
      });
      await tx.insert(programVersions).values({
        id: sourceProgramVersionId,
        programId,
        versionNo: 1,
        name: "Schedule graph Program",
      });
      await tx.insert(workoutTemplates).values({
        id: routineId,
        programVersionId: sourceProgramVersionId,
        lineageId: routineLineageId,
        name: "Strength A",
        orderIdx: 0,
      });
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: sourceProgramVersionId,
        })
        .where(sql`${programs.id} = ${programId}::uuid`);
    });

    const scheduleId = crypto.randomUUID();
    const scheduleVersionId = crypto.randomUUID();
    const phaseId = crypto.randomUUID();
    const sourceEventId = crypto.randomUUID();
    const resistanceIntent = {
      id: sourceEventId,
      kind: "resistance" as const,
      routineLineageId,
    };
    const document = {
      schemaVersion: "program-schedule/1" as const,
      startsOn: "2026-08-10",
      targetEndsOn: "2026-08-16",
      phases: [
        {
          id: phaseId,
          name: "Base",
          order: 1,
          boundary: { kind: "program_week_range" as const, startWeek: 1, endWeek: 1 },
          schedule: {
            kind: "fixed_7_day" as const,
            days: Array.from({ length: 7 }, (_, index) => ({
              isoWeekday: index + 1,
              event:
                index === 0
                  ? resistanceIntent
                  : { id: crypto.randomUUID(), kind: "rest" as const },
            })),
          },
        },
      ],
    };
    const contentHash = sha256Hex(
      Buffer.from(canonicalJson(document), "utf8"),
    );
    await database.db.insert(programSchedules).values({
      id: scheduleId,
      userId: user.id,
      programId,
    });
    await database.db.insert(programScheduleVersions).values({
      id: scheduleVersionId,
      userId: user.id,
      programId,
      scheduleId,
      versionNo: 1,
      sourceProgramVersionId,
      document,
      contentHash,
    });
    await database.db
      .update(programSchedules)
      .set({ currentVersionId: scheduleVersionId })
      .where(sql`${programSchedules.id} = ${scheduleId}::uuid`);
    const eventRows = materializeProgramScheduleWindow(document, {
      startsOn: document.startsOn,
      endsOn: document.targetEndsOn,
    }).map((occurrence, index) => {
      if (occurrence.state !== "scheduled") {
        throw new Error("Schedule graph fixture did not fully materialize.");
      }
      return {
        id: crypto.randomUUID(),
        userId: user.id,
        programId,
        scheduleId,
        scheduleVersionId,
        sourceProgramVersionId,
        sourcePhaseId: occurrence.phaseId,
        sourcePhaseName: occurrence.phaseName,
        sourceEventId: occurrence.eventId,
        kind: occurrence.eventKind,
        scheduleKind: occurrence.scheduleKind,
        routineLineageId: occurrence.routineLineageId,
        intentSnapshot: occurrence.intentSnapshot,
        sequenceNo: index + 1,
        cyclePosition: occurrence.cyclePosition,
        programWeek: occurrence.nominalProgramWeek,
        originalLocalDate: occurrence.plannedLocalDate,
        currentLocalDate: occurrence.plannedLocalDate,
        timezone: "America/Toronto",
      };
    });
    await database.db.insert(scheduledProgramEvents).values(eventRows);
    const scheduledProgramEventId = eventRows[0].id;
    await database.db.insert(workoutSessions).values({
      userId: user.id,
      templateId: routineId,
      templateName: "Strength A",
      sourceProgramId: programId,
      sourceProgramVersionId,
      sourceDayLineageId: routineLineageId,
      programScheduleSnapshot: {
        schemaVersion: 1,
        scheduledProgramEventId,
        programScheduleId: scheduleId,
        programScheduleVersionId: scheduleVersionId,
        programScheduleVersionHash: contentHash,
        scheduleSourceProgramVersionId: sourceProgramVersionId,
        resolvedProgramVersionId: sourceProgramVersionId,
        sourcePhaseId: phaseId,
        sourcePhaseName: "Base",
        scheduleKind: "fixed_7_day",
        eventKind: "resistance",
        sourceEventId,
        eventRevision: 0,
        originalLocalDate: "2026-08-10",
        currentLocalDate: "2026-08-10",
        timezone: "America/Toronto",
        nominalProgramWeek: 1,
        cyclePosition: 1,
        routineLineageId,
      },
      timezone: "America/Toronto",
      localDate: "2026-08-10",
      startedAt: new Date("2026-08-10T16:00:00.000Z"),
    });

    const captured = await captureUserSnapshot(
      database.db,
      user.id,
      new Date("2026-08-10T16:01:00.000Z"),
      "schedule-graph-test",
    );
    expect(() => validateSnapshotPayload(captured, user.id)).not.toThrow();
    const tamperedGraph = structuredClone(captured);
    (tamperedGraph.tables.scheduled_program_events[0] as Record<string, unknown>)
      .source_phase_name = "Wrong phase";
    expect(() => validateSnapshotPayload(tamperedGraph, user.id)).toThrow(
      /scheduled Program event/i,
    );
    const independentHistory = structuredClone(captured);
    independentHistory.tables.program_schedules = [];
    independentHistory.tables.program_schedule_versions = [];
    independentHistory.tables.scheduled_program_events = [];
    expect(
      () => validateSnapshotPayload(independentHistory, user.id),
    ).not.toThrow();
  });
});
