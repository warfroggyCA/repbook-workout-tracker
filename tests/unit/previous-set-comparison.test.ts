import { describe, expect, it } from "vitest";
import {
  areComparableLoadUnits,
  comparePreviousPerformedSet,
  type ComparableSetMeasurement,
  type ComparableSetSemantics,
} from "@/lib/previous-set-comparison";

const exerciseId = "00000000-0000-4000-8000-000000000001";

function semantics(
  overrides: Partial<ComparableSetSemantics> = {},
): ComparableSetSemantics {
  return {
    exerciseId,
    performedSemanticsVersion: 1,
    metricType: "weight_reps",
    performedLoadType: "barbell",
    performedLoadSemantics: "total",
    loadEntryMeaning: "total_system",
    ...overrides,
  };
}

function measurement(
  overrides: Partial<ComparableSetMeasurement> = {},
): ComparableSetMeasurement {
  return {
    weight: 100,
    weightUnit: "lb",
    reps: 8,
    distanceKm: null,
    durationSeconds: null,
    ...overrides,
  };
}

describe("previous performed-set comparison", () => {
  it("accepts explicit lb/kg units at the supported conversion boundary", () => {
    expect(areComparableLoadUnits("lb", "lb")).toBe(true);
    expect(areComparableLoadUnits("lb", "kg")).toBe(true);
    expect(areComparableLoadUnits("kg", "lb")).toBe(true);
    expect(areComparableLoadUnits(null, "lb")).toBe(false);
    expect(areComparableLoadUnits(null, null)).toBe(true);

    expect(comparePreviousPerformedSet({
      target: semantics(),
      targetLoadUnit: "lb",
      candidate: {
        ...semantics(),
        ...measurement({ weight: 45, weightUnit: "kg" }),
      },
    })).toEqual({ comparable: true });
  });

  it("requires exact stable exercise identity without a name or slot fallback", () => {
    expect(comparePreviousPerformedSet({
      target: semantics(),
      candidate: {
        ...semantics({
          exerciseId: "00000000-0000-4000-8000-000000000002",
        }),
        ...measurement(),
      },
    })).toEqual({
      comparable: false,
      reason: "exercise_identity_mismatch",
    });
  });

  it("rejects legacy, incomplete, conflicting, and unsupported semantics", () => {
    expect(comparePreviousPerformedSet({
      target: semantics(),
      candidate: {
        ...semantics({ performedSemanticsVersion: null }),
        ...measurement(),
      },
    })).toMatchObject({
      comparable: false,
      reason: "unsupported_semantics_version",
    });
    expect(comparePreviousPerformedSet({
      target: semantics(),
      candidate: {
        ...semantics({ performedLoadType: null }),
        ...measurement(),
      },
    })).toMatchObject({ comparable: false, reason: "incomplete_semantics" });
    expect(comparePreviousPerformedSet({
      target: semantics(),
      candidate: {
        ...semantics({ performedLoadSemantics: "per_implement" }),
        ...measurement(),
      },
    })).toMatchObject({
      comparable: false,
      reason: "load_semantics_mismatch",
    });
    expect(comparePreviousPerformedSet({
      target: semantics({
        metricType: "activity",
        performedLoadType: "activity",
        performedLoadSemantics: "none",
        loadEntryMeaning: null,
      }),
      candidate: {
        ...semantics({
          metricType: "activity",
          performedLoadType: "activity",
          performedLoadSemantics: "none",
          loadEntryMeaning: null,
        }),
        ...measurement({ weight: null, weightUnit: null, reps: null }),
      },
    })).toMatchObject({ comparable: false, reason: "unsupported_metric" });
  });

  it("requires matching acknowledged load meaning for numeric loads", () => {
    expect(comparePreviousPerformedSet({
      target: semantics({ loadEntryMeaning: "legacy_unknown" }),
      candidate: { ...semantics(), ...measurement() },
    })).toMatchObject({
      comparable: false,
      reason: "load_entry_meaning_unavailable",
    });
    expect(comparePreviousPerformedSet({
      target: semantics(),
      candidate: {
        ...semantics({ loadEntryMeaning: "per_loading_point" }),
        ...measurement(),
      },
    })).toMatchObject({
      comparable: false,
      reason: "load_entry_meaning_mismatch",
    });
  });

  it("accepts supported unweighted shapes and rejects malformed evidence", () => {
    const repetitions = semantics({
      metricType: "reps",
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight",
      loadEntryMeaning: "legacy_unknown",
    });
    expect(comparePreviousPerformedSet({
      target: repetitions,
      candidate: {
        ...repetitions,
        ...measurement({ weight: null, weightUnit: null, reps: 12 }),
      },
    })).toEqual({ comparable: true });
    expect(comparePreviousPerformedSet({
      target: repetitions,
      candidate: {
        ...repetitions,
        ...measurement({ weight: 20, weightUnit: "lb", reps: 12 }),
      },
    })).toMatchObject({
      comparable: false,
      reason: "invalid_measurement_shape",
    });
  });

  it("requires exact retained machine or cable equipment configuration", () => {
    const machine = semantics({
      performedLoadType: "external",
      performedLoadSemantics: "machine_stack",
      loadEntryMeaning: "displayed_stack",
      equipmentProfileKind: "cable_machine",
      equipmentConfigurationHash: "a".repeat(64),
    });
    expect(comparePreviousPerformedSet({
      target: machine,
      candidate: { ...machine, ...measurement() },
    })).toEqual({ comparable: true });
    expect(comparePreviousPerformedSet({
      target: machine,
      candidate: {
        ...machine,
        equipmentConfigurationHash: "b".repeat(64),
        ...measurement(),
      },
    })).toMatchObject({
      comparable: false,
      reason: "equipment_configuration_mismatch",
    });
    expect(comparePreviousPerformedSet({
      target: { ...machine, equipmentConfigurationHash: null },
      candidate: { ...machine, ...measurement() },
    })).toMatchObject({
      comparable: false,
      reason: "equipment_evidence_unavailable",
    });
  });
});
