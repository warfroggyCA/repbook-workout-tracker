import {
  missingRequirements,
  type EquipmentRequirement,
  type InventoryItem,
} from "./equipment-filter";

export type GeometryCertainty = "known" | "partial" | "unknown";

export type ExactExecutionRequirement = {
  requiredProfileKind: string | null;
  requiredEquipmentDefinitionId: string | null;
  requiredAttachmentKind: string | null;
  requiredAttachmentDefinitionId: string | null;
  requiresKnownGeometry: boolean;
};

export type CompatibleAttachmentCandidate = {
  equipmentItemId: string;
  available: boolean;
  attachmentKind: string | null;
  equipmentDefinitionId: string | null;
};

/**
 * One reviewed executable setup. `compatibleAttachments` contains only explicit
 * station-to-attachment relationships; merely owning a generic attachment does
 * not make it compatible with this candidate.
 */
export type ExactExecutionCandidate = {
  equipmentItemId: string;
  available: boolean;
  profileKind: string | null;
  equipmentDefinitionId: string | null;
  geometryCertainty: GeometryCertainty | null;
  compatibleAttachments: CompatibleAttachmentCandidate[];
};

export type ExactAvailabilityResolution = {
  available: boolean;
  status:
    | "broad_unavailable"
    | "broad_only"
    | "exact_unavailable"
    | "exact_available";
  selection: "not_applicable" | "automatic" | "required";
  missingBroadRequirements: EquipmentRequirement[];
  candidateEquipmentItemIds: string[];
};

function attachmentMatches(
  requirement: ExactExecutionRequirement,
  attachment: CompatibleAttachmentCandidate,
): boolean {
  return (
    attachment.available &&
    (requirement.requiredAttachmentKind == null ||
      attachment.attachmentKind === requirement.requiredAttachmentKind) &&
    (requirement.requiredAttachmentDefinitionId == null ||
      attachment.equipmentDefinitionId ===
        requirement.requiredAttachmentDefinitionId)
  );
}

export function exactExecutionCandidateMatches(
  requirement: ExactExecutionRequirement,
  candidate: ExactExecutionCandidate,
): boolean {
  if (!candidate.available) return false;
  if (
    requirement.requiredProfileKind != null &&
    candidate.profileKind !== requirement.requiredProfileKind
  ) {
    return false;
  }
  if (
    requirement.requiredEquipmentDefinitionId != null &&
    candidate.equipmentDefinitionId !==
      requirement.requiredEquipmentDefinitionId
  ) {
    return false;
  }
  if (
    requirement.requiresKnownGeometry &&
    candidate.geometryCertainty !== "known"
  ) {
    return false;
  }
  if (
    requirement.requiredAttachmentKind != null ||
    requirement.requiredAttachmentDefinitionId != null
  ) {
    return candidate.compatibleAttachments.some((attachment) =>
      attachmentMatches(requirement, attachment),
    );
  }
  return true;
}

/**
 * Resolve availability in the required order: broad ownership first, then the
 * reviewed exact execution predicates. The resolver also reports whether one
 * setup may be selected automatically or multiple plausible setups require an
 * explicit workout-time choice.
 */
export function resolveExactEquipmentAvailability(input: {
  broadRequirements: EquipmentRequirement[];
  broadInventory: InventoryItem[];
  exactRequirement: ExactExecutionRequirement | null;
  exactCandidates: ExactExecutionCandidate[];
}): ExactAvailabilityResolution {
  const missingBroad = missingRequirements(
    input.broadRequirements,
    input.broadInventory,
  );
  if (missingBroad.length > 0) {
    return {
      available: false,
      status: "broad_unavailable",
      selection: "not_applicable",
      missingBroadRequirements: missingBroad,
      candidateEquipmentItemIds: [],
    };
  }

  if (input.exactRequirement == null) {
    return {
      available: true,
      status: "broad_only",
      selection: "not_applicable",
      missingBroadRequirements: [],
      candidateEquipmentItemIds: [],
    };
  }

  const candidateEquipmentItemIds = [...new Set(
    input.exactCandidates
      .filter((candidate) =>
        exactExecutionCandidateMatches(input.exactRequirement!, candidate),
      )
      .map((candidate) => candidate.equipmentItemId),
  )].sort();

  if (candidateEquipmentItemIds.length === 0) {
    return {
      available: false,
      status: "exact_unavailable",
      selection: "not_applicable",
      missingBroadRequirements: [],
      candidateEquipmentItemIds: [],
    };
  }

  return {
    available: true,
    status: "exact_available",
    selection:
      candidateEquipmentItemIds.length === 1 ? "automatic" : "required",
    missingBroadRequirements: [],
    candidateEquipmentItemIds,
  };
}
