import { describe, expect, it } from "vitest";
import {
  assessMeasurementSemantics,
  buildCoachSummary,
  buildCoverageMetric,
  buildExerciseReportSummary,
  calculateDurationAdherence,
  classifyReportingTargetOutcome,
  coachSummaryStatementSchema,
  confidenceTierForPercentage,
  deriveExerciseReportingStates,
  formatExerciseReportSummary,
  formatTargetAttainmentConclusion,
  formatNonLoadQuantity,
  formatWarmupSummary,
  partitionPlannedOutcomes,
  summarizeDominantNonCompletionReason,
  summarizeTargetAttainmentCoverage,
  summarizeWarmups,
  type CoachSummaryStatement,
  type ReportingOccurrence,
  type WarmupOccurrence,
} from "@/lib/training-report";

function occurrence(
  id: string,
  overrides: Partial<ReportingOccurrence> = {},
): ReportingOccurrence {
  const value: ReportingOccurrence = {
    id,
    sessionId: "session-1",
    plannedOutcome: true,
    planRelationship: "as_planned",
    performanceState: "performed",
    measurementCoverage: "full",
    resolution: "completed",
    reason: null,
    targetOutcome: "at",
    targetDimensions: {
      algorithmVersion: "prescription-dimension-outcome-v1",
      evaluability: "fully_evaluable",
      repetitions: {
        prescribed: true,
        evaluable: true,
        outcome: "at",
        limitation: null,
      },
      load: {
        prescribed: false,
        evaluable: false,
        outcome: "not_prescribed",
        limitation: null,
      },
      overall: "at",
    },
    measurementKind: "loaded_repetitions",
    countingBasis: "total",
    analyticalEligibility: "eligible",
    analyticalExclusionReason: null,
    ...overrides,
  };
  if (overrides.targetOutcome && !overrides.targetDimensions) {
    value.targetDimensions = {
      ...value.targetDimensions,
      repetitions: {
        ...value.targetDimensions.repetitions,
        evaluable: overrides.targetOutcome !== "unknown",
        outcome: overrides.targetOutcome,
        limitation: overrides.targetOutcome === "unknown"
          ? "test_evidence_unavailable"
          : null,
      },
      evaluability: overrides.targetOutcome === "unknown"
        ? "not_evaluable"
        : "fully_evaluable",
      overall: overrides.targetOutcome,
    };
  }
  return value;
}

function warmup(
  id: string,
  overrides: Partial<WarmupOccurrence> = {},
): WarmupOccurrence {
  return {
    id,
    planned: true,
    outcome: "completed",
    reason: null,
    note: null,
    painReported: false,
    changed: false,
    unusualLoad: false,
    failedMovement: false,
    changedWorkingPrescription: false,
    ...overrides,
  };
}

describe("training-report deterministic semantics", () => {
  it("keeps performance, metric coverage, and substitution orthogonal", () => {
    expect(
      deriveExerciseReportingStates({
        planRelationship: "as_planned",
        performanceState: "performed",
        measurementCoverage: "full",
        resolution: "completed",
      }),
    ).toEqual({
      algorithmVersion: "exercise-reporting-v1",
      executionState: "performed_with_full_metrics",
      substituted: false,
      states: ["performed_with_full_metrics"],
    });

    expect(
      deriveExerciseReportingStates({
        planRelationship: "substituted_in",
        performanceState: "performed",
        measurementCoverage: "partial",
        resolution: "completed",
      }),
    ).toMatchObject({
      executionState: "performed_with_partial_metrics",
      substituted: true,
      states: ["performed_with_partial_metrics", "substituted"],
    });
  });

  it("never describes performed exercise evidence as no sets or not performed", () => {
    const summary = buildExerciseReportSummary({
      exerciseId: "lat-pulldown",
      exerciseName: "Lat Pulldown",
      occurrences: Array.from({ length: 4 }, (_, index) =>
        occurrence(`lat-${index + 1}`, {
          measurementCoverage: "unavailable",
          targetOutcome: "unknown",
          analyticalEligibility: "ineligible",
          analyticalExclusionReason: "performed_result_unavailable",
        }),
      ),
    });

    expect(summary).toMatchObject({
      states: ["performed_metrics_unavailable"],
      prescribedWorkCompletion: "completed_as_prescribed",
      counts: {
        planned: 4,
        performed: 4,
        unavailableMetrics: 4,
      },
    });
    const rendered = formatExerciseReportSummary(summary);
    expect(rendered).toBe(
      "Lat Pulldown — 4 of 4 planned sets completed; performed-set metrics unavailable for progression analysis; 0 of 4 performed sets are eligible for progression analysis (4 performed result unavailable).",
    );
    expect(rendered).not.toMatch(/no sets|not performed/iu);
  });

  it("retains mixed performed, skipped, and session-ended work", () => {
    const summary = buildExerciseReportSummary({
      exerciseId: "row",
      exerciseName: "Barbell Row",
      occurrences: [
        occurrence("row-1"),
        occurrence("row-2"),
        occurrence("row-3", {
          performanceState: "not_performed",
          measurementCoverage: "not_applicable",
          resolution: "skipped",
          reason: "pain_discomfort",
          targetOutcome: "unknown",
        }),
        occurrence("row-4", {
          performanceState: "not_performed",
          measurementCoverage: "not_applicable",
          resolution: "session_ended_before_completion",
          reason: "time_limit_reached",
          targetOutcome: "unknown",
        }),
      ],
    });

    expect(summary.prescribedWorkCompletion).toBe("partial");
    expect(summary.states).toEqual([
      "performed_with_full_metrics",
      "skipped",
      "session_ended_before_completion",
    ]);
    expect(summary.counts).toMatchObject({
      planned: 4,
      performedPlanned: 2,
      performed: 2,
      skipped: 1,
      sessionEndedBeforeCompletion: 1,
    });
    expect(formatExerciseReportSummary(summary)).toBe(
      "Barbell Row — 2 of 4 planned sets completed; 1 skipped; 1 ended with the session (1 pain discomfort, 1 time limit reached); performed-set metrics retained; all 2 performed sets are eligible for progression analysis.",
    );
  });

  it("reports complete retained metrics separately from progression eligibility", () => {
    const summary = buildExerciseReportSummary({
      exerciseId: "dead-bug",
      exerciseName: "Dead Bug",
      occurrences: [
        occurrence("dead-bug-1", {
          measurementKind: "bodyweight_repetitions",
          countingBasis: "unknown",
          targetOutcome: "unknown",
          analyticalEligibility: "ineligible",
          analyticalExclusionReason: "counting_basis_unknown_or_unsupported",
        }),
      ],
    });

    expect(formatExerciseReportSummary(summary)).toBe(
      "Dead Bug — 1 of 1 planned set completed; performed-set metrics retained; 0 of 1 performed set is eligible for progression analysis (1 counting basis unknown or unsupported).",
    );
  });

  it("does not relabel unlinked legacy performance as additional work", () => {
    const summary = buildExerciseReportSummary({
      exerciseId: "legacy-row",
      exerciseName: "Row",
      occurrences: [
        occurrence("legacy-planned", {
          planRelationship: "legacy_unknown",
          performanceState: "historical_unknown",
          measurementCoverage: "unknown",
          resolution: "historical_unknown",
          reason: "unknown_historical_outcome",
          targetOutcome: "unknown",
          measurementKind: "unknown",
          countingBasis: "unknown",
          analyticalEligibility: "unknown",
        }),
        occurrence("legacy-result", {
          plannedOutcome: false,
          planRelationship: "legacy_unknown",
          targetOutcome: "unknown",
          countingBasis: "unknown",
          analyticalEligibility: "ineligible",
          analyticalExclusionReason: "missing_occurrence_linkage",
        }),
      ],
    });

    const rendered = formatExerciseReportSummary(summary);
    expect(rendered).toContain(
      "0 of 1 planned set completed; 1 retained performed set; plan linkage unknown",
    );
    expect(rendered).not.toContain("additional set");
  });

  it("partitions every planned occurrence exactly once and rejects duplicate identities", () => {
    const input = [
      occurrence("evaluable"),
      occurrence("performed-unknown", { targetOutcome: "unknown" }),
      occurrence("skipped", {
        performanceState: "not_performed",
        measurementCoverage: "not_applicable",
        resolution: "skipped",
        reason: "fatigue",
        targetOutcome: "unknown",
      }),
      occurrence("ended", {
        performanceState: "not_performed",
        measurementCoverage: "not_applicable",
        resolution: "session_ended_before_completion",
        reason: "time_limit_reached",
        targetOutcome: "unknown",
      }),
      occurrence("substituted", {
        planRelationship: "substituted_out",
        performanceState: "not_performed",
        measurementCoverage: "not_applicable",
        resolution: "skipped",
        reason: "exercise_substitution",
        targetOutcome: "unknown",
      }),
      occurrence("not-performed", {
        performanceState: "not_performed",
        measurementCoverage: "not_applicable",
        resolution: "not_performed",
        targetOutcome: "unknown",
      }),
      occurrence("pending", {
        performanceState: "not_performed",
        measurementCoverage: "unknown",
        resolution: "pending",
        targetOutcome: "unknown",
      }),
      occurrence("legacy", {
        planRelationship: "legacy_unknown",
        performanceState: "historical_unknown",
        measurementCoverage: "unknown",
        resolution: "historical_unknown",
        reason: "unknown_historical_outcome",
        targetOutcome: "unknown",
        measurementKind: "unknown",
        countingBasis: "unknown",
      }),
      occurrence("extra", {
        plannedOutcome: false,
        planRelationship: "ad_hoc",
        targetOutcome: "unknown",
      }),
    ];
    const partition = partitionPlannedOutcomes(input);

    expect(partition.total).toBe(8);
    expect(partition.counts).toEqual({
      evaluable: 1,
      performed_unevaluable: 1,
      skipped: 1,
      session_ended_before_completion: 1,
      substituted_out: 1,
      not_performed: 1,
      pending: 1,
      historical_unknown: 1,
    });
    expect(Object.keys(partition.byOccurrenceId)).toHaveLength(8);
    expect(() => partitionPlannedOutcomes([input[0]!, input[0]!])).toThrow(
      "Duplicate planned occurrence ID",
    );
  });

  it("leads the August regression with 2-of-64 coverage and withholds a conclusion", () => {
    const outcomes = Array.from({ length: 64 }, (_, index) =>
      index < 2
        ? occurrence(`outcome-${index + 1}`, {
            sessionId: `session-${index + 1}`,
            targetOutcome: "above",
          })
        : occurrence(`outcome-${index + 1}`, {
            sessionId: `session-${(index % 4) + 1}`,
            planRelationship: "legacy_unknown",
            performanceState: "historical_unknown",
            measurementCoverage: "unknown",
            resolution: "historical_unknown",
            reason: "unknown_historical_outcome",
            targetOutcome: "unknown",
            measurementKind: "unknown",
            countingBasis: "unknown",
          }),
    );

    const summary = summarizeTargetAttainmentCoverage(outcomes);
    expect(summary.coverage).toMatchObject({
      numerator: 2,
      denominator: 64,
      percentage: 3.1,
      tier: "low",
    });
    expect(summary.rawStatistic).toEqual({
      below: 0,
      at: 0,
      above: 2,
      atOrAbove: 2,
      evaluable: 2,
      atOrAbovePercentage: 100,
    });
    expect(summary.conclusion).toMatchObject({
      eligible: false,
      status: "insufficient_coverage",
      evaluableSessions: 2,
    });
    expect(summary.partition.total).toBe(64);
    expect(summary.partition.counts.historical_unknown).toBe(62);
  });

  it("renders each target-attainment gate without relabelling sample limits as coverage limits", () => {
    const base = {
      eligible: false,
      minimumCoveragePercentage: 80 as const,
      minimumEvaluableOutcomes: 8 as const,
      minimumSessions: 2 as const,
      evaluableSessions: 0,
      denominatorComplete: true,
    };
    expect(
      formatTargetAttainmentConclusion({
        ...base,
        status: "insufficient_coverage",
      }),
    ).toContain("Coverage is insufficient");
    expect(
      formatTargetAttainmentConclusion({
        ...base,
        status: "insufficient_sample_size",
      }),
    ).toContain("sample is too small");
    expect(
      formatTargetAttainmentConclusion({
        ...base,
        status: "insufficient_session_span",
      }),
    ).toContain("too few sessions");
    expect(
      formatTargetAttainmentConclusion({
        ...base,
        eligible: true,
        status: "eligible",
      }),
    ).toContain("permit a bounded attainment conclusion");
    expect(
      formatTargetAttainmentConclusion({
        ...base,
        denominatorComplete: false,
        status: "incomplete_denominator",
      }),
    ).toContain("denominator is incomplete");
  });

  it("uses one target projector to exclude unknown counting basis while preserving supported loaded comparisons", () => {
    const setSemantics = {
      measurementMeaning: "weight_reps" as const,
      difficultyDirection: "higher_load_is_harder" as const,
      prescriptionOutcomeEligible: true,
      longitudinalComparable: true,
      loadedWorkEligible: true,
      estimatedStrengthEligible: true,
      personalRecordEligible: true,
      automaticProgressionEligible: true,
      evidenceProvenance: "performed_semantics_snapshot" as const,
      exclusionReason: null,
    };
    const base = {
      setSemantics,
      measurementKind: "loaded_repetitions" as const,
      originalPlanned: true,
      performed: true,
      completed: true,
      asPlanned: true,
      exactOccurrenceLinkage: true,
      reps: 8,
      weight: 100,
      weightUnit: "kg" as const,
      targetRepsMin: 8,
      targetRepsMax: 10,
      targetLoad: 90,
      targetLoadUnit: "kg" as const,
      targetLoadPercent: null,
      targetLoadText: null,
    };

    expect(
      classifyReportingTargetOutcome({
        ...base,
        countingBasis: "not_applicable",
      }),
    ).toBe("above");
    expect(
      classifyReportingTargetOutcome({
        ...base,
        countingBasis: "unknown",
      }),
    ).toBe("unknown");
  });

  it("applies coverage, sample-size, and session-span gates in that order", () => {
    const eligible = Array.from({ length: 8 }, (_, index) =>
      occurrence(`eligible-${index}`, {
        sessionId: index < 4 ? "session-a" : "session-b",
        targetOutcome: index % 2 === 0 ? "at" : "above",
      }),
    );
    expect(summarizeTargetAttainmentCoverage(eligible).conclusion).toMatchObject({
      eligible: true,
      status: "eligible",
    });
    expect(
      summarizeTargetAttainmentCoverage(eligible.slice(0, 7)).conclusion.status,
    ).toBe("insufficient_sample_size");
    expect(
      summarizeTargetAttainmentCoverage(
        eligible.map((item) => ({ ...item, sessionId: "one-session" })),
      ).conclusion.status,
    ).toBe("insufficient_session_span");
  });

  it("reports dimension-specific coverage tiers without turning absent data into zero", () => {
    expect(buildCoverageMetric({ numerator: 18, denominator: 100 })).toMatchObject({
      percentage: 18,
      tier: "low",
      availability: "measured",
    });
    expect(
      buildCoverageMetric({
        numerator: 0,
        denominator: 0,
        zeroDenominator: "not_applicable",
      }),
    ).toMatchObject({
      percentage: null,
      tier: null,
      availability: "not_applicable",
    });
    expect(confidenceTierForPercentage(49.9)).toBe("low");
    expect(confidenceTierForPercentage(50)).toBe("moderate");
    expect(confidenceTierForPercentage(80)).toBe("high");
    expect(confidenceTierForPercentage(95)).toBe("very_high");
    expect(() => buildCoverageMetric({ numerator: 2, denominator: 1 })).toThrow();
  });

  it("calculates exact and ranged duration adherence from supported active time", () => {
    expect(
      calculateDurationAdherence({
        targetMinMinutes: 45,
        targetMaxMinutes: 45,
        actualMinutes: 63,
      }),
    ).toEqual({
      algorithmVersion: "duration-adherence-v2",
      target: { minMinutes: 45, maxMinutes: 45 },
      targetSource: null,
      targetConsistency: {
        algorithmVersion: "duration-target-consistency-v1",
        status: "not_assessed",
        athletePreferenceMinutes: null,
        compatibleBand: null,
        limitation: "Athlete session-length preference is unavailable.",
      },
      actualMinutes: 63,
      status: "over_target",
      varianceMinutes: 18,
      variancePercentage: 40,
      comparisonBoundaryMinutes: 45,
      toleranceMinutes: 5,
      withinTolerance: false,
      limitation: null,
    });
    expect(
      calculateDurationAdherence({
        targetMinMinutes: 10,
        targetMaxMinutes: 20,
        targetSource: "program_day_target",
        athletePreferenceMinutes: 45,
        actualMinutes: 73,
      }),
    ).toMatchObject({
      target: { minMinutes: 10, maxMinutes: 20 },
      targetSource: "program_day_target",
      targetConsistency: {
        status: "material_conflict",
        athletePreferenceMinutes: 45,
        compatibleBand: { minMinutes: 22.5, maxMinutes: 67.5 },
      },
      actualMinutes: 73,
      status: "unknown",
      varianceMinutes: null,
      variancePercentage: null,
      withinTolerance: null,
    });
    expect(
      calculateDurationAdherence({
        targetMinMinutes: 35,
        targetMaxMinutes: 45,
        targetSource: "program_day_target",
        athletePreferenceMinutes: 45,
        actualMinutes: 73,
      }),
    ).toMatchObject({
      targetConsistency: { status: "consistent" },
      status: "over_target",
      varianceMinutes: 28,
      variancePercentage: 62.2,
    });
    expect(
      calculateDurationAdherence({
        targetMinMinutes: 40,
        targetMaxMinutes: 45,
        actualMinutes: 42,
      }),
    ).toMatchObject({
      status: "within_target",
      varianceMinutes: 0,
      variancePercentage: 0,
      comparisonBoundaryMinutes: null,
      withinTolerance: true,
    });
    expect(
      calculateDurationAdherence({
        targetMinMinutes: 45,
        targetMaxMinutes: 45,
        actualMinutes: null,
      }),
    ).toMatchObject({
      status: "unknown",
      varianceMinutes: null,
      withinTolerance: null,
      limitation: "Supported active duration is unavailable.",
    });
    expect(() =>
      calculateDurationAdherence({
        targetMinMinutes: 45,
        targetMaxMinutes: null,
        actualMinutes: 45,
      }),
    ).toThrow("both minimum and maximum");
  });

  it("keeps non-load counting basis explicit and excludes unknown meaning", () => {
    expect(
      assessMeasurementSemantics({
        measurementKind: "repetitions",
        countingBasis: "unknown",
      }),
    ).toEqual({
      supported: false,
      countingBasisKnown: false,
      progressionEligible: false,
      limitation: "Counting basis is unknown.",
    });
    expect(
      formatNonLoadQuantity({
        measurementKind: "repetitions",
        value: 20,
        countingBasis: "unknown",
      }),
    ).toBe("20 reps (counting basis unknown)");
    expect(
      formatNonLoadQuantity({
        measurementKind: "repetitions",
        value: 10,
        countingBasis: "per_side",
      }),
    ).toBe("10 reps per side");
    expect(
      formatNonLoadQuantity({
        measurementKind: "duration",
        value: 45,
        countingBasis: "hold",
      }),
    ).toBe("45-second hold");
    expect(
      formatNonLoadQuantity({
        measurementKind: "bodyweight_repetitions",
        value: 12,
        countingBasis: "total",
      }),
    ).toBe("bodyweight × 12 reps total");
  });

  it("calls a reason dominant only with adequate coverage, share, and session span", () => {
    const dominant = summarizeDominantNonCompletionReason([
      {
        occurrenceId: "time-1",
        sessionId: "session-1",
        reason: "time_limit_reached",
      },
      {
        occurrenceId: "time-2",
        sessionId: "session-2",
        reason: "time_limit_reached",
      },
      {
        occurrenceId: "time-3",
        sessionId: "session-2",
        reason: "time_limit_reached",
      },
      {
        occurrenceId: "equipment-1",
        sessionId: "session-3",
        reason: "equipment_unavailable_incompatible",
      },
    ]);
    expect(dominant).toMatchObject({
      dominantReason: "time_limit_reached",
      status: "dominant",
      coverage: { percentage: 100 },
    });

    expect(
      summarizeDominantNonCompletionReason([
        { occurrenceId: "known-1", sessionId: "s1", reason: "fatigue" },
        { occurrenceId: "known-2", sessionId: "s2", reason: "fatigue" },
        { occurrenceId: "known-3", sessionId: "s3", reason: "fatigue" },
        {
          occurrenceId: "unknown",
          sessionId: "s4",
          reason: "unknown_historical_outcome",
        },
      ]).status,
    ).toBe("insufficient_coverage");

    expect(
      summarizeDominantNonCompletionReason([
        { occurrenceId: "time", sessionId: "s1", reason: "time_limit_reached" },
        { occurrenceId: "pain", sessionId: "s2", reason: "pain_discomfort" },
      ]).status,
    ).toBe("mixed");
  });

  it("collapses routine warm-up noise and expands only notable details", () => {
    expect(formatWarmupSummary(summarizeWarmups([]))).toBe(
      "Warm-up: no planned elements recorded.",
    );
    const warmups = [
      ...Array.from({ length: 5 }, (_, index) => warmup(`done-${index}`)),
      warmup("time-1", {
        outcome: "skipped",
        reason: "time_limit_reached",
      }),
      warmup("time-2", {
        outcome: "skipped",
        reason: "time_limit_reached",
      }),
    ];
    const summary = summarizeWarmups(warmups);
    expect(summary).toMatchObject({
      planned: 7,
      completed: 5,
      skipped: 2,
      reasons: { time_limit_reached: 2 },
      notableOccurrenceIds: [],
      expandDetails: false,
    });
    expect(formatWarmupSummary(summary)).toBe(
      "Warm-up: 5 of 7 planned elements completed. 2 skipped because the session time limit was reached.",
    );

    expect(
      summarizeWarmups([
        ...warmups,
        warmup("pain", {
          painReported: true,
          note: "Mild discomfort during the ramp-up",
        }),
      ]),
    ).toMatchObject({
      notableOccurrenceIds: ["pain"],
      expandDetails: true,
    });

    const unresolved = summarizeWarmups([
      warmup("unresolved", { outcome: "historical_unknown" }),
    ]);
    expect(unresolved).toMatchObject({
      planned: 1,
      completed: 0,
      historicalUnknown: 1,
    });
    expect(formatWarmupSummary(unresolved)).toBe(
      "Warm-up: 0 of 1 planned element completed. 1 historical outcome is unknown.",
    );
  });

  it("requires evidence-linked, bounded, deterministic Coach Summary sections", () => {
    const windowRef = {
      kind: "report_window" as const,
      id: "window-14d",
      revision: null,
    };
    const statement = (
      section: CoachSummaryStatement["section"],
      index: number,
    ): CoachSummaryStatement => ({
      id: `statement-${index}`,
      section,
      ruleId: `${section}.rule`,
      ruleVersion: "coach-summary-rules-v1",
      text: `${section.replaceAll("_", " ")} has bounded retained evidence.`,
      conclusionStrength:
        section === "data_confidence" ? "qualified_conclusion" : "fact",
      evidenceRefs: [windowRef],
      coverageMetricId:
        section === "data_confidence" ? "coverage-load-reps" : null,
      limitations:
        section === "data_confidence" ? ["Coverage is not complete."] : [],
    });
    const statements = [
      statement("data_confidence", 5),
      statement("pain", 4),
      statement("training_exposure", 1),
      statement("progression", 3),
      statement("program_execution", 2),
    ];
    const summary = buildCoachSummary(statements);

    expect(summary.semanticVersion).toBe("training-report/3");
    expect(summary.ruleVersion).toBe("coach-summary-rules-v1");
    expect(summary.statements.map((item) => item.section)).toEqual([
      "training_exposure",
      "program_execution",
      "progression",
      "pain",
      "data_confidence",
    ]);
    expect(summary.wordCount).toBeLessThanOrEqual(350);
    expect(() => buildCoachSummary(statements.slice(0, 4))).toThrow(
      "missing sections",
    );
    expect(
      coachSummaryStatementSchema.safeParse({
        ...statement("data_confidence", 6),
        evidenceRefs: [],
      }).success,
    ).toBe(false);
  });
});
