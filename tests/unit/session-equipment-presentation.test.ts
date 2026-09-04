import { describe, expect, it } from "vitest";
import { buildSessionEquipmentPresentation } from "@/lib/session-equipment-presentation";
import { retainedPrimaryEquipmentCandidateMatchesBroad } from "@/lib/session-equipment-requirements";
import type { LoadedEquipmentLoadProfile } from "@/services/equipment-load-profiles";

const ezProfile = (id: string, label: string): LoadedEquipmentLoadProfile => ({
  equipmentItemId: id,
  itemType: "ez_bar",
  itemLabel: label,
  equipmentDefinitionId: null,
  equipmentDefinitionKey: null,
  available: true,
  profile: {
    kind: "plate_loaded_implement",
    id: `10000000-0000-4000-8000-${id.slice(-12)}`,
    loadingKind: "ez",
    emptyWeight: 18,
    collarWeight: 0,
    unit: "lb",
    sharedPlatePoolCompatible: true,
  },
});

const plates = [
  { id: "20000000-0000-4000-8000-000000000001", denomination: 1.25, quantity: 2, unit: "lb" as const },
  { id: "20000000-0000-4000-8000-000000000002", denomination: 2.5, quantity: 2, unit: "lb" as const },
  { id: "20000000-0000-4000-8000-000000000003", denomination: 5, quantity: 2, unit: "lb" as const },
  { id: "20000000-0000-4000-8000-000000000004", denomination: 10, quantity: 2, unit: "lb" as const },
];

const exercise = {
  id: "30000000-0000-4000-8000-000000000001",
  exerciseId: "30000000-0000-4000-8000-000000000002",
  loadType: "ez_bar",
  targetLoad: 23,
  targetLoadUnit: "lb" as const,
  requirements: [{ equipmentType: "ez_bar", minWeight: null }, { equipmentType: "plates", minWeight: null }],
  exactRequirement: null,
  currentSelection: null,
};

describe("active-workout equipment presentation", () => {
  it("requires a physical choice when more than one EZ bar is valid", () => {
    const profiles = [
      ezProfile("00000000-0000-4000-8000-000000000001", "Garage EZ bar"),
      ezProfile("00000000-0000-4000-8000-000000000002", "Travel EZ bar"),
    ];
    const result = buildSessionEquipmentPresentation({
      exercise,
      profiles,
      inventory: profiles.map((profile) => ({ type: profile.itemType, available: true, attrs: {} })),
      plates,
    });

    expect(result.setup?.selectionRequired).toBe(true);
    expect(result.setup?.options).toHaveLength(2);
    expect(result.plateConfig).toBeNull();
  });

  it("lets retained evidence withhold an otherwise plausible setup option", () => {
    const allowed = ezProfile(
      "00000000-0000-4000-8000-000000000001",
      "Retained EZ bar",
    );
    const wrong = ezProfile(
      "00000000-0000-4000-8000-000000000002",
      "Wrong same-type EZ bar",
    );
    const result = buildSessionEquipmentPresentation({
      exercise,
      profiles: [allowed, wrong],
      inventory: [allowed, wrong].map((profile) => ({
        type: profile.itemType,
        available: true,
        attrs: {},
      })),
      plates,
      primaryEquipmentAllowed: (equipmentItemId) =>
        equipmentItemId === allowed.equipmentItemId,
    });

    expect(result.setup).toMatchObject({
      status: "available",
      selectionRequired: false,
    });
    expect(result.setup?.options.map((option) => option.equipmentLabel))
      .toEqual(["Retained EZ bar"]);
  });

  it("uses the exact 18 lb EZ bar and every owned plate denomination in balanced pairs", () => {
    const profile = ezProfile("00000000-0000-4000-8000-000000000001", "18 lb EZ-curl bar");
    const result = buildSessionEquipmentPresentation({
      exercise: {
        ...exercise,
        currentSelection: {
          id: "40000000-0000-4000-8000-000000000001",
          equipmentItemId: profile.equipmentItemId,
          attachmentItemId: null,
          equipmentLabel: profile.itemLabel,
          attachmentLabel: null,
          geometrySnapshot: {
            version: 1,
            kind: "plate_loaded_implement",
            loadingKind: "ez",
            emptyWeight: 18,
            collarWeight: 0,
            unit: "lb",
            sharedPlatePoolCompatible: true,
            compatiblePlates: plates.map(({ denomination, quantity, unit }) => ({ denomination, quantity, unit })),
          },
        },
      },
      profiles: [profile],
      inventory: [{ type: "ez_bar", available: true, attrs: {} }],
      plates,
    });

    expect(result.plateConfig).toEqual({
      barWeight: 18,
      collarWeight: 0,
      plates: [
        { denomination: 1.25, countPerSide: 1 },
        { denomination: 2.5, countPerSide: 1 },
        { denomination: 5, countPerSide: 1 },
        { denomination: 10, countPerSide: 1 },
      ],
    });
    expect(result.setup?.currentGuidance).toContain("Per side: 2.5");
    expect(result.setup?.loadEntryMeaning).toBe("total_system");
  });

  it("keeps unknown cable geometry and effective load visibly unknown", () => {
    const cable: LoadedEquipmentLoadProfile = {
      equipmentItemId: "50000000-0000-4000-8000-000000000001",
      itemType: "cable",
      itemLabel: "Home cable tower",
      equipmentDefinitionId: null,
      equipmentDefinitionKey: null,
      available: true,
      profile: {
        kind: "cable_machine",
        id: "51000000-0000-4000-8000-000000000001",
        geometryCertainty: "unknown",
        stackCount: null,
        topology: null,
        displayedUnit: null,
        ratioStatus: "unknown",
        ratioNumerator: null,
        ratioDenominator: null,
        stackSteps: [],
        compatibleAttachmentItemIds: [],
      },
    };
    const result = buildSessionEquipmentPresentation({
      exercise: {
        ...exercise,
        loadType: "external",
        requirements: [{ equipmentType: "cable", minWeight: null }],
        exactRequirement: {
          requiredProfileKind: "cable_machine",
          requiredEquipmentDefinitionId: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinitionId: null,
          requiresKnownGeometry: false,
        },
        currentSelection: {
          id: "52000000-0000-4000-8000-000000000001",
          equipmentItemId: cable.equipmentItemId,
          attachmentItemId: null,
          equipmentLabel: cable.itemLabel,
          attachmentLabel: null,
          geometrySnapshot: {
            version: 1,
            kind: "cable_machine",
            geometryCertainty: "unknown",
            stackCount: null,
            topology: null,
            displayedUnit: null,
            ratioStatus: "unknown",
            ratioNumerator: null,
            ratioDenominator: null,
            stackSteps: [],
          },
        },
      },
      profiles: [cable],
      inventory: [{ type: "cable", available: true, attrs: {} }],
      plates: [],
    });

    expect(result.setup?.currentGuidance).toBe(
      "Cable geometry is unknown. Record the displayed stack setting only; effective load is unknown.",
    );
  });

  it("names incomplete saved geometry instead of calling it incompatible", () => {
    const machine: LoadedEquipmentLoadProfile = {
      equipmentItemId: "53000000-0000-4000-8000-000000000001",
      itemType: "machine",
      itemLabel: "Garage lat pulldown",
      equipmentDefinitionId: "53000000-0000-4000-8000-000000000002",
      equipmentDefinitionKey: "plate-loaded-lat-pulldown",
      available: true,
      profile: {
        kind: "plate_loaded_machine",
        id: "53000000-0000-4000-8000-000000000003",
        geometryCertainty: "partial",
        startingResistance: 10,
        startingResistanceUnit: "lb",
        loadingPointCount: null,
        balancingRule: null,
        targetEntryMeaning: null,
        compatiblePlateIds: [],
      },
    };
    const result = buildSessionEquipmentPresentation({
      exercise: {
        ...exercise,
        loadType: "external",
        requirements: [{ equipmentType: "machine", minWeight: null }],
        exactRequirement: {
          requiredProfileKind: "plate_loaded_machine",
          requiredEquipmentDefinitionId: machine.equipmentDefinitionId,
          requiredAttachmentKind: null,
          requiredAttachmentDefinitionId: null,
          requiresKnownGeometry: true,
        },
      },
      profiles: [machine],
      inventory: [{ type: "machine", available: true, attrs: {} }],
      plates: [],
    });

    expect(result.setup).toMatchObject({
      decisionState: "configuration_incomplete",
      status: "unavailable",
      options: [],
      configurationIssues: [{
        equipmentItemId: machine.equipmentItemId,
        equipmentLabel: "Garage lat pulldown",
        missingFields: [
          "loading points",
          "balancing rule",
          "load-entry meaning",
        ],
      }],
    });
  });

  it("does not name an incomplete machine that fails retained broad identity", () => {
    const retainedDefinitionId = "54000000-0000-4000-8000-000000000004";
    const machine: LoadedEquipmentLoadProfile = {
      equipmentItemId: "54000000-0000-4000-8000-000000000001",
      itemType: "machine",
      itemLabel: "Wrong partial machine",
      equipmentDefinitionId: "54000000-0000-4000-8000-000000000002",
      equipmentDefinitionKey: "wrong-machine",
      available: true,
      profile: {
        kind: "plate_loaded_machine",
        id: "54000000-0000-4000-8000-000000000003",
        geometryCertainty: "partial",
        startingResistance: 10,
        startingResistanceUnit: "lb",
        loadingPointCount: null,
        balancingRule: null,
        targetEntryMeaning: null,
        compatiblePlateIds: [],
      },
    };
    const result = buildSessionEquipmentPresentation({
      exercise: {
        ...exercise,
        loadType: "external",
        requirements: [{ equipmentType: "machine", minWeight: 100 }],
        exactRequirement: {
          requiredProfileKind: "plate_loaded_machine",
          requiredEquipmentDefinitionId: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinitionId: null,
          requiresKnownGeometry: true,
        },
      },
      profiles: [machine],
      inventory: [
        {
          type: "machine",
          available: true,
          attrs: { maxWeight: 150 },
        },
        {
          type: "machine",
          available: true,
          attrs: { maxWeight: 50 },
        },
      ],
      plates: [],
      primaryEquipmentAllowed: () =>
        retainedPrimaryEquipmentCandidateMatchesBroad([{
          sourceRequirementId:
            "54000000-0000-4000-8000-000000000005",
          equipmentType: "machine",
          equipmentDefinition: {
            id: retainedDefinitionId,
            key: "required-machine",
            label: "Required machine",
          },
          minWeight: 100,
        }], {
          equipmentType: machine.itemType,
          equipmentDefinitionId: machine.equipmentDefinitionId,
          attrs: { maxWeight: 50 },
        }),
    });

    expect(result.setup).toMatchObject({
      decisionState: "incompatible",
      status: "unavailable",
      options: [],
      configurationIssues: [],
    });
  });

  it("shows displayed stack load and nominal handle resistance only for a known ratio", () => {
    const cable: LoadedEquipmentLoadProfile = {
      equipmentItemId: "60000000-0000-4000-8000-000000000001",
      itemType: "cable",
      itemLabel: "Known cable tower",
      equipmentDefinitionId: null,
      equipmentDefinitionKey: null,
      available: true,
      profile: {
        kind: "cable_machine",
        id: "61000000-0000-4000-8000-000000000001",
        geometryCertainty: "known",
        stackCount: 1,
        topology: "shared_selection",
        displayedUnit: "lb",
        ratioStatus: "known",
        ratioNumerator: 1,
        ratioDenominator: 2,
        stackSteps: [{
          id: "62000000-0000-4000-8000-000000000001",
          stackIndex: 0,
          stepIndex: 5,
          displayedLoad: 50,
          positionLabel: "Pin 5",
        }],
        compatibleAttachmentItemIds: [],
      },
    };
    const geometry = {
      version: 1 as const,
      kind: "cable_machine" as const,
      geometryCertainty: "known" as const,
      stackCount: 1,
      topology: "shared_selection" as const,
      displayedUnit: "lb" as const,
      ratioStatus: "known" as const,
      ratioNumerator: 1,
      ratioDenominator: 2,
      stackSteps: [{
        stackIndex: 0,
        stepIndex: 5,
        displayedLoad: 50,
        positionLabel: "Pin 5",
      }],
    };
    const result = buildSessionEquipmentPresentation({
      exercise: {
        ...exercise,
        loadType: "external",
        targetLoad: 50,
        requirements: [{ equipmentType: "cable", minWeight: null }],
        exactRequirement: {
          requiredProfileKind: "cable_machine",
          requiredEquipmentDefinitionId: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinitionId: null,
          requiresKnownGeometry: true,
        },
        currentSelection: {
          id: "63000000-0000-4000-8000-000000000001",
          equipmentItemId: cable.equipmentItemId,
          attachmentItemId: null,
          equipmentLabel: cable.itemLabel,
          attachmentLabel: null,
          geometrySnapshot: geometry,
        },
      },
      profiles: [cable],
      inventory: [{ type: "cable", available: true, attrs: {} }],
      plates: [],
    });

    expect(result.setup?.currentGuidance).toContain("stack: exact 50 lb (Pin 5)");
    expect(result.setup?.currentGuidance).toContain("nominal handle: 25 lb");
    expect(result.setup?.loadEntryMeaning).toBe("displayed_stack");
  });

  it("makes the meaning of an independent-stack entry an explicit retained choice", () => {
    const cable: LoadedEquipmentLoadProfile = {
      equipmentItemId: "70000000-0000-4000-8000-000000000001",
      itemType: "cable",
      itemLabel: "Dual cable tower",
      equipmentDefinitionId: null,
      equipmentDefinitionKey: null,
      available: true,
      profile: {
        kind: "cable_machine",
        id: "71000000-0000-4000-8000-000000000001",
        geometryCertainty: "known",
        stackCount: 2,
        topology: "independent_per_stack",
        displayedUnit: "lb",
        ratioStatus: "unknown",
        ratioNumerator: null,
        ratioDenominator: null,
        stackSteps: [
          { id: null, stackIndex: 1, stepIndex: 2, displayedLoad: 25, positionLabel: "Left 2" },
          { id: null, stackIndex: 1, stepIndex: 5, displayedLoad: 50, positionLabel: "Left 5" },
          { id: null, stackIndex: 2, stepIndex: 2, displayedLoad: 25, positionLabel: "Right 2" },
          { id: null, stackIndex: 2, stepIndex: 5, displayedLoad: 50, positionLabel: "Right 5" },
        ],
        compatibleAttachmentItemIds: [],
      },
    };
    const result = buildSessionEquipmentPresentation({
      exercise: {
        ...exercise,
        loadType: "external",
        targetLoad: 50,
        requirements: [{ equipmentType: "cable", minWeight: null }],
        exactRequirement: {
          requiredProfileKind: "cable_machine",
          requiredEquipmentDefinitionId: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinitionId: null,
          requiresKnownGeometry: true,
        },
        currentSelection: {
          id: "72000000-0000-4000-8000-000000000001",
          equipmentItemId: cable.equipmentItemId,
          attachmentItemId: null,
          equipmentLabel: cable.itemLabel,
          attachmentLabel: null,
          geometrySnapshot: {
            version: 1,
            kind: "cable_machine",
            geometryCertainty: "known",
            stackCount: 2,
            topology: "independent_per_stack",
            displayedUnit: "lb",
            ratioStatus: "unknown",
            ratioNumerator: null,
            ratioDenominator: null,
            stackSteps: [
              { stackIndex: 1, stepIndex: 2, displayedLoad: 25, positionLabel: "Left 2" },
              { stackIndex: 1, stepIndex: 5, displayedLoad: 50, positionLabel: "Left 5" },
              { stackIndex: 2, stepIndex: 2, displayedLoad: 25, positionLabel: "Right 2" },
              { stackIndex: 2, stepIndex: 5, displayedLoad: 50, positionLabel: "Right 5" },
            ],
          },
        },
      },
      profiles: [cable],
      inventory: [{ type: "cable", available: true, attrs: {} }],
      plates: [],
    });

    expect(result.setup?.loadEntryMeaning).toBe("per_stack");
    expect(result.setup?.loadEntryMeaningChoices).toEqual([
      "per_stack",
      "combined_stacks",
    ]);
    expect(result.setup?.currentGuidance).toContain("effective load remains unknown");
    expect(result.setup?.currentGuidanceByLoadEntryMeaning.per_stack).toContain(
      "stack 1: exact 50 lb (Left 5)",
    );
    expect(result.setup?.currentGuidanceByLoadEntryMeaning.combined_stacks).toContain(
      "Combined exact 50 lb: stack 1 25 lb (Left 2) + stack 2 25 lb (Right 2)",
    );
  });

  it("shows both lower and upper machine setups when the target is unavailable", () => {
    const profile: LoadedEquipmentLoadProfile = {
      equipmentItemId: "80000000-0000-4000-8000-000000000001",
      itemType: "machine",
      itemLabel: "Two-point press",
      equipmentDefinitionId: null,
      equipmentDefinitionKey: null,
      available: true,
      profile: {
        kind: "plate_loaded_machine",
        id: "81000000-0000-4000-8000-000000000001",
        geometryCertainty: "known",
        startingResistance: 20,
        startingResistanceUnit: "lb",
        loadingPointCount: 2,
        balancingRule: "identical_each_point",
        targetEntryMeaning: "total_system",
        compatiblePlateIds: [],
      },
    };
    const geometry = {
      version: 1 as const,
      kind: "plate_loaded_machine" as const,
      geometryCertainty: "known" as const,
      startingResistance: 20,
      startingResistanceUnit: "lb" as const,
      loadingPointCount: 2,
      balancingRule: "identical_each_point" as const,
      targetEntryMeaning: "total_system" as const,
      compatiblePlates: [
        { denomination: 10, quantity: 2, unit: "lb" as const },
        { denomination: 20, quantity: 2, unit: "lb" as const },
      ],
    };
    const result = buildSessionEquipmentPresentation({
      exercise: {
        ...exercise,
        loadType: "external",
        targetLoad: 50,
        requirements: [{ equipmentType: "machine", minWeight: null }],
        exactRequirement: {
          requiredProfileKind: "plate_loaded_machine",
          requiredEquipmentDefinitionId: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinitionId: null,
          requiresKnownGeometry: true,
        },
        currentSelection: {
          id: "82000000-0000-4000-8000-000000000001",
          equipmentItemId: profile.equipmentItemId,
          attachmentItemId: null,
          equipmentLabel: profile.itemLabel,
          attachmentLabel: null,
          geometrySnapshot: geometry,
        },
      },
      profiles: [profile],
      inventory: [{ type: "machine", available: true, attrs: {} }],
      plates: [
        { id: "83000000-0000-4000-8000-000000000010", denomination: 10, quantity: 2, unit: "lb" },
        { id: "83000000-0000-4000-8000-000000000020", denomination: 20, quantity: 2, unit: "lb" },
        { id: "83000000-0000-4000-8000-000000000030", denomination: 15, quantity: 4, unit: "kg" },
      ],
    });

    expect(result.setup?.currentGuidance).toContain("nearest lower 40 lb");
    expect(result.setup?.currentGuidance).toContain("nearest upper 60 lb");
    expect(result.setup?.currentGuidance).toContain("total resistance 60 lb");
    expect(result.setup?.machineLoadConfig).toEqual({
      geometryStatus: "known",
      startingResistance: 20,
      unit: "lb",
      loadingPointCount: 2,
      balancingRule: "identical_each_point",
      targetEntryMeaning: "total_system",
      compatiblePlates: [
        { denomination: 10, quantity: 2 },
        { denomination: 20, quantity: 2 },
      ],
    });
  });

  it("shows both neighbouring cable positions instead of choosing one", () => {
    const profile: LoadedEquipmentLoadProfile = {
      equipmentItemId: "90000000-0000-4000-8000-000000000001",
      itemType: "cable",
      itemLabel: "Irregular stack",
      equipmentDefinitionId: null,
      equipmentDefinitionKey: null,
      available: true,
      profile: {
        kind: "cable_machine",
        id: "91000000-0000-4000-8000-000000000001",
        geometryCertainty: "known",
        stackCount: 1,
        topology: "shared_selection",
        displayedUnit: "lb",
        ratioStatus: "unknown",
        ratioNumerator: null,
        ratioDenominator: null,
        stackSteps: [
          { id: null, stackIndex: 0, stepIndex: 4, displayedLoad: 40, positionLabel: "Pin 4" },
          { id: null, stackIndex: 0, stepIndex: 6, displayedLoad: 60, positionLabel: "Pin 6" },
        ],
        compatibleAttachmentItemIds: [],
      },
    };
    const geometry = {
      version: 1 as const,
      kind: "cable_machine" as const,
      geometryCertainty: "known" as const,
      stackCount: 1,
      topology: "shared_selection" as const,
      displayedUnit: "lb" as const,
      ratioStatus: "unknown" as const,
      ratioNumerator: null,
      ratioDenominator: null,
      stackSteps: [
        { stackIndex: 0, stepIndex: 4, displayedLoad: 40, positionLabel: "Pin 4" },
        { stackIndex: 0, stepIndex: 6, displayedLoad: 60, positionLabel: "Pin 6" },
      ],
    };
    const result = buildSessionEquipmentPresentation({
      exercise: {
        ...exercise,
        loadType: "external",
        targetLoad: 50,
        requirements: [{ equipmentType: "cable", minWeight: null }],
        exactRequirement: {
          requiredProfileKind: "cable_machine",
          requiredEquipmentDefinitionId: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinitionId: null,
          requiresKnownGeometry: true,
        },
        currentSelection: {
          id: "92000000-0000-4000-8000-000000000001",
          equipmentItemId: profile.equipmentItemId,
          attachmentItemId: null,
          equipmentLabel: profile.itemLabel,
          attachmentLabel: null,
          geometrySnapshot: geometry,
        },
      },
      profiles: [profile],
      inventory: [{ type: "cable", available: true, attrs: {} }],
      plates: [],
    });

    expect(result.setup?.currentGuidance).toContain("nearest lower 40 lb (Pin 4)");
    expect(result.setup?.currentGuidance).toContain("nearest upper 60 lb (Pin 6)");
  });

  it("changes Triceps Pushdown assistance with the selected equipment geometry", () => {
    const plateLoaded: LoadedEquipmentLoadProfile = {
      equipmentItemId: "a0000000-0000-4000-8000-000000000001",
      itemType: "machine",
      itemLabel: "Plate-loaded cable station",
      equipmentDefinitionId: null,
      equipmentDefinitionKey: null,
      available: true,
      profile: {
        kind: "plate_loaded_machine",
        id: "a1000000-0000-4000-8000-000000000001",
        geometryCertainty: "known",
        startingResistance: 10,
        startingResistanceUnit: "lb",
        loadingPointCount: 1,
        balancingRule: "single_point",
        targetEntryMeaning: "total_system",
        compatiblePlateIds: [],
      },
    };
    const selectorized: LoadedEquipmentLoadProfile = {
      equipmentItemId: "a0000000-0000-4000-8000-000000000002",
      itemType: "cable",
      itemLabel: "Selectorized cable stack",
      equipmentDefinitionId: null,
      equipmentDefinitionKey: null,
      available: true,
      profile: {
        kind: "cable_machine",
        id: "a1000000-0000-4000-8000-000000000002",
        geometryCertainty: "known",
        stackCount: 1,
        topology: "shared_selection",
        displayedUnit: "lb",
        ratioStatus: "known",
        ratioNumerator: 1,
        ratioDenominator: 1,
        stackSteps: [
          { id: null, stackIndex: 0, stepIndex: 4, displayedLoad: 40, positionLabel: "Pin 4" },
          { id: null, stackIndex: 0, stepIndex: 5, displayedLoad: 50, positionLabel: "Pin 5" },
        ],
        compatibleAttachmentItemIds: [],
      },
    };
    const ownedPlates = [
      { id: "a2000000-0000-4000-8000-000000000001", denomination: 10, quantity: 4, unit: "lb" as const },
    ];
    const basePushdown = {
      ...exercise,
      exerciseId: "a3000000-0000-4000-8000-000000000001",
      loadType: "external",
      targetLoad: 50,
      requirements: [{ equipmentType: "machine", minWeight: null }],
    };

    const plateResult = buildSessionEquipmentPresentation({
      exercise: {
        ...basePushdown,
        exactRequirement: {
          requiredProfileKind: "plate_loaded_machine",
          requiredEquipmentDefinitionId: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinitionId: null,
          requiresKnownGeometry: true,
        },
        currentSelection: {
          id: "a4000000-0000-4000-8000-000000000001",
          equipmentItemId: plateLoaded.equipmentItemId,
          attachmentItemId: null,
          equipmentLabel: plateLoaded.itemLabel,
          attachmentLabel: null,
          geometrySnapshot: {
            version: 1,
            kind: "plate_loaded_machine",
            geometryCertainty: "known",
            startingResistance: 10,
            startingResistanceUnit: "lb",
            loadingPointCount: 1,
            balancingRule: "single_point",
            targetEntryMeaning: "total_system",
            compatiblePlates: [{ denomination: 10, quantity: 4, unit: "lb" }],
          },
        },
      },
      profiles: [plateLoaded, selectorized],
      inventory: [
        { type: "machine", available: true, attrs: {} },
        { type: "cable", available: true, attrs: {} },
      ],
      plates: ownedPlates,
    });
    expect(plateResult.setup?.machineLoadConfig).not.toBeNull();
    expect(plateResult.setup?.currentGuidance).toContain("each loading point");

    const selectorizedResult = buildSessionEquipmentPresentation({
      exercise: {
        ...basePushdown,
        requirements: [{ equipmentType: "cable", minWeight: null }],
        exactRequirement: {
          requiredProfileKind: "cable_machine",
          requiredEquipmentDefinitionId: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinitionId: null,
          requiresKnownGeometry: true,
        },
        currentSelection: {
          id: "a4000000-0000-4000-8000-000000000002",
          equipmentItemId: selectorized.equipmentItemId,
          attachmentItemId: null,
          equipmentLabel: selectorized.itemLabel,
          attachmentLabel: null,
          geometrySnapshot: {
            version: 1,
            kind: "cable_machine",
            geometryCertainty: "known",
            stackCount: 1,
            topology: "shared_selection",
            displayedUnit: "lb",
            ratioStatus: "known",
            ratioNumerator: 1,
            ratioDenominator: 1,
            stackSteps: [
              { stackIndex: 0, stepIndex: 4, displayedLoad: 40, positionLabel: "Pin 4" },
              { stackIndex: 0, stepIndex: 5, displayedLoad: 50, positionLabel: "Pin 5" },
            ],
          },
        },
      },
      profiles: [plateLoaded, selectorized],
      inventory: [
        { type: "machine", available: true, attrs: {} },
        { type: "cable", available: true, attrs: {} },
      ],
      plates: ownedPlates,
    });
    expect(selectorizedResult.setup?.machineLoadConfig).toBeNull();
    expect(selectorizedResult.plateConfig).toBeNull();
    expect(selectorizedResult.setup?.currentGuidance).toContain("Pin 5");
    expect(selectorizedResult.setup?.currentGuidance).not.toContain(
      "each loading point",
    );
  });
});
