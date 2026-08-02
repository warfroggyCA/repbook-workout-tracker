import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import {
  completedSets,
  exercises,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { workoutLocalDate } from "@/lib/workout-calendar";
import {
  logWorkoutSet,
  type LogWorkoutSetInput,
} from "@/services/session-lifecycle";

type ExerciseKey =
  | "loaded"
  | "plannedSubstitution"
  | "bodyweightSubstitution"
  | "assisted"
  | "duration"
  | "distance"
  | "activity"
  | "loadedDuration"
  | "legacy";

type SessionExerciseKey =
  | "loaded"
  | "bodyweightSubstitution"
  | "assisted"
  | "duration"
  | "distance"
  | "activity"
  | "loadedDuration";

type T01Command<Metric extends LogWorkoutSetInput["metricType"]> = Extract<
  LogWorkoutSetInput,
  { metricType: Metric }
>;

export type T01RecordingTruthFixture = {
  userId: string;
  sessionId: string;
  legacySessionId: string;
  legacySetId: string;
  exerciseIds: Record<ExerciseKey, string>;
  sessionExerciseIds: Record<SessionExerciseKey, string>;
  commands: {
    loaded: T01Command<"weight_reps">;
    bodyweightSubstitution: T01Command<"reps">;
    assisted: T01Command<"assisted_reps">;
    duration: T01Command<"duration">;
    distance: T01Command<"distance_duration">;
  };
};

const timezone = "America/Toronto";

export async function seedT01RecordingTruth(
  db: Db,
): Promise<T01RecordingTruthFixture> {
  const suffix = crypto.randomUUID();
  const startedAt = new Date(Date.now() - 5 * 60 * 1000);
  const observedAt = new Date(Date.now() - 60 * 1000).toISOString();
  const [user] = await db
    .insert(users)
    .values({ email: `v2-t01-${suffix}@example.com` })
    .returning({ id: users.id });
  await db.insert(userProfiles).values({
    userId: user.id,
    timezone,
    unit: "lb",
  });

  const definitions = {
    loaded: {
      name: `T01 loaded press ${suffix}`,
      movementPattern: "horizontal_push" as const,
      primaryMuscles: ["chest"],
      loadType: "dumbbell",
      metricType: "weight_reps" as const,
      loadSemantics: "total" as const,
    },
    plannedSubstitution: {
      name: `T01 planned split squat ${suffix}`,
      movementPattern: "lunge" as const,
      primaryMuscles: ["quads"],
      loadType: "dumbbell",
      metricType: "weight_reps" as const,
      loadSemantics: "per_implement" as const,
    },
    bodyweightSubstitution: {
      name: `T01 bodyweight split squat ${suffix}`,
      movementPattern: "lunge" as const,
      primaryMuscles: ["quads"],
      loadType: "bodyweight",
      metricType: "reps" as const,
      loadSemantics: "bodyweight" as const,
    },
    assisted: {
      name: `T01 assisted pull ${suffix}`,
      movementPattern: "vertical_pull" as const,
      primaryMuscles: ["back"],
      loadType: "external",
      metricType: "assisted_reps" as const,
      loadSemantics: "assistance" as const,
      variantAttributes: { assistance: "assisted" as const },
    },
    duration: {
      name: `T01 wall sit ${suffix}`,
      movementPattern: "squat" as const,
      primaryMuscles: ["quads"],
      loadType: "bodyweight",
      metricType: "duration" as const,
      loadSemantics: "bodyweight" as const,
    },
    distance: {
      name: `T01 walk ${suffix}`,
      movementPattern: "locomotion" as const,
      primaryMuscles: ["legs"],
      loadType: "bodyweight",
      activityClass: "conditioning" as const,
      metricType: "distance_duration" as const,
      loadSemantics: "bodyweight" as const,
    },
    activity: {
      name: `T01 activity-only ${suffix}`,
      movementPattern: "conditioning" as const,
      primaryMuscles: ["full body"],
      loadType: "bodyweight",
      activityClass: "conditioning" as const,
      metricType: "activity" as const,
      loadSemantics: "none" as const,
    },
    loadedDuration: {
      name: `T01 loaded hold ${suffix}`,
      movementPattern: "core" as const,
      primaryMuscles: ["core"],
      loadType: "external",
      metricType: "duration" as const,
      loadSemantics: "added_weight" as const,
    },
    legacy: {
      name: `T01 legacy partial ${suffix}`,
      movementPattern: "horizontal_pull" as const,
      primaryMuscles: ["back"],
      loadType: "external",
      metricType: "weight_reps" as const,
      loadSemantics: "total" as const,
    },
  };

  const exerciseIds = {} as Record<ExerciseKey, string>;
  for (const [key, definition] of Object.entries(definitions) as Array<
    [ExerciseKey, (typeof definitions)[ExerciseKey]]
  >) {
    const [row] = await db
      .insert(exercises)
      .values(definition)
      .returning({ id: exercises.id });
    exerciseIds[key] = row.id;
  }

  const [session] = await db
    .insert(workoutSessions)
    .values({
      userId: user.id,
      templateName: "T01 truthful recording",
      status: "in_progress",
      startedAt,
      timezone,
      localDate: workoutLocalDate(startedAt, timezone),
    })
    .returning({ id: workoutSessions.id });

  const sessionDefinitions = [
    {
      key: "loaded" as const,
      exerciseId: exerciseIds.loaded,
      orderIdx: 0,
      targetSets: 1,
      targetRepsMin: 5,
      targetRepsMax: 5,
      targetLoad: 100,
      targetLoadUnit: "kg" as const,
    },
    {
      key: "bodyweightSubstitution" as const,
      exerciseId: exerciseIds.bodyweightSubstitution,
      orderIdx: 1,
      targetSets: 1,
      targetRepsMin: 8,
      targetRepsMax: 8,
      targetLoad: 40,
      targetLoadUnit: "lb" as const,
      modificationType: "substituted" as const,
      substitutedForExerciseId: exerciseIds.plannedSubstitution,
      substitutionReason: "equipment_busy" as const,
      substitutedAt: startedAt,
    },
    {
      key: "assisted" as const,
      exerciseId: exerciseIds.assisted,
      orderIdx: 2,
      targetSets: 1,
      targetRepsMin: 6,
      targetRepsMax: 6,
    },
    {
      key: "duration" as const,
      exerciseId: exerciseIds.duration,
      orderIdx: 3,
      targetSets: 1,
    },
    {
      key: "distance" as const,
      exerciseId: exerciseIds.distance,
      orderIdx: 4,
      targetSets: 1,
    },
    {
      key: "activity" as const,
      exerciseId: exerciseIds.activity,
      orderIdx: 5,
      targetSets: 1,
    },
    {
      key: "loadedDuration" as const,
      exerciseId: exerciseIds.loadedDuration,
      orderIdx: 6,
      targetSets: 1,
    },
  ];
  const sessionExerciseIds = {} as Record<SessionExerciseKey, string>;
  for (const definition of sessionDefinitions) {
    const { key, ...values } = definition;
    const [row] = await db
      .insert(sessionExercises)
      .values({ sessionId: session.id, ...values })
      .returning({ id: sessionExercises.id });
    sessionExerciseIds[key] = row.id;
  }

  await db.insert(sessionOccurrences).values(
    sessionDefinitions.map((definition, sequenceIdx) => ({
      sessionId: session.id,
      sessionExerciseId: sessionExerciseIds[definition.key],
      kind: "working_set",
      origin: "planned",
      sequenceIdx,
      kindOrdinal: 0,
      plannedExerciseId:
        definition.key === "bodyweightSubstitution"
          ? exerciseIds.plannedSubstitution
          : definition.exerciseId,
      plannedRepsMin:
        "targetRepsMin" in definition ? definition.targetRepsMin ?? null : null,
      plannedRepsMax:
        "targetRepsMax" in definition ? definition.targetRepsMax ?? null : null,
      plannedLoad:
        "targetLoad" in definition ? definition.targetLoad ?? null : null,
      plannedLoadUnit:
        "targetLoadUnit" in definition
          ? definition.targetLoadUnit ?? null
          : null,
      plannedRestSec: 90,
    })),
  );

  const [legacySession] = await db
    .insert(workoutSessions)
    .values({
      userId: user.id,
      templateName: "T01 legacy partial",
      status: "completed",
      startedAt: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000),
      finishedAt: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
      timezone,
      localDate: workoutLocalDate(
        new Date(startedAt.getTime() - 24 * 60 * 60 * 1000),
        timezone,
      ),
      source: "tracker",
    })
    .returning({ id: workoutSessions.id });
  const [legacySessionExercise] = await db
    .insert(sessionExercises)
    .values({
      sessionId: legacySession.id,
      exerciseId: exerciseIds.legacy,
      orderIdx: 0,
      targetSets: 1,
      targetRepsMin: 8,
      targetRepsMax: 12,
    })
    .returning({ id: sessionExercises.id });
  const [legacySet] = await db
    .insert(completedSets)
    .values({
      sessionExerciseId: legacySessionExercise.id,
      setNo: 1,
      weight: 50,
      weightUnit: "lb",
      reps: 10,
      metricType: "weight_reps",
      performedSemanticsVersion: null,
      performedLoadType: null,
      performedLoadSemantics: null,
      targetMet: null,
      clientKey: "v2-t01-legacy-partial",
    })
    .returning({ id: completedSets.id });
  await db.insert(sessionOccurrences).values({
    sessionId: legacySession.id,
    sessionExerciseId: legacySessionExercise.id,
    kind: "working_set",
    origin: "legacy",
    sequenceIdx: 0,
    kindOrdinal: 0,
    plannedExerciseId: exerciseIds.legacy,
    outcome: "completed",
    revision: 1,
    resolvedAt: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000 + 10 * 60 * 1000),
    completedSetId: legacySet.id,
  });

  const common = {
    performedSemanticsVersion: 1 as const,
    setNo: 1,
    rpe: null,
    note: null,
    equipmentSnapshotId: null,
    loadEntryMeaning: "legacy_unknown" as const,
    observedCompletedAtISO: observedAt,
  };
  const commands = {
    loaded: {
      ...common,
      clientKey: "v2-t01-loaded",
      sessionExerciseId: sessionExerciseIds.loaded,
      performedExerciseId: exerciseIds.loaded,
      performedLoadType: "dumbbell",
      performedLoadSemantics: "total" as const,
      metricType: "weight_reps" as const,
      weight: 100,
      weightUnit: "kg" as const,
      reps: 5,
      distanceKm: null,
      durationSeconds: null,
    },
    bodyweightSubstitution: {
      ...common,
      clientKey: "v2-t01-bodyweight-substitution",
      sessionExerciseId: sessionExerciseIds.bodyweightSubstitution,
      performedExerciseId: exerciseIds.bodyweightSubstitution,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight" as const,
      metricType: "reps" as const,
      weight: null,
      weightUnit: null,
      reps: 8,
      distanceKm: null,
      durationSeconds: null,
    },
    assisted: {
      ...common,
      clientKey: "v2-t01-assisted",
      sessionExerciseId: sessionExerciseIds.assisted,
      performedExerciseId: exerciseIds.assisted,
      performedLoadType: "external",
      performedLoadSemantics: "assistance" as const,
      metricType: "assisted_reps" as const,
      weight: 25,
      weightUnit: "kg" as const,
      reps: 6,
      distanceKm: null,
      durationSeconds: null,
    },
    duration: {
      ...common,
      clientKey: "v2-t01-duration",
      sessionExerciseId: sessionExerciseIds.duration,
      performedExerciseId: exerciseIds.duration,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight" as const,
      metricType: "duration" as const,
      weight: null,
      weightUnit: null,
      reps: null,
      distanceKm: null,
      durationSeconds: 45,
    },
    distance: {
      ...common,
      clientKey: "v2-t01-distance",
      sessionExerciseId: sessionExerciseIds.distance,
      performedExerciseId: exerciseIds.distance,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight" as const,
      metricType: "distance_duration" as const,
      weight: null,
      weightUnit: null,
      reps: null,
      distanceKm: 1.2,
      durationSeconds: 600,
    },
  } satisfies T01RecordingTruthFixture["commands"];

  return {
    userId: user.id,
    sessionId: session.id,
    legacySessionId: legacySession.id,
    legacySetId: legacySet.id,
    exerciseIds,
    sessionExerciseIds,
    commands,
  };
}

export async function recordT01SupportedSets(
  db: Db,
  fixture: T01RecordingTruthFixture,
) {
  const results = {} as Record<keyof T01RecordingTruthFixture["commands"], {
    setId: string;
    occurrenceId: string;
  }>;
  for (const [key, command] of Object.entries(fixture.commands) as Array<
    [keyof T01RecordingTruthFixture["commands"], LogWorkoutSetInput]
  >) {
    const result = await logWorkoutSet(db, fixture.userId, command);
    if (result.outcome !== "saved") {
      throw new Error(`T01 ${key} fixture was not saved: ${result.outcome}`);
    }
    results[key] = { setId: result.setId, occurrenceId: result.occurrenceId };
  }
  return results;
}

export async function completeT01Workout(
  db: Db,
  fixture: T01RecordingTruthFixture,
) {
  await db
    .update(workoutSessions)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(workoutSessions.id, fixture.sessionId));
}
