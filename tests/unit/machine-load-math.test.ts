import { describe, expect, it } from "vitest";
import {
  solveMachineLoad,
  type MachineLoadConfig,
} from "@/engine/machine-load-math";

const knownMachine: MachineLoadConfig = {
  geometryStatus: "known",
  startingResistance: 20,
  unit: "lb",
  loadingPointCount: 2,
  balancingRule: "identical_each_point",
  targetEntryMeaning: "total_system",
  compatiblePlates: [
    { denomination: 25, quantity: 2 },
    { denomination: 10, quantity: 5 },
    { denomination: 5, quantity: 3 },
  ],
};

describe("solveMachineLoad", () => {
  it("treats explicit zero resistance as zero and gives 50 per side for 100 total", () => {
    const result = solveMachineLoad(100, {
      ...knownMachine,
      startingResistance: 0,
      compatiblePlates: [{ denomination: 25, quantity: 4 }],
    });
    expect(result).toMatchObject({
      status: "available",
      canonicalTargetTotal: 100,
      exact: {
        canonicalTotalLoad: 100,
        addedLoadPerPoint: 50,
        platesPerPoint: [25, 25],
        inventoryConsumed: [{ denomination: 25, quantity: 4 }],
      },
    });
  });

  it("solves exact two-point loads and consumes identical plates at every point", () => {
    const result = solveMachineLoad(90, knownMachine);
    expect(result).toMatchObject({
      status: "available",
      canonicalTargetTotal: 90,
      exact: {
        canonicalTotalLoad: 90,
        addedLoadPerPoint: 35,
        platesPerPoint: [25, 10],
        inventoryConsumed: [
          { denomination: 25, quantity: 2 },
          { denomination: 10, quantity: 2 },
        ],
      },
    });
  });

  it("does not turn odd spare plates into symmetric capacity", () => {
    const result = solveMachineLoad(60, {
      ...knownMachine,
      compatiblePlates: [{ denomination: 10, quantity: 3 }],
    });
    expect(result).toMatchObject({
      status: "available",
      exact: null,
      nearestBelow: { canonicalTotalLoad: 40 },
      nearestAbove: null,
    });
  });

  it("requires four identical copies for a four-point machine", () => {
    const result = solveMachineLoad(60, {
      ...knownMachine,
      startingResistance: 0,
      loadingPointCount: 4,
      compatiblePlates: [{ denomination: 10, quantity: 7 }],
    });
    expect(result).toMatchObject({
      status: "available",
      exact: null,
      nearestBelow: { canonicalTotalLoad: 40 },
      nearestAbove: null,
    });
  });

  it("keeps per-point entry separate from canonical total", () => {
    const result = solveMachineLoad(35, {
      ...knownMachine,
      targetEntryMeaning: "per_loading_point",
    });
    expect(result).toMatchObject({
      status: "available",
      enteredTarget: 35,
      canonicalTargetTotal: 90,
      exact: { enteredLoad: 35, canonicalTotalLoad: 90 },
    });
  });

  it("breaks an equally near target toward the lower valid total", () => {
    const result = solveMachineLoad(40, {
      ...knownMachine,
      startingResistance: 20,
      compatiblePlates: [{ denomination: 20, quantity: 2 }],
    });
    expect(result).toMatchObject({
      status: "available",
      exact: null,
      nearest: { canonicalTotalLoad: 20 },
      nearestBelow: { canonicalTotalLoad: 20 },
      nearestAbove: { canonicalTotalLoad: 60 },
    });
  });

  it("supports a true single-point machine", () => {
    const result = solveMachineLoad(55, {
      ...knownMachine,
      loadingPointCount: 1,
      balancingRule: "single_point",
      startingResistance: 20,
      compatiblePlates: [
        { denomination: 25, quantity: 1 },
        { denomination: 10, quantity: 1 },
      ],
    });
    expect(result).toMatchObject({
      status: "available",
      exact: {
        canonicalTotalLoad: 55,
        platesPerPoint: [25, 10],
      },
    });
  });

  it("refuses null or unknown facts instead of assuming zero or all plates", () => {
    expect(
      solveMachineLoad(90, { ...knownMachine, startingResistance: null }),
    ).toEqual({ status: "unavailable", reason: "starting_resistance_unknown" });
    expect(
      solveMachineLoad(90, { ...knownMachine, geometryStatus: "partial" }),
    ).toEqual({ status: "unavailable", reason: "geometry_unknown" });
    expect(
      solveMachineLoad(90, { ...knownMachine, compatiblePlates: null }),
    ).toEqual({ status: "unavailable", reason: "compatible_plates_unknown" });
    expect(
      solveMachineLoad(Number.POSITIVE_INFINITY, knownMachine),
    ).toEqual({ status: "unavailable", reason: "invalid_target" });
    expect(
      solveMachineLoad(-0.01, knownMachine),
    ).toEqual({ status: "unavailable", reason: "invalid_target" });
  });

  it("chooses fewer plates, then the lexicographically heavier list for equal totals", () => {
    const fewer = solveMachineLoad(40, {
      ...knownMachine,
      startingResistance: 0,
      compatiblePlates: [
        { denomination: 20, quantity: 2 },
        { denomination: 10, quantity: 4 },
      ],
    });
    expect(fewer).toMatchObject({ exact: { platesPerPoint: [20] } });

    const heavier = solveMachineLoad(24, {
      ...knownMachine,
      startingResistance: 0,
      compatiblePlates: [
        { denomination: 8, quantity: 2 },
        { denomination: 7, quantity: 2 },
        { denomination: 5, quantity: 2 },
        { denomination: 4, quantity: 4 },
      ],
    });
    expect(heavier).toMatchObject({ exact: { platesPerPoint: [8, 4] } });
  });

  it("is deterministic when inventory rows arrive in another order", () => {
    const forward = solveMachineLoad(90, knownMachine);
    const reversed = solveMachineLoad(90, {
      ...knownMachine,
      compatiblePlates: [...knownMachine.compatiblePlates!].reverse(),
    });
    expect(reversed).toEqual(forward);
  });
});
