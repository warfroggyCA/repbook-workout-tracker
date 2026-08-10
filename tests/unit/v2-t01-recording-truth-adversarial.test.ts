import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  sessionOccurrenceMutations,
  sessionOccurrences,
  workoutSessions,
} from "@/db/schema";
import { logSetSchema } from "@/lib/session-action-validation";
import {
  enqueueWorkoutSetOutboxEntry,
  parseWorkoutSetOutbox,
  type WorkoutSetOutboxStorage,
} from "@/lib/workout-set-outbox";
import { logWorkoutSet } from "@/services/session-lifecycle";
import { updateSetWithVersion } from "@/services/record-versions";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  completeT01Workout,
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

class MemoryStorage implements WorkoutSetOutboxStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("V2 T01 recording trust-boundary refusals", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  it("rejects contradictory, unsupported, non-finite, and combined measurement commands", () => {
    const base = fixture.commands.loaded;
    expect(logSetSchema.safeParse({
      ...base,
      metricType: "duration",
      weight: null,
      weightUnit: null,
      reps: 1,
      durationSeconds: 30,
    }).success).toBe(false);
    expect(logSetSchema.safeParse({
      ...base,
      metricType: "distance_duration",
      weight: null,
      weightUnit: null,
      reps: null,
      distanceKm: null,
      durationSeconds: 30,
    }).success).toBe(false);
    expect(logSetSchema.safeParse({ ...base, weight: Number.NaN }).success)
      .toBe(false);
    expect(logSetSchema.safeParse({ ...base, weight: Number.POSITIVE_INFINITY }).success)
      .toBe(false);
    expect(logSetSchema.safeParse({
      ...base,
      metricType: "activity",
      weight: null,
      weightUnit: null,
      reps: null,
      distanceKm: null,
      durationSeconds: null,
    }).success).toBe(false);
    expect(logSetSchema.safeParse({
      ...fixture.commands.duration,
      performedLoadSemantics: "added_weight",
    }).success).toBe(false);
  });

  it("quarantines old or tampered device commands instead of replaying inferred facts", () => {
    const storage = new MemoryStorage();
    expect(enqueueWorkoutSetOutboxEntry(storage, {
      ...fixture.commands.loaded,
      clientKey: crypto.randomUUID(),
      ownerId: fixture.userId,
      sessionId: fixture.sessionId,
      exerciseName: "T01 loaded press",
      rpe: fixture.commands.loaded.rpe ?? null,
      note: fixture.commands.loaded.note ?? null,
      equipmentSnapshotId:
        fixture.commands.loaded.equipmentSnapshotId ?? null,
      loadEntryMeaning:
        fixture.commands.loaded.loadEntryMeaning ?? "legacy_unknown",
      createdAtISO: new Date().toISOString(),
    })).toMatchObject({ ok: true });
    const current = JSON.parse(
      storage.getItem("workout-tracker:workout-set-outbox:v1") ?? "null",
    ) as { version: number; entries: Array<Record<string, unknown>> };

    expect(parseWorkoutSetOutbox(JSON.stringify({
      version: 3,
      entries: current.entries,
    }))).toMatchObject({
      entries: [],
      quarantined: [{
        raw: current.entries[0],
        reason: expect.stringContaining("older recording format"),
      }],
      error: null,
    });

    const tampered = {
      ...current.entries[0],
      durationSeconds: 30,
    };
    expect(parseWorkoutSetOutbox(JSON.stringify({
      version: 4,
      entries: [tampered],
    }))).toMatchObject({
      entries: [],
      quarantined: [{
        raw: tampered,
        reason: expect.stringContaining("incomplete or invalid"),
      }],
      error: null,
    });
  });

  it("refuses stale identity, metric, semantics, and unsupported combined shapes before mutation", async () => {
    const beforeSets = (await database.db.select().from(completedSets)).length;
    const beforeReceipts = (
      await database.db.select().from(sessionOccurrenceMutations)
    ).length;

    await expect(logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      performedExerciseId: crypto.randomUUID(),
      clientKey: "v2-t01-wrong-exercise",
    })).resolves.toEqual({
      outcome: "performed_evidence_conflict",
      reason: "exercise_changed",
    });
    await expect(logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      clientKey: "v2-t01-wrong-metric",
      metricType: "reps",
      weight: null,
      weightUnit: null,
      reps: 5,
      distanceKm: null,
      durationSeconds: null,
    })).resolves.toEqual({
      outcome: "performed_evidence_conflict",
      reason: "metric_changed",
    });
    await expect(logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      clientKey: "v2-t01-wrong-semantics",
      performedLoadSemantics: "per_implement",
    })).resolves.toEqual({
      outcome: "performed_evidence_conflict",
      reason: "semantics_changed",
    });
    await expect(logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.duration,
      clientKey: "v2-t01-loaded-duration",
      sessionExerciseId: fixture.sessionExerciseIds.loadedDuration,
      performedExerciseId: fixture.exerciseIds.loadedDuration,
      performedLoadType: "external",
      performedLoadSemantics: "added_weight",
    })).resolves.toEqual({
      outcome: "unsupported_set_shape",
      metricType: "duration",
      reason: "metric_semantics_conflict",
    });
    await expect(logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      clientKey: "v2-t01-nonfinite-load",
      weight: Number.POSITIVE_INFINITY,
    })).resolves.toEqual({
      outcome: "unsupported_set_shape",
      metricType: "weight_reps",
      reason: "measurement_shape_conflict",
    });

    expect((await database.db.select().from(completedSets)).length).toBe(beforeSets);
    expect(
      (await database.db.select().from(sessionOccurrenceMutations)).length,
    ).toBe(beforeReceipts);
    expect(await database.db.query.sessionOccurrences.findFirst({
      where: eq(
        sessionOccurrences.sessionExerciseId,
        fixture.sessionExerciseIds.loaded,
      ),
    })).toMatchObject({ outcome: "pending", completedSetId: null });
  });

  it("does not let the existing correction path reshape timed evidence before T02", async () => {
    const saved = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.duration,
    );
    if (saved.outcome !== "saved") throw new Error(saved.outcome);
    await completeT01Workout(database.db, fixture);
    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, fixture.sessionId),
    });
    if (!session) throw new Error("Missing T01 workout.");

    await expect(updateSetWithVersion(
      database.db,
      fixture.userId,
      saved.setId,
      {
        weight: 20,
        weightUnit: "lb",
        reps: 5,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      "set.completed_correction",
      {
        expected: {
          weight: null,
          weightUnit: null,
          reps: null,
          distanceKm: null,
          durationSeconds: 45,
          rpe: null,
          note: null,
        },
        expectedHistoryRevision: session.historyRevision,
        clientMutationId: crypto.randomUUID(),
        correctionEvidence: {
          category: "measurement_entry",
          reasonNote: null,
          source: "workout_history",
        },
      },
    )).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("recorded metric"),
    });
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, saved.setId),
    })).toMatchObject({
      metricType: "duration",
      weight: null,
      weightUnit: null,
      reps: null,
      durationSeconds: 45,
    });
  });
});
