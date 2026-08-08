import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  adaptationEvents,
  completedSets,
  painLogs,
  recommendations,
  userDecisions,
} from "@/db/schema";
import { logWorkoutSet } from "@/services/session-lifecycle";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedT01RecordingTruth,
  completeT01Workout,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";
import {
  recordU02Exception,
  U02_EXCEPTION_CONTEXT,
} from "../helpers/v2-u02-exception-context";
import {
  WORKOUT_SET_OUTBOX_STORAGE_KEY,
  enqueueWorkoutSetOutboxEntry,
  parseWorkoutSetOutbox,
  type WorkoutSetOutboxStorage,
} from "@/lib/workout-set-outbox";
import { loadExercisePainHold } from "@/services/pain-hold";
import { getReviewDecisionData } from "@/services/review-decisions";

describe("V2 U02 exception context boundaries", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("replays exact context once and rejects identity reuse with changed evidence", async () => {
    const first = await recordU02Exception(database.db, fixture);
    await expect(logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      clientKey: "v2-u02-exception",
      rpe: null,
      ...U02_EXCEPTION_CONTEXT,
    })).resolves.toEqual(first);
    await expect(logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      clientKey: "v2-u02-exception",
      rpe: null,
      ...U02_EXCEPTION_CONTEXT,
      pain: { ...U02_EXCEPTION_CONTEXT.pain, severity: 5 },
    })).resolves.toEqual({ outcome: "retry_identity_conflict" });
    expect(await database.db.query.painLogs.findMany({
      where: eq(painLogs.completedSetId, first.setId),
    })).toHaveLength(1);
  });

  it("does not create or change recommendation, decision, or adaptation ledgers", async () => {
    await recordU02Exception(database.db, fixture);
    expect(await database.db.select().from(recommendations)).toHaveLength(0);
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    expect(await database.db.select().from(adaptationEvents)).toHaveLength(0);
  });

  it("lets H04 consume positive set-linked pain as proposal-only evidence", async () => {
    const saved = await recordU02Exception(database.db, fixture);
    await completeT01Workout(database.db, fixture);
    const savedPain = await database.db.query.painLogs.findFirst({
      where: eq(painLogs.completedSetId, saved.setId),
    });
    if (!savedPain) throw new Error("Expected retained set-linked pain evidence.");

    await expect(loadExercisePainHold(database.db, {
      userId: fixture.userId,
      exerciseId: fixture.exerciseIds.loaded,
      now: new Date(Date.now() + 1_000),
    })).resolves.toMatchObject({
      state: "hold",
      blocksProgression: true,
      evidenceIds: [savedPain.id],
    });
    const review = await getReviewDecisionData(database.db, fixture.userId);
    expect(review.recentExceptions).toContainEqual(expect.objectContaining({
      setId: saved.setId,
      sessionId: fixture.sessionId,
      painBodyPart: "back",
      painSeverity: 4,
      painMeaning: "pain",
      painAlgorithmVersion: "pain-evidence-v1",
    }));
    expect(await database.db.select().from(recommendations)).toHaveLength(0);
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    expect(await database.db.select().from(adaptationEvents)).toHaveLength(0);
  });

  it("keeps substituted performed and planned identity separate in Review", async () => {
    const saved = await logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.bodyweightSubstitution,
      clientKey: "v2-h04-substitution-pain",
      pain: { bodyPart: "knee", severity: 3, note: "Only at depth" },
    });
    if (saved.outcome !== "saved") throw new Error(saved.outcome);
    await completeT01Workout(database.db, fixture);

    const review = await getReviewDecisionData(database.db, fixture.userId);
    expect(review.recentExceptions).toContainEqual(expect.objectContaining({
      setId: saved.setId,
      performedExerciseId: fixture.exerciseIds.bodyweightSubstitution,
      performedExerciseName: expect.any(String),
      plannedExerciseId: fixture.exerciseIds.plannedSubstitution,
      plannedExerciseName: null,
      modificationType: "substituted",
      substitutionReason: "equipment_busy",
      painMeaning: "pain",
    }));
    expect(await database.db.select().from(recommendations)).toHaveLength(0);
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    expect(await database.db.select().from(adaptationEvents)).toHaveLength(0);
  });

  it("refuses a cross-owner set-linked pain record at the database boundary", async () => {
    const saved = await recordU02Exception(database.db, fixture);
    const other = await seedT01RecordingTruth(database.db);
    await expect(database.db.execute(sql`
      INSERT INTO pain_logs (
        user_id, session_id, exercise_id, completed_set_id,
        body_part, severity, source
      ) VALUES (
        ${other.userId}::uuid,
        ${other.sessionId}::uuid,
        ${other.exerciseIds.loaded}::uuid,
        ${saved.setId}::uuid,
        'back', 2, 'set_flag'
      )
    `)).rejects.toThrow();
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, saved.setId),
    })).toMatchObject({ rir: 2, techniqueIssue: "bracing" });
  });

  it("refuses invented set-linked pain values at the database boundary", async () => {
    const saved = await recordU02Exception(database.db, fixture);
    await expect(database.db.execute(sql`
      UPDATE pain_logs
      SET body_part = 'unspecified-location'
      WHERE completed_set_id = ${saved.setId}::uuid
    `)).rejects.toThrow();
    expect(await database.db.query.painLogs.findFirst({
      where: eq(painLogs.completedSetId, saved.setId),
    })).toMatchObject({ bodyPart: "back", severity: 4 });
  });

  it("retains exception context offline and upgrades an older queue entry as unknown", () => {
    const values = new Map<string, string>();
    const storage: WorkoutSetOutboxStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    const input = {
      clientKey: "10000000-0000-4000-8000-000000000001",
      ownerId: "20000000-0000-4000-8000-000000000001",
      sessionId: "30000000-0000-4000-8000-000000000001",
      sessionExerciseId: "40000000-0000-4000-8000-000000000001",
      performedExerciseId: "50000000-0000-4000-8000-000000000001",
      performedSemanticsVersion: 1 as const,
      performedLoadType: "dumbbell",
      performedLoadSemantics: "total" as const,
      exerciseName: "Press",
      setNo: 1,
      metricType: "weight_reps" as const,
      weight: 50,
      weightUnit: "lb" as const,
      reps: 8,
      distanceKm: null,
      durationSeconds: null,
      rpe: null,
      rir: 2,
      techniqueIssue: "bracing" as const,
      limitationCause: "strength_fatigue" as const,
      pain: { bodyPart: "back" as const, severity: 4, note: null },
      note: null,
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown" as const,
      createdAtISO: new Date().toISOString(),
    };
    expect(enqueueWorkoutSetOutboxEntry(storage, input)).toMatchObject({
      ok: true,
      entry: {
        rir: 2,
        techniqueIssue: "bracing",
        limitationCause: "strength_fatigue",
        pain: { bodyPart: "back", severity: 4 },
      },
    });
    expect(enqueueWorkoutSetOutboxEntry(storage, {
      ...input,
      pain: { ...input.pain, severity: 5 },
    })).toMatchObject({ ok: false, reason: expect.stringContaining("different") });

    const stored = JSON.parse(values.get(WORKOUT_SET_OUTBOX_STORAGE_KEY)!);
    for (const key of ["rir", "techniqueIssue", "limitationCause", "pain"]) {
      delete stored.entries[0][key];
    }
    const upgraded = parseWorkoutSetOutbox(JSON.stringify(stored));
    expect(upgraded.quarantined).toHaveLength(0);
    expect(upgraded.entries[0]).toMatchObject({
      rir: null,
      techniqueIssue: null,
      limitationCause: null,
      pain: null,
    });
  });
});
