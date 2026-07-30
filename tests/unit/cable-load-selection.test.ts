import { describe, expect, it } from "vitest";
import {
  selectCombinedIndependentCableLoad,
  selectCableLoad,
  type CableLoadConfig,
} from "@/engine/cable-load-selection";

const irregularShared: CableLoadConfig = {
  geometryStatus: "known",
  stackCount: 1,
  topology: "shared_selection",
  unit: "lb",
  schedules: [{ stackOrdinal: 0, steps: [10, 15, 22.5, 30, 42.5].map((displayedLoad, stepIndex) => ({
    stepIndex,
    displayedLoad,
    positionLabel: `Pin ${stepIndex + 1}`,
  })) }],
  ratio: { status: "unknown" },
};

describe("selectCableLoad", () => {
  it("uses explicit irregular steps for exact and nearest pin guidance", () => {
    expect(selectCableLoad(22.5, irregularShared)).toMatchObject({
      status: "available",
      selections: [{
        exact: { displayedLoad: 22.5, positionLabel: "Pin 3" },
        nearestBelow: { displayedLoad: 15, positionLabel: "Pin 2" },
        nearestAbove: { displayedLoad: 30, positionLabel: "Pin 4" },
      }],
    });
    expect(selectCableLoad(25, irregularShared)).toMatchObject({
      status: "available",
      selections: [{
        exact: null,
        nearestBelow: { displayedLoad: 22.5 },
        nearestAbove: { displayedLoad: 30 },
      }],
    });
  });

  it("does not manufacture an equivalent resistance when ratio is unknown", () => {
    expect(selectCableLoad(30, irregularShared)).toMatchObject({
      status: "available",
      ratio: { status: "unknown" },
      nominalHandleResistance: null,
    });
  });

  it("applies a known rational movement ratio without replacing displayed selection", () => {
    const result = selectCableLoad(30, {
      ...irregularShared,
      ratio: { status: "known", numerator: 1, denominator: 2 },
    });
    expect(result).toMatchObject({
      status: "available",
      selections: [{ enteredTarget: 30, exact: { displayedLoad: 30 } }],
      ratio: { status: "known", numerator: 1, denominator: 2 },
      nominalHandleResistance: [15],
    });
  });

  it("retains both selections for independent dual stacks", () => {
    const result = selectCableLoad([20, 25], {
      geometryStatus: "known",
      stackCount: 2,
      topology: "independent_per_stack",
      unit: "kg",
      schedules: [
        { stackOrdinal: 2, steps: [5, 15, 25, 35].map((displayedLoad, stepIndex) => ({ stepIndex, displayedLoad, positionLabel: null })) },
        { stackOrdinal: 1, steps: [10, 20, 30].map((displayedLoad, stepIndex) => ({ stepIndex, displayedLoad, positionLabel: null })) },
      ],
      ratio: { status: "known", numerator: 1, denominator: 1 },
    });
    expect(result).toMatchObject({
      status: "available",
      selections: [
        { stackOrdinal: 1, enteredTarget: 20, exact: { displayedLoad: 20 } },
        { stackOrdinal: 2, enteredTarget: 25, exact: { displayedLoad: 25 } },
      ],
      nominalHandleResistance: [20, 25],
    });
  });

  it("allows known stack guidance when only the ratio is unknown", () => {
    expect(
      selectCableLoad(15, { ...irregularShared, geometryStatus: "partial" }),
    ).toMatchObject({
      status: "available",
      selections: [{ exact: { displayedLoad: 15 } }],
      nominalHandleResistance: null,
    });
  });

  it("refuses unknown geometry or missing steps", () => {
    expect(
      selectCableLoad(20, { ...irregularShared, geometryStatus: "unknown" }),
    ).toEqual({ status: "unavailable", reason: "geometry_unknown" });
    expect(
      selectCableLoad(20, { ...irregularShared, schedules: null }),
    ).toEqual({ status: "unavailable", reason: "stack_steps_unknown" });
  });

  it("rejects ambiguous topology, target counts, and invalid ratios", () => {
    expect(selectCableLoad([20, 20], irregularShared)).toEqual({
      status: "unavailable",
      reason: "invalid_configuration",
    });
    expect(
      selectCableLoad([20], {
        ...irregularShared,
        stackCount: 2,
        topology: "independent_per_stack",
        schedules: [
          { stackOrdinal: 1, steps: [10, 20].map((displayedLoad, stepIndex) => ({ stepIndex, displayedLoad, positionLabel: null })) },
          { stackOrdinal: 2, steps: [10, 20].map((displayedLoad, stepIndex) => ({ stepIndex, displayedLoad, positionLabel: null })) },
        ],
      }),
    ).toEqual({ status: "unavailable", reason: "invalid_configuration" });
    expect(
      selectCableLoad(20, {
        ...irregularShared,
        ratio: { status: "known", numerator: 1, denominator: 0 },
      }),
    ).toEqual({ status: "unavailable", reason: "invalid_configuration" });
  });

  it("normalizes duplicate and unsorted steps deterministically", () => {
    const forward = selectCableLoad(17, {
      ...irregularShared,
      schedules: [{ stackOrdinal: 0, steps: [
        { stepIndex: 0, displayedLoad: 30, positionLabel: "Pin 0" },
        { stepIndex: 1, displayedLoad: 20, positionLabel: "Pin 1" },
        { stepIndex: 2, displayedLoad: 10, positionLabel: "Pin 2" },
        { stepIndex: 3, displayedLoad: 20, positionLabel: "Pin 3" },
      ] }],
    });
    const reverse = selectCableLoad(17, {
      ...irregularShared,
      schedules: [{ stackOrdinal: 0, steps: [
        { stepIndex: 2, displayedLoad: 10, positionLabel: "Pin 2" },
        { stepIndex: 0, displayedLoad: 30, positionLabel: "Pin 0" },
        { stepIndex: 3, displayedLoad: 20, positionLabel: "Pin 3" },
        { stepIndex: 1, displayedLoad: 20, positionLabel: "Pin 1" },
      ] }],
    });
    expect(reverse).toEqual(forward);
    expect(forward).toMatchObject({
      selections: [
        {
          nearestBelow: { displayedLoad: 10 },
          nearestAbove: { displayedLoad: 20, stepIndex: 1 },
        },
      ],
    });
  });
});

describe("selectCombinedIndependentCableLoad", () => {
  const independent: CableLoadConfig = {
    geometryStatus: "known",
    stackCount: 2,
    topology: "independent_per_stack",
    unit: "lb",
    schedules: [
      { stackOrdinal: 1, steps: [10, 20, 30].map((displayedLoad, stepIndex) => ({ stepIndex, displayedLoad, positionLabel: `L${stepIndex}` })) },
      { stackOrdinal: 2, steps: [15, 25, 35].map((displayedLoad, stepIndex) => ({ stepIndex, displayedLoad, positionLabel: `R${stepIndex}` })) },
    ],
    ratio: { status: "known", numerator: 1, denominator: 2 },
  };

  it("solves the entered value as one combined total and retains both pins", () => {
    expect(selectCombinedIndependentCableLoad(45, independent)).toMatchObject({
      status: "available",
      exact: {
        displayedTotal: 45,
        selections: [
          { stackOrdinal: 1, step: { displayedLoad: 10, positionLabel: "L0" } },
          { stackOrdinal: 2, step: { displayedLoad: 35, positionLabel: "R2" } },
        ],
        nominalHandleResistanceTotal: 22.5,
      },
    });
  });

  it("shows both neighbouring combined setups without treating the target as per-stack", () => {
    expect(selectCombinedIndependentCableLoad(42, independent)).toMatchObject({
      status: "available",
      exact: null,
      nearestBelow: { displayedTotal: 35 },
      nearestAbove: { displayedTotal: 45 },
    });
  });

  it("does not invent nominal resistance when the ratio is unknown", () => {
    expect(selectCombinedIndependentCableLoad(45, {
      ...independent,
      ratio: { status: "unknown" },
    })).toMatchObject({
      status: "available",
      exact: { displayedTotal: 45, nominalHandleResistanceTotal: null },
    });
  });

  it("refuses shared topology and malformed independent geometry", () => {
    expect(selectCombinedIndependentCableLoad(30, irregularShared)).toEqual({
      status: "unavailable",
      reason: "invalid_configuration",
    });
    expect(selectCombinedIndependentCableLoad(30, {
      ...independent,
      schedules: independent.schedules?.slice(0, 1) ?? null,
    })).toEqual({ status: "unavailable", reason: "invalid_configuration" });
  });
});
