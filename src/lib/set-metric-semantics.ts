import { convertWeight, type LoadUnit } from "@/lib/units";

export const PERFORMED_METRIC_TYPES = [
  "weight_reps",
  "reps",
  "assisted_reps",
  "duration",
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
  | "displayed_stack"
  | "per_stack"
  | "combined_stacks"
  | "legacy_unknown";

export type SetMetricExclusionReason =
  | "source_excluded"
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
      prescriptionOutcomeEligible: cleanRepetitionShape,
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
      prescriptionOutcomeEligible: true,
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
    prescriptionOutcomeEligible: true,
    longitudinalComparable: true,
    loadedWorkEligible: true,
    estimatedStrengthEligible: true,
    personalRecordEligible: true,
    automaticProgressionEligible: true,
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

export function classifyPrescriptionOutcome(input: {
  semantics: SetMetricContainment;
  reps: number | null;
  weight: number | null;
  weightUnit: LoadUnit | null;
  targetRepsMin: number | null;
  targetRepsMax?: number | null;
  targetLoad: number | null;
  targetLoadUnit: LoadUnit | null;
}): PrescriptionOutcome {
  if (
    !input.semantics.prescriptionOutcomeEligible ||
    input.reps == null ||
    input.targetRepsMin == null
  ) {
    return "unknown";
  }
  if (input.reps < input.targetRepsMin) return "below";
  const aboveRepetitions =
    input.targetRepsMax != null && input.reps > input.targetRepsMax;
  if (input.targetLoad == null) return aboveRepetitions ? "above" : "at";
  if (
    input.weight == null ||
    input.weightUnit == null ||
    input.targetLoadUnit == null
  ) {
    return "unknown";
  }
  const performed = convertWeight(
    input.weight,
    input.weightUnit,
    input.targetLoadUnit,
  );
  if (performed < input.targetLoad) return "below";
  if (performed > input.targetLoad || aboveRepetitions) return "above";
  return "at";
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
