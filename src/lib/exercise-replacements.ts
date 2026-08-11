import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import {
  isSupportedSetWriterSemanticDefinition,
  SUPPORTED_SET_WRITER_METRICS,
  type PerformedMetricType,
  type SupportedSetWriterMetric,
} from "@/lib/set-metric-semantics";

export function workoutReplacementUnavailableReason(
  item: ExerciseDiscoveryItem,
): string | null {
  if (
    !SUPPORTED_SET_WRITER_METRICS.includes(
      item.metricType as SupportedSetWriterMetric,
    )
  ) {
    return "Independent activity-only observations use the activity flow rather than workout sets.";
  }
  if (
    (item.metricType === "duration" || item.metricType === "distance_duration") &&
    item.loadSemantics !== "none" &&
    item.loadSemantics !== "bodyweight"
  ) {
    return "This exercise needs load plus time or distance, a combined performed shape the workout runner cannot yet represent truthfully.";
  }
  if (!isSupportedSetWriterSemanticDefinition({
    metricType: item.metricType as PerformedMetricType,
    loadSemantics: item.loadSemantics,
  })) {
    return "This exercise has an inconsistent performed-measurement definition and cannot be recorded truthfully.";
  }
  if (item.constraintBlocked) {
    return "Blocked by your current safety constraints.";
  }
  if (
    item.equipmentFitStatus !== "compatible" &&
    item.equipmentFitStatus !== "not_required"
  ) {
    return item.equipmentFitReason ??
      "No current owner-reviewed equipment fit proves that this replacement can be performed.";
  }
  if (!item.available) {
    return item.unavailableReason ?? "Required equipment is not currently available.";
  }
  return null;
}

export function workoutReplacementEquipmentWarning(
  item: ExerciseDiscoveryItem,
): string | null {
  // PII-01B makes equipment fit a hard proposal boundary. This helper remains
  // for callers that display legacy warnings, but it cannot soften an unknown
  // or incompatible stable-ID relation into a selectable replacement.
  if (!item.available) return null;
  if ((item.missingEquipment?.length ?? 0) === 0) return null;
  return `${item.unavailableReason ?? "Required equipment is not marked available."} You can still replace the exercise, but the workout will not invent or reuse an incompatible setup.`;
}
