/**
 * Durable owner-reviewed meaning for whether an exact exercise can use an
 * exact saved equipment item. Display names and broad equipment categories
 * identify candidates only; they never prove physical compatibility.
 */

export const EXERCISE_EQUIPMENT_FIT_SEMANTICS_VERSION = 1 as const;

export type ExerciseEquipmentFitVerdict = "compatible" | "incompatible";
export type ExerciseEquipmentFitStatus =
  | "compatible"
  | "incompatible"
  | "unknown"
  | "missing"
  | "not_required";

export type ExerciseEquipmentFitReasonCode =
  | "owner_verified"
  | "geometry_limit"
  | "missing_capability"
  | "attachment_limit"
  | "range_of_motion_limit"
  | "space_limit"
  | "safety_constraint"
  | "other";

export type ExerciseEquipmentFitRequirement = {
  id?: string;
  equipmentType: string;
  equipmentDefinitionId?: string | null;
  minWeight: number | null;
};

export type ExerciseEquipmentFitItem = {
  id: string;
  type: string;
  definitionId?: string | null;
  available: boolean;
  attrs: Record<string, unknown>;
};

export type ExerciseEquipmentFitAssertion = {
  id: string;
  exerciseId: string;
  equipmentItemId: string;
  verdict: ExerciseEquipmentFitVerdict;
  reasonCode: ExerciseEquipmentFitReasonCode;
  reasonNote: string | null;
  provenance: "owner_review";
  semanticsVersion: number;
  evidenceRevision: string;
  revision: number;
  reviewedAt?: Date | string | null;
};

export type ExerciseEquipmentFitRequirementResolution = {
  requirementId: string | null;
  equipmentType: string;
  status: Exclude<ExerciseEquipmentFitStatus, "not_required">;
  candidateEquipmentItemIds: string[];
  compatibleEquipmentItemIds: string[];
  incompatibleEquipmentItemIds: string[];
  unknownEquipmentItemIds: string[];
  staleEquipmentItemIds: string[];
};

export type ExerciseEquipmentFitResolution = {
  semanticsVersion: typeof EXERCISE_EQUIPMENT_FIT_SEMANTICS_VERSION;
  exerciseId: string;
  status: ExerciseEquipmentFitStatus;
  reason: string;
  candidateEquipmentItemIds: string[];
  compatibleEquipmentItemIds: string[];
  incompatibleEquipmentItemIds: string[];
  unknownEquipmentItemIds: string[];
  staleEquipmentItemIds: string[];
  requirements: ExerciseEquipmentFitRequirementResolution[];
  assertions: Array<{
    id: string;
    equipmentItemId: string;
    verdict: ExerciseEquipmentFitVerdict;
    reasonCode: ExerciseEquipmentFitReasonCode;
    reasonNote: string | null;
    evidenceRevision: string;
    revision: number;
  }>;
};

const NON_ITEM_REQUIREMENTS = new Set(["bodyweight", "plates"]);

function finiteMaxWeight(item: ExerciseEquipmentFitItem): number | null {
  const value = item.attrs.maxWeight;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function itemMatchesRequirement(
  item: ExerciseEquipmentFitItem,
  requirement: ExerciseEquipmentFitRequirement,
) {
  if (!item.available || item.type !== requirement.equipmentType) return false;
  if (
    requirement.equipmentDefinitionId != null &&
    item.definitionId !== requirement.equipmentDefinitionId
  ) {
    return false;
  }
  return requirement.minWeight == null ||
    (finiteMaxWeight(item) != null && finiteMaxWeight(item)! >= requirement.minWeight);
}

function validAssertion(
  assertion: ExerciseEquipmentFitAssertion,
  exerciseId: string,
) {
  if (
    assertion.exerciseId !== exerciseId ||
    assertion.provenance !== "owner_review" ||
    assertion.semanticsVersion !== EXERCISE_EQUIPMENT_FIT_SEMANTICS_VERSION ||
    !/^[0-9a-f]{32}$/u.test(assertion.evidenceRevision) ||
    !Number.isInteger(assertion.revision) ||
    assertion.revision < 1
  ) {
    return false;
  }
  if (assertion.verdict === "compatible") {
    return assertion.reasonCode === "owner_verified";
  }
  if (assertion.reasonCode === "owner_verified") return false;
  return assertion.reasonCode !== "other" || Boolean(assertion.reasonNote?.trim());
}

function requirementStatus(input: {
  exerciseId: string;
  requirement: ExerciseEquipmentFitRequirement;
  items: ExerciseEquipmentFitItem[];
  assertionsByItem: Map<string, ExerciseEquipmentFitAssertion[]>;
  currentEvidenceRevisions: ReadonlyMap<string, string>;
}): ExerciseEquipmentFitRequirementResolution {
  const candidates = input.items
    .filter((item) => itemMatchesRequirement(item, input.requirement))
    .sort((a, b) => a.id.localeCompare(b.id));
  const compatible: string[] = [];
  const incompatible: string[] = [];
  const unknown: string[] = [];
  const stale: string[] = [];

  for (const item of candidates) {
    const assertions = (input.assertionsByItem.get(item.id) ?? [])
      .filter((assertion) => validAssertion(assertion, input.exerciseId));
    const currentEvidenceRevision = input.currentEvidenceRevisions.get(item.id);
    if (assertions.length > 1) {
      unknown.push(item.id);
    } else if (
      assertions.length === 1 &&
      (currentEvidenceRevision == null ||
        assertions[0].evidenceRevision !== currentEvidenceRevision)
    ) {
      stale.push(item.id);
      unknown.push(item.id);
    } else if (assertions.length === 1 && assertions[0].verdict === "compatible") {
      compatible.push(item.id);
    } else if (assertions.length === 1) {
      incompatible.push(item.id);
    } else {
      unknown.push(item.id);
    }
  }

  const status = candidates.length === 0
    ? "missing" as const
    : compatible.length > 0
      ? "compatible" as const
      : unknown.length > 0
        ? "unknown" as const
        : "incompatible" as const;

  return {
    requirementId: input.requirement.id ?? null,
    equipmentType: input.requirement.equipmentType,
    status,
    candidateEquipmentItemIds: candidates.map((item) => item.id),
    compatibleEquipmentItemIds: compatible,
    incompatibleEquipmentItemIds: incompatible,
    unknownEquipmentItemIds: unknown,
    staleEquipmentItemIds: stale,
  };
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function resolutionReason(
  status: ExerciseEquipmentFitStatus,
  requirements: ExerciseEquipmentFitRequirementResolution[],
) {
  if (status === "not_required") {
    return "This exercise does not require an owner-reviewed equipment-item fit.";
  }
  if (status === "compatible") {
    return "Every equipment requirement has a currently available item with current stable-ID evidence that proves an exact compatible fit.";
  }
  if (status === "incompatible") {
    const types = uniqueSorted(requirements
      .filter((requirement) => requirement.status === "incompatible")
      .map((requirement) => requirement.equipmentType));
    return `Saved equipment is explicitly incompatible with this exercise${types.length > 0 ? ` (${types.join(", ")})` : ""}.`;
  }
  if (status === "missing") {
    const types = uniqueSorted(requirements
      .filter((requirement) => requirement.status === "missing")
      .map((requirement) => requirement.equipmentType));
    return `No currently available saved equipment item satisfies this exercise requirement${types.length > 0 ? ` (${types.join(", ")})` : ""}.`;
  }
  return requirements.some((requirement) => requirement.staleEquipmentItemIds.length > 0)
    ? "A retained equipment-fit review is stale because the exercise requirement or exact equipment capability changed. Review the pair again."
    : "Saved equipment candidates exist, but no current owner-reviewed or exact stable-item fit proves that this exercise can use them.";
}

/**
 * Resolves only current, stable-ID evidence. An absent or malformed assertion
 * remains unknown, while a matching display name has no semantic effect.
 */
export function resolveExerciseEquipmentFit(input: {
  exerciseId: string;
  requirements: ExerciseEquipmentFitRequirement[];
  items: ExerciseEquipmentFitItem[];
  assertions: ExerciseEquipmentFitAssertion[];
  currentEvidenceRevisions?: ReadonlyMap<string, string>;
}): ExerciseEquipmentFitResolution {
  const applicableRequirements = input.requirements.filter(
    (requirement) => !NON_ITEM_REQUIREMENTS.has(requirement.equipmentType),
  );
  const assertionsByItem = new Map<string, ExerciseEquipmentFitAssertion[]>();
  for (const assertion of input.assertions) {
    if (assertion.exerciseId !== input.exerciseId) continue;
    const existing = assertionsByItem.get(assertion.equipmentItemId) ?? [];
    existing.push(assertion);
    assertionsByItem.set(assertion.equipmentItemId, existing);
  }

  const requirements = applicableRequirements.map((requirement) =>
    requirementStatus({
      exerciseId: input.exerciseId,
      requirement,
      items: input.items,
      assertionsByItem,
      currentEvidenceRevisions: input.currentEvidenceRevisions ?? new Map(),
    }),
  );

  const status: ExerciseEquipmentFitStatus = requirements.length === 0
    ? "not_required"
    : requirements.every((requirement) => requirement.status === "compatible")
      ? "compatible"
      : requirements.some((requirement) => requirement.status === "incompatible")
        ? "incompatible"
        : requirements.some((requirement) => requirement.status === "missing")
          ? "missing"
          : "unknown";
  const retainedAssertions = input.assertions
    .filter((assertion) => validAssertion(assertion, input.exerciseId))
    .sort((a, b) => a.equipmentItemId.localeCompare(b.equipmentItemId))
    .map((assertion) => ({
      id: assertion.id,
      equipmentItemId: assertion.equipmentItemId,
      verdict: assertion.verdict,
      reasonCode: assertion.reasonCode,
      reasonNote: assertion.reasonNote,
      evidenceRevision: assertion.evidenceRevision,
      revision: assertion.revision,
    }));

  return {
    semanticsVersion: EXERCISE_EQUIPMENT_FIT_SEMANTICS_VERSION,
    exerciseId: input.exerciseId,
    status,
    reason: resolutionReason(status, requirements),
    candidateEquipmentItemIds: uniqueSorted(requirements.flatMap((requirement) => requirement.candidateEquipmentItemIds)),
    compatibleEquipmentItemIds: uniqueSorted(requirements.flatMap((requirement) => requirement.compatibleEquipmentItemIds)),
    incompatibleEquipmentItemIds: uniqueSorted(requirements.flatMap((requirement) => requirement.incompatibleEquipmentItemIds)),
    unknownEquipmentItemIds: uniqueSorted(requirements.flatMap((requirement) => requirement.unknownEquipmentItemIds)),
    staleEquipmentItemIds: uniqueSorted(requirements.flatMap((requirement) => requirement.staleEquipmentItemIds)),
    requirements,
    assertions: retainedAssertions,
  };
}

export function isExerciseEquipmentFitRecommendationSafe(
  resolution: ExerciseEquipmentFitResolution,
) {
  return resolution.status === "compatible" || resolution.status === "not_required";
}

export function isExerciseEquipmentItemFitRecommendationSafe(
  resolution: ExerciseEquipmentFitResolution,
  equipmentItemId: string,
) {
  return resolution.status === "not_required" ||
    (resolution.status === "compatible" &&
      resolution.compatibleEquipmentItemIds.includes(equipmentItemId));
}
