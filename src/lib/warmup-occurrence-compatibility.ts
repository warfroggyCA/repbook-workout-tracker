import { hasGeneratedOverviewWarmupItems } from "@/lib/program-document";

type WarmupItem = {
  key: string;
  label: string;
  reps: number | null;
  load: number | null;
  loadUnit: "lb" | "kg" | null;
  loadPercent: number | null;
  loadText: string | null;
  notes: string | null;
};

type WarmupOccurrence = {
  id: string;
  sessionExerciseId: string | null;
  kind: string;
  kindOrdinal: number;
  label: string | null;
  plannedRepsMin: number | null;
  plannedRepsMax: number | null;
  plannedLoad: number | null;
  plannedLoadUnit: string | null;
  plannedLoadPercent: number | null;
  plannedLoadText: string | null;
  plannedRestSec: number | null;
  plannedNote: string | null;
  outcome: string;
};

type ExerciseWarmupSnapshot = {
  id: string;
  warmupNotes: string | null;
  warmupSets: readonly unknown[];
};

/**
 * A pre-occurrence migration projected free-text guidance into warm-up rows so
 * old sessions retained visible evidence. Those rows stay stored, but a still-
 * pending projection is not an authored action and must not become checkable
 * evidence after T04.
 */
export function actionableActiveSessionOccurrences<
  TOccurrence extends WarmupOccurrence,
>(input: {
  sessionId: string;
  templateId: string | null;
  sourceDayLineageId: string | null;
  dayWarmupNotes: string | null;
  dayWarmupItems: WarmupItem[];
  exercises: ExerciseWarmupSnapshot[];
  occurrences: TOccurrence[];
}): TOccurrence[] {
  const dayOverviewWasProjected = hasGeneratedOverviewWarmupItems(
    {
      lineageId: input.sourceDayLineageId ?? input.sessionId,
      warmupNotes: input.dayWarmupNotes,
      warmupItems: input.dayWarmupItems,
    },
    [input.sessionId, ...(input.templateId ? [input.templateId] : [])],
  );
  const exerciseById = new Map(
    input.exercises.map((exercise) => [exercise.id, exercise]),
  );
  const exerciseWarmupCounts = new Map<string, number>();
  for (const occurrence of input.occurrences) {
    if (
      occurrence.kind !== "exercise_warmup" ||
      occurrence.sessionExerciseId == null
    ) continue;
    exerciseWarmupCounts.set(
      occurrence.sessionExerciseId,
      (exerciseWarmupCounts.get(occurrence.sessionExerciseId) ?? 0) + 1,
    );
  }

  return input.occurrences.filter((occurrence) => {
    if (occurrence.outcome !== "pending") return true;
    if (occurrence.kind === "day_warmup") {
      return !dayOverviewWasProjected;
    }
    if (
      occurrence.kind !== "exercise_warmup" ||
      occurrence.sessionExerciseId == null
    ) return true;
    const exercise = exerciseById.get(occurrence.sessionExerciseId);
    if (!exercise?.warmupNotes) return true;
    const hasExtraOverviewOccurrence =
      (exerciseWarmupCounts.get(exercise.id) ?? 0) >
      exercise.warmupSets.length;
    const isPlainOverviewProjection =
      occurrence.kindOrdinal === 0 &&
      occurrence.label === exercise.warmupNotes &&
      occurrence.plannedRepsMin == null &&
      occurrence.plannedRepsMax == null &&
      occurrence.plannedLoad == null &&
      occurrence.plannedLoadUnit == null &&
      occurrence.plannedLoadPercent == null &&
      occurrence.plannedLoadText == null &&
      occurrence.plannedRestSec == null &&
      occurrence.plannedNote == null;
    return !(hasExtraOverviewOccurrence && isPlainOverviewProjection);
  });
}
