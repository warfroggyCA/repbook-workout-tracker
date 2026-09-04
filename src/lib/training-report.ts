import { z } from "zod";
import type { PlannedDurationSource } from "@/lib/session-completion-semantics";
import {
  classifyPrescriptionDimensions,
  PRESCRIPTION_DIMENSION_OUTCOME_ALGORITHM_VERSION,
  unavailablePrescriptionDimensions,
  type PrescriptionDimensionOutcome,
  type SetMetricContainment,
} from "@/lib/set-metric-semantics";

export const TRAINING_REPORT_SEMANTIC_VERSION = "training-report/3" as const;
export const EXERCISE_REPORTING_ALGORITHM_VERSION =
  "exercise-reporting-v1" as const;
export const DURATION_ADHERENCE_ALGORITHM_VERSION =
  "duration-adherence-v2" as const;
export const DURATION_TARGET_CONSISTENCY_ALGORITHM_VERSION =
  "duration-target-consistency-v1" as const;
export const COVERAGE_CONFIDENCE_ALGORITHM_VERSION =
  "coverage-confidence-v1" as const;
export const TARGET_ATTAINMENT_COVERAGE_ALGORITHM_VERSION =
  "target-attainment-coverage-v2" as const;
export const NON_COMPLETION_PATTERN_ALGORITHM_VERSION =
  "non-completion-pattern-v1" as const;
export const WARMUP_SUMMARY_ALGORITHM_VERSION = "warmup-summary-v1" as const;
export const COACH_SUMMARY_RULES_VERSION = "coach-summary-rules-v1" as const;

export const PLAN_RELATIONSHIPS = [
  "as_planned",
  "substituted_out",
  "substituted_in",
  "ad_hoc",
  "legacy_unknown",
] as const;
export const planRelationshipSchema = z.enum(PLAN_RELATIONSHIPS);
export type PlanRelationship = z.infer<typeof planRelationshipSchema>;

export const PERFORMANCE_STATES = [
  "performed",
  "not_performed",
  "historical_unknown",
] as const;
export const performanceStateSchema = z.enum(PERFORMANCE_STATES);
export type PerformanceState = z.infer<typeof performanceStateSchema>;

export const MEASUREMENT_COVERAGE_VALUES = [
  "full",
  "partial",
  "unavailable",
  "not_applicable",
  "unknown",
] as const;
export const measurementCoverageSchema = z.enum(
  MEASUREMENT_COVERAGE_VALUES,
);
export type MeasurementCoverage = z.infer<typeof measurementCoverageSchema>;

export const PRESCRIBED_WORK_COMPLETION_VALUES = [
  "completed_as_prescribed",
  "partial",
  "none",
  "not_evaluable",
] as const;
export const prescribedWorkCompletionSchema = z.enum(
  PRESCRIBED_WORK_COMPLETION_VALUES,
);
export type PrescribedWorkCompletion = z.infer<
  typeof prescribedWorkCompletionSchema
>;

export const REPORTING_RESOLUTIONS = [
  "completed",
  "not_performed",
  "skipped",
  "session_ended_before_completion",
  "pending",
  "historical_unknown",
] as const;
export const reportingResolutionSchema = z.enum(REPORTING_RESOLUTIONS);
export type ReportingResolution = z.infer<typeof reportingResolutionSchema>;

export const STRUCTURED_NON_COMPLETION_REASONS = [
  "equipment_unavailable_incompatible",
  "time_limit_reached",
  "fatigue",
  "pain_discomfort",
  "user_choice",
  "exercise_substitution",
  "technical_app_issue",
  "interruption",
  "program_change",
  "unknown_historical_outcome",
  "other_explicit",
] as const;
export const structuredNonCompletionReasonSchema = z.enum(
  STRUCTURED_NON_COMPLETION_REASONS,
);
export type StructuredNonCompletionReason = z.infer<
  typeof structuredNonCompletionReasonSchema
>;

export const TARGET_OUTCOMES = ["below", "at", "above", "unknown"] as const;
export const targetOutcomeSchema = z.enum(TARGET_OUTCOMES);
export type TargetOutcome = z.infer<typeof targetOutcomeSchema>;

const prescriptionDimensionAssessmentSchema = z
  .object({
    prescribed: z.boolean(),
    evaluable: z.boolean(),
    outcome: z.enum([...TARGET_OUTCOMES, "not_prescribed"]),
    limitation: z.string().trim().min(1).nullable(),
  })
  .strict();

export const prescriptionDimensionOutcomeSchema = z
  .object({
    algorithmVersion: z.literal(
      PRESCRIPTION_DIMENSION_OUTCOME_ALGORITHM_VERSION,
    ),
    evaluability: z.enum([
      "fully_evaluable",
      "partially_evaluable",
      "not_evaluable",
    ]),
    repetitions: prescriptionDimensionAssessmentSchema,
    load: prescriptionDimensionAssessmentSchema,
    overall: targetOutcomeSchema,
  })
  .strict();

export const MEASUREMENT_KINDS = [
  "loaded_repetitions",
  "bodyweight_repetitions",
  "assisted_repetitions",
  "repetitions",
  "duration",
  "distance_duration",
  "unknown",
] as const;
export const measurementKindSchema = z.enum(MEASUREMENT_KINDS);
export type MeasurementKind = z.infer<typeof measurementKindSchema>;

export const COUNTING_BASES = [
  "total",
  "per_side",
  "alternating_total",
  "hold",
  "not_applicable",
  "unknown",
] as const;
export const countingBasisSchema = z.enum(COUNTING_BASES);
export type CountingBasis = z.infer<typeof countingBasisSchema>;

export const ANALYTICAL_ELIGIBILITY_VALUES = [
  "eligible",
  "ineligible",
  "unknown",
] as const;
export const analyticalEligibilitySchema = z.enum(
  ANALYTICAL_ELIGIBILITY_VALUES,
);
export type AnalyticalEligibility = z.infer<
  typeof analyticalEligibilitySchema
>;

export const EXERCISE_REPORTING_STATES = [
  "not_performed",
  "performed_with_full_metrics",
  "performed_with_partial_metrics",
  "performed_metrics_unavailable",
  "skipped",
  "substituted",
  "session_ended_before_completion",
  "historical_outcome_unknown",
  "in_progress",
] as const;
export const exerciseReportingStateSchema = z.enum(
  EXERCISE_REPORTING_STATES,
);
export type ExerciseReportingState = z.infer<
  typeof exerciseReportingStateSchema
>;

export const EVIDENCE_REF_KINDS = [
  "workout_session",
  "session_exercise",
  "session_occurrence",
  "completed_set",
  "pain_log",
  "health_activity",
  "recommendation",
  "report_window",
  "coverage_metric",
] as const;
export const evidenceRefSchema = z
  .object({
    kind: z.enum(EVIDENCE_REF_KINDS),
    id: z.string().trim().min(1),
    revision: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const reportingOccurrenceSchema = z
  .object({
    id: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    plannedOutcome: z.boolean(),
    planRelationship: planRelationshipSchema,
    performanceState: performanceStateSchema,
    measurementCoverage: measurementCoverageSchema,
    resolution: reportingResolutionSchema,
    reason: structuredNonCompletionReasonSchema.nullable(),
    targetOutcome: targetOutcomeSchema,
    targetDimensions: prescriptionDimensionOutcomeSchema,
    measurementKind: measurementKindSchema,
    countingBasis: countingBasisSchema,
    analyticalEligibility: analyticalEligibilitySchema,
    analyticalExclusionReason: z.string().trim().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.plannedOutcome &&
      (value.planRelationship === "ad_hoc" ||
        value.planRelationship === "substituted_in")
    ) {
      context.addIssue({
        code: "custom",
        path: ["plannedOutcome"],
        message:
          "Ad-hoc or substituted-in work cannot be counted as an original planned outcome.",
      });
    }
    if (!value.plannedOutcome && value.planRelationship === "substituted_out") {
      context.addIssue({
        code: "custom",
        path: ["plannedOutcome"],
        message: "Substituted-out work must retain its original planned outcome.",
      });
    }
    if (
      value.targetOutcome !== "unknown" &&
      (!value.plannedOutcome ||
        value.performanceState !== "performed" ||
        value.resolution !== "completed")
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetOutcome"],
        message:
          "A below, at, or above target outcome requires completed performed evidence.",
      });
    }
    if (value.targetDimensions.overall !== value.targetOutcome) {
      context.addIssue({
        code: "custom",
        path: ["targetDimensions", "overall"],
        message:
          "Dimension-level and aggregate target outcomes must agree.",
      });
    }
    if (
      value.performanceState === "performed" &&
      value.resolution !== "completed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolution"],
        message: "Performed occurrence evidence must be completed.",
      });
    }
    if (
      value.resolution === "completed" &&
      value.performanceState !== "performed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["performanceState"],
        message: "A completed occurrence must retain performed evidence.",
      });
    }
    if (
      value.analyticalEligibility === "eligible" &&
      value.analyticalExclusionReason != null
    ) {
      context.addIssue({
        code: "custom",
        path: ["analyticalExclusionReason"],
        message: "Eligible evidence cannot carry an exclusion reason.",
      });
    }
    if (
      value.analyticalEligibility === "ineligible" &&
      value.analyticalExclusionReason == null
    ) {
      context.addIssue({
        code: "custom",
        path: ["analyticalExclusionReason"],
        message: "Ineligible evidence must explain its exclusion.",
      });
    }
  });
export type ReportingOccurrence = z.infer<typeof reportingOccurrenceSchema>;

export type ExerciseReportingFacets = Pick<
  ReportingOccurrence,
  | "planRelationship"
  | "performanceState"
  | "measurementCoverage"
  | "resolution"
>;

const exerciseReportingFacetsSchema = z
  .object({
    planRelationship: planRelationshipSchema,
    performanceState: performanceStateSchema,
    measurementCoverage: measurementCoverageSchema,
    resolution: reportingResolutionSchema,
  })
  .strict();

export type ExerciseReportingClassification = {
  algorithmVersion: typeof EXERCISE_REPORTING_ALGORITHM_VERSION;
  executionState: Exclude<ExerciseReportingState, "substituted">;
  substituted: boolean;
  states: ExerciseReportingState[];
};

export function deriveExerciseReportingStates(
  input: ExerciseReportingFacets,
): ExerciseReportingClassification {
  const facets = exerciseReportingFacetsSchema.parse(input);
  let executionState: ExerciseReportingClassification["executionState"];
  if (
    facets.performanceState === "historical_unknown" ||
    facets.resolution === "historical_unknown"
  ) {
    executionState = "historical_outcome_unknown";
  } else if (facets.performanceState === "performed") {
    executionState = facets.measurementCoverage === "full"
      ? "performed_with_full_metrics"
      : facets.measurementCoverage === "partial"
        ? "performed_with_partial_metrics"
        : "performed_metrics_unavailable";
  } else if (facets.resolution === "skipped") {
    executionState = "skipped";
  } else if (facets.resolution === "session_ended_before_completion") {
    executionState = "session_ended_before_completion";
  } else if (facets.resolution === "pending") {
    executionState = "in_progress";
  } else {
    executionState = "not_performed";
  }
  const substituted =
    facets.planRelationship === "substituted_in" ||
    facets.planRelationship === "substituted_out";
  return {
    algorithmVersion: EXERCISE_REPORTING_ALGORITHM_VERSION,
    executionState,
    substituted,
    states: substituted ? [executionState, "substituted"] : [executionState],
  };
}

export type ExerciseReportSummary = {
  algorithmVersion: typeof EXERCISE_REPORTING_ALGORITHM_VERSION;
  exerciseId: string;
  exerciseName: string;
  states: ExerciseReportingState[];
  prescribedWorkCompletion: PrescribedWorkCompletion;
  counts: {
    planned: number;
    performedPlanned: number;
    performed: number;
    performedAdditional: number;
    performedPlanLinkageUnknown: number;
    fullMetrics: number;
    partialMetrics: number;
    unavailableMetrics: number;
    analyticallyEligible: number;
    analyticallyIneligible: number;
    analyticalEligibilityUnknown: number;
    skipped: number;
    substituted: number;
    sessionEndedBeforeCompletion: number;
    historicalUnknown: number;
    pending: number;
    notPerformed: number;
  };
  nonCompletionReasons: Array<{
    reason: StructuredNonCompletionReason;
    occurrences: number;
  }>;
  analyticalExclusionReasons: Array<{
    reason: string;
    occurrences: number;
  }>;
};

function derivePrescribedWorkCompletion(
  planned: ReportingOccurrence[],
): PrescribedWorkCompletion {
  if (
    planned.length === 0 ||
    planned.some(
      (occurrence) =>
        occurrence.performanceState === "historical_unknown" ||
        occurrence.resolution === "historical_unknown" ||
        occurrence.resolution === "pending",
    )
  ) {
    return "not_evaluable";
  }
  if (
    planned.every(
      (occurrence) =>
        occurrence.planRelationship === "as_planned" &&
        occurrence.performanceState === "performed" &&
        occurrence.resolution === "completed",
    )
  ) {
    return "completed_as_prescribed";
  }
  const performed = planned.filter(
    (occurrence) => occurrence.performanceState === "performed",
  ).length;
  return performed === 0 ? "none" : "partial";
}

export function buildExerciseReportSummary(input: {
  exerciseId: string;
  exerciseName: string;
  occurrences: ReportingOccurrence[];
}): ExerciseReportSummary {
  const exerciseId = z.string().trim().min(1).parse(input.exerciseId);
  const exerciseName = z.string().trim().min(1).parse(input.exerciseName);
  const occurrences = z.array(reportingOccurrenceSchema).parse(input.occurrences);
  if (new Set(occurrences.map((occurrence) => occurrence.id)).size !== occurrences.length) {
    throw new Error("Exercise summary occurrence IDs must be unique.");
  }
  const planned = occurrences.filter((occurrence) => occurrence.plannedOutcome);
  const performed = occurrences.filter(
    (occurrence) => occurrence.performanceState === "performed",
  );
  const fullMetrics = performed.filter(
    (occurrence) => occurrence.measurementCoverage === "full",
  ).length;
  const partialMetrics = performed.filter(
    (occurrence) => occurrence.measurementCoverage === "partial",
  ).length;
  const unavailableMetrics = performed.length - fullMetrics - partialMetrics;
  const nonCompletionReasonCounts = new Map<
    StructuredNonCompletionReason,
    number
  >();
  const analyticalExclusionReasonCounts = new Map<string, number>();
  for (const occurrence of occurrences) {
    if (
      occurrence.reason != null &&
      occurrence.resolution !== "completed"
    ) {
      nonCompletionReasonCounts.set(
        occurrence.reason,
        (nonCompletionReasonCounts.get(occurrence.reason) ?? 0) + 1,
      );
    }
    if (
      occurrence.performanceState === "performed" &&
      occurrence.analyticalEligibility !== "eligible"
    ) {
      const reason = occurrence.analyticalExclusionReason ??
        "analytical_eligibility_unknown";
      analyticalExclusionReasonCounts.set(
        reason,
        (analyticalExclusionReasonCounts.get(reason) ?? 0) + 1,
      );
    }
  }

  let primaryState: ExerciseReportingState;
  if (performed.length > 0) {
    primaryState = fullMetrics === performed.length
      ? "performed_with_full_metrics"
      : unavailableMetrics === performed.length
        ? "performed_metrics_unavailable"
        : "performed_with_partial_metrics";
  } else if (
    occurrences.some(
      (occurrence) =>
        occurrence.performanceState === "historical_unknown" ||
        occurrence.resolution === "historical_unknown",
    )
  ) {
    primaryState = "historical_outcome_unknown";
  } else if (
    occurrences.some(
      (occurrence) => occurrence.resolution === "session_ended_before_completion",
    )
  ) {
    primaryState = "session_ended_before_completion";
  } else if (
    occurrences.some((occurrence) => occurrence.resolution === "skipped")
  ) {
    primaryState = "skipped";
  } else if (
    occurrences.some((occurrence) => occurrence.resolution === "pending")
  ) {
    primaryState = "in_progress";
  } else {
    primaryState = "not_performed";
  }

  const states: ExerciseReportingState[] = [primaryState];
  if (
    occurrences.some(
      (occurrence) =>
        occurrence.planRelationship === "substituted_in" ||
        occurrence.planRelationship === "substituted_out",
    )
  ) {
    states.push("substituted");
  }
  if (
    performed.length > 0 &&
    occurrences.some((occurrence) => occurrence.resolution === "skipped")
  ) {
    states.push("skipped");
  }
  if (
    performed.length > 0 &&
    occurrences.some(
      (occurrence) => occurrence.resolution === "session_ended_before_completion",
    )
  ) {
    states.push("session_ended_before_completion");
  }
  if (
    performed.length > 0 &&
    occurrences.some(
      (occurrence) => occurrence.resolution === "historical_unknown",
    )
  ) {
    states.push("historical_outcome_unknown");
  }
  if (
    performed.length > 0 &&
    occurrences.some((occurrence) => occurrence.resolution === "not_performed")
  ) {
    states.push("not_performed");
  }

  return {
    algorithmVersion: EXERCISE_REPORTING_ALGORITHM_VERSION,
    exerciseId,
    exerciseName,
    states: [...new Set(states)],
    prescribedWorkCompletion: derivePrescribedWorkCompletion(planned),
    counts: {
      planned: planned.length,
      performedPlanned: planned.filter(
        (occurrence) => occurrence.performanceState === "performed",
      ).length,
      performed: performed.length,
      performedAdditional: performed.filter(
        (occurrence) =>
          !occurrence.plannedOutcome &&
          (occurrence.planRelationship === "ad_hoc" ||
            occurrence.planRelationship === "substituted_in"),
      ).length,
      performedPlanLinkageUnknown: performed.filter(
        (occurrence) =>
          !occurrence.plannedOutcome &&
          occurrence.planRelationship === "legacy_unknown",
      ).length,
      fullMetrics,
      partialMetrics,
      unavailableMetrics,
      analyticallyEligible: occurrences.filter(
        (occurrence) =>
          occurrence.performanceState === "performed" &&
          occurrence.analyticalEligibility === "eligible",
      ).length,
      analyticallyIneligible: occurrences.filter(
        (occurrence) =>
          occurrence.performanceState === "performed" &&
          occurrence.analyticalEligibility === "ineligible",
      ).length,
      analyticalEligibilityUnknown: occurrences.filter(
        (occurrence) =>
          occurrence.performanceState === "performed" &&
          occurrence.analyticalEligibility === "unknown",
      ).length,
      skipped: occurrences.filter(
        (occurrence) => occurrence.resolution === "skipped",
      ).length,
      substituted: occurrences.filter(
        (occurrence) =>
          occurrence.planRelationship === "substituted_in" ||
          occurrence.planRelationship === "substituted_out",
      ).length,
      sessionEndedBeforeCompletion: occurrences.filter(
        (occurrence) =>
          occurrence.resolution === "session_ended_before_completion",
      ).length,
      historicalUnknown: occurrences.filter(
        (occurrence) =>
          occurrence.performanceState === "historical_unknown" ||
          occurrence.resolution === "historical_unknown",
      ).length,
      pending: occurrences.filter(
        (occurrence) => occurrence.resolution === "pending",
      ).length,
      notPerformed: occurrences.filter(
        (occurrence) => occurrence.resolution === "not_performed",
      ).length,
    },
    nonCompletionReasons: [...nonCompletionReasonCounts.entries()]
      .map(([reason, occurrences]) => ({ reason, occurrences }))
      .sort(
        (left, right) =>
          right.occurrences - left.occurrences ||
          left.reason.localeCompare(right.reason),
      ),
    analyticalExclusionReasons: [...analyticalExclusionReasonCounts.entries()]
      .map(([reason, occurrences]) => ({ reason, occurrences }))
      .sort(
        (left, right) =>
          right.occurrences - left.occurrences ||
          left.reason.localeCompare(right.reason),
      ),
  };
}

function formatReasonCounts(summary: ExerciseReportSummary): string | null {
  if (summary.nonCompletionReasons.length === 0) return null;
  return summary.nonCompletionReasons
    .map(
      ({ reason, occurrences }) =>
        `${occurrences} ${reason.replaceAll("_", " ")}`,
    )
    .join(", ");
}

export function formatExerciseReportSummary(
  summary: ExerciseReportSummary,
): string {
  const performed = summary.counts.performed;
  if (performed > 0) {
    const completedWithKnownRelationship =
      summary.counts.performedPlanned + summary.counts.performedAdditional;
    const onlyUnlinkedLegacyPerformance =
      summary.counts.planned === 0 && completedWithKnownRelationship === 0;
    const completedLabel = summary.counts.planned > 0
      ? `${summary.counts.performedPlanned} of ${summary.counts.planned} planned set${summary.counts.planned === 1 ? "" : "s"} completed`
      : completedWithKnownRelationship > 0
        ? `${completedWithKnownRelationship} set${completedWithKnownRelationship === 1 ? "" : "s"} completed`
        : `${summary.counts.performedPlanLinkageUnknown} retained performed set${summary.counts.performedPlanLinkageUnknown === 1 ? "" : "s"}; plan linkage unknown`;
    const metricLabel = summary.states.includes("performed_with_full_metrics")
      ? "performed-set metrics retained"
      : summary.states.includes("performed_with_partial_metrics")
        ? "performed-set metrics partially retained"
        : "performed-set metrics unavailable for progression analysis";
    const analyticalReasons = summary.analyticalExclusionReasons
      .map(
        ({ reason, occurrences }) =>
          `${occurrences} ${reason.replaceAll("_", " ")}`,
      )
      .join(", ");
    const analyticalLabel = summary.counts.analyticallyEligible === performed
      ? `all ${performed} performed set${performed === 1 ? " is" : "s are"} eligible for progression analysis`
      : `${summary.counts.analyticallyEligible} of ${performed} performed set${performed === 1 ? " is" : "s are"} eligible for progression analysis${analyticalReasons ? ` (${analyticalReasons})` : ""}`;
    const incomplete: string[] = [];
    if (summary.counts.skipped > 0) {
      incomplete.push(
        `${summary.counts.skipped} skipped`,
      );
    }
    if (summary.counts.sessionEndedBeforeCompletion > 0) {
      incomplete.push(
        `${summary.counts.sessionEndedBeforeCompletion} ended with the session`,
      );
    }
    if (summary.counts.historicalUnknown > 0) {
      incomplete.push(
        `${summary.counts.historicalUnknown} historical outcome${summary.counts.historicalUnknown === 1 ? "" : "s"} unknown`,
      );
    }
    const reasons = formatReasonCounts(summary);
    const additionalLabel = summary.counts.performedAdditional > 0 &&
        summary.counts.planned > 0
      ? `; ${summary.counts.performedAdditional} additional set${summary.counts.performedAdditional === 1 ? "" : "s"} performed`
      : "";
    const unknownLinkageLabel =
      summary.counts.performedPlanLinkageUnknown > 0 &&
      !onlyUnlinkedLegacyPerformance
      ? `; ${summary.counts.performedPlanLinkageUnknown} retained performed set${summary.counts.performedPlanLinkageUnknown === 1 ? "" : "s"}; plan linkage unknown`
      : "";
    return `${summary.exerciseName} — ${completedLabel}${additionalLabel}${unknownLinkageLabel}${incomplete.length ? `; ${incomplete.join("; ")}` : ""}${reasons ? ` (${reasons})` : ""}; ${metricLabel}; ${analyticalLabel}.`;
  }
  const state = summary.states[0];
  const reasons = formatReasonCounts(summary);
  if (state === "skipped") {
    return `${summary.exerciseName} — ${summary.counts.skipped || summary.counts.planned || 1} planned set${(summary.counts.skipped || summary.counts.planned || 1) === 1 ? "" : "s"} skipped${reasons ? ` (${reasons})` : ""}.`;
  }
  if (state === "session_ended_before_completion") {
    return `${summary.exerciseName} — ${summary.counts.sessionEndedBeforeCompletion || summary.counts.planned || 1} planned set${(summary.counts.sessionEndedBeforeCompletion || summary.counts.planned || 1) === 1 ? "" : "s"} ended with the session${reasons ? ` (${reasons})` : ""}.`;
  }
  if (state === "historical_outcome_unknown") {
    return `${summary.exerciseName} — historical outcome unknown.`;
  }
  if (state === "in_progress") return `${summary.exerciseName} — in progress.`;
  return `${summary.exerciseName} — not performed.`;
}

export const PLANNED_OUTCOME_PARTITIONS = [
  "evaluable",
  "performed_unevaluable",
  "skipped",
  "session_ended_before_completion",
  "substituted_out",
  "not_performed",
  "pending",
  "historical_unknown",
] as const;
export type PlannedOutcomePartition =
  (typeof PLANNED_OUTCOME_PARTITIONS)[number];

export type PlannedOutcomePartitionSummary = {
  total: number;
  counts: Record<PlannedOutcomePartition, number>;
  byOccurrenceId: Record<string, PlannedOutcomePartition>;
};

function plannedOutcomePartition(
  occurrence: ReportingOccurrence,
): PlannedOutcomePartition {
  if (
    occurrence.performanceState === "historical_unknown" ||
    occurrence.resolution === "historical_unknown"
  ) {
    return "historical_unknown";
  }
  if (occurrence.planRelationship === "substituted_out") {
    return "substituted_out";
  }
  if (occurrence.resolution === "skipped") return "skipped";
  if (occurrence.resolution === "session_ended_before_completion") {
    return "session_ended_before_completion";
  }
  if (occurrence.resolution === "pending") return "pending";
  if (
    occurrence.performanceState === "performed" &&
    occurrence.targetOutcome !== "unknown"
  ) {
    return "evaluable";
  }
  if (occurrence.performanceState === "performed") {
    return "performed_unevaluable";
  }
  return "not_performed";
}

export function partitionPlannedOutcomes(
  input: ReportingOccurrence[],
): PlannedOutcomePartitionSummary {
  const occurrences = z.array(reportingOccurrenceSchema).parse(input);
  const planned = occurrences.filter((occurrence) => occurrence.plannedOutcome);
  const ids = new Set<string>();
  const counts = Object.fromEntries(
    PLANNED_OUTCOME_PARTITIONS.map((partition) => [partition, 0]),
  ) as Record<PlannedOutcomePartition, number>;
  const byOccurrenceId: Record<string, PlannedOutcomePartition> = {};
  for (const occurrence of planned) {
    if (ids.has(occurrence.id)) {
      throw new Error(`Duplicate planned occurrence ID: ${occurrence.id}`);
    }
    ids.add(occurrence.id);
    const partition = plannedOutcomePartition(occurrence);
    counts[partition] += 1;
    byOccurrenceId[occurrence.id] = partition;
  }
  const partitioned = Object.values(counts).reduce(
    (total, count) => total + count,
    0,
  );
  if (partitioned !== planned.length) {
    throw new Error("Every planned occurrence must have exactly one partition.");
  }
  return { total: planned.length, counts, byOccurrenceId };
}

export const CONFIDENCE_TIERS = [
  "none",
  "low",
  "moderate",
  "high",
  "very_high",
] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

function roundedPercentage(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 1_000) / 10;
}

export function confidenceTierForPercentage(percentage: number): ConfidenceTier {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error("Coverage percentage must be between 0 and 100.");
  }
  if (percentage === 0) return "none";
  if (percentage < 50) return "low";
  if (percentage < 80) return "moderate";
  if (percentage < 95) return "high";
  return "very_high";
}

export type CoverageMetric = {
  algorithmVersion: typeof COVERAGE_CONFIDENCE_ALGORITHM_VERSION;
  numerator: number;
  denominator: number;
  percentage: number | null;
  tier: ConfidenceTier | null;
  availability: "measured" | "not_collected" | "not_applicable";
};

export function buildCoverageMetric(input: {
  numerator: number;
  denominator: number;
  zeroDenominator?: "not_collected" | "not_applicable";
}): CoverageMetric {
  if (
    !Number.isInteger(input.numerator) ||
    !Number.isInteger(input.denominator) ||
    input.numerator < 0 ||
    input.denominator < 0 ||
    input.numerator > input.denominator
  ) {
    throw new Error(
      "Coverage requires whole non-negative counts with numerator no greater than denominator.",
    );
  }
  if (input.denominator === 0) {
    return {
      algorithmVersion: COVERAGE_CONFIDENCE_ALGORITHM_VERSION,
      numerator: 0,
      denominator: 0,
      percentage: null,
      tier: null,
      availability: input.zeroDenominator ?? "not_collected",
    };
  }
  const exactPercentage = (input.numerator / input.denominator) * 100;
  const percentage = roundedPercentage(input.numerator, input.denominator);
  return {
    algorithmVersion: COVERAGE_CONFIDENCE_ALGORITHM_VERSION,
    numerator: input.numerator,
    denominator: input.denominator,
    percentage,
    tier: confidenceTierForPercentage(exactPercentage),
    availability: "measured",
  };
}

export type TargetAttainmentCoverage = {
  algorithmVersion: typeof TARGET_ATTAINMENT_COVERAGE_ALGORITHM_VERSION;
  partition: PlannedOutcomePartitionSummary;
  coverage: CoverageMetric;
  rawStatistic: {
    below: number;
    at: number;
    above: number;
    atOrAbove: number;
    evaluable: number;
    atOrAbovePercentage: number | null;
  };
  conclusion: {
    eligible: boolean;
    status:
      | "eligible"
      | "incomplete_denominator"
      | "insufficient_coverage"
      | "insufficient_sample_size"
      | "insufficient_session_span";
    minimumCoveragePercentage: 80;
    minimumEvaluableOutcomes: 8;
    minimumSessions: 2;
    evaluableSessions: number;
    denominatorComplete: boolean;
  };
};

export function formatTargetAttainmentConclusion(
  conclusion: TargetAttainmentCoverage["conclusion"],
): string {
  switch (conclusion.status) {
    case "eligible":
      return "Coverage and sample thresholds permit a bounded attainment conclusion.";
    case "incomplete_denominator":
      return "The planned-outcome denominator is incomplete, so no overall attainment conclusion is supported.";
    case "insufficient_coverage":
      return "Coverage is insufficient for an overall attainment conclusion.";
    case "insufficient_sample_size":
      return "The evaluable sample is too small for an overall attainment conclusion.";
    case "insufficient_session_span":
      return "The evaluable outcomes span too few sessions for an overall attainment conclusion.";
  }
}

export function summarizeTargetAttainmentCoverage(
  input: ReportingOccurrence[],
  options: { denominatorComplete?: boolean } = {},
): TargetAttainmentCoverage {
  const occurrences = z.array(reportingOccurrenceSchema).parse(input);
  const partition = partitionPlannedOutcomes(occurrences);
  const evaluable = occurrences.filter(
    (occurrence) =>
      partition.byOccurrenceId[occurrence.id] === "evaluable",
  );
  const below = evaluable.filter(
    (occurrence) => occurrence.targetOutcome === "below",
  ).length;
  const at = evaluable.filter(
    (occurrence) => occurrence.targetOutcome === "at",
  ).length;
  const above = evaluable.filter(
    (occurrence) => occurrence.targetOutcome === "above",
  ).length;
  const atOrAbove = at + above;
  const coverage = buildCoverageMetric({
    numerator: evaluable.length,
    denominator: partition.total,
  });
  const evaluableSessions = new Set(
    evaluable.map((occurrence) => occurrence.sessionId),
  ).size;
  let status: TargetAttainmentCoverage["conclusion"]["status"] = "eligible";
  const denominatorComplete = options.denominatorComplete ?? true;
  if (!denominatorComplete) {
    status = "incomplete_denominator";
  } else if (partition.total === 0 || evaluable.length / partition.total < 0.8) {
    status = "insufficient_coverage";
  } else if (evaluable.length < 8) {
    status = "insufficient_sample_size";
  } else if (evaluableSessions < 2) {
    status = "insufficient_session_span";
  }
  return {
    algorithmVersion: TARGET_ATTAINMENT_COVERAGE_ALGORITHM_VERSION,
    partition,
    coverage,
    rawStatistic: {
      below,
      at,
      above,
      atOrAbove,
      evaluable: evaluable.length,
      atOrAbovePercentage: evaluable.length
        ? roundedPercentage(atOrAbove, evaluable.length)
        : null,
    },
    conclusion: {
      eligible: status === "eligible",
      status,
      minimumCoveragePercentage: 80,
      minimumEvaluableOutcomes: 8,
      minimumSessions: 2,
      evaluableSessions,
      denominatorComplete,
    },
  };
}

export type DurationAdherence = {
  algorithmVersion: typeof DURATION_ADHERENCE_ALGORITHM_VERSION;
  target: { minMinutes: number; maxMinutes: number } | null;
  targetSource: PlannedDurationSource | null;
  targetConsistency: DurationTargetConsistency;
  actualMinutes: number | null;
  status: "under_target" | "within_target" | "over_target" | "unknown";
  varianceMinutes: number | null;
  variancePercentage: number | null;
  comparisonBoundaryMinutes: number | null;
  toleranceMinutes: number | null;
  withinTolerance: boolean | null;
  limitation: string | null;
};

export type DurationTargetConsistency = {
  algorithmVersion: typeof DURATION_TARGET_CONSISTENCY_ALGORITHM_VERSION;
  status: "consistent" | "material_conflict" | "not_assessed";
  athletePreferenceMinutes: number | null;
  compatibleBand: { minMinutes: number; maxMinutes: number } | null;
  limitation: string | null;
};

export function assessDurationTargetConsistency(input: {
  targetMinMinutes: number | null;
  targetMaxMinutes: number | null;
  athletePreferenceMinutes: number | null;
}): DurationTargetConsistency {
  const targetMissing =
    input.targetMinMinutes == null && input.targetMaxMinutes == null;
  if ((input.targetMinMinutes == null) !== (input.targetMaxMinutes == null)) {
    throw new Error("Planned duration requires both minimum and maximum minutes.");
  }
  if (
    input.athletePreferenceMinutes != null &&
    (!Number.isFinite(input.athletePreferenceMinutes) ||
      input.athletePreferenceMinutes <= 0)
  ) {
    throw new Error("Athlete duration preference must be positive or null.");
  }
  if (targetMissing || input.athletePreferenceMinutes == null) {
    return {
      algorithmVersion: DURATION_TARGET_CONSISTENCY_ALGORITHM_VERSION,
      status: "not_assessed",
      athletePreferenceMinutes: input.athletePreferenceMinutes,
      compatibleBand: null,
      limitation: targetMissing
        ? "Planned duration is unavailable."
        : "Athlete session-length preference is unavailable.",
    };
  }
  const preference = input.athletePreferenceMinutes;
  const compatibleBand = {
    minMinutes: Math.round(preference * 0.5 * 10) / 10,
    maxMinutes: Math.round(preference * 1.5 * 10) / 10,
  };
  const materialConflict =
    input.targetMaxMinutes! < compatibleBand.minMinutes ||
    input.targetMinMinutes! > compatibleBand.maxMinutes;
  return {
    algorithmVersion: DURATION_TARGET_CONSISTENCY_ALGORITHM_VERSION,
    status: materialConflict ? "material_conflict" : "consistent",
    athletePreferenceMinutes: preference,
    compatibleBand,
    limitation: materialConflict
      ? "The frozen workout target is materially inconsistent with the athlete session-length preference."
      : null,
  };
}

export function calculateDurationAdherence(input: {
  targetMinMinutes: number | null;
  targetMaxMinutes: number | null;
  actualMinutes: number | null;
  targetSource?: PlannedDurationSource | null;
  athletePreferenceMinutes?: number | null;
}): DurationAdherence {
  const { targetMinMinutes, targetMaxMinutes, actualMinutes } = input;
  const targetMissing = targetMinMinutes == null && targetMaxMinutes == null;
  if ((targetMinMinutes == null) !== (targetMaxMinutes == null)) {
    throw new Error("Planned duration requires both minimum and maximum minutes.");
  }
  if (
    !targetMissing &&
    (!Number.isFinite(targetMinMinutes) ||
      !Number.isFinite(targetMaxMinutes) ||
      targetMinMinutes! <= 0 ||
      targetMaxMinutes! < targetMinMinutes!)
  ) {
    throw new Error("Planned duration range is invalid.");
  }
  if (actualMinutes != null && (!Number.isFinite(actualMinutes) || actualMinutes < 0)) {
    throw new Error("Actual duration must be a non-negative number or null.");
  }
  if (targetMissing && input.targetSource != null) {
    throw new Error("Planned duration source requires a planned duration range.");
  }
  const targetConsistency = assessDurationTargetConsistency({
    targetMinMinutes,
    targetMaxMinutes,
    athletePreferenceMinutes: input.athletePreferenceMinutes ?? null,
  });
  if (targetConsistency.status === "material_conflict") {
    return {
      algorithmVersion: DURATION_ADHERENCE_ALGORITHM_VERSION,
      target: { minMinutes: targetMinMinutes!, maxMinutes: targetMaxMinutes! },
      targetSource: input.targetSource ?? null,
      targetConsistency,
      actualMinutes,
      status: "unknown",
      varianceMinutes: null,
      variancePercentage: null,
      comparisonBoundaryMinutes: null,
      toleranceMinutes: null,
      withinTolerance: null,
      limitation: targetConsistency.limitation,
    };
  }
  if (targetMissing || actualMinutes == null) {
    return {
      algorithmVersion: DURATION_ADHERENCE_ALGORITHM_VERSION,
      target: targetMissing
        ? null
        : { minMinutes: targetMinMinutes!, maxMinutes: targetMaxMinutes! },
      targetSource: input.targetSource ?? null,
      targetConsistency,
      actualMinutes,
      status: "unknown",
      varianceMinutes: null,
      variancePercentage: null,
      comparisonBoundaryMinutes: null,
      toleranceMinutes: null,
      withinTolerance: null,
      limitation: targetMissing
        ? "Planned duration is unavailable."
        : "Supported active duration is unavailable.",
    };
  }

  const minimum = targetMinMinutes!;
  const maximum = targetMaxMinutes!;
  const status = actualMinutes < minimum
    ? "under_target"
    : actualMinutes > maximum
      ? "over_target"
      : "within_target";
  const comparisonBoundaryMinutes = status === "under_target"
    ? minimum
    : status === "over_target"
      ? maximum
      : null;
  const varianceMinutes = comparisonBoundaryMinutes == null
    ? 0
    : Math.round((actualMinutes - comparisonBoundaryMinutes) * 10) / 10;
  const variancePercentage = comparisonBoundaryMinutes == null
    ? 0
    : Math.round((varianceMinutes / comparisonBoundaryMinutes) * 1_000) / 10;
  const toleranceReference = comparisonBoundaryMinutes ?? maximum;
  const toleranceMinutes = Math.max(
    5,
    Math.round(toleranceReference) / 10,
  );
  return {
    algorithmVersion: DURATION_ADHERENCE_ALGORITHM_VERSION,
    target: { minMinutes: minimum, maxMinutes: maximum },
    targetSource: input.targetSource ?? null,
    targetConsistency,
    actualMinutes,
    status,
    varianceMinutes,
    variancePercentage,
    comparisonBoundaryMinutes,
    toleranceMinutes,
    withinTolerance: Math.abs(varianceMinutes) <= toleranceMinutes,
    limitation: null,
  };
}

export type MeasurementSemanticsAssessment = {
  supported: boolean;
  countingBasisKnown: boolean;
  progressionEligible: boolean;
  limitation: string | null;
};

export function deriveMeasurementKind(input: {
  metricType: string;
  loadSemantics: string | null;
}): MeasurementKind {
  switch (input.metricType) {
    case "weight_reps":
      return input.loadSemantics === "bodyweight"
        ? "bodyweight_repetitions"
        : "loaded_repetitions";
    case "assisted_reps":
      return "assisted_repetitions";
    case "reps":
      return input.loadSemantics === "bodyweight"
        ? "bodyweight_repetitions"
        : "repetitions";
    case "duration":
      return "duration";
    case "distance_duration":
    case "activity":
      return "distance_duration";
    default:
      return "unknown";
  }
}

export function resolveFrozenCountingBasis(input: {
  semanticsVersion: number | null | undefined;
  basis: string | null | undefined;
}): CountingBasis {
  return input.semanticsVersion === 1 && input.basis === "not_applicable"
    ? "not_applicable"
    : "unknown";
}

export function deriveReportingCountingBasis(input: {
  measurementKind: MeasurementKind;
  isUnilateral: boolean | null;
}): CountingBasis {
  const parsed = z
    .object({
      measurementKind: measurementKindSchema,
      isUnilateral: z.boolean().nullable(),
    })
    .strict()
    .parse(input);
  if (parsed.measurementKind === "distance_duration") return "not_applicable";
  // Current exercise laterality is mutable and is not a historical counting-
  // basis snapshot. Until a real writer stores total/per-side/hold meaning,
  // repetition and duration evidence must remain explicitly unknown.
  void parsed.isUnilateral;
  return "unknown";
}

export function assessMeasurementSemantics(input: {
  measurementKind: MeasurementKind;
  countingBasis: CountingBasis;
}): MeasurementSemanticsAssessment {
  const parsed = z
    .object({
      measurementKind: measurementKindSchema,
      countingBasis: countingBasisSchema,
    })
    .strict()
    .parse(input);
  if (parsed.measurementKind === "unknown") {
    return {
      supported: false,
      countingBasisKnown: parsed.countingBasis !== "unknown",
      progressionEligible: false,
      limitation: "Measurement kind is unknown.",
    };
  }
  if (parsed.countingBasis === "unknown") {
    return {
      supported: false,
      countingBasisKnown: false,
      progressionEligible: false,
      limitation: "Counting basis is unknown.",
    };
  }
  const validBasis = parsed.measurementKind === "duration"
    ? ["total", "per_side", "hold"].includes(parsed.countingBasis)
    : parsed.measurementKind === "distance_duration"
      ? parsed.countingBasis === "not_applicable" ||
        parsed.countingBasis === "total"
      : parsed.measurementKind === "repetitions" ||
          parsed.measurementKind === "bodyweight_repetitions"
        ? ["total", "per_side", "alternating_total", "not_applicable"].includes(
            parsed.countingBasis,
          )
        : ["total", "per_side", "alternating_total", "not_applicable"].includes(
            parsed.countingBasis,
          );
  return validBasis
    ? {
        supported: true,
        countingBasisKnown: true,
        progressionEligible: true,
        limitation: null,
      }
    : {
        supported: false,
        countingBasisKnown: true,
        progressionEligible: false,
        limitation: "Counting basis is incompatible with the measurement kind.",
      };
}

export function classifyReportingTargetOutcome(input: {
  setSemantics: SetMetricContainment;
  measurementKind: MeasurementKind;
  countingBasis: CountingBasis;
  originalPlanned: boolean;
  performed: boolean;
  completed: boolean;
  asPlanned: boolean;
  exactOccurrenceLinkage: boolean;
  reps: number | null;
  weight: number | null;
  weightUnit: "lb" | "kg" | null;
  targetRepsMin: number | null;
  targetRepsMax: number | null;
  targetLoad: number | null;
  targetLoadUnit: "lb" | "kg" | null;
  targetLoadPercent: number | null;
  targetLoadText: string | null;
}): TargetOutcome {
  return classifyReportingTargetDimensions(input).overall;
}

export function classifyReportingTargetDimensions(input: {
  setSemantics: SetMetricContainment;
  measurementKind: MeasurementKind;
  countingBasis: CountingBasis;
  originalPlanned: boolean;
  performed: boolean;
  completed: boolean;
  asPlanned: boolean;
  exactOccurrenceLinkage: boolean;
  reps: number | null;
  weight: number | null;
  weightUnit: "lb" | "kg" | null;
  targetRepsMin: number | null;
  targetRepsMax: number | null;
  targetLoad: number | null;
  targetLoadUnit: "lb" | "kg" | null;
  targetLoadPercent: number | null;
  targetLoadText: string | null;
}): PrescriptionDimensionOutcome {
  if (
    !input.originalPlanned ||
    !input.performed ||
    !input.completed ||
    !input.asPlanned ||
    !input.exactOccurrenceLinkage ||
    !assessMeasurementSemantics({
      measurementKind: input.measurementKind,
      countingBasis: input.countingBasis,
    }).progressionEligible
  ) {
    return unavailablePrescriptionDimensions({
      targetRepsMin: input.targetRepsMin,
      targetRepsMax: input.targetRepsMax,
      targetLoad: input.targetLoad,
      targetLoadUnit: input.targetLoadUnit,
      targetLoadPercent: input.targetLoadPercent,
      targetLoadText: input.targetLoadText,
      limitation: "reporting_evidence_unavailable",
    });
  }
  return classifyPrescriptionDimensions({
    semantics: input.setSemantics,
    reps: input.reps,
    weight: input.weight,
    weightUnit: input.weightUnit,
    targetRepsMin: input.targetRepsMin,
    targetRepsMax: input.targetRepsMax,
    targetLoad: input.targetLoad,
    targetLoadUnit: input.targetLoadUnit,
    targetLoadPercent: input.targetLoadPercent,
    targetLoadText: input.targetLoadText,
  });
}

export function formatNonLoadQuantity(input: {
  measurementKind: Extract<
    MeasurementKind,
    "bodyweight_repetitions" | "repetitions" | "duration"
  >;
  value: number;
  countingBasis: CountingBasis;
}): string {
  if (!Number.isFinite(input.value) || input.value < 0) {
    throw new Error("Measurement value must be non-negative.");
  }
  if (input.measurementKind === "duration") {
    if (input.countingBasis === "hold") return `${input.value}-second hold`;
    if (input.countingBasis === "per_side") {
      return `${input.value} seconds per side`;
    }
    if (input.countingBasis === "total") return `${input.value} seconds total`;
    return `${input.value} seconds (counting basis unknown)`;
  }
  const prefix = input.measurementKind === "bodyweight_repetitions"
    ? "bodyweight × "
    : "";
  if (input.countingBasis === "not_applicable") {
    return `${prefix}${input.value} reps`;
  }
  if (input.countingBasis === "per_side") {
    return `${prefix}${input.value} reps per side`;
  }
  if (input.countingBasis === "alternating_total") {
    return `${prefix}${input.value} alternating reps total`;
  }
  if (input.countingBasis === "total") {
    return `${prefix}${input.value} reps total`;
  }
  return `${prefix}${input.value} reps (counting basis unknown)`;
}

export type NonCompletionReasonInput = {
  occurrenceId: string;
  sessionId: string;
  reason: StructuredNonCompletionReason;
};

export type DominantReasonSummary = {
  algorithmVersion: typeof NON_COMPLETION_PATTERN_ALGORITHM_VERSION;
  coverage: CoverageMetric;
  counts: Array<{
    reason: StructuredNonCompletionReason;
    occurrences: number;
    sessions: number;
  }>;
  dominantReason: StructuredNonCompletionReason | null;
  status:
    | "dominant"
    | "mixed"
    | "incomplete_denominator"
    | "insufficient_coverage"
    | "insufficient_sample_size";
};

export function summarizeDominantNonCompletionReason(
  input: NonCompletionReasonInput[],
  options: { denominatorComplete?: boolean } = {},
): DominantReasonSummary {
  const parsed = z
    .array(
      z
        .object({
          occurrenceId: z.string().trim().min(1),
          sessionId: z.string().trim().min(1),
          reason: structuredNonCompletionReasonSchema,
        })
        .strict(),
    )
    .parse(input);
  const occurrenceIds = new Set<string>();
  for (const item of parsed) {
    if (occurrenceIds.has(item.occurrenceId)) {
      throw new Error(`Duplicate non-completion occurrence ID: ${item.occurrenceId}`);
    }
    occurrenceIds.add(item.occurrenceId);
  }
  const classified = parsed.filter(
    (item) => item.reason !== "unknown_historical_outcome",
  );
  const coverage = buildCoverageMetric({
    numerator: classified.length,
    denominator: parsed.length,
  });
  const counts = STRUCTURED_NON_COMPLETION_REASONS.map((reason) => {
    const matching = classified.filter((item) => item.reason === reason);
    return {
      reason,
      occurrences: matching.length,
      sessions: new Set(matching.map((item) => item.sessionId)).size,
    };
  })
    .filter((item) => item.occurrences > 0)
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.reason.localeCompare(right.reason),
    );

  if (options.denominatorComplete === false) {
    return {
      algorithmVersion: NON_COMPLETION_PATTERN_ALGORITHM_VERSION,
      coverage,
      counts,
      dominantReason: null,
      status: "incomplete_denominator",
    };
  }
  if (parsed.length < 2) {
    return {
      algorithmVersion: NON_COMPLETION_PATTERN_ALGORITHM_VERSION,
      coverage,
      counts,
      dominantReason: null,
      status: "insufficient_sample_size",
    };
  }
  if (parsed.length === 0 || classified.length / parsed.length < 0.8) {
    return {
      algorithmVersion: NON_COMPLETION_PATTERN_ALGORITHM_VERSION,
      coverage,
      counts,
      dominantReason: null,
      status: "insufficient_coverage",
    };
  }
  const top = counts[0];
  const tied = top != null && counts[1]?.occurrences === top.occurrences;
  if (
    top == null ||
    tied ||
    top.occurrences / classified.length <= 0.5
  ) {
    return {
      algorithmVersion: NON_COMPLETION_PATTERN_ALGORITHM_VERSION,
      coverage,
      counts,
      dominantReason: null,
      status: "mixed",
    };
  }
  if (top.occurrences < 2 || top.sessions < 2) {
    return {
      algorithmVersion: NON_COMPLETION_PATTERN_ALGORITHM_VERSION,
      coverage,
      counts,
      dominantReason: null,
      status: "insufficient_sample_size",
    };
  }
  return {
    algorithmVersion: NON_COMPLETION_PATTERN_ALGORITHM_VERSION,
    coverage,
    counts,
    dominantReason: top.reason,
    status: "dominant",
  };
}

export const WARMUP_OUTCOMES = [
  "completed",
  "skipped",
  "session_ended_before_completion",
  "pending",
  "historical_unknown",
] as const;
export type WarmupOutcome = (typeof WARMUP_OUTCOMES)[number];

export const warmupOccurrenceSchema = z
  .object({
    id: z.string().trim().min(1),
    planned: z.boolean(),
    outcome: z.enum(WARMUP_OUTCOMES),
    reason: structuredNonCompletionReasonSchema.nullable(),
    note: z.string().nullable(),
    painReported: z.boolean(),
    changed: z.boolean(),
    unusualLoad: z.boolean(),
    failedMovement: z.boolean(),
    changedWorkingPrescription: z.boolean(),
  })
  .strict();
export type WarmupOccurrence = z.infer<typeof warmupOccurrenceSchema>;

const NOTABLE_WARMUP_REASONS = new Set<StructuredNonCompletionReason>([
  "equipment_unavailable_incompatible",
  "pain_discomfort",
  "technical_app_issue",
  "interruption",
  "program_change",
]);

export function isWarmupNotable(input: WarmupOccurrence): boolean {
  const warmup = warmupOccurrenceSchema.parse(input);
  return (
    warmup.painReported ||
    Boolean(warmup.note?.trim()) ||
    warmup.changed ||
    warmup.unusualLoad ||
    warmup.failedMovement ||
    warmup.changedWorkingPrescription ||
    (warmup.reason != null && NOTABLE_WARMUP_REASONS.has(warmup.reason))
  );
}

export type WarmupSummary = {
  algorithmVersion: typeof WARMUP_SUMMARY_ALGORITHM_VERSION;
  planned: number;
  unplanned: number;
  completed: number;
  skipped: number;
  sessionEndedBeforeCompletion: number;
  pending: number;
  historicalUnknown: number;
  reasons: Partial<Record<StructuredNonCompletionReason, number>>;
  notableOccurrenceIds: string[];
  expandDetails: boolean;
};

export function summarizeWarmups(input: WarmupOccurrence[]): WarmupSummary {
  const warmups = z.array(warmupOccurrenceSchema).parse(input);
  const planned = warmups.filter((warmup) => warmup.planned);
  const reasons: Partial<Record<StructuredNonCompletionReason, number>> = {};
  for (const warmup of planned) {
    if (warmup.reason != null) {
      reasons[warmup.reason] = (reasons[warmup.reason] ?? 0) + 1;
    }
  }
  const notableOccurrenceIds = warmups
    .filter(isWarmupNotable)
    .map((warmup) => warmup.id);
  return {
    algorithmVersion: WARMUP_SUMMARY_ALGORITHM_VERSION,
    planned: planned.length,
    unplanned: warmups.length - planned.length,
    completed: planned.filter((warmup) => warmup.outcome === "completed").length,
    skipped: planned.filter((warmup) => warmup.outcome === "skipped").length,
    sessionEndedBeforeCompletion: planned.filter(
      (warmup) => warmup.outcome === "session_ended_before_completion",
    ).length,
    pending: planned.filter((warmup) => warmup.outcome === "pending").length,
    historicalUnknown: planned.filter(
      (warmup) => warmup.outcome === "historical_unknown",
    ).length,
    reasons,
    notableOccurrenceIds,
    expandDetails: notableOccurrenceIds.length > 0,
  };
}

export function formatWarmupSummary(summary: WarmupSummary): string {
  if (summary.planned === 0) {
    return summary.unplanned > 0
      ? `Warm-up: no planned elements recorded; ${summary.unplanned} workout-only element${summary.unplanned === 1 ? "" : "s"} retained.`
      : "Warm-up: no planned elements recorded.";
  }
  const element = summary.planned === 1 ? "element" : "elements";
  let text = `Warm-up: ${summary.completed} of ${summary.planned} planned ${element} completed.`;
  const timeLimited = summary.reasons.time_limit_reached ?? 0;
  if (timeLimited > 0) {
    text += timeLimited === summary.skipped
      ? ` ${timeLimited} skipped because the session time limit was reached.`
      : ` ${timeLimited} not completed because the session time limit was reached.`;
  }
  if (summary.historicalUnknown > 0) {
    text += ` ${summary.historicalUnknown} historical outcome${
      summary.historicalUnknown === 1 ? " is" : "s are"
    } unknown.`;
  }
  return text;
}

export const COACH_SUMMARY_SECTIONS = [
  "training_exposure",
  "program_execution",
  "progression",
  "pain",
  "data_confidence",
] as const;
export type CoachSummarySection = (typeof COACH_SUMMARY_SECTIONS)[number];

export const coachSummaryStatementSchema = z
  .object({
    id: z.string().trim().min(1),
    section: z.enum(COACH_SUMMARY_SECTIONS),
    ruleId: z.string().trim().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    ruleVersion: z.string().trim().regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/),
    text: z.string().trim().min(1).max(1_000),
    conclusionStrength: z.enum([
      "fact",
      "qualified_conclusion",
      "insufficient_evidence",
    ]),
    evidenceRefs: z.array(evidenceRefSchema).min(1),
    coverageMetricId: z.string().trim().min(1).nullable(),
    limitations: z.array(z.string().trim().min(1).max(500)),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.conclusionStrength !== "fact" &&
      value.limitations.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "Qualified and insufficient-evidence statements need a limitation.",
      });
    }
    if (value.section === "data_confidence" && value.coverageMetricId == null) {
      context.addIssue({
        code: "custom",
        path: ["coverageMetricId"],
        message: "Data-confidence statements must identify their coverage metric.",
      });
    }
  });
export type CoachSummaryStatement = z.infer<
  typeof coachSummaryStatementSchema
>;

export type CoachSummary = {
  semanticVersion: typeof TRAINING_REPORT_SEMANTIC_VERSION;
  ruleVersion: typeof COACH_SUMMARY_RULES_VERSION;
  wordCount: number;
  statements: CoachSummaryStatement[];
};

export function buildCoachSummary(
  input: CoachSummaryStatement[],
): CoachSummary {
  const statements = z.array(coachSummaryStatementSchema).parse(input);
  const statementIds = new Set<string>();
  for (const statement of statements) {
    if (statementIds.has(statement.id)) {
      throw new Error(`Duplicate Coach Summary statement ID: ${statement.id}`);
    }
    statementIds.add(statement.id);
  }
  const missingSections = COACH_SUMMARY_SECTIONS.filter(
    (section) => !statements.some((statement) => statement.section === section),
  );
  if (missingSections.length > 0) {
    throw new Error(
      `Coach Summary is missing sections: ${missingSections.join(", ")}`,
    );
  }
  const sorted = [...statements].sort(
    (left, right) =>
      COACH_SUMMARY_SECTIONS.indexOf(left.section) -
        COACH_SUMMARY_SECTIONS.indexOf(right.section) ||
      left.id.localeCompare(right.id),
  );
  const wordCount = sorted.reduce(
    (total, statement) =>
      total + statement.text.split(/\s+/u).filter(Boolean).length,
    0,
  );
  if (wordCount > 350) {
    throw new Error("Coach Summary must not exceed 350 words.");
  }
  return {
    semanticVersion: TRAINING_REPORT_SEMANTIC_VERSION,
    ruleVersion: COACH_SUMMARY_RULES_VERSION,
    wordCount,
    statements: sorted,
  };
}
