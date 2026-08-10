import "server-only";

import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { sessionExercises } from "@/db/schema";
import {
  rankExerciseAlternatives,
  type ExerciseAlternativeAnnotation,
} from "@/lib/exercise-alternatives";
import { getExerciseDiscoveryLibrary } from "@/services/exercise-discovery";

export type ExerciseAlternativeOptions = {
  currentExerciseId: string;
  plannedExerciseId: string;
  plannedExerciseName: string;
  plannedExercise: Awaited<ReturnType<typeof getExerciseDiscoveryLibrary>>[number];
  items: Awaited<ReturnType<typeof getExerciseDiscoveryLibrary>>;
  priorityIds: string[];
  annotations: Record<string, ExerciseAlternativeAnnotation>;
};

export async function getExerciseAlternativeOptions(
  db: Db,
  userId: string,
  sessionExerciseId: string
): Promise<ExerciseAlternativeOptions> {
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

  const ranked = rankExerciseAlternatives(
    planned,
    library.filter(
      (item) =>
        item.id !== sessionExercise.exerciseId &&
        item.id !== plannedExerciseId
    )
  );
  const rankedById = new Map(ranked.map((candidate) => [candidate.item.id, candidate]));
  const annotations = Object.fromEntries(
    ranked.map((candidate) => [candidate.item.id, candidate.annotation])
  );

  const items = library.map((item) => {
    const candidate = rankedById.get(item.id);
    const isCurrent = item.id === sessionExercise.exerciseId;
    const isPlanned = item.id === plannedExerciseId;
    const trackingCompatible = item.metricType === planned.metricType;
    const selectable =
      Boolean(candidate) &&
      item.available &&
      trackingCompatible &&
      !isCurrent &&
      !isPlanned;
    const unavailableReason = isCurrent
      ? "Already selected for this workout"
      : isPlanned && sessionExercise.substitutedForExerciseId
        ? "Use Undo to return to the planned exercise"
        : !candidate
          ? "Not close enough to the planned exercise for this workout"
          : !trackingCompatible
            ? "Uses a different tracking method from the planned exercise"
          : item.unavailableReason;
    return {
      ...item,
      available: selectable,
      unavailableReason: selectable ? null : unavailableReason,
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
    plannedExercise: planned,
    items,
    priorityIds: ranked
      .filter(
        (candidate) =>
          candidate.item.available &&
          candidate.item.metricType === planned.metricType
      )
      .map((candidate) => candidate.item.id),
    annotations,
  };
}

export async function requireActiveOwnedSessionExercise(
  db: Db,
  userId: string,
  sessionExerciseId: string
) {
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
  return sessionExercise;
}
