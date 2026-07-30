import { describe, expect, it } from "vitest";
import {
  cableEquipmentGeometrySnapshotSchema,
  implementEquipmentGeometrySnapshotSchema,
  machineEquipmentGeometrySnapshotSchema,
} from "@/lib/session-equipment-snapshot-contract";

describe("immutable equipment geometry contract", () => {
  it("preserves the exact 18 lb EZ bar and accepts the complete owned plate pool", () => {
    expect(implementEquipmentGeometrySnapshotSchema.parse({
      version: 1,
      kind: "plate_loaded_implement",
      loadingKind: "ez",
      emptyWeight: 18,
      collarWeight: 0,
      unit: "lb",
      sharedPlatePoolCompatible: true,
      compatiblePlates: [1.25, 2.5, 5, 10].map((denomination) => ({
        denomination,
        quantity: 2,
        unit: "lb",
      })),
    })).toMatchObject({ emptyWeight: 18 });
  });

  it("rejects duplicate, mixed-unit, and noncanonical implement plate evidence", () => {
    const base = {
      version: 1 as const,
      kind: "plate_loaded_implement" as const,
      loadingKind: "ez" as const,
      emptyWeight: 18,
      collarWeight: 0,
      unit: "lb" as const,
      sharedPlatePoolCompatible: true,
      compatiblePlates: [{ denomination: 2.5, quantity: 2, unit: "lb" as const }],
    };
    expect(implementEquipmentGeometrySnapshotSchema.safeParse({
      ...base,
      compatiblePlates: [...base.compatiblePlates, ...base.compatiblePlates],
    }).success).toBe(false);
    expect(implementEquipmentGeometrySnapshotSchema.safeParse({
      ...base,
      compatiblePlates: [{ denomination: 2.5, quantity: 2, unit: "kg" }],
    }).success).toBe(false);
    expect(implementEquipmentGeometrySnapshotSchema.safeParse({
      ...base,
      emptyWeight: 18.001,
    }).success).toBe(false);
  });

  it("enforces known, partial, and unknown machine cross-field meaning", () => {
    const known = {
      version: 1 as const,
      kind: "plate_loaded_machine" as const,
      geometryCertainty: "known" as const,
      startingResistance: 10,
      startingResistanceUnit: "lb" as const,
      loadingPointCount: 4,
      balancingRule: "identical_each_point" as const,
      targetEntryMeaning: "total_system" as const,
      compatiblePlates: [{ denomination: 5, quantity: 4, unit: "lb" as const }],
    };
    expect(machineEquipmentGeometrySnapshotSchema.safeParse(known).success).toBe(true);
    expect(machineEquipmentGeometrySnapshotSchema.safeParse({
      ...known,
      geometryCertainty: "partial",
    }).success).toBe(false);
    expect(machineEquipmentGeometrySnapshotSchema.safeParse({
      ...known,
      geometryCertainty: "unknown",
    }).success).toBe(false);
    expect(machineEquipmentGeometrySnapshotSchema.safeParse({
      ...known,
      loadingPointCount: 1,
    }).success).toBe(false);
  });

  it("requires cable ratio pairs, unique steps, valid indexes, and full known-stack coverage", () => {
    const cable = {
      version: 1 as const,
      kind: "cable_machine" as const,
      geometryCertainty: "known" as const,
      stackCount: 2,
      topology: "independent_per_stack" as const,
      displayedUnit: "lb" as const,
      ratioStatus: "known" as const,
      ratioNumerator: 1,
      ratioDenominator: 2,
      stackSteps: [
        { stackIndex: 1, stepIndex: 0, displayedLoad: 10, positionLabel: "1" },
        { stackIndex: 2, stepIndex: 0, displayedLoad: 10, positionLabel: "1" },
      ],
    };
    expect(cableEquipmentGeometrySnapshotSchema.safeParse(cable).success).toBe(true);
    expect(cableEquipmentGeometrySnapshotSchema.safeParse({
      ...cable,
      ratioDenominator: null,
    }).success).toBe(false);
    expect(cableEquipmentGeometrySnapshotSchema.safeParse({
      ...cable,
      stackSteps: [cable.stackSteps[0], cable.stackSteps[0]],
    }).success).toBe(false);
    expect(cableEquipmentGeometrySnapshotSchema.safeParse({
      ...cable,
      stackSteps: [cable.stackSteps[0]],
    }).success).toBe(false);
    expect(cableEquipmentGeometrySnapshotSchema.safeParse({
      ...cable,
      stackSteps: [{ ...cable.stackSteps[0], stackIndex: 0 }, cable.stackSteps[1]],
    }).success).toBe(false);
  });
});
