import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";

export const SUPPORTED_WORKOUT_REPLACEMENT_METRICS = [
  "weight_reps",
  "reps",
  "assisted_reps",
] as const;

export type SupportedWorkoutReplacementMetric =
  (typeof SUPPORTED_WORKOUT_REPLACEMENT_METRICS)[number];

export function workoutReplacementUnavailableReason(
  item: ExerciseDiscoveryItem,
): string | null {
  if (
    (item.activityClass != null && item.activityClass !== "strength") ||
    ["conditioning", "locomotion", "mobility", "stretch"].includes(
      item.movementPattern,
    )
  ) {
    return "This workout runner does not yet support this exercise type truthfully.";
  }
  if (
    !SUPPORTED_WORKOUT_REPLACEMENT_METRICS.includes(
      item.metricType as SupportedWorkoutReplacementMetric,
    )
  ) {
    return "This exercise uses duration, distance, or activity tracking that this workout runner does not yet support.";
  }
  if (item.constraintBlocked) {
    return "Blocked by your current safety constraints.";
  }
  return null;
}

export function workoutReplacementEquipmentWarning(
  item: ExerciseDiscoveryItem,
): string | null {
  if ((item.missingEquipment?.length ?? 0) === 0) return null;
  return `${item.unavailableReason ?? "Required equipment is not marked available."} You can still replace the exercise, but the workout will not invent or reuse an incompatible setup.`;
}
