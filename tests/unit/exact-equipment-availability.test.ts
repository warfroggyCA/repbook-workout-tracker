import { describe, expect, it } from "vitest";
import {
  resolveExactEquipmentAvailability,
  type ExactExecutionCandidate,
  type ExactExecutionRequirement,
} from "@/engine/exact-equipment-availability";

const broadMachineRequirement = [
  { equipmentType: "machine", minWeight: null },
];
const broadMachineInventory = [
  { type: "machine", available: true, attrs: {} },
];

const plateLoadedRequirement: ExactExecutionRequirement = {
  requiredProfileKind: "plate_loaded_machine",
  requiredEquipmentDefinitionId: "lat-pulldown-definition",
  requiredAttachmentKind: null,
  requiredAttachmentDefinitionId: null,
  requiresKnownGeometry: true,
};

function candidate(
  overrides: Partial<ExactExecutionCandidate> = {},
): ExactExecutionCandidate {
  return {
    equipmentItemId: "machine-a",
    available: true,
    profileKind: "plate_loaded_machine",
    equipmentDefinitionId: "lat-pulldown-definition",
    geometryCertainty: "known",
    compatibleAttachments: [],
    ...overrides,
  };
}

describe("resolveExactEquipmentAvailability", () => {
  it("keeps broad ownership as the first gate", () => {
    expect(
      resolveExactEquipmentAvailability({
        broadRequirements: broadMachineRequirement,
        broadInventory: [],
        exactRequirement: plateLoadedRequirement,
        exactCandidates: [candidate()],
      }),
    ).toMatchObject({
      available: false,
      status: "broad_unavailable",
      candidateEquipmentItemIds: [],
    });
  });

  it("retains broad-only availability when no reviewed exact requirement exists", () => {
    expect(
      resolveExactEquipmentAvailability({
        broadRequirements: broadMachineRequirement,
        broadInventory: broadMachineInventory,
        exactRequirement: null,
        exactCandidates: [],
      }),
    ).toEqual({
      available: true,
      status: "broad_only",
      selection: "not_applicable",
      missingBroadRequirements: [],
      candidateEquipmentItemIds: [],
      configurationIncompleteEquipmentItemIds: [],
    });
  });

  it("does not let a generic machine satisfy an exact reviewed machine kind", () => {
    const result = resolveExactEquipmentAvailability({
      broadRequirements: broadMachineRequirement,
      broadInventory: broadMachineInventory,
      exactRequirement: plateLoadedRequirement,
      exactCandidates: [
        candidate({
          profileKind: null,
          equipmentDefinitionId: null,
          geometryCertainty: null,
        }),
      ],
    });

    expect(result).toMatchObject({
      available: false,
      status: "exact_unavailable",
    });
  });

  it("requires the reviewed definition and known geometry exactly", () => {
    const wrongDefinition = resolveExactEquipmentAvailability({
      broadRequirements: broadMachineRequirement,
      broadInventory: broadMachineInventory,
      exactRequirement: plateLoadedRequirement,
      exactCandidates: [
        candidate({ equipmentDefinitionId: "generic-machine-definition" }),
      ],
    });
    const partialGeometry = resolveExactEquipmentAvailability({
      broadRequirements: broadMachineRequirement,
      broadInventory: broadMachineInventory,
      exactRequirement: plateLoadedRequirement,
      exactCandidates: [candidate({ geometryCertainty: "partial" })],
    });

    expect(wrongDefinition.available).toBe(false);
    expect(wrongDefinition.status).toBe("exact_unavailable");
    expect(partialGeometry).toMatchObject({
      available: false,
      status: "configuration_incomplete",
      candidateEquipmentItemIds: [],
      configurationIncompleteEquipmentItemIds: ["machine-a"],
    });
  });

  it("requires an explicitly compatible exact attachment", () => {
    const cableRequirement: ExactExecutionRequirement = {
      requiredProfileKind: "cable_machine",
      requiredEquipmentDefinitionId: null,
      requiredAttachmentKind: "rope",
      requiredAttachmentDefinitionId: "rope-definition",
      requiresKnownGeometry: false,
    };
    const cable = candidate({
      profileKind: "cable_machine",
      equipmentDefinitionId: null,
      geometryCertainty: "unknown",
      compatibleAttachments: [],
    });

    const unlinked = resolveExactEquipmentAvailability({
      broadRequirements: [{ equipmentType: "cable", minWeight: null }],
      broadInventory: [{ type: "cable", available: true, attrs: {} }],
      exactRequirement: cableRequirement,
      exactCandidates: [cable],
    });
    const linked = resolveExactEquipmentAvailability({
      broadRequirements: [{ equipmentType: "cable", minWeight: null }],
      broadInventory: [{ type: "cable", available: true, attrs: {} }],
      exactRequirement: cableRequirement,
      exactCandidates: [
        {
          ...cable,
          compatibleAttachments: [
            {
              equipmentItemId: "rope-a",
              available: true,
              attachmentKind: "rope",
              equipmentDefinitionId: "rope-definition",
            },
          ],
        },
      ],
    });

    expect(unlinked.available).toBe(false);
    expect(linked).toMatchObject({
      available: true,
      status: "exact_available",
      selection: "automatic",
      candidateEquipmentItemIds: ["machine-a"],
    });
  });

  it("requires an explicit choice when multiple exact setups are plausible", () => {
    const result = resolveExactEquipmentAvailability({
      broadRequirements: broadMachineRequirement,
      broadInventory: broadMachineInventory,
      exactRequirement: plateLoadedRequirement,
      exactCandidates: [
        candidate({ equipmentItemId: "machine-z" }),
        candidate({ equipmentItemId: "machine-a" }),
      ],
    });

    expect(result).toMatchObject({
      available: true,
      selection: "required",
      candidateEquipmentItemIds: ["machine-a", "machine-z"],
    });
  });

  it("does not turn duplicate joins for one physical item into ambiguity", () => {
    const result = resolveExactEquipmentAvailability({
      broadRequirements: broadMachineRequirement,
      broadInventory: broadMachineInventory,
      exactRequirement: plateLoadedRequirement,
      exactCandidates: [candidate(), candidate()],
    });
    expect(result).toMatchObject({
      available: true,
      selection: "automatic",
      candidateEquipmentItemIds: ["machine-a"],
    });
  });
});
