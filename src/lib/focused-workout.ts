/** Presentation only. The occurrence ledger still owns current/next work. */
export function exerciseVisibleInWorkoutView(input: {
  view: "focused" | "overview";
  exerciseId: string;
  currentExerciseId: string | null;
  recoveryExerciseId: string | null;
  needsEquipmentDecision: boolean;
  needsSaveRecovery?: boolean;
}) {
  return input.view === "overview" || input.currentExerciseId == null ||
    input.exerciseId === input.currentExerciseId ||
    input.exerciseId === input.recoveryExerciseId || input.needsEquipmentDecision ||
    input.needsSaveRecovery === true;
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
