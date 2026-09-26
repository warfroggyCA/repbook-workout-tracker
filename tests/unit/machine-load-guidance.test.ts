import { describe, expect, it } from "vitest";
import {
  formatMachineLoadGuidance,
  machineLoadEntryLabel,
  machineLoadStepsAvailable,
  stepMachineEntryLoad,
} from "@/lib/machine-load-guidance";
import type { MachineLoadConfig } from "@/engine/machine-load-math";

const twoSided: MachineLoadConfig = {
  geometryStatus: "known",
  startingResistance: 20,
  unit: "lb",
  loadingPointCount: 2,
  balancingRule: "identical_each_point",
  targetEntryMeaning: "total_system",
  compatiblePlates: [
    { denomination: 25, quantity: 2 },
    { denomination: 10, quantity: 2 },
    { denomination: 5, quantity: 2 },
  ],
};

describe("live plate-loaded machine guidance", () => {
  it("shows the owner's zero-starting-resistance 100-total example", () => {
    expect(formatMachineLoadGuidance(100, {
      ...twoSided,
      startingResistance: 0,
      compatiblePlates: [{ denomination: 25, quantity: 4 }],
    })).toBe(
      "25 + 25 lb per side · 100 lb total resistance (0 lb starting resistance + 50 lb × 2 sides). The entered 100 lb means total machine resistance.",
    );
  });

  it("shows achievable plates per side and truthful total resistance", () => {
    expect(machineLoadEntryLabel(twoSided)).toBe("Total machine resistance");
    expect(formatMachineLoadGuidance(90, twoSided)).toBe(
      "25 + 10 lb per side · 90 lb total resistance (20 lb starting resistance + 35 lb × 2 sides). The entered 90 lb means total machine resistance.",
    );
  });

  it("keeps per-side entry meaning distinct from total resistance", () => {
    const config = {
      ...twoSided,
      targetEntryMeaning: "per_loading_point" as const,
    };
    expect(machineLoadEntryLabel(config)).toBe("Added plate load per side");
    expect(formatMachineLoadGuidance(35, config)).toContain(
      "90 lb total resistance",
    );
    expect(formatMachineLoadGuidance(35, config)).toContain(
      "entered 35 lb means added plate load per side",
    );
  });

  it("reports incompatible or insufficient owned plates without inventing a setup", () => {
    const guidance = formatMachineLoadGuidance(90, {
      ...twoSided,
      compatiblePlates: [{ denomination: 10, quantity: 2 }],
    });
    expect(guidance).toContain("not achievable with the compatible owned plates");
    expect(guidance).toContain("Nearest lower");
    expect(guidance).not.toContain("Nearest higher");
  });

  it("preserves unknown geometry as displayed-load evidence", () => {
    const config: MachineLoadConfig = {
      geometryStatus: "unknown",
      startingResistance: null,
      unit: null,
      loadingPointCount: null,
      balancingRule: null,
      targetEntryMeaning: null,
      compatiblePlates: [],
    };
    expect(machineLoadEntryLabel(config)).toBe("Displayed machine load");
    expect(formatMachineLoadGuidance(70, config)).toContain(
      "effective total resistance is unknown",
    );
  });

  it("uses the same exact semantics at kg precision boundaries", () => {
    expect(formatMachineLoadGuidance(30, {
      geometryStatus: "known",
      startingResistance: 10,
      unit: "kg",
      loadingPointCount: 2,
      balancingRule: "identical_each_point",
      targetEntryMeaning: "total_system",
      compatiblePlates: [{ denomination: 10, quantity: 2 }],
    })).toContain(
      "10 kg per side · 30 kg total resistance",
    );
  });
});


describe("selected machine weight steps", () => {
  it("uses compatible inventory and machine-wide starting resistance", () => {
    expect(machineLoadStepsAvailable(twoSided)).toBe(true);
    expect(stepMachineEntryLoad(90, 1, twoSided, "lb")).toBe(100);
    expect(stepMachineEntryLoad(90, -1, twoSided, "lb")).toBe(80);
    expect(stepMachineEntryLoad(89, 1, twoSided, "lb")).toBe(90);
    expect(stepMachineEntryLoad(null, 1, twoSided, "lb")).toBe(20);
    expect(stepMachineEntryLoad(100, 1, twoSided, "lb")).toBe(100);
  });

  it("counts single owned plates for an added-plates pulley without inventing resistance", () => {
    const config: MachineLoadConfig = { ...twoSided, startingResistance: null,
      loadingPointCount: 1, balancingRule: "single_point", targetEntryMeaning: "added_plates",
      compatiblePlates: [{ denomination: 25, quantity: 1 }, { denomination: 2.5, quantity: 1 }] };
    expect(stepMachineEntryLoad(25, 1, config, "lb")).toBe(27.5);
    expect(stepMachineEntryLoad(25, -1, config, "lb")).toBe(2.5);
    expect(stepMachineEntryLoad(null, -1, config, "lb")).toBeNull();
    expect(formatMachineLoadGuidance(27.5, config)).toContain("25 + 2.5 lb per loading point");
  });

  it("preserves unknown geometry and never manufactures a step", () => {
    const config = { ...twoSided, geometryStatus: "unknown" as const };
    expect(machineLoadStepsAvailable(config)).toBe(false);
    expect(stepMachineEntryLoad(90, 1, config, "lb")).toBe(90);
    expect(stepMachineEntryLoad(null, 1, config, "lb")).toBeNull();
  });

  it("converts entry units at the boundary and handles round-trip precision", () => {
    const config = { ...twoSided, unit: "kg" as const, startingResistance: 0,
      compatiblePlates: [{ denomination: 10, quantity: 4 }] };
    expect(stepMachineEntryLoad(44.09, 1, config, "lb")).toBe(88.18);
    expect(stepMachineEntryLoad(88.18, -1, config, "lb")).toBe(44.09);
    expect(formatMachineLoadGuidance(44.09, config, "lb")).toContain("10 kg per side");
  });

  it("respects per-point meaning and insufficient plate pairs", () => {
    const config = { ...twoSided, targetEntryMeaning: "per_loading_point" as const,
      compatiblePlates: [{ denomination: 25, quantity: 1 }, { denomination: 5, quantity: 2 }] };
    expect(stepMachineEntryLoad(0, 1, config, "lb")).toBe(5);
    expect(stepMachineEntryLoad(5, 1, config, "lb")).toBe(5);
  });
});
