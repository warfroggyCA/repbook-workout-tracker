import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  completedSets,
  externalExerciseMappings,
  exercises,
  recordVersions,
  sessionEquipmentSnapshots,
  sessionExercises,
  sessionOccurrences,
  users,
} from "@/db/schema";
import {
  PREVIOUS_COMPARABLE_SET_UNAVAILABLE,
  getPreviousComparableSets,
} from "@/services/previous-comparable-sets";
import type { PerformedLoadSemantics } from "@/lib/set-metric-semantics";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("previous comparable performed sets", () => {
  let database: TestDatabase;
  let userId: string;
  let otherUserId: string;
  let exerciseId: string;
  let currentSessionExerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }, { id: otherUserId }] = await database.db
      .insert(users)
      .values([
        { email: `comparison-${crypto.randomUUID()}@example.com` },
        { email: `comparison-other-${crypto.randomUUID()}@example.com` },
      ])
      .returning({ id: users.id });
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Synthetic comparison press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        metricType: "weight_reps",
        loadType: "barbell",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });
    const currentSessionId = crypto.randomUUID();
    await database.db.execute(sql`
      INSERT INTO workout_sessions (
        id, user_id, template_name, status, started_at, timezone, local_date
      ) VALUES (
        ${currentSessionId}::uuid,
        ${userId}::uuid,
        'Current synthetic workout',
        'in_progress'::session_status,
        '2026-08-10T14:00:00.000Z'::timestamptz,
        'America/Toronto',
        '2026-08-10'
      )
    `);
    [{ id: currentSessionExerciseId }] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: currentSessionId,
        exerciseId,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: "Synthetic comparison press",
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        orderIdx: 0,
      })
      .returning({ id: sessionExercises.id });
  }, 30_000);

  afterEach(async () => database.close());

  async function addHistoricalSet(input: {
    startedAtISO: string;
    exerciseId?: string;
    performedSemanticsVersion?: 1 | null;
    performedLoadType?: string | null;
    performedLoadSemantics?: PerformedLoadSemantics | null;
    loadEntryMeaning?: "total_system" | "per_loading_point";
    weight?: number;
    weightUnit?: "lb" | "kg";
    reps?: number;
    setNos?: number[];
    excludeFromAnalytics?: boolean;
    source?: string;
    sourceExerciseName?: string | null;
  }) {
    const startedAt = new Date(input.startedAtISO);
    const finishedAt = new Date(startedAt.getTime() + 45 * 60_000);
    const sessionId = crypto.randomUUID();
    await database.db.execute(sql`
      INSERT INTO workout_sessions (
        id, user_id, template_name, source, status, started_at, finished_at,
        timezone, local_date
      ) VALUES (
        ${sessionId}::uuid,
        ${userId}::uuid,
        'Historical synthetic workout',
        ${input.source ?? "tracker"},
        'completed'::session_status,
        ${startedAt}::timestamptz,
        ${finishedAt}::timestamptz,
        'America/Toronto',
        ${input.startedAtISO.slice(0, 10)}
      )
    `);
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId: input.exerciseId ?? exerciseId,
        sourceExerciseName: input.sourceExerciseName ?? null,
        orderIdx: 0,
      })
      .returning({ id: sessionExercises.id });
    const [equipment] = await database.db
      .insert(sessionEquipmentSnapshots)
      .values({
        userId,
        sessionId,
        sessionExerciseId: sessionExercise.id,
        equipmentLabel: "Synthetic barbell",
        profileKind: "other",
        geometryCertainty: "known",
        unit: input.weightUnit ?? "lb",
        selectionProvenance: "user_selected",
        configurationRevision: 1,
        configurationHash: "0".repeat(64),
        geometryVersion: 1,
        geometrySnapshot: { version: 1, kind: "other" },
      })
      .returning({ id: sessionEquipmentSnapshots.id });
    const semanticsVersion = input.performedSemanticsVersion === undefined
      ? 1
      : input.performedSemanticsVersion;
    const createdSets = await database.db
      .insert(completedSets)
      .values((input.setNos ?? [1]).map((setNo) => ({
        sessionExerciseId: sessionExercise.id,
        setNo,
        weight: input.weight ?? 45,
        weightUnit: input.weightUnit ?? "kg",
        reps: input.reps ?? 8,
        metricType: "weight_reps" as const,
        performedSemanticsVersion: semanticsVersion,
        performedLoadType: semanticsVersion == null
          ? null
          : (input.performedLoadType ?? "barbell"),
        performedLoadSemantics: semanticsVersion == null
          ? null
          : (input.performedLoadSemantics ?? "total"),
        equipmentSnapshotId: equipment.id,
        loadEntryMeaning: input.loadEntryMeaning ?? "total_system",
        excludeFromAnalytics: input.excludeFromAnalytics ?? false,
        observedCompletedAt: new Date(finishedAt.getTime() - setNo * 60_000),
        observedCompletionProvenance: "live_client",
        observedCompletionQuality: "trustworthy",
      })))
      .returning({ id: completedSets.id, setNo: completedSets.setNo });
    await database.db.insert(sessionOccurrences).values(createdSets.map((set) => ({
      sessionId,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set" as const,
      origin: input.source === "hevy" ? "imported" as const : "ad_hoc" as const,
      sequenceIdx: set.setNo - 1,
      kindOrdinal: set.setNo - 1,
      plannedExerciseId: input.exerciseId ?? exerciseId,
      outcome: "completed" as const,
      resolvedAt: finishedAt,
      completedSetId: set.id,
      equipmentSnapshotId: equipment.id,
    })));
    return {
      sessionId,
      sessionExerciseId: sessionExercise.id,
      equipmentSnapshotId: equipment.id,
      finishedAt,
      setIds: createdSets.map((set) => set.id),
    };
  }

  it("uses exact identity and complete semantics, scanning past newer unsafe rows", async () => {
    const safe = await addHistoricalSet({
      startedAtISO: "2026-08-01T14:00:00.000Z",
      weight: 45,
      weightUnit: "kg",
      setNos: [1, 2],
    });
    await database.db.insert(recordVersions).values([
      {
        userId,
        entityType: "completed_set",
        entityId: safe.setIds[0],
        action: "set.completed_correction",
        beforeData: { weight: 44, weight_unit: "kg" },
        afterData: { weight: 45, weight_unit: "kg" },
        changedFields: ["weight"],
      },
      {
        userId,
        entityType: "completed_set",
        entityId: safe.setIds[0],
        action: "set.version_restore",
        beforeData: { weight: 47, weight_unit: "kg" },
        afterData: { weight: 45, weight_unit: "kg" },
        changedFields: ["weight"],
      },
      {
        userId,
        entityType: "completed_set",
        entityId: safe.setIds[1],
        action: "set.snapshot_restore",
        beforeData: { weight: 46, weight_unit: "kg" },
        afterData: { weight: 45, weight_unit: "kg" },
        changedFields: ["weight"],
      },
    ]);
    await addHistoricalSet({
      startedAtISO: "2026-08-03T14:00:00.000Z",
      performedSemanticsVersion: null,
      weight: 105,
      weightUnit: "lb",
    });
    await addHistoricalSet({
      startedAtISO: "2026-08-04T14:00:00.000Z",
      performedLoadSemantics: "per_implement",
      weight: 55,
      weightUnit: "lb",
    });
    await addHistoricalSet({
      startedAtISO: "2026-08-05T14:00:00.000Z",
      loadEntryMeaning: "per_loading_point",
      weight: 60,
      weightUnit: "lb",
    });
    const [differentIdentity] = await database.db
      .insert(exercises)
      .values({
        name: "Synthetic collision press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        metricType: "weight_reps",
        loadType: "barbell",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });
    await addHistoricalSet({
      startedAtISO: "2026-08-06T14:00:00.000Z",
      exerciseId: differentIdentity.id,
      weight: 135,
      weightUnit: "lb",
    });

    const result = await getPreviousComparableSets(database.db, userId, [{
      sessionExerciseId: currentSessionExerciseId,
      loadEntryMeaning: "total_system",
      targetLoadUnit: "lb",
    }]);

    expect(result[currentSessionExerciseId]).toMatchObject({
      status: "available",
      exerciseId,
      semantics: {
        version: 1,
        metricType: "weight_reps",
        loadType: "barbell",
        loadSemantics: "total",
        loadEntryMeaning: "total_system",
      },
      source: {
        workoutId: safe.sessionId,
        localDate: "2026-08-01",
        historyHref: `/history/${safe.sessionId}`,
      },
      sets: [
        {
          setId: safe.setIds[0],
          setNo: 1,
          weight: 45,
          weightUnit: "kg",
          reps: 8,
          correctionProvenance: {
            state: "version_restored",
            count: 2,
          },
        },
        {
          setId: safe.setIds[1],
          setNo: 2,
          weight: 45,
          weightUnit: "kg",
          reps: 8,
          correctionProvenance: {
            state: "snapshot_restored",
            count: 1,
          },
        },
      ],
    });
  });

  it("is explicit when current load meaning, ownership, or safe evidence is absent", async () => {
    await addHistoricalSet({
      startedAtISO: "2026-08-01T14:00:00.000Z",
      performedSemanticsVersion: null,
    });
    const missingId = crypto.randomUUID();
    const [unknownMeaning, wrongOwner] = await Promise.all([
      getPreviousComparableSets(database.db, userId, [{
        sessionExerciseId: currentSessionExerciseId,
        loadEntryMeaning: "legacy_unknown",
      }]),
      getPreviousComparableSets(database.db, otherUserId, [{
        sessionExerciseId: currentSessionExerciseId,
        loadEntryMeaning: "total_system",
      }, {
        sessionExerciseId: missingId,
        loadEntryMeaning: "total_system",
      }]),
    ]);

    expect(unknownMeaning[currentSessionExerciseId]).toEqual({
      status: "unavailable",
      currentSessionExerciseId,
      message: PREVIOUS_COMPARABLE_SET_UNAVAILABLE,
      reason: "load_entry_meaning_unavailable",
    });
    expect(wrongOwner[currentSessionExerciseId]).toMatchObject({
      status: "unavailable",
      reason: "current_exercise_unavailable",
    });
    expect(wrongOwner[missingId]).toMatchObject({
      status: "unavailable",
      reason: "current_exercise_unavailable",
    });

    const noSafe = await getPreviousComparableSets(database.db, userId, [{
      sessionExerciseId: currentSessionExerciseId,
      loadEntryMeaning: "total_system",
    }]);
    expect(noSafe[currentSessionExerciseId]).toMatchObject({
      status: "unavailable",
      message: PREVIOUS_COMPARABLE_SET_UNAVAILABLE,
      reason: "no_comparable_history",
    });
  });

  it("requires the current exact owner-reviewed mapping for Hevy evidence", async () => {
    const ordinary = await addHistoricalSet({
      startedAtISO: "2026-08-01T14:00:00.000Z",
    });
    const imported = await addHistoricalSet({
      startedAtISO: "2026-08-02T14:00:00.000Z",
      source: "hevy",
      sourceExerciseName: "Hevy Synthetic Press",
      weight: 50,
      weightUnit: "kg",
    });
    const request = [{
      sessionExerciseId: currentSessionExerciseId,
      loadEntryMeaning: "total_system" as const,
    }];

    await expect(
      getPreviousComparableSets(database.db, userId, request),
    ).resolves.toMatchObject({
      [currentSessionExerciseId]: {
        status: "available",
        source: { workoutId: ordinary.sessionId, workoutSource: "tracker" },
      },
    });

    await database.db.insert(externalExerciseMappings).values({
      userId,
      source: "hevy",
      sourceName: "Hevy Synthetic Press",
      normalizedKey: "hevy synthetic press||",
      exerciseId,
    });
    await expect(
      getPreviousComparableSets(database.db, userId, request),
    ).resolves.toMatchObject({
      [currentSessionExerciseId]: {
        status: "available",
        source: { workoutId: imported.sessionId, workoutSource: "hevy" },
      },
    });
  });

  it("rejects an ambiguous duplicate completed-occurrence link", async () => {
    const historical = await addHistoricalSet({
      startedAtISO: "2026-08-01T14:00:00.000Z",
    });
    await database.db.execute(sql`
      DROP INDEX session_occurrences_completed_set_uq
    `);
    await database.db.insert(sessionOccurrences).values({
      sessionId: historical.sessionId,
      sessionExerciseId: historical.sessionExerciseId,
      kind: "working_set",
      origin: "legacy",
      sequenceIdx: 50,
      kindOrdinal: 50,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      resolvedAt: historical.finishedAt,
      completedSetId: historical.setIds[0],
      equipmentSnapshotId: historical.equipmentSnapshotId,
    });

    const result = await getPreviousComparableSets(database.db, userId, [{
      sessionExerciseId: currentSessionExerciseId,
      loadEntryMeaning: "total_system",
    }]);
    expect(result[currentSessionExerciseId]).toMatchObject({
      status: "unavailable",
      reason: "no_comparable_history",
    });
  });
});
