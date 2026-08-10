import {
  PERFORMED_LOAD_SEMANTICS,
  SUPPORTED_SET_WRITER_METRICS,
  isSupportedSetWriterSemanticDefinition,
  validateSetWriterShape,
  type PerformedLoadSemantics,
  type PerformedMetricType,
  type SetLoadEntryMeaning,
  type SupportedSetWriterMetric,
} from "@/lib/set-metric-semantics";
import type { LoadUnit } from "@/lib/units";

export type ComparableSetSemantics = {
  exerciseId: string;
  performedSemanticsVersion: number | null;
  metricType: PerformedMetricType;
  performedLoadType: string | null;
  performedLoadSemantics: PerformedLoadSemantics | null;
  loadEntryMeaning: SetLoadEntryMeaning | null;
  equipmentProfileKind?: string | null;
  equipmentConfigurationHash?: string | null;
};

export type ComparableSetMeasurement = {
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
};

export type PreviousSetComparisonReason =
  | "exercise_identity_mismatch"
  | "unsupported_semantics_version"
  | "incomplete_semantics"
  | "unsupported_metric"
  | "metric_mismatch"
  | "load_type_mismatch"
  | "load_semantics_mismatch"
  | "load_entry_meaning_unavailable"
  | "load_entry_meaning_mismatch"
  | "equipment_evidence_unavailable"
  | "equipment_configuration_mismatch"
  | "invalid_measurement_shape"
  | "incompatible_load_unit";

export type PreviousSetComparison =
  | { comparable: true }
  | { comparable: false; reason: PreviousSetComparisonReason };

function supportedMetric(
  metricType: PerformedMetricType,
): metricType is SupportedSetWriterMetric {
  return SUPPORTED_SET_WRITER_METRICS.includes(
    metricType as SupportedSetWriterMetric,
  );
}

function completeSemantics(
  semantics: ComparableSetSemantics,
): semantics is ComparableSetSemantics & {
  performedSemanticsVersion: 1;
  performedLoadType: string;
  performedLoadSemantics: PerformedLoadSemantics;
} {
  return (
    semantics.performedSemanticsVersion === 1 &&
    typeof semantics.performedLoadType === "string" &&
    semantics.performedLoadType.trim().length > 0 &&
    semantics.performedLoadSemantics != null &&
    PERFORMED_LOAD_SEMANTICS.includes(semantics.performedLoadSemantics)
  );
}

function metricUsesNumericLoad(metricType: PerformedMetricType) {
  return metricType === "weight_reps" || metricType === "assisted_reps";
}

function requiresExactEquipment(
  semantics: ComparableSetSemantics,
) {
  return semantics.performedLoadSemantics === "machine_stack" ||
    semantics.equipmentProfileKind === "cable_machine" ||
    semantics.equipmentProfileKind === "plate_loaded_machine";
}

/**
 * `lb` and `kg` are compatible because Repbook has one named, tested
 * conversion boundary. A missing unit is never treated as compatible with a
 * numeric load.
 */
export function areComparableLoadUnits(
  left: LoadUnit | null,
  right: LoadUnit | null,
) {
  if (left == null || right == null) return left === right;
  return (left === "lb" || left === "kg") && (right === "lb" || right === "kg");
}

/**
 * Proves that a historical set can be shown as previous-set evidence for the
 * current logging point. The proof uses only exact exercise identity and the
 * immutable performed-semantics tuple captured on the historical set. It does
 * not use display names, Program slots, or mutable catalog metadata.
 */
export function comparePreviousPerformedSet(input: {
  target: ComparableSetSemantics;
  candidate: ComparableSetSemantics & ComparableSetMeasurement;
  targetLoadUnit?: LoadUnit | null;
}): PreviousSetComparison {
  const { target, candidate } = input;
  if (target.exerciseId !== candidate.exerciseId) {
    return { comparable: false, reason: "exercise_identity_mismatch" };
  }
  if (
    target.performedSemanticsVersion !== 1 ||
    candidate.performedSemanticsVersion !== 1
  ) {
    return { comparable: false, reason: "unsupported_semantics_version" };
  }
  if (!completeSemantics(target) || !completeSemantics(candidate)) {
    return { comparable: false, reason: "incomplete_semantics" };
  }
  if (!supportedMetric(target.metricType) || !supportedMetric(candidate.metricType)) {
    return { comparable: false, reason: "unsupported_metric" };
  }
  if (
    !isSupportedSetWriterSemanticDefinition({
      metricType: target.metricType,
      loadSemantics: target.performedLoadSemantics,
    }) ||
    !isSupportedSetWriterSemanticDefinition({
      metricType: candidate.metricType,
      loadSemantics: candidate.performedLoadSemantics,
    })
  ) {
    return { comparable: false, reason: "unsupported_metric" };
  }
  if (target.metricType !== candidate.metricType) {
    return { comparable: false, reason: "metric_mismatch" };
  }
  if (target.performedLoadType !== candidate.performedLoadType) {
    return { comparable: false, reason: "load_type_mismatch" };
  }
  if (target.performedLoadSemantics !== candidate.performedLoadSemantics) {
    return { comparable: false, reason: "load_semantics_mismatch" };
  }
  if (requiresExactEquipment(target) || requiresExactEquipment(candidate)) {
    if (
      target.equipmentProfileKind == null ||
      target.equipmentConfigurationHash == null ||
      candidate.equipmentProfileKind == null ||
      candidate.equipmentConfigurationHash == null
    ) {
      return {
        comparable: false,
        reason: "equipment_evidence_unavailable",
      };
    }
    if (
      target.equipmentProfileKind !== candidate.equipmentProfileKind ||
      target.equipmentConfigurationHash !==
        candidate.equipmentConfigurationHash
    ) {
      return {
        comparable: false,
        reason: "equipment_configuration_mismatch",
      };
    }
  }
  if (metricUsesNumericLoad(target.metricType)) {
    if (
      target.loadEntryMeaning == null ||
      target.loadEntryMeaning === "legacy_unknown" ||
      candidate.loadEntryMeaning == null ||
      candidate.loadEntryMeaning === "legacy_unknown"
    ) {
      return {
        comparable: false,
        reason: "load_entry_meaning_unavailable",
      };
    }
    if (target.loadEntryMeaning !== candidate.loadEntryMeaning) {
      return { comparable: false, reason: "load_entry_meaning_mismatch" };
    }
  }

  const shape = validateSetWriterShape({
    metricType: candidate.metricType,
    loadSemantics: candidate.performedLoadSemantics,
    weight: candidate.weight,
    weightUnit: candidate.weightUnit,
    reps: candidate.reps,
    distanceKm: candidate.distanceKm,
    durationSeconds: candidate.durationSeconds,
  });
  if (!shape.ok) {
    return { comparable: false, reason: "invalid_measurement_shape" };
  }
  if (
    metricUsesNumericLoad(target.metricType) &&
    !areComparableLoadUnits(input.targetLoadUnit ?? candidate.weightUnit, candidate.weightUnit)
  ) {
    return { comparable: false, reason: "incompatible_load_unit" };
  }
  return { comparable: true };
}
