import type { TodayData } from "@/services/today";

export function occurrenceTitle(occurrence: TodayData["inProgressOccurrences"][number]) {
  if (occurrence.kind === "day_warmup") {
    return occurrence.label ?? "Day warm-up";
  }
  if (occurrence.kind === "exercise_warmup") {
    return `${occurrence.plannedExerciseName ?? "Exercise"} warm-up${
      occurrence.label ? ` — ${occurrence.label}` : ""
    }`;
  }
  return `${occurrence.plannedExerciseName ?? "Exercise"} · set ${
    occurrence.kindOrdinal + 1
  }`;
}

export function occurrencePrescription(
  occurrence: TodayData["inProgressOccurrences"][number],
  { includeRest = true }: { includeRest?: boolean } = {},
) {
  const details: string[] = [];
  if (occurrence.plannedRepsMin != null) {
    details.push(
      occurrence.plannedRepsMax != null &&
        occurrence.plannedRepsMax !== occurrence.plannedRepsMin
        ? `${occurrence.plannedRepsMin}–${occurrence.plannedRepsMax} reps`
        : `${occurrence.plannedRepsMin} reps`,
    );
  }
  if (occurrence.plannedLoad != null && occurrence.plannedLoadUnit) {
    details.push(`${occurrence.plannedLoad} ${occurrence.plannedLoadUnit}`);
  } else if (occurrence.plannedLoadPercent != null) {
    details.push(`${occurrence.plannedLoadPercent}% of work weight`);
  } else if (occurrence.plannedLoadText) {
    details.push(occurrence.plannedLoadText);
  }
  if (occurrence.groupRound != null) {
    details.push(
      `group round ${occurrence.groupRound}, member ${(occurrence.groupMemberOrderIdx ?? 0) + 1}`,
    );
  }
  if (includeRest && occurrence.plannedRestSec != null) {
    details.push(`${occurrence.plannedRestSec}s rest after`);
  }
  return details.join(" · ");
}

export function resumeUpNext(occurrence: TodayData["inProgressOccurrences"][number]) {
  return {
    title: occurrenceTitle({
      ...occurrence,
      plannedExerciseName: occurrence.currentExerciseName ?? occurrence.plannedExerciseName,
    }),
    // Frozen targets belong to the planned movement, never its replacement.
    detail: occurrence.currentExerciseId === occurrence.plannedExerciseId
      ? occurrencePrescription(occurrence, { includeRest: false }) || null
      : null,
  };
}
