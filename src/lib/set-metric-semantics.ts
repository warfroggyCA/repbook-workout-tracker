import { convertWeight, type LoadUnit } from "@/lib/units";

export const PERFORMED_METRIC_TYPES = [
  "weight_reps",
  "reps",
  "assisted_reps",
  "duration",
  "weight_duration_per_side",
  "distance_duration",
  "activity",
] as const;

export type PerformedMetricType = (typeof PERFORMED_METRIC_TYPES)[number];

export const PERFORMED_LOAD_SEMANTICS = [
  "total",
  "per_implement",
  "bodyweight",
  "added_weight",
  "assistance",
  "machine_stack",
  "resistance_band",
  "none",
] as const;

export type PerformedLoadSemantics =
  (typeof PERFORMED_LOAD_SEMANTICS)[number];

export const SUPPORTED_SET_WRITER_METRICS = [
  "weight_reps",
  "reps",
  "assisted_reps",
  "duration",
  "weight_duration_per_side",
  "distance_duration",
] as const;

export type SupportedSetWriterMetric =
  (typeof SUPPORTED_SET_WRITER_METRICS)[number];

export function isSupportedSetWriterSemanticDefinition(input: {
  metricType: PerformedMetricType;
  loadSemantics?: string | null;
}) {
  if (!SUPPORTED_SET_WRITER_METRICS.includes(
    input.metricType as SupportedSetWriterMetric,
  )) return false;
  if (
    input.loadSemantics != null &&
    !PERFORMED_LOAD_SEMANTICS.includes(
      input.loadSemantics as PerformedLoadSemantics,
    )
  ) return false;
  if (
    (input.loadSemantics === "assistance") !==
    (input.metricType === "assisted_reps")
  ) return false;
  if (input.metricType === "weight_duration_per_side") {
    return input.loadSemantics === "per_implement" || input.loadSemantics === "total";
  }
  return !(
    (input.metricType === "duration" ||
      input.metricType === "distance_duration") &&
    input.loadSemantics !== "none" &&
    input.loadSemantics !== "bodyweight"
  );
}

/**
 * The exact mutually-exclusive numeric shapes accepted by the live workout
 * writer. `activity` remains an imported/independent-activity fact and is not
 * a set command. Every branch carries explicit nulls so device storage and
 * replay compare the complete observation rather than filling omitted fields.
 */
export type PerformedSetMeasurement =
  | {
      metricType: "weight_duration_per_side";
      weight: number;
      weightUnit: LoadUnit;
      reps: null;
      distanceKm: null;
      durationSeconds: number;
    }
  | {
      metricType: "weight_reps";
      weight: number;
      weightUnit: LoadUnit;
      reps: number;
      distanceKm: null;
      durationSeconds: null;
    }
  | {
      metricType: "reps";
      weight: null;
      weightUnit: null;
      reps: number;
      distanceKm: null;
      durationSeconds: null;
    }
  | {
      metricType: "assisted_reps";
      weight: number;
      weightUnit: LoadUnit;
      reps: number;
      distanceKm: null;
      durationSeconds: null;
    }
  | {
      metricType: "duration";
      weight: null;
      weightUnit: null;
      reps: null;
      distanceKm: null;
      durationSeconds: number;
    }
  | {
      metricType: "distance_duration";
      weight: null;
      weightUnit: null;
      reps: null;
      distanceKm: number;
      durationSeconds: number | null;
    };

export type SetLoadEntryMeaning =
  | "total_system"
  | "per_loading_point"
  | "added_plates"
  | "displayed_stack"
  | "per_stack"
  | "combined_stacks"
  | "legacy_unknown";

export type SetMetricExclusionReason =
  | "source_excluded"
  | "missing_prescribed_semantics"
  | "unsupported_performed_semantics_version"
  | "incomplete_performed_semantics"
  | "metric_semantics_conflict"
  | "unsupported_metric"
  | "assistance_not_comparable"
  | "per_implement_not_aggregatable"
  | "added_weight_missing_system_load"
  | "machine_geometry_not_comparable"
  | "band_resistance_not_numeric"
  | "unproven_load_entry_meaning"
  | "unvalidated_total_system_implement"
  | "repetitions_only"
  | "missing_load_or_repetitions";

export type SetWriteRefusalReason =
  | "unsupported_metric"
  | "metric_semantics_conflict"
  | "measurement_shape_conflict"
  | "weight_reps_requires_load"
  | "reps_cannot_include_load"
  | "assisted_reps_requires_numeric_assistance"
  | "duration_requires_time"
  | "distance_duration_requires_distance";

/**
 * Resolves the metric that a new set can truthfully persist from the current
 * exercise definition. Resistance bands have no numeric load in the workout
 * UI, so their observable repetitions are stored as repetitions rather than
 * inventing a missing weight. This is a future-write rule only; readers must
 * never use current catalog metadata to relabel an existing completed set.
 */
export function resolveFutureSetWriterMetricType(input: {
  metricType: PerformedMetricType;
  loadSemantics?: string | null;
}): PerformedMetricType {
  return input.metricType === "weight_reps" &&
    input.loadSemantics === "resistance_band"
    ? "reps"
    : input.metricType;
}

export type SetMetricContainment = {
  measurementMeaning: PerformedMetricType;
  difficultyDirection:
    | "higher_load_is_harder"
    | "lower_assistance_is_harder"
    | "higher_repetitions_may_be_harder"
    | "task_specific"
    | "unknown";
  prescriptionOutcomeEligible: boolean;
  longitudinalComparable: boolean;
  loadedWorkEligible: boolean;
  estimatedStrengthEligible: boolean;
  personalRecordEligible: boolean;
  automaticProgressionEligible: boolean;
  evidenceProvenance:
    | "performed_semantics_snapshot"
    | "recorded_metric_and_current_catalog_agree"
    | "current_catalog_conflict_suppression"
    | "recorded_metric_only";
  exclusionReason: SetMetricExclusionReason | null;
};

export type SetMetricContainmentInput = {
  recordedMetricType: PerformedMetricType;
  prescribedSemanticsVersion?: number | null;
  performedSemanticsVersion?: number | null;
  performedLoadType?: string | null;
  performedLoadSemantics?: string | null;
  currentExerciseMetricType?: PerformedMetricType | null;
  loadType?: string | null;
  loadSemantics?: string | null;
  loadEntryMeaning?: string | null;
  weight?: number | null;
  reps?: number | null;
  excludeFromAnalytics?: boolean;
};

function metricConflict(input: SetMetricContainmentInput) {
  if (input.performedSemanticsVersion === 1) return false;
  return (
    input.currentExerciseMetricType != null &&
    input.currentExerciseMetricType !== input.recordedMetricType
  );
}

function evidenceProvenance(
  input: SetMetricContainmentInput,
): SetMetricContainment["evidenceProvenance"] {
  if (
    input.performedSemanticsVersion === 1 &&
    typeof input.performedLoadType === "string" &&
    input.performedLoadType.trim().length > 0 &&
    input.performedLoadSemantics != null
  ) {
    return "performed_semantics_snapshot";
  }
  if (metricConflict(input)) return "current_catalog_conflict_suppression";
  return input.currentExerciseMetricType == null
    ? "recorded_metric_only"
    : "recorded_metric_and_current_catalog_agree";
}

/**
 * Conservative, read-time containment for consequential claims.
 *
 * Current catalog metadata may suppress a claim when it conflicts with the
 * recorded metric. It is never evidence for rewriting a historical set.
 */
export function classifySetMetricContainment(
  input: SetMetricContainmentInput,
): SetMetricContainment {
  const hasAnyPerformedSemantics =
    input.performedSemanticsVersion != null ||
    input.performedLoadType != null ||
    input.performedLoadSemantics != null;
  const hasCompletePerformedSemantics =
    input.performedSemanticsVersion === 1 &&
    typeof input.performedLoadType === "string" &&
    input.performedLoadType.trim().length > 0 &&
    input.performedLoadSemantics != null;
  const prescriptionMeaningKnown =
    input.prescribedSemanticsVersion === undefined ||
    input.prescribedSemanticsVersion === 1;
  const loadType = hasCompletePerformedSemantics
    ? input.performedLoadType
    : input.loadType;
  const loadSemantics = hasCompletePerformedSemantics
    ? input.performedLoadSemantics
    : (input.loadSemantics ?? "none");
  const base = {
    measurementMeaning: input.recordedMetricType,
    evidenceProvenance: evidenceProvenance(input),
  } as const;

  if (input.excludeFromAnalytics) {
    return {
      ...base,
      difficultyDirection: "unknown",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "source_excluded",
    };
  }
  if (!prescriptionMeaningKnown && !hasCompletePerformedSemantics) {
    return {
      ...base,
      difficultyDirection: "unknown",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "missing_prescribed_semantics",
    };
  }
  if (
    input.performedSemanticsVersion != null &&
    input.performedSemanticsVersion !== 1
  ) {
    return {
      ...base,
      difficultyDirection: "unknown",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "unsupported_performed_semantics_version",
    };
  }
  if (hasAnyPerformedSemantics && !hasCompletePerformedSemantics) {
    return {
      ...base,
      difficultyDirection: "unknown",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "incomplete_performed_semantics",
    };
  }
  if (metricConflict(input)) {
    return {
      ...base,
      difficultyDirection: "unknown",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "metric_semantics_conflict",
    };
  }
  if (
    hasCompletePerformedSemantics &&
    input.recordedMetricType === "reps" &&
    loadSemantics === "resistance_band"
  ) {
    return {
      ...base,
      difficultyDirection: "unknown",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "band_resistance_not_numeric",
    };
  }
  if (
    hasCompletePerformedSemantics &&
    input.recordedMetricType === "reps" &&
    loadSemantics !== "bodyweight" &&
    loadSemantics !== "none" &&
    loadSemantics !== "assistance"
  ) {
    return {
      ...base,
      difficultyDirection: "unknown",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "metric_semantics_conflict",
    };
  }
  if (
    input.recordedMetricType === "duration" ||
    input.recordedMetricType === "weight_duration_per_side" ||
    input.recordedMetricType === "distance_duration" ||
    input.recordedMetricType === "activity"
  ) {
    return {
      ...base,
      difficultyDirection: "task_specific",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "unsupported_metric",
    };
  }
  if (
    input.recordedMetricType === "assisted_reps" ||
    loadSemantics === "assistance"
  ) {
    return {
      ...base,
      difficultyDirection:
        input.weight == null ? "unknown" : "lower_assistance_is_harder",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "assistance_not_comparable",
    };
  }
  if (input.recordedMetricType === "reps") {
    const cleanRepetitionShape = input.weight == null && input.reps != null;
    return {
      ...base,
      difficultyDirection: "higher_repetitions_may_be_harder",
      prescriptionOutcomeEligible:
        cleanRepetitionShape && prescriptionMeaningKnown,
      longitudinalComparable: cleanRepetitionShape,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: cleanRepetitionShape,
      automaticProgressionEligible: false,
      exclusionReason: cleanRepetitionShape
        ? "repetitions_only"
        : "missing_load_or_repetitions",
    };
  }

  if (input.weight == null || input.reps == null) {
    return {
      ...base,
      difficultyDirection: "unknown",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "missing_load_or_repetitions",
    };
  }

  if (loadSemantics === "per_implement") {
    return {
      ...base,
      difficultyDirection: "higher_load_is_harder",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "per_implement_not_aggregatable",
    };
  }
  if (loadSemantics === "added_weight") {
    return {
      ...base,
      difficultyDirection: "higher_load_is_harder",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "added_weight_missing_system_load",
    };
  }
  if (loadSemantics === "machine_stack") {
    return {
      ...base,
      difficultyDirection: "higher_load_is_harder",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "machine_geometry_not_comparable",
    };
  }
  if (loadSemantics === "resistance_band") {
    return {
      ...base,
      difficultyDirection: "unknown",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "band_resistance_not_numeric",
    };
  }
  if (
    loadSemantics !== "total" ||
    input.loadEntryMeaning !== "total_system"
  ) {
    return {
      ...base,
      difficultyDirection: "higher_load_is_harder",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "unproven_load_entry_meaning",
    };
  }
  if (loadType !== "barbell") {
    return {
      ...base,
      difficultyDirection: "higher_load_is_harder",
      prescriptionOutcomeEligible: prescriptionMeaningKnown,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "unvalidated_total_system_implement",
    };
  }
  return {
    ...base,
    difficultyDirection: "higher_load_is_harder",
    prescriptionOutcomeEligible: prescriptionMeaningKnown,
    longitudinalComparable: true,
    loadedWorkEligible: true,
    estimatedStrengthEligible: true,
    personalRecordEligible: true,
    automaticProgressionEligible: prescriptionMeaningKnown,
    exclusionReason: null,
  };
}

export function validateSetWriterShape(input: {
  metricType: PerformedMetricType;
  loadSemantics?: string | null;
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  distanceKm?: number | null;
  durationSeconds?: number | null;
}): { ok: true; metricType: SupportedSetWriterMetric } | {
  ok: false;
  reason: SetWriteRefusalReason;
  message: string;
} {
  if (
    input.loadSemantics != null &&
    ((input.loadSemantics === "assistance") !==
      (input.metricType === "assisted_reps"))
  ) {
    return {
      ok: false,
      reason: "metric_semantics_conflict",
      message:
        "This exercise has an inconsistent assistance measurement definition. Review the exercise definition before recording a set.",
    };
  }
  if (input.metricType === "activity") {
    return {
      ok: false,
      reason: "unsupported_metric",
      message:
        "Independent activity observations are recorded through the activity flow, not as workout sets.",
    };
  }
  const distanceKm = input.distanceKm ?? null;
  const durationSeconds = input.durationSeconds ?? null;
  const hasStrengthMeasurement =
    input.weight != null || input.weightUnit != null || input.reps != null;
  if (input.metricType === "weight_duration_per_side") {
    return (input.loadSemantics === "per_implement" || input.loadSemantics === "total") &&
      input.weight != null && input.weightUnit != null && input.reps == null &&
      distanceKm == null && durationSeconds != null && durationSeconds > 0
      ? { ok: true, metricType: "weight_duration_per_side" }
      : { ok: false, reason: "measurement_shape_conflict", message: "Enter the carried load and seconds completed on each side, without reps or distance." };
  }
  if (input.metricType === "duration") {
    if (
      input.loadSemantics != null &&
      input.loadSemantics !== "none" &&
      input.loadSemantics !== "bodyweight"
    ) {
      return {
        ok: false,
        reason: "metric_semantics_conflict",
        message:
          "This timed exercise also requires a performed load that the current timed-set shape cannot represent truthfully.",
      };
    }
    return !hasStrengthMeasurement &&
      distanceKm == null &&
      durationSeconds != null
      ? { ok: true, metricType: "duration" }
      : {
          ok: false,
          reason:
            durationSeconds == null
              ? "duration_requires_time"
              : "measurement_shape_conflict",
          message:
            "A timed set needs an explicit duration and cannot carry repetitions, distance, or load.",
        };
  }
  if (input.metricType === "distance_duration") {
    if (
      input.loadSemantics != null &&
      input.loadSemantics !== "none" &&
      input.loadSemantics !== "bodyweight"
    ) {
      return {
        ok: false,
        reason: "metric_semantics_conflict",
        message:
          "This distance exercise also requires a performed load that the current distance-set shape cannot represent truthfully.",
      };
    }
    return !hasStrengthMeasurement && distanceKm != null
      ? { ok: true, metricType: "distance_duration" }
      : {
          ok: false,
          reason:
            distanceKm == null
              ? "distance_duration_requires_distance"
              : "measurement_shape_conflict",
          message:
            "A distance set needs an explicit distance and may include duration, but cannot carry repetitions or load.",
        };
  }
  if (distanceKm != null || durationSeconds != null) {
    return {
      ok: false,
      reason: "measurement_shape_conflict",
      message:
        "A repetitions-based set cannot also carry time or distance values.",
    };
  }
  if (input.metricType === "reps") {
    return input.reps != null && input.weight == null && input.weightUnit == null
      ? { ok: true, metricType: "reps" }
      : {
          ok: false,
          reason: input.reps == null
            ? "measurement_shape_conflict"
            : "reps_cannot_include_load",
          message:
            input.reps == null
              ? "A repetitions-based set needs an explicit repetition count."
              : "This exercise records repetitions without a load. Remove the load or choose the correct weighted exercise variant.",
        };
  }
  if (input.metricType === "assisted_reps") {
    return input.reps != null && input.weight != null && input.weightUnit != null
      ? { ok: true, metricType: "assisted_reps" }
      : {
          ok: false,
          reason: input.reps == null
            ? "measurement_shape_conflict"
            : "assisted_reps_requires_numeric_assistance",
          message:
            input.reps == null
              ? "An assisted set needs an explicit repetition count."
              : "Enter the numeric assistance and unit for this set, or keep the observation in a note instead.",
        };
  }
  return input.reps != null && input.weight != null && input.weightUnit != null
    ? { ok: true, metricType: "weight_reps" }
    : {
        ok: false,
        reason: input.reps == null
          ? "measurement_shape_conflict"
          : "weight_reps_requires_load",
        message:
          input.reps == null
            ? "A loaded set needs an explicit repetition count."
            : "This exercise requires a numeric load and unit. Enter the load or choose the correct repetitions-only variant.",
      };
}

export function buildPerformedSetMeasurement(input: {
  metricType: PerformedMetricType;
  loadSemantics?: string | null;
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
}):
  | { ok: true; measurement: PerformedSetMeasurement }
  | { ok: false; reason: SetWriteRefusalReason; message: string } {
  if (!SUPPORTED_SET_WRITER_METRICS.includes(
    input.metricType as SupportedSetWriterMetric,
  )) {
    return {
      ok: false,
      reason: "unsupported_metric",
      message: "This performed measurement is not supported by the workout set writer.",
    };
  }
  const shape = validateSetWriterShape(input);
  if (!shape.ok) return shape;
  const finite = [input.weight, input.distanceKm, input.durationSeconds]
    .every((value) => value == null || Number.isFinite(value));
  const repetitionsValid = input.reps == null ||
    (Number.isInteger(input.reps) && input.reps >= 0 && input.reps <= 100);
  const weightValid = input.weight == null ||
    (input.weight >= 0 && input.weight <= 2000);
  const distanceValid = input.distanceKm == null ||
    (input.distanceKm >= 0 && input.distanceKm <= 10_000);
  const durationValid = input.durationSeconds == null ||
    (Number.isInteger(input.durationSeconds) &&
      input.durationSeconds >= 0 && input.durationSeconds <= 604_800);
  if (!finite || !repetitionsValid || !weightValid || !distanceValid || !durationValid) {
    return {
      ok: false,
      reason: "measurement_shape_conflict",
      message: "Enter a valid performed value for this set.",
    };
  }
  switch (shape.metricType) {
    case "weight_duration_per_side":
      return { ok: true, measurement: {
        metricType: "weight_duration_per_side", weight: input.weight!, weightUnit: input.weightUnit!,
        reps: null, distanceKm: null, durationSeconds: input.durationSeconds!,
      } };
    case "weight_reps":
    case "assisted_reps":
      return {
        ok: true,
        measurement: {
          metricType: shape.metricType,
          weight: input.weight!,
          weightUnit: input.weightUnit!,
          reps: input.reps!,
          distanceKm: null,
          durationSeconds: null,
        },
      };
    case "reps":
      return {
        ok: true,
        measurement: {
          metricType: "reps",
          weight: null,
          weightUnit: null,
          reps: input.reps!,
          distanceKm: null,
          durationSeconds: null,
        },
      };
    case "duration":
      return {
        ok: true,
        measurement: {
          metricType: "duration",
          weight: null,
          weightUnit: null,
          reps: null,
          distanceKm: null,
          durationSeconds: input.durationSeconds!,
        },
      };
    case "distance_duration":
      return {
        ok: true,
        measurement: {
          metricType: "distance_duration",
          weight: null,
          weightUnit: null,
          reps: null,
          distanceKm: input.distanceKm!,
          durationSeconds: input.durationSeconds,
        },
      };
  }
}

export type PrescriptionOutcome = "below" | "at" | "above" | "unknown";

export const PRESCRIPTION_OUTCOME_ALGORITHM_VERSION =
  "prescription-outcome-v2";

export const PRESCRIPTION_DIMENSION_OUTCOME_ALGORITHM_VERSION =
  "prescription-dimension-outcome-v1" as const;

export type PrescriptionDimensionStatus =
  | Exclude<PrescriptionOutcome, "unknown">
  | "unknown"
  | "not_prescribed";

export type PrescriptionDimensionAssessment = {
  prescribed: boolean;
  evaluable: boolean;
  outcome: PrescriptionDimensionStatus;
  limitation: string | null;
};

export type PrescriptionDimensionOutcome = {
  algorithmVersion: typeof PRESCRIPTION_DIMENSION_OUTCOME_ALGORITHM_VERSION;
  evaluability: "fully_evaluable" | "partially_evaluable" | "not_evaluable";
  repetitions: PrescriptionDimensionAssessment;
  load: PrescriptionDimensionAssessment;
  overall: PrescriptionOutcome;
};

export type PrescriptionOutcomeSummary = {
  algorithmVersion: typeof PRESCRIPTION_OUTCOME_ALGORITHM_VERSION;
  below: number;
  at: number;
  above: number;
  unknown: number;
  supported: number;
  atOrAboveRate: number | null;
};

export function buildPrescriptionOutcomeSummary(input: {
  below: number;
  at: number;
  above: number;
  unknown: number;
}): PrescriptionOutcomeSummary {
  const supported = input.below + input.at + input.above;
  return {
    algorithmVersion: PRESCRIPTION_OUTCOME_ALGORITHM_VERSION,
    ...input,
    supported,
    atOrAboveRate: supported
      ? Math.round(((input.at + input.above) / supported) * 100)
      : null,
  };
}

export function summarizePrescriptionOutcomes(
  outcomes: PrescriptionOutcome[],
): PrescriptionOutcomeSummary {
  const below = outcomes.filter((outcome) => outcome === "below").length;
  const at = outcomes.filter((outcome) => outcome === "at").length;
  const above = outcomes.filter((outcome) => outcome === "above").length;
  const unknown = outcomes.filter((outcome) => outcome === "unknown").length;
  return buildPrescriptionOutcomeSummary({ below, at, above, unknown });
}

export function classifyPrescriptionOutcome(input: {
  semantics: SetMetricContainment;
  reps: number | null;
  weight: number | null;
  weightUnit: LoadUnit | null;
  targetRepsMin: number | null;
  targetRepsMax?: number | null;
  targetLoad: number | null;
  targetLoadUnit: LoadUnit | null;
  targetLoadPercent?: number | null;
  targetLoadText?: string | null;
}): PrescriptionOutcome {
  return classifyPrescriptionDimensions(input).overall;
}

function prescribedDimension(
  outcome: PrescriptionOutcome,
  evaluable: boolean,
  limitation: string | null,
): PrescriptionDimensionAssessment {
  return {
    prescribed: true,
    evaluable,
    outcome: evaluable ? outcome : "unknown",
    limitation,
  };
}

function unprescribedDimension(): PrescriptionDimensionAssessment {
  return {
    prescribed: false,
    evaluable: false,
    outcome: "not_prescribed",
    limitation: null,
  };
}

function combinePrescriptionDimensions(input: {
  repetitions: PrescriptionDimensionAssessment;
  load: PrescriptionDimensionAssessment;
}): PrescriptionDimensionOutcome {
  const prescribed = [input.repetitions, input.load].filter(
    (dimension) => dimension.prescribed,
  );
  const evaluable = prescribed.filter((dimension) => dimension.evaluable);
  const evaluability = prescribed.length === 0 || evaluable.length === 0
    ? "not_evaluable" as const
    : evaluable.length === prescribed.length
      ? "fully_evaluable" as const
      : "partially_evaluable" as const;
  const overall = evaluability !== "fully_evaluable"
    ? "unknown" as const
    : evaluable.some((dimension) => dimension.outcome === "below")
      ? "below" as const
      : evaluable.some((dimension) => dimension.outcome === "above")
        ? "above" as const
        : "at" as const;
  return {
    algorithmVersion: PRESCRIPTION_DIMENSION_OUTCOME_ALGORITHM_VERSION,
    evaluability,
    repetitions: input.repetitions,
    load: input.load,
    overall,
  };
}

export function unavailablePrescriptionDimensions(input: {
  targetRepsMin: number | null;
  targetRepsMax?: number | null;
  targetLoad: number | null;
  targetLoadUnit: LoadUnit | null;
  targetLoadPercent?: number | null;
  targetLoadText?: string | null;
  limitation: string;
}): PrescriptionDimensionOutcome {
  const repetitionsPrescribed =
    input.targetRepsMin != null || input.targetRepsMax != null;
  const loadPrescribed =
    input.targetLoad != null ||
    input.targetLoadUnit != null ||
    input.targetLoadPercent != null ||
    input.targetLoadText != null;
  return combinePrescriptionDimensions({
    repetitions: repetitionsPrescribed
      ? prescribedDimension("unknown", false, input.limitation)
      : unprescribedDimension(),
    load: loadPrescribed
      ? prescribedDimension("unknown", false, input.limitation)
      : unprescribedDimension(),
  });
}

/**
 * Evaluates each prescribed dimension independently. A valid repetition
 * result remains usable when no load was prescribed, while a prescribed but
 * unsupported load keeps the aggregate set outcome unknown.
 */
export function classifyPrescriptionDimensions(input: {
  semantics: SetMetricContainment;
  reps: number | null;
  weight: number | null;
  weightUnit: LoadUnit | null;
  targetRepsMin: number | null;
  targetRepsMax?: number | null;
  targetLoad: number | null;
  targetLoadUnit: LoadUnit | null;
  targetLoadPercent?: number | null;
  targetLoadText?: string | null;
}): PrescriptionDimensionOutcome {
  const repetitionsPrescribed =
    input.targetRepsMin != null || input.targetRepsMax != null;
  const repetitionsEligible =
    input.semantics.prescriptionOutcomeEligible &&
    ["weight_reps", "reps", "assisted_reps"].includes(
      input.semantics.measurementMeaning,
    ) &&
    input.reps != null &&
    input.targetRepsMin != null &&
    (input.targetRepsMax == null ||
      input.targetRepsMax >= input.targetRepsMin);
  const repetitions = !repetitionsPrescribed
    ? unprescribedDimension()
    : !repetitionsEligible
      ? prescribedDimension(
          "unknown",
          false,
          input.targetRepsMin == null
            ? "incomplete_repetition_target"
            : "repetition_comparison_unavailable",
        )
      : prescribedDimension(
          input.reps! < input.targetRepsMin!
            ? "below"
            : input.targetRepsMax != null && input.reps! > input.targetRepsMax
              ? "above"
              : "at",
          true,
          null,
        );

  const loadPrescribed =
    input.targetLoad != null ||
    input.targetLoadUnit != null ||
    input.targetLoadPercent != null ||
    input.targetLoadText != null;
  let load = unprescribedDimension();
  if (loadPrescribed) {
    const numericLoadTargetComplete =
      input.targetLoad != null &&
      input.targetLoadUnit != null &&
      input.targetLoadPercent == null &&
      input.targetLoadText == null;
    const loadEligible =
      numericLoadTargetComplete &&
      input.semantics.prescriptionOutcomeEligible &&
      input.weight != null &&
      input.weightUnit != null;
    if (!loadEligible) {
      load = prescribedDimension(
        "unknown",
        false,
        input.targetLoadPercent != null || input.targetLoadText != null
          ? "non_numeric_load_target"
          : "load_comparison_unavailable",
      );
    } else {
      const performed = convertWeight(
        input.weight!,
        input.weightUnit!,
        input.targetLoadUnit!,
      );
      load = prescribedDimension(
        performed < input.targetLoad!
          ? "below"
          : performed > input.targetLoad!
            ? "above"
            : "at",
        true,
        null,
      );
    }
  }
  const combined = combinePrescriptionDimensions({ repetitions, load });
  return repetitionsPrescribed
    ? combined
    : {
        ...combined,
        evaluability: load.evaluable
          ? "partially_evaluable"
          : "not_evaluable",
        overall: "unknown",
      };
}

export function legacyTargetMetProjection(
  outcome: PrescriptionOutcome,
): boolean | null {
  if (outcome === "unknown") return null;
  return outcome === "at" || outcome === "above";
}

/**
 * Rebuilds the legacy `target_met` projection from raw facts only when the set
 * retains a complete, supported performed-semantics snapshot. Restore and
 * rollback callers must not use today's exercise catalog as evidence for an
 * older row whose historical meaning was never captured.
 */
export function recomputeRestoredTargetMet(input: {
  recordedMetricType: PerformedMetricType;
  performedSemanticsVersion?: number | null;
  performedLoadType?: string | null;
  performedLoadSemantics?: string | null;
  loadEntryMeaning?: string | null;
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  targetRepsMin: number | null;
  targetRepsMax?: number | null;
  targetLoad: number | null;
  targetLoadUnit: LoadUnit | null;
  targetLoadPercent?: number | null;
  targetLoadText?: string | null;
  isWarmup?: boolean;
  modificationType?: string | null;
  excludeFromAnalytics?: boolean;
}): boolean | null {
  if (
    input.isWarmup ||
    input.modificationType !== "as_planned" ||
    input.performedSemanticsVersion !== 1 ||
    typeof input.performedLoadType !== "string" ||
    input.performedLoadType.trim().length === 0 ||
    typeof input.performedLoadSemantics !== "string"
  ) {
    return null;
  }
  const semantics = classifySetMetricContainment({
    recordedMetricType: input.recordedMetricType,
    performedSemanticsVersion: input.performedSemanticsVersion,
    performedLoadType: input.performedLoadType,
    performedLoadSemantics: input.performedLoadSemantics,
    loadEntryMeaning: input.loadEntryMeaning,
    weight: input.weight,
    reps: input.reps,
    excludeFromAnalytics: input.excludeFromAnalytics,
  });
  return legacyTargetMetProjection(
    classifyPrescriptionOutcome({
      semantics,
      reps: input.reps,
      weight: input.weight,
      weightUnit: input.weightUnit,
      targetRepsMin: input.targetRepsMin,
      targetRepsMax: input.targetRepsMax,
      targetLoad: input.targetLoad,
      targetLoadUnit: input.targetLoadUnit,
      targetLoadPercent: input.targetLoadPercent,
      targetLoadText: input.targetLoadText,
    }),
  );
}

export function setMetricExclusionLabel(
  reason: SetMetricExclusionReason | null,
): string | null {
  switch (reason) {
    case "assistance_not_comparable":
      return "Comparable strength estimate unavailable for assisted work.";
    case "metric_semantics_conflict":
      return "Calculation unavailable because the recorded and current metric meanings conflict.";
    case "missing_prescribed_semantics":
      return "Calculation unavailable because this workout's prescribed measurement meaning was not retained.";
    case "unsupported_performed_semantics_version":
    case "incomplete_performed_semantics":
      return "Calculation unavailable because this set's performed measurement meaning is unsupported.";
    case "per_implement_not_aggregatable":
    case "added_weight_missing_system_load":
    case "machine_geometry_not_comparable":
    case "band_resistance_not_numeric":
    case "unproven_load_entry_meaning":
      return "Comparable load calculation unavailable for this recorded load meaning.";
    case "unvalidated_total_system_implement":
      return "Loaded-work and estimated-strength calculations are not yet validated for this equipment type.";
    case "unsupported_metric":
      return "This measurement does not support a load-based strength calculation.";
    case "source_excluded":
      return "This set is excluded from analytics.";
    case "repetitions_only":
      return "Load-based strength calculations do not apply to repetitions-only work.";
    case "missing_load_or_repetitions":
      return "Comparable load calculation unavailable because required measurements are missing.";
    case null:
      return null;
  }
}
