import type { ExerciseVariantAttributes } from "@/db/schema/exercise";

/**
 * The single equipment/assistance gate between a source exercise name and a
 * catalog exercise. The matcher, the import confirmation gate, and the review
 * UI must all agree on this judgement, so they all call this one predicate.
 */
export type CompatCheckExercise = {
  equipment: string[];
  loadType: string;
  loadSemantics: string;
  metricType: string;
  variantAttributes?: ExerciseVariantAttributes | null;
};

export type CompatCheckHints = {
  equipment: string | null;
  assistance: "assisted" | "weighted" | null;
};

export function exerciseMatchesIdentityHints(
  exercise: CompatCheckExercise,
  hints: CompatCheckHints
): boolean {
  if (hints.equipment) {
    const compatible =
      exercise.equipment.includes(hints.equipment) ||
      exercise.loadType === hints.equipment ||
      (hints.equipment === "bodyweight" && exercise.loadSemantics === "bodyweight");
    if (!compatible) return false;
  }

  const assistance = exercise.variantAttributes?.assistance;
  if (hints.assistance === "assisted") {
    return (
      exercise.metricType === "assisted_reps" ||
      exercise.loadSemantics === "assistance" ||
      assistance === "assisted"
    );
  }
  if (hints.assistance === "weighted") {
    return exercise.loadSemantics === "added_weight" || assistance === "weighted";
  }
  return true;
}
