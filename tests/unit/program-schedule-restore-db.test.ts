import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exercises,
  programScheduleVersions,
  programSchedules,
  scheduledProgramEvents,
  userProfiles,
  users,
  workoutTemplates,
} from "@/db/schema";
import {
  materializeProgramScheduleWindow,
  parseProgramScheduleDocument,
} from "@/lib/program-schedule";
import { activateProgramAtomically } from "@/services/program-activation";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import {
  captureUserSnapshot,
  type CanonicalSnapshotPayload,
} from "@/services/snapshot-capture";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
  validateSnapshotPayload,
} from "@/services/snapshot-restore";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  createDataSnapshot,
  readVerifiedDataSnapshot,
  type SnapshotKeyring,
} from "@/services/snapshots";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

const key = Buffer.alloc(32, 81);
const keyring: SnapshotKeyring = {
  currentVersion: "schedule-restore-v1",
  resolve(version) {
    if (version !== this.currentVersion) throw new Error("Unknown test key.");
    return key;
  },
};

type ScheduleIds = {
  userId: string;
  programId: string;
  programVersionId: string;
  routineLineageId: string;
  scheduleId: string;
  currentVersionId: string;
  currentEventId: string;
};

function scheduleRows(payload: CanonicalSnapshotPayload) {
  return {
    program_schedules: payload.tables.program_schedules,
    program_schedule_versions: payload.tables.program_schedule_versions,
    scheduled_program_events: payload.tables.scheduled_program_events,
  };
}

function errorChain(error: unknown) {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

describe("Program schedule snapshot restore SQL", () => {
  let database: TestDatabase;
  let store: MemorySnapshotObjectStore;
  let fixture: ScheduleIds;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    store = new MemorySnapshotObjectStore();

    const [user] = await database.db
      .insert(users)
      .values({
        email: `schedule-restore-${randomUUID()}@example.com`,
        name: "Schedule restore owner",
      })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId: user.id,
      unit: "kg",
    });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        userId: user.id,
        name: `Schedule restore squat ${randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "bodyweight",
      })
      .returning({ id: exercises.id });
    const activation = await activateProgramAtomically(database.db, {
      userId: user.id,
      loadUnit: "kg",
      programName: "Schedule restore Program",
      days: [
        {
          name: "Day A",
          exercises: [
            {
              exerciseId: exercise.id,
              sets: 2,
              repMin: 8,
              repMax: 10,
              targetLoad: null,
              restSec: 60,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Create schedule restore fixture",
      auditAction: "program.activate",
      auditSummary: "Created schedule restore fixture",
    });
    if (!activation.ok) throw new Error(activation.reason);
    const template = await database.db.query.workoutTemplates.findFirst({
      where: eq(
        workoutTemplates.programVersionId,
        activation.programVersionId,
      ),
    });
    if (!template) throw new Error("Schedule restore routine is missing.");

    fixture = {
      userId: user.id,
      programId: activation.programId,
      programVersionId: activation.programVersionId,
      routineLineageId: template.lineageId,
      scheduleId: randomUUID(),
      currentVersionId: "",
      currentEventId: "",
    };
    const first = await addScheduleVersion(1, null, "Base");
    fixture.currentVersionId = first.versionId;
    fixture.currentEventId = first.eventRowId;
  }, 30_000);

  afterEach(async () => database.close());

  async function addScheduleVersion(
    versionNo: number,
    parentVersionId: string | null,
    phaseName: string,
  ) {
    const versionId = randomUUID();
    const phaseId = randomUUID();
    const resistanceEventId = randomUUID();
    const restEventIds = Array.from({ length: 6 }, () => randomUUID());
    const document = parseProgramScheduleDocument({
      schemaVersion: "program-schedule/1",
      startsOn: "2026-08-17",
      targetEndsOn: "2026-08-23",
      phases: [
        {
          id: phaseId,
          name: phaseName,
          order: 1,
          boundary: {
            kind: "program_week_range",
            startWeek: 1,
            endWeek: 1,
          },
          schedule: {
            kind: "fixed_7_day",
            days: Array.from({ length: 7 }, (_, index) => ({
              isoWeekday: index + 1,
              event:
                index === 0
                  ? {
                      id: resistanceEventId,
                      kind: "resistance" as const,
                      routineLineageId: fixture.routineLineageId,
                    }
                  : {
                      id: restEventIds[index - 1],
                      kind: "rest" as const,
                    },
            })),
          },
        },
      ],
    });
    const contentHash = sha256Hex(
      Buffer.from(canonicalJson(document), "utf8"),
    );
    if (versionNo === 1) {
      await database.db.insert(programSchedules).values({
        id: fixture.scheduleId,
        userId: fixture.userId,
        programId: fixture.programId,
      });
    }
    await database.db.insert(programScheduleVersions).values({
      id: versionId,
      userId: fixture.userId,
      programId: fixture.programId,
      scheduleId: fixture.scheduleId,
      versionNo,
      parentVersionId,
      sourceProgramVersionId: fixture.programVersionId,
      document,
      contentHash,
    });
    const eventRows = materializeProgramScheduleWindow(document, {
      startsOn: document.startsOn,
      endsOn: document.targetEndsOn!,
    }).map((occurrence, index) => {
      if (occurrence.state !== "scheduled") {
        throw new Error("Schedule restore fixture did not fully materialize.");
      }
      return {
        id: randomUUID(),
        userId: fixture.userId,
        programId: fixture.programId,
        scheduleId: fixture.scheduleId,
        scheduleVersionId: versionId,
        sourceProgramVersionId: fixture.programVersionId,
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
    const eventRowId = eventRows[0].id;
    await database.db
      .update(programSchedules)
      .set({ currentVersionId: versionId })
      .where(eq(programSchedules.id, fixture.scheduleId));
    return { versionId, eventRowId };
  }

  async function createSourceSnapshot() {
    const source = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "Program schedule source", reason: "manual" },
      {
        store,
        keyring,
        now: new Date("2026-08-17T12:00:00.000Z"),
        appVersion: "program-schedule-restore-test",
      },
    );
    if (!source.ok) throw new Error(source.reason);
    return source.snapshotId;
  }

  async function restore(snapshotId: string, failAfterTable?: string) {
    const preview = await getSnapshotRestorePreview(
      database.db,
      fixture.userId,
      snapshotId,
      "full",
      { store, keyring },
    );
    return restoreDataSnapshot(
      database.db,
      fixture.userId,
      {
        snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      {
        store,
        keyring,
        appVersion: "program-schedule-restore-test",
        failAfterTable,
      },
    );
  }

  it("round-trips the complete schedule graph during a full restore", async () => {
    const snapshotId = await createSourceSnapshot();
    const source = await readVerifiedDataSnapshot(
      database.db,
      fixture.userId,
      snapshotId,
      { store, keyring },
    );
    const newer = await addScheduleVersion(
      2,
      fixture.currentVersionId,
      "Newer destination",
    );
    fixture.currentVersionId = newer.versionId;

    const result = await restore(snapshotId);
    if (!result.ok) throw new Error(result.reason);
    expect(result).toMatchObject({
      ok: true,
      scope: "full",
    });
    const restored = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-18T12:00:00.000Z"),
      "schedule-restore-check",
    );
    expect(scheduleRows(restored)).toEqual(scheduleRows(source.payload));
  }, 30_000);

  it("rejects omitted or falsified immutable schedule occurrences", async () => {
    const source = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-17T12:30:00.000Z"),
      "schedule-validation-source",
    );
    expect(
      source.tables.scheduled_program_events,
    ).toHaveLength(7);

    const omitted = structuredClone(source);
    omitted.tables.scheduled_program_events.pop();
    expect(() => validateSnapshotPayload(omitted, fixture.userId)).toThrow(
      /do not exactly match immutable schedule content/i,
    );

    const wrongDate = structuredClone(source);
    const firstDate = wrongDate.tables.scheduled_program_events.find(
      (event) =>
        Number((event as Record<string, unknown>).sequence_no) === 1,
    );
    if (!firstDate) throw new Error("First schedule occurrence is missing.");
    (
      firstDate as Record<string, unknown>
    ).original_local_date = "2026-08-18";
    expect(() => validateSnapshotPayload(wrongDate, fixture.userId)).toThrow(
      /do not exactly match immutable schedule content/i,
    );

    const wrongCoordinate = structuredClone(source);
    const firstCoordinate =
      wrongCoordinate.tables.scheduled_program_events.find(
        (event) =>
          Number((event as Record<string, unknown>).sequence_no) === 1,
      );
    if (!firstCoordinate) {
      throw new Error("First schedule occurrence is missing.");
    }
    (
      firstCoordinate as Record<string, unknown>
    ).cycle_position = 2;
    expect(() =>
      validateSnapshotPayload(wrongCoordinate, fixture.userId)
    ).toThrow(/do not exactly match immutable schedule content/i);
  }, 30_000);

  it("fails closed in SQL on an incomplete immutable occurrence graph", async () => {
    const snapshotId = await createSourceSnapshot();
    const current = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-17T13:00:00.000Z"),
      "schedule-incomplete-current",
    );
    const incomplete = structuredClone(scheduleRows(current));
    incomplete.scheduled_program_events.pop();

    let restoreError: unknown;
    try {
      await database.db.execute(sql`
        SELECT restore_user_snapshot(
          ${fixture.userId}::uuid,
          'full'::text,
          ${JSON.stringify(scheduleRows(current))}::jsonb,
          ${JSON.stringify(incomplete)}::jsonb,
          '{}'::jsonb,
          ${snapshotId}::uuid,
          ${randomUUID()}::uuid,
          NULL::text
        )
      `);
    } catch (error) {
      restoreError = error;
    }
    expect(errorChain(restoreError)).toMatch(
      /schedule graph is cross-owner or contradictory/i,
    );
    const after = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-17T14:00:00.000Z"),
      "schedule-incomplete-after",
    );
    expect(scheduleRows(after)).toEqual(scheduleRows(current));
  }, 30_000);

  it("preserves a newer destination calendar during History restore", async () => {
    const snapshotId = await createSourceSnapshot();
    const newer = await addScheduleVersion(
      2,
      fixture.currentVersionId,
      "Newer destination",
    );
    fixture.currentVersionId = newer.versionId;
    const before = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-18T12:00:00.000Z"),
      "schedule-history-before",
    );
    const preview = await getSnapshotRestorePreview(
      database.db,
      fixture.userId,
      snapshotId,
      "history",
      { store, keyring },
    );
    const restored = await restoreDataSnapshot(
      database.db,
      fixture.userId,
      {
        snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "program-schedule-restore-test" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });
    const after = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-18T13:00:00.000Z"),
      "schedule-history-after",
    );
    expect(scheduleRows(after)).toEqual(scheduleRows(before));
  }, 30_000);

  it("rejects a stale full-restore schedule preview inside SQL", async () => {
    const snapshotId = await createSourceSnapshot();
    const expected = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-17T13:00:00.000Z"),
      "schedule-stale-expected",
    );
    const source = await readVerifiedDataSnapshot(
      database.db,
      fixture.userId,
      snapshotId,
      { store, keyring },
    );
    await database.db
      .update(scheduledProgramEvents)
      .set({
        currentLocalDate: "2026-08-18",
        adjustmentKind: "manual",
        revision: 1,
      })
      .where(eq(scheduledProgramEvents.id, fixture.currentEventId));

    let restoreError: unknown;
    try {
      await database.db.execute(sql`
        SELECT restore_user_snapshot(
          ${fixture.userId}::uuid,
          'full'::text,
          ${JSON.stringify(scheduleRows(expected))}::jsonb,
          ${JSON.stringify(scheduleRows(source.payload))}::jsonb,
          '{}'::jsonb,
          ${snapshotId}::uuid,
          ${randomUUID()}::uuid,
          NULL::text
        )
      `);
    } catch (error) {
      restoreError = error;
    }
    expect(errorChain(restoreError)).toMatch(/stale for Program schedule data/i);
  }, 30_000);

  it("fails closed on a contradictory schedule graph", async () => {
    const snapshotId = await createSourceSnapshot();
    const current = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-17T13:00:00.000Z"),
      "schedule-graph-current",
    );
    const contradictory = structuredClone(scheduleRows(current));
    (
      contradictory.scheduled_program_events[0] as Record<string, unknown>
    ).schedule_id = randomUUID();

    let restoreError: unknown;
    try {
      await database.db.execute(sql`
        SELECT restore_user_snapshot(
          ${fixture.userId}::uuid,
          'full'::text,
          ${JSON.stringify(scheduleRows(current))}::jsonb,
          ${JSON.stringify(contradictory)}::jsonb,
          '{}'::jsonb,
          ${snapshotId}::uuid,
          ${randomUUID()}::uuid,
          NULL::text
        )
      `);
    } catch (error) {
      restoreError = error;
    }
    expect(errorChain(restoreError)).toMatch(
      /schedule graph is cross-owner or contradictory/i,
    );
    const after = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-17T14:00:00.000Z"),
      "schedule-graph-after",
    );
    expect(scheduleRows(after)).toEqual(scheduleRows(current));
  }, 30_000);

  it.each([
    "program_schedules",
    "program_schedule_versions",
    "scheduled_program_events",
  ])("rolls back the entire restore after %s", async (failAfterTable) => {
    const snapshotId = await createSourceSnapshot();
    const newer = await addScheduleVersion(
      2,
      fixture.currentVersionId,
      "Newer destination",
    );
    fixture.currentVersionId = newer.versionId;
    await database.db
      .update(userProfiles)
      .set({ unit: "lb" })
      .where(eq(userProfiles.userId, fixture.userId));
    const before = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-18T12:00:00.000Z"),
      "schedule-failure-before",
    );

    const result = await restore(snapshotId, failAfterTable);
    expect(result).toMatchObject({ ok: false });
    const after = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-18T13:00:00.000Z"),
      "schedule-failure-after",
    );
    expect(scheduleRows(after)).toEqual(scheduleRows(before));
    expect(
      await database.db.query.userProfiles.findFirst({
        where: eq(userProfiles.userId, fixture.userId),
      }),
    ).toMatchObject({ unit: "lb" });
  }, 30_000);
});
