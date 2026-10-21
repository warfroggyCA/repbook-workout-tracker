import type { ActiveSetRowProjection } from "@/lib/active-set-row-projection";

/** Use the ledger's evidence classification rather than interpreting saved results again. */
export function activeSetEvidenceNeedsReview(projection: ActiveSetRowProjection) {
  return projection.rows.some((row) =>
    row.state === "completed_without_result" || row.state === "unknown_legacy",
  ) || projection.diagnostics.unlinkedSetIds.length > 0 ||
    projection.diagnostics.duplicateSetIds.length > 0 ||
    projection.diagnostics.contradictoryOccurrenceIds.length > 0;
}

/** Presentation only. The occurrence ledger still owns current/next work. */
export function exerciseVisibleInWorkoutView(input: {
  view: "focused" | "overview";
  exerciseId: string;
  currentExerciseId: string | null;
  recoveryExerciseId: string | null;
  needsEquipmentDecision: boolean;
  needsSaveRecovery?: boolean;
  ledgerProjection: ActiveSetRowProjection;
}) {
  return input.view === "overview" || input.currentExerciseId == null ||
    input.exerciseId === input.currentExerciseId ||
    input.exerciseId === input.recoveryExerciseId || input.needsEquipmentDecision ||
    input.needsSaveRecovery === true || activeSetEvidenceNeedsReview(input.ledgerProjection);
}

/** Never infer paired implements, or reinterpret old loads from display names. */
export function handheldLoadPresentation(input: {
  loadType: string;
  loadSemantics: string;
}): { label: string; explanation: string } | null {
  if (input.loadType !== "dumbbell" && input.loadType !== "kettlebell") return null;
  const implement = input.loadType === "dumbbell" ? "dumbbell" : "kettlebell";
  if (input.loadSemantics === "per_implement") {
    return {
      label: `Weight per ${implement}`,
      explanation: `Enter one ${implement}’s weight. Do not add a pair together.`,
    };
  }
  if (input.loadSemantics === "total") {
    return {
      label: "Total weight",
      explanation: "This exercise uses total weight. A per-hand amount is not calculated.",
    };
  }
  return {
    label: "Recorded weight",
    explanation: "The weight convention is unclear. No per-hand or combined amount is calculated.",
  };
}
