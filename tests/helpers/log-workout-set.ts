import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { sessionExercises } from "@/db/schema";
import {
  resolveFutureSetWriterMetricType,
  type PerformedLoadSemantics,
} from "@/lib/set-metric-semantics";
import {
  logWorkoutSet as logTruthfulWorkoutSet,
  type LogWorkoutSetInput,
  type SessionLifecycleDependencies,
} from "@/services/session-lifecycle";
import type { LoadUnit } from "@/lib/units";

type CharacterizationSetInput = {
  sessionExerciseId: string;
  setNo: number;
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  distanceKm?: number | null;
  durationSeconds?: number | null;
  rpe?: number | null;
  isWarmup?: boolean;
  note?: string | null;
  clientKey: string;
  equipmentSnapshotId?: string | null;
  loadEntryMeaning?: LogWorkoutSetInput["loadEntryMeaning"];
  observedCompletedAtISO?: string | null;
};

/**
 * Existing lifecycle characterization calls predate T01's device command.
 * This test-only adapter reads the same active performed-exercise definition
 * the page renders, freezes it into the new command, and then invokes the real
 * service. It never operates on completed history and is not a production
 * writer or compatibility fallback.
 */
export async function logWorkoutSet(
  db: Db,
  userId: string,
  input: CharacterizationSetInput,
  dependencies: SessionLifecycleDependencies = {},
) {
  const sessionExercise = await db.query.sessionExercises.findFirst({
    where: eq(sessionExercises.id, input.sessionExerciseId),
    with: { exercise: true, session: true },
  });
  if (!sessionExercise || sessionExercise.session.userId !== userId) {
    // Preserve the real service's owner-scoped not-found behavior without
    // fabricating performed evidence for an invisible row.
    return logTruthfulWorkoutSet(
      db,
      userId,
      {
        ...input,
        performedExerciseId: crypto.randomUUID(),
        performedSemanticsVersion: 1,
        performedLoadType: "unknown",
        performedLoadSemantics: "none",
        metricType: "weight_reps",
        distanceKm: null,
        durationSeconds: null,
      } as LogWorkoutSetInput,
      dependencies,
    );
  }
  const metricType = resolveFutureSetWriterMetricType({
    metricType: sessionExercise.exercise.metricType,
    loadSemantics: sessionExercise.exercise.loadSemantics,
  });
  return logTruthfulWorkoutSet(
    db,
    userId,
    {
      ...input,
      performedExerciseId: sessionExercise.exerciseId,
      performedSemanticsVersion: 1,
      performedLoadType: sessionExercise.exercise.loadType,
      performedLoadSemantics:
        sessionExercise.exercise.loadSemantics as PerformedLoadSemantics,
      metricType,
      distanceKm: input.distanceKm ?? null,
      durationSeconds: input.durationSeconds ?? null,
    } as LogWorkoutSetInput,
    dependencies,
  );
}
