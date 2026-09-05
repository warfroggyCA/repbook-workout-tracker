import { describe, expect, it } from "vitest";
import {
  classifyPrescriptionOutcome,
  classifySetMetricContainment,
  legacyTargetMetProjection,
  recomputeRestoredTargetMet,
  resolveFutureSetWriterMetricType,
  validateSetWriterShape,
  type PerformedMetricType,
  type SetLoadEntryMeaning,
} from "@/lib/set-metric-semantics";

function classify(
  overrides: Partial<Parameters<typeof classifySetMetricContainment>[0]> = {},
) {
  return classifySetMetricContainment({
    recordedMetricType: "weight_reps",
    currentExerciseMetricType: "weight_reps",
    loadType: "barbell",
    loadSemantics: "total",
    loadEntryMeaning: "total_system",
    weight: 100,
    reps: 8,
    ...overrides,
  });
}

describe("performed-set semantic containment", () => {
  it("recomputes restore outcomes only from retained supported meaning", () => {
    const supported = {
      recordedMetricType: "weight_reps" as const,
      performedSemanticsVersion: 1,
      performedLoadType: "barbell",
      performedLoadSemantics: "total",
      loadEntryMeaning: "total_system",
      weight: 100,
      weightUnit: "lb" as const,
      reps: 8,
      targetRepsMin: 8,
      targetLoad: 100,
      targetLoadUnit: "lb" as const,
      modificationType: "as_planned",
    };
    expect(recomputeRestoredTargetMet(supported)).toBe(true);
    expect(
      recomputeRestoredTargetMet({ ...supported, weight: 95 }),
    ).toBe(false);
    expect(
      recomputeRestoredTargetMet({
        ...supported,
        performedSemanticsVersion: null,
        performedLoadType: null,
        performedLoadSemantics: null,
      }),
    ).toBeNull();
    expect(
      recomputeRestoredTargetMet({
        ...supported,
        recordedMetricType: "assisted_reps",
        performedLoadSemantics: "assistance",
      }),
    ).toBeNull();
    expect(
      recomputeRestoredTargetMet({
        ...supported,
        targetRepsMin: null,
      }),
    ).toBeNull();
  });

  it("records nonnumeric band work as repetitions without relabeling other metrics", () => {
    expect(
      resolveFutureSetWriterMetricType({
        metricType: "weight_reps",
        loadSemantics: "resistance_band",
      }),
    ).toBe("reps");
    expect(
      resolveFutureSetWriterMetricType({
        metricType: "weight_reps",
        loadSemantics: "total",
      }),
    ).toBe("weight_reps");
    expect(
      resolveFutureSetWriterMetricType({
        metricType: "assisted_reps",
        loadSemantics: "assistance",
      }),
    ).toBe("assisted_reps");
  });

  it("keeps versioned band repetitions observable but ineligible for claims", () => {
    expect(
      classify({
        recordedMetricType: "reps",
        performedSemanticsVersion: 1,
        performedLoadType: "external",
        performedLoadSemantics: "resistance_band",
        currentExerciseMetricType: "weight_reps",
        loadType: "external",
        loadSemantics: "resistance_band",
        loadEntryMeaning: "legacy_unknown",
        weight: null,
        reps: 12,
      }),
    ).toMatchObject({
      measurementMeaning: "reps",
      evidenceProvenance: "performed_semantics_snapshot",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "band_resistance_not_numeric",
    });
  });

  it("keeps the supported write matrix narrow and gives a compatible alternative", () => {
    expect(
      validateSetWriterShape({
        metricType: "weight_reps",
        weight: 100,
        weightUnit: "lb",
        reps: 8,
      }),
    ).toEqual({ ok: true, metricType: "weight_reps" });
    expect(
      validateSetWriterShape({
        metricType: "reps",
        weight: null,
        weightUnit: null,
        reps: 8,
      }),
    ).toEqual({ ok: true, metricType: "reps" });
    expect(
      validateSetWriterShape({
        metricType: "assisted_reps",
        weight: 80,
        weightUnit: "lb",
        reps: 8,
      }),
    ).toEqual({ ok: true, metricType: "assisted_reps" });

    expect(
      validateSetWriterShape({
        metricType: "assisted_reps",
        weight: null,
        weightUnit: null,
        reps: 8,
      }),
    ).toMatchObject({
      ok: false,
      reason: "assisted_reps_requires_numeric_assistance",
    });
    expect(
      validateSetWriterShape({
        metricType: "reps",
        weight: 10,
        weightUnit: "lb",
        reps: 8,
      }),
    ).toMatchObject({ ok: false, reason: "reps_cannot_include_load" });
    expect(
      validateSetWriterShape({
        metricType: "weight_reps",
        weight: null,
        weightUnit: null,
        reps: 8,
      }),
    ).toMatchObject({ ok: false, reason: "weight_reps_requires_load" });
    expect(
      validateSetWriterShape({
        metricType: "reps",
        loadSemantics: "assistance",
        weight: null,
        weightUnit: null,
        reps: 8,
      }),
    ).toMatchObject({ ok: false, reason: "metric_semantics_conflict" });
    expect(
      validateSetWriterShape({
        metricType: "weight_reps",
        weight: 100,
        weightUnit: "lb",
        reps: null,
      }),
    ).toMatchObject({ ok: false, reason: "measurement_shape_conflict" });

    expect(
      validateSetWriterShape({
        metricType: "duration",
        weight: null,
        weightUnit: null,
        reps: 8,
        durationSeconds: null,
      }),
    ).toMatchObject({
      ok: false,
      reason: "duration_requires_time",
    });
    expect(
      validateSetWriterShape({
        metricType: "distance_duration",
        weight: null,
        weightUnit: null,
        reps: 8,
        distanceKm: null,
        durationSeconds: null,
      }),
    ).toMatchObject({
      ok: false,
      reason: "distance_duration_requires_distance",
    });

    const activityRefusal = validateSetWriterShape({
      metricType: "activity",
      weight: null,
      weightUnit: null,
      reps: 8,
    });
    expect(activityRefusal).toMatchObject({
        ok: false,
        reason: "unsupported_metric",
    });
    if (activityRefusal.ok) throw new Error("Expected a refusal");
    expect(activityRefusal.message).toContain("activity flow");
  });

  it("separates measurement, direction, outcome, comparability, eligibility, and provenance", () => {
    expect(classify()).toEqual({
      measurementMeaning: "weight_reps",
      difficultyDirection: "higher_load_is_harder",
      prescriptionOutcomeEligible: true,
      longitudinalComparable: true,
      loadedWorkEligible: true,
      estimatedStrengthEligible: true,
      personalRecordEligible: true,
      automaticProgressionEligible: true,
      evidenceProvenance: "recorded_metric_and_current_catalog_agree",
      exclusionReason: null,
    });

    expect(
      classify({
        recordedMetricType: "assisted_reps",
        currentExerciseMetricType: "assisted_reps",
        loadSemantics: "assistance",
        loadEntryMeaning: "displayed_stack",
      }),
    ).toMatchObject({
      measurementMeaning: "assisted_reps",
      difficultyDirection: "lower_assistance_is_harder",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "assistance_not_comparable",
    });
  });

  it("suppresses every unproven load meaning with a stable reason", () => {
    const cases: Array<{
      loadSemantics: string;
      loadEntryMeaning: SetLoadEntryMeaning;
      reason: ReturnType<typeof classify>["exclusionReason"];
    }> = [
      {
        loadSemantics: "per_implement",
        loadEntryMeaning: "total_system",
        reason: "per_implement_not_aggregatable",
      },
      {
        loadSemantics: "added_weight",
        loadEntryMeaning: "total_system",
        reason: "added_weight_missing_system_load",
      },
      {
        loadSemantics: "machine_stack",
        loadEntryMeaning: "per_stack",
        reason: "machine_geometry_not_comparable",
      },
      {
        loadSemantics: "machine_stack",
        loadEntryMeaning: "combined_stacks",
        reason: "machine_geometry_not_comparable",
      },
      {
        loadSemantics: "resistance_band",
        loadEntryMeaning: "legacy_unknown",
        reason: "band_resistance_not_numeric",
      },
      {
        loadSemantics: "total",
        loadEntryMeaning: "legacy_unknown",
        reason: "unproven_load_entry_meaning",
      },
    ];
    for (const entry of cases) {
      expect(
        classify({
          loadSemantics: entry.loadSemantics,
          loadEntryMeaning: entry.loadEntryMeaning,
        }),
      ).toMatchObject({
        loadedWorkEligible: false,
        estimatedStrengthEligible: false,
        personalRecordEligible: false,
        automaticProgressionEligible: false,
        exclusionReason: entry.reason,
      });
    }
  });

  it("does not broaden loaded calculations beyond the validated barbell fixture", () => {
    expect(classify({ loadType: "dumbbell" })).toMatchObject({
      prescriptionOutcomeEligible: true,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "unvalidated_total_system_implement",
    });
  });

  it("uses current catalog meaning only to suppress a conflicting recorded metric", () => {
    expect(
      classify({
        recordedMetricType: "weight_reps",
        currentExerciseMetricType: "assisted_reps",
        loadSemantics: "assistance",
      }),
    ).toMatchObject({
      evidenceProvenance: "current_catalog_conflict_suppression",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      exclusionReason: "metric_semantics_conflict",
    });
  });

  it("keeps performed-time semantics authoritative when current catalog metadata changes", () => {
    const performed = classify({
      performedSemanticsVersion: 1,
      performedLoadType: "barbell",
      performedLoadSemantics: "total",
      currentExerciseMetricType: "assisted_reps",
      loadType: "external",
      loadSemantics: "assistance",
    });

    expect(performed).toMatchObject({
      evidenceProvenance: "performed_semantics_snapshot",
      loadedWorkEligible: true,
      estimatedStrengthEligible: true,
      automaticProgressionEligible: true,
      exclusionReason: null,
    });
  });

  it("contains schema-27 rows without discarding complete performed-v1 facts", () => {
    expect(
      classify({
        prescribedSemanticsVersion: null,
        performedSemanticsVersion: null,
        performedLoadType: null,
        performedLoadSemantics: null,
      }),
    ).toMatchObject({
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      loadedWorkEligible: false,
      personalRecordEligible: false,
      automaticProgressionEligible: false,
      exclusionReason: "missing_prescribed_semantics",
    });

    expect(
      classify({
        prescribedSemanticsVersion: null,
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
        currentExerciseMetricType: "assisted_reps",
        loadType: "external",
        loadSemantics: "assistance",
      }),
    ).toMatchObject({
      evidenceProvenance: "performed_semantics_snapshot",
      prescriptionOutcomeEligible: false,
      longitudinalComparable: true,
      loadedWorkEligible: true,
      estimatedStrengthEligible: true,
      personalRecordEligible: true,
      automaticProgressionEligible: false,
      exclusionReason: null,
    });
  });

  it("fails closed for incomplete or unsupported performed-time versions", () => {
    expect(
      classify({
        performedSemanticsVersion: 1,
        performedLoadType: null,
        performedLoadSemantics: "total",
      }),
    ).toMatchObject({
      loadedWorkEligible: false,
      exclusionReason: "incomplete_performed_semantics",
    });
    expect(
      classify({
        performedSemanticsVersion: 2,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
      }),
    ).toMatchObject({
      loadedWorkEligible: false,
      exclusionReason: "unsupported_performed_semantics_version",
    });
  });

  it("keeps repetitions comparable without manufacturing load claims", () => {
    expect(
      classify({
        recordedMetricType: "reps",
        currentExerciseMetricType: "reps",
        loadSemantics: "bodyweight",
        loadEntryMeaning: "legacy_unknown",
        weight: null,
        reps: 12,
      }),
    ).toMatchObject({
      difficultyDirection: "higher_repetitions_may_be_harder",
      prescriptionOutcomeEligible: true,
      longitudinalComparable: true,
      loadedWorkEligible: false,
      estimatedStrengthEligible: false,
      personalRecordEligible: true,
      automaticProgressionEligible: false,
      exclusionReason: "repetitions_only",
    });
  });

  it("preserves ordinary total-system target behavior while naming below, at, and above", () => {
    const semantics = classify();
    const outcome = (weight: number, unit: "lb" | "kg" = "lb") =>
      classifyPrescriptionOutcome({
        semantics,
        reps: 8,
        weight,
        weightUnit: unit,
        targetRepsMin: 8,
        targetRepsMax: 10,
        targetLoad: 100,
        targetLoadUnit: "lb",
      });

    expect(outcome(95)).toBe("below");
    expect(outcome(100)).toBe("at");
    expect(outcome(105)).toBe("above");
    expect(legacyTargetMetProjection(outcome(95))).toBe(false);
    expect(legacyTargetMetProjection(outcome(100))).toBe(true);
    expect(legacyTargetMetProjection(outcome(105))).toBe(true);
    expect(outcome(45.359237, "kg")).toBe("at");
  });

  it("never turns assisted values into a prescription outcome", () => {
    const assisted = classify({
      recordedMetricType: "assisted_reps",
      currentExerciseMetricType: "assisted_reps",
      loadSemantics: "assistance",
      loadEntryMeaning: "displayed_stack",
    });
    expect(
      classifyPrescriptionOutcome({
        semantics: assisted,
        reps: 10,
        weight: 150,
        weightUnit: "lb",
        targetRepsMin: 10,
        targetRepsMax: 10,
        targetLoad: 100,
        targetLoadUnit: "lb",
      }),
    ).toBe("unknown");
  });

  it.each([
    "duration",
    "distance_duration",
    "activity",
  ] satisfies PerformedMetricType[])(
    "treats %s as raw task-specific evidence only",
    (recordedMetricType) => {
      expect(
        classify({
          recordedMetricType,
          currentExerciseMetricType: recordedMetricType,
          loadSemantics: "none",
          loadEntryMeaning: "legacy_unknown",
          weight: null,
          reps: null,
        }),
      ).toMatchObject({
        difficultyDirection: "task_specific",
        longitudinalComparable: false,
        exclusionReason: "unsupported_metric",
      });
    },
  );
});


describe("loaded time per side", () => {
  const measurement = { metricType: "weight_duration_per_side" as const, loadSemantics: "per_implement", weight: 20, weightUnit: "lb" as const, reps: null, distanceKm: null, durationSeconds: 35 };
  it("requires both load and actual seconds without reps or distance", () => {
    expect(validateSetWriterShape(measurement)).toEqual({ ok: true, metricType: "weight_duration_per_side" });
    for (const patch of [{ weight: null }, { weightUnit: null }, { durationSeconds: null }, { durationSeconds: 0 }, { reps: 35 }, { distanceKm: 1 }, { loadSemantics: "bodyweight" }, { loadSemantics: null }]) {
      expect(validateSetWriterShape({ ...measurement, ...patch }).ok).toBe(false);
    }
  });
  it("keeps seconds out of repetition target outcomes", () => {
    expect(recomputeRestoredTargetMet({ recordedMetricType: "weight_duration_per_side", performedSemanticsVersion: 1, performedLoadType: "dumbbell", performedLoadSemantics: "per_implement", weight: 20, weightUnit: "lb", reps: null, targetRepsMin: null, targetLoad: 20, targetLoadUnit: "lb", modificationType: "as_planned" })).toBeNull();
  });
});
