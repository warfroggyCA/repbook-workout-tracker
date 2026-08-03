import "server-only";

import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { sessionExercises } from "@/db/schema";
import {
  workoutReplacementEquipmentWarning,
  workoutReplacementUnavailableReason,
} from "@/lib/exercise-replacements";
import { getExerciseDiscoveryLibrary } from "@/services/exercise-discovery";

type SessionExerciseRow = typeof sessionExercises.$inferSelect;

export type ExerciseReplacementOptions = {
  currentExerciseId: string;
  plannedExerciseId: string;
  plannedExerciseName: string;
  currentState: {
    modificationType: SessionExerciseRow["modificationType"];
    skipReason: SessionExerciseRow["skipReason"];
    substitutedForExerciseId: string | null;
    substitutionReason: SessionExerciseRow["substitutionReason"];
    substitutedAt: string | null;
    targetLoad: number | null;
    targetLoadUnit: SessionExerciseRow["targetLoadUnit"];
    notes: string | null;
    warmupNotes: string | null;
    warmupSets: SessionExerciseRow["warmupSets"];
    setNotes: SessionExerciseRow["setNotes"];
  };
  items: Awaited<ReturnType<typeof getExerciseDiscoveryLibrary>>;
  warnings: Record<string, string>;
};

export async function getExerciseReplacementOptions(
  db: Db,
  userId: string,
  sessionExerciseId: string,
): Promise<ExerciseReplacementOptions> {
  const sessionExercise = await db.query.sessionExercises.findFirst({
    where: eq(sessionExercises.id, sessionExerciseId),
    with: { session: true },
  });
  if (
    !sessionExercise ||
    sessionExercise.session.userId !== userId ||
    sessionExercise.session.status !== "in_progress" ||
    sessionExercise.session.archivedAt != null
  ) {
    throw new Error("The workout exercise is no longer available.");
  }

  const library = await getExerciseDiscoveryLibrary(db, userId);
  const plannedExerciseId =
    sessionExercise.substitutedForExerciseId ?? sessionExercise.exerciseId;
  const planned = library.find((item) => item.id === plannedExerciseId);
  if (!planned) throw new Error("The planned exercise is no longer available.");

  const warnings: Record<string, string> = {};
  const items = library.map((item) => {
    const hardReason = workoutReplacementUnavailableReason(item);
    const equipmentWarning = workoutReplacementEquipmentWarning(item);
    const unavailableReason =
      item.id === sessionExercise.exerciseId
        ? "Already selected for this workout"
        : item.id === plannedExerciseId && sessionExercise.substitutedForExerciseId
          ? "Use Undo to return to the originally planned exercise"
          : hardReason;
    if (equipmentWarning && unavailableReason == null) {
      warnings[item.id] = equipmentWarning;
    }
    return {
      ...item,
      available: unavailableReason == null,
      unavailableReason,
    };
  });

  return {
    currentExerciseId: sessionExercise.exerciseId,
    plannedExerciseId,
    plannedExerciseName:
      sessionExercise.prescribedSemanticsVersion === 1 &&
      sessionExercise.prescribedExerciseName
        ? sessionExercise.prescribedExerciseName
        : planned.name,
    currentState: {
      modificationType: sessionExercise.modificationType,
      skipReason: sessionExercise.skipReason,
      substitutedForExerciseId: sessionExercise.substitutedForExerciseId,
      substitutionReason: sessionExercise.substitutionReason,
      substitutedAt: sessionExercise.substitutedAt?.toISOString() ?? null,
      targetLoad: sessionExercise.targetLoad,
      targetLoadUnit: sessionExercise.targetLoadUnit,
      notes: sessionExercise.notes,
      warmupNotes: sessionExercise.warmupNotes,
      warmupSets: sessionExercise.warmupSets,
      setNotes: sessionExercise.setNotes,
    },
    items,
    warnings,
  };
}
