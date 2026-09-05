import { describe, expect, it } from "vitest";
import {
  cableMachineProfileSchema,
  equipmentLoadProfileSchema,
  plateLoadedMachineProfileSchema,
} from "@/lib/equipment-load-profile-contract";
import { MAX_STORED_LOAD } from "@/lib/units";

describe("equipment load profile contract", () => {
  it("keeps an exact 18 lb EZ implement distinct", () => {
    expect(
      equipmentLoadProfileSchema.parse({
        kind: "plate_loaded_implement",
        id: null,
        loadingKind: "ez",
        emptyWeight: 18,
        collarWeight: 0,
        unit: "lb",
        sharedPlatePoolCompatible: true,
      })
    ).toMatchObject({ loadingKind: "ez", emptyWeight: 18 });
  });

  it("does not call incomplete machine geometry known", () => {
    const result = plateLoadedMachineProfileSchema.safeParse({
        kind: "plate_loaded_machine",
        id: null,
        geometryCertainty: "known",
        startingResistance: null,
        startingResistanceUnit: "lb",
        loadingPointCount: 2,
        balancingRule: "identical_each_point",
        targetEntryMeaning: "total_system",
        compatiblePlateIds: [],
      });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["startingResistance"],
          message: "Enter the machine's starting resistance; enter 0 only when it is known to be zero.",
        }),
      ]));
    }
  });

  it("preserves zero and the supported maximum without accepting overflow", () => {
    const profile = {
      kind: "plate_loaded_machine" as const,
      id: null,
      geometryCertainty: "known" as const,
      startingResistance: 0,
      startingResistanceUnit: "lb" as const,
      loadingPointCount: 2,
      balancingRule: "identical_each_point" as const,
      targetEntryMeaning: "total_system" as const,
      compatiblePlateIds: [],
    };
    expect(plateLoadedMachineProfileSchema.parse(profile).startingResistance)
      .toBe(0);
    expect(plateLoadedMachineProfileSchema.parse({
      ...profile,
      startingResistance: MAX_STORED_LOAD,
    }).startingResistance).toBe(MAX_STORED_LOAD);
    expect(plateLoadedMachineProfileSchema.safeParse({
      ...profile,
      startingResistance: MAX_STORED_LOAD + 0.01,
    }).success).toBe(false);
  });

  it("rejects a multi-point machine described as single point", () => {
    expect(
      plateLoadedMachineProfileSchema.safeParse({
        kind: "plate_loaded_machine",
        id: null,
        geometryCertainty: "known",
        startingResistance: 20,
        startingResistanceUnit: "lb",
        loadingPointCount: 2,
        balancingRule: "single_point",
        targetEntryMeaning: "total_system",
        compatiblePlateIds: [],
      }).success
    ).toBe(false);
  });

  it("preserves unknown cable ratio without manufacturing values", () => {
    expect(
      cableMachineProfileSchema.parse({
        kind: "cable_machine",
        id: null,
        geometryCertainty: "partial",
        stackCount: 1,
        topology: "shared_selection",
        displayedUnit: "lb",
        ratioStatus: "unknown",
        ratioNumerator: null,
        ratioDenominator: null,
        stackSteps: [
          {
            id: null,
            stackIndex: 0,
            stepIndex: 1,
            displayedLoad: 10,
            positionLabel: "1",
          },
        ],
        compatibleAttachmentItemIds: [],
      })
    ).toMatchObject({ ratioStatus: "unknown" });
  });

  it("requires explicit rational values for a known cable ratio", () => {
    expect(
      cableMachineProfileSchema.safeParse({
        kind: "cable_machine",
        id: null,
        geometryCertainty: "known",
        stackCount: 2,
        topology: "independent_per_stack",
        displayedUnit: "lb",
        ratioStatus: "known",
        ratioNumerator: 2,
        ratioDenominator: null,
        stackSteps: [],
        compatibleAttachmentItemIds: [],
      }).success
    ).toBe(false);
  });

  it("aligns unknown and known certainty with executable geometry", () => {
    expect(plateLoadedMachineProfileSchema.safeParse({
      kind: "plate_loaded_machine",
      id: null,
      geometryCertainty: "unknown",
      startingResistance: 0,
      startingResistanceUnit: "lb",
      loadingPointCount: null,
      balancingRule: null,
      targetEntryMeaning: null,
      compatiblePlateIds: [],
    }).success).toBe(false);
    expect(cableMachineProfileSchema.safeParse({
      kind: "cable_machine",
      id: null,
      geometryCertainty: "known",
      stackCount: 1,
      topology: "shared_selection",
      displayedUnit: "lb",
      ratioStatus: "unknown",
      ratioNumerator: null,
      ratioDenominator: null,
      stackSteps: [],
      compatibleAttachmentItemIds: [],
    }).success).toBe(false);
    expect(cableMachineProfileSchema.safeParse({
      kind: "cable_machine",
      id: null,
      geometryCertainty: "known",
      stackCount: 2,
      topology: "independent_per_stack",
      displayedUnit: "lb",
      ratioStatus: "unknown",
      ratioNumerator: null,
      ratioDenominator: null,
      stackSteps: [{
        id: null,
        stackIndex: 1,
        stepIndex: 1,
        displayedLoad: 10,
        positionLabel: "Left pin 1",
      }],
      compatibleAttachmentItemIds: [],
    }).success).toBe(false);
  });
});
