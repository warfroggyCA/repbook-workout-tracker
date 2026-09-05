import { z } from "zod";
import {
  EQUIPMENT_TYPE_VALUES,
} from "@/lib/equipment-inventory-contract";
import { equipmentItemProvidesType, equipmentRequirementLabel } from "@/engine/equipment-filter";
import {
  exactExecutionCandidateMatches,
  type ExactExecutionCandidate,
} from "@/engine/exact-equipment-availability";

export const SESSION_EQUIPMENT_REQUIREMENTS_SEMANTICS_VERSION = 1 as const;

const retainedDefinitionSchema = z.object({
  id: z.uuid(),
  key: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(300),
}).strict();

const retainedBroadRequirementSchema = z.object({
  sourceRequirementId: z.uuid(),
  equipmentType: z.enum(EQUIPMENT_TYPE_VALUES),
  equipmentDefinition: retainedDefinitionSchema.nullable(),
  minWeight: z.number().finite().nonnegative().nullable(),
}).strict();

const retainedExactRequirementSchema = z.object({
  sourceRequirementId: z.uuid(),
  requiredProfileKind: z.string().trim().min(1).max(100).nullable(),
  requiredEquipmentDefinition: retainedDefinitionSchema.nullable(),
  requiredAttachmentKind: z.string().trim().min(1).max(100).nullable(),
  requiredAttachmentDefinition: retainedDefinitionSchema.nullable(),
  requiresKnownGeometry: z.boolean(),
}).strict();

export const sessionEquipmentRequirementsSnapshotSchema = z.object({
  sourceExerciseId: z.uuid(),
  broad: z.array(retainedBroadRequirementSchema).max(100),
  exact: retainedExactRequirementSchema.nullable(),
}).strict();

export type SessionEquipmentRequirementsSnapshot = z.infer<
  typeof sessionEquipmentRequirementsSnapshotSchema
>;
export type RetainedBroadEquipmentRequirement = z.infer<
  typeof retainedBroadRequirementSchema
>;
export type RetainedExactEquipmentRequirement = z.infer<
  typeof retainedExactRequirementSchema
>;

export type RetainedPrimaryEquipmentCandidate = {
  equipmentType: string;
  equipmentDefinitionId: string | null;
  attrs?: Record<string, unknown>;
};

export type RetainedSavedEquipmentItem = RetainedPrimaryEquipmentCandidate & {
  equipmentItemId: string;
  available: boolean;
};

export type RetainedExecutableSetupCandidate =
  RetainedSavedEquipmentItem & ExactExecutionCandidate;

export type RetainedSavedAttachmentItem = {
  equipmentItemId: string;
  equipmentDefinitionId: string | null;
  attachmentKind: string | null;
  available: boolean;
};

function retainedExactRequirementMatchesCandidate(
  exact: RetainedExactEquipmentRequirement,
  candidate: RetainedExecutableSetupCandidate,
) {
  return exactExecutionCandidateMatches({
    requiredProfileKind: exact.requiredProfileKind,
    requiredEquipmentDefinitionId:
      exact.requiredEquipmentDefinition?.id ?? null,
    requiredAttachmentKind: exact.requiredAttachmentKind,
    requiredAttachmentDefinitionId:
      exact.requiredAttachmentDefinition?.id ?? null,
    requiresKnownGeometry: exact.requiresKnownGeometry,
  }, candidate);
}

function retainedExactPrimaryMatchesCandidate(
  exact: RetainedExactEquipmentRequirement,
  candidate: RetainedExecutableSetupCandidate,
) {
  return exactExecutionCandidateMatches({
    requiredProfileKind: exact.requiredProfileKind,
    requiredEquipmentDefinitionId:
      exact.requiredEquipmentDefinition?.id ?? null,
    requiredAttachmentKind: null,
    requiredAttachmentDefinitionId: null,
    requiresKnownGeometry: exact.requiresKnownGeometry,
  }, candidate);
}

/**
 * Resolves the primary/profile row from every contributing session exercise's
 * frozen tuple. Broad and attachment compatibility remain separate; the full
 * conjunction must still pass before the projected row can be available.
 */
export function retainedExactRequirementRowHasSavedSetup(input: {
  sourceRequirementIds: string[];
  sourceSessionExerciseIds: string[];
  exactRequirementsBySessionExerciseId: ReadonlyMap<
    string,
    RetainedExactEquipmentRequirement
  >;
  exactCandidates: RetainedExecutableSetupCandidate[];
}) {
  if (input.sourceSessionExerciseIds.length === 0) return false;
  return input.sourceSessionExerciseIds.every((sessionExerciseId) => {
    const exact = input.exactRequirementsBySessionExerciseId.get(
      sessionExerciseId,
    );
    return exact != null &&
      input.sourceRequirementIds.includes(exact.sourceRequirementId) &&
      input.exactCandidates.some((candidate) =>
        retainedExactPrimaryMatchesCandidate(exact, candidate)
      );
  });
}

/**
 * Checks an attachment row against saved attachment identity only. Reviewed
 * station linkage belongs to the full executable conjunction, not to whether
 * the attachment itself is present in saved equipment. Source requirement IDs
 * can repeat across retained revisions, so the frozen tuple stays session-local.
 */
export function retainedAttachmentRequirementHasSavedSetup(input: {
  equipmentDefinitionId: string | null;
  requiredAttachmentKind: string | null;
  sourceSessionExerciseIds: string[];
  exactRequirementsBySessionExerciseId: ReadonlyMap<
    string,
    RetainedExactEquipmentRequirement
  >;
  savedAttachments: RetainedSavedAttachmentItem[];
}) {
  if (input.sourceSessionExerciseIds.length === 0) return false;
  return input.sourceSessionExerciseIds.every((sessionExerciseId) => {
    const exact = input.exactRequirementsBySessionExerciseId.get(
      sessionExerciseId,
    );
    if (exact == null) return false;
    if (input.equipmentDefinitionId != null) {
      if (
        exact.requiredAttachmentDefinition?.id !==
          input.equipmentDefinitionId
      ) {
        return false;
      }
    } else if (
      exact.requiredAttachmentDefinition != null ||
      exact.requiredAttachmentKind !== input.requiredAttachmentKind
    ) {
      return false;
    }
    return input.savedAttachments.some((attachment) =>
      attachment.available &&
      (exact.requiredAttachmentKind == null ||
        attachment.attachmentKind === exact.requiredAttachmentKind) &&
      (exact.requiredAttachmentDefinition == null ||
        attachment.equipmentDefinitionId ===
          exact.requiredAttachmentDefinition.id)
    );
  });
}

/**
 * Applies retained broad-requirement identity to one primary equipment item.
 * Every retained requirement for that item's type must match; satisfying one
 * same-type row must never hide a conflicting definition or minimum.
 */
export function retainedPrimaryEquipmentCandidateMatchesBroad(
  requirements: RetainedBroadEquipmentRequirement[],
  candidate: RetainedPrimaryEquipmentCandidate,
) {
  const physical = requirements.filter(
    (requirement) => requirement.equipmentType !== "bodyweight",
  );
  if (physical.length === 0) return true;
  const sameType = physical.filter(
    (requirement) => equipmentItemProvidesType({ type: candidate.equipmentType, attrs: candidate.attrs }, requirement.equipmentType),
  );
  return sameType.length > 0 && sameType.every((requirement) =>
    (requirement.equipmentDefinition == null ||
      candidate.equipmentDefinitionId === requirement.equipmentDefinition.id) &&
    (requirement.minWeight == null || (
      typeof candidate.attrs?.maxWeight === "number" &&
      Number.isFinite(candidate.attrs.maxWeight) &&
      candidate.attrs.maxWeight >= requirement.minWeight
    )),
  );
}

function retainedBroadRequirementSatisfiedBySavedEquipment(
  requirement: RetainedBroadEquipmentRequirement,
  inventory: RetainedSavedEquipmentItem[],
  hasPlates: boolean,
) {
  if (requirement.equipmentType === "bodyweight") return true;
  if (requirement.equipmentType === "plates") {
    return requirement.equipmentDefinition == null && hasPlates;
  }
  return inventory.some((item) =>
    item.available &&
    equipmentItemProvidesType({ type: item.equipmentType, attrs: item.attrs }, requirement.equipmentType) &&
    (requirement.equipmentDefinition == null ||
      item.equipmentDefinitionId === requirement.equipmentDefinition.id) &&
    (requirement.minWeight == null || (
      typeof item.attrs?.maxWeight === "number" &&
      Number.isFinite(item.attrs.maxWeight) &&
      item.attrs.maxWeight >= requirement.minWeight
    )),
  );
}

/**
 * Proves one retained exercise is executable as a conjunction. Broad rows
 * must all be present, every same-type group must fit one saved item, and one
 * exact candidate must satisfy both that primary identity and every retained
 * profile, definition, geometry, and attachment predicate.
 */
export function retainedExerciseHasExecutableSetup(input: {
  snapshot: SessionEquipmentRequirementsSnapshot;
  inventory: RetainedSavedEquipmentItem[];
  hasPlates: boolean;
  exactCandidates: RetainedExecutableSetupCandidate[];
}) {
  if (!input.snapshot.broad.every((requirement) =>
    retainedBroadRequirementSatisfiedBySavedEquipment(
      requirement,
      input.inventory,
      input.hasPlates,
    )
  )) {
    return false;
  }

  const requirementsByType = new Map<
    string,
    RetainedBroadEquipmentRequirement[]
  >();
  for (const requirement of input.snapshot.broad) {
    if (
      requirement.equipmentType === "bodyweight" ||
      requirement.equipmentType === "plates"
    ) {
      continue;
    }
    const group = requirementsByType.get(requirement.equipmentType) ?? [];
    group.push(requirement);
    requirementsByType.set(requirement.equipmentType, group);
  }
  for (const [equipmentType, requirements] of requirementsByType) {
    if (!input.inventory.some((candidate) =>
      candidate.available &&
      equipmentItemProvidesType({ type: candidate.equipmentType, attrs: candidate.attrs }, equipmentType) &&
      retainedPrimaryEquipmentCandidateMatchesBroad(
        requirements,
        candidate,
      )
    )) {
      return false;
    }
  }

  const exact = input.snapshot.exact;
  if (exact == null) return true;
  return input.exactCandidates.some((candidate) =>
    retainedPrimaryEquipmentCandidateMatchesBroad(
      input.snapshot.broad,
      candidate,
    ) && retainedExactRequirementMatchesCandidate(exact, candidate),
  );
}

export type SessionEquipmentRequirementsEvidence =
  | {
      state: "retained";
      snapshot: SessionEquipmentRequirementsSnapshot;
    }
  | {
      state: "legacy_unknown" | "unsupported" | "invalid";
      snapshot: null;
    };

export function parseSessionEquipmentRequirementsEvidence(
  semanticsVersion: number | null,
  value: unknown,
  expectedExerciseId?: string,
): SessionEquipmentRequirementsEvidence {
  if (semanticsVersion == null && value == null) {
    return { state: "legacy_unknown", snapshot: null };
  }
  if (semanticsVersion !== SESSION_EQUIPMENT_REQUIREMENTS_SEMANTICS_VERSION) {
    return { state: "unsupported", snapshot: null };
  }
  const parsed = sessionEquipmentRequirementsSnapshotSchema.safeParse(value);
  if (
    !parsed.success ||
    (expectedExerciseId != null &&
      parsed.data.sourceExerciseId !== expectedExerciseId)
  ) {
    return { state: "invalid", snapshot: null };
  }
  return { state: "retained", snapshot: parsed.data };
}

export type SessionPreparationRequirementStatus =
  | "available"
  | "unavailable"
  | "incompatible"
  | "unknown";

export type SessionPreparationAggregateStatus =
  | "available"
  | "unavailable"
  | "unknown";

export type SessionPreparationRequirementRow = {
  key: string;
  label: string;
  classification: "confirmed" | "attention";
  status: SessionPreparationRequirementStatus;
  statusText: string;
  usageContext: string | null;
  equipmentType: string | null;
  equipmentDefinitionId: string | null;
  requiredProfileKind: string | null;
  requiredAttachmentKind: string | null;
  requiresKnownGeometry: boolean;
  minWeight: number | null;
  sourceExerciseIds: string[];
  sourceRequirementIds: string[];
};

export type SessionPreparationEquipmentProjection = {
  state: SessionPreparationAggregateStatus;
  statusText: string;
  evidenceState: "retained" | "partial_unknown" | "unknown" | "updating";
  sourceHistoryRevision: number | null;
  rows: SessionPreparationRequirementRow[];
};

export function createUpdatingSessionEquipmentProjection(
  sourceHistoryRevision: number | null = null,
): SessionPreparationEquipmentProjection {
  return {
    state: "unknown",
    statusText: "Updating equipment after workout change.",
    evidenceState: "updating",
    sourceHistoryRevision,
    rows: [],
  };
}

export type SessionPreparationExerciseRequirements = {
  sessionExerciseId: string;
  exerciseId: string;
  exerciseLabel: string;
  orderIdx: number;
  semanticsVersion: number | null;
  snapshot: unknown;
};

type PendingRow = Omit<
  SessionPreparationRequirementRow,
  "classification" | "status" | "statusText" | "usageContext"
> & {
  firstOrder: number;
  firstLocalOrder: number;
  sourceSessionExerciseIds: string[];
  usageLabels: string[];
};

export type ResolveSessionPreparationRequirementStatus = (
  row: Omit<
    PendingRow,
    "firstOrder" | "firstLocalOrder" | "sourceSessionExerciseIds" | "usageLabels"
  >,
  sourceSessionExerciseIds: string[],
) => SessionPreparationRequirementStatus;

function broadIdentity(requirement: RetainedBroadEquipmentRequirement) {
  return requirement.equipmentDefinition == null
    ? `type:${requirement.equipmentType}`
    : `definition:${requirement.equipmentDefinition.id}`;
}

function broadSupportsProfileKind(
  requirement: RetainedBroadEquipmentRequirement,
  profileKind: string,
) {
  if (profileKind === "cable_machine") {
    return requirement.equipmentType === "cable";
  }
  if (profileKind === "plate_loaded_machine") {
    return ["machine", "smith_machine", "cable"].includes(requirement.equipmentType);
  }
  if (profileKind === "plate_loaded_implement") {
    return ["barbell", "ez_bar", "trap_bar"].includes(
      requirement.equipmentType,
    );
  }
  return false;
}

function retainedExactPrimaryProjection(
  snapshot: SessionEquipmentRequirementsSnapshot,
) {
  const exact = snapshot.exact;
  if (exact == null) return null;
  if (exact.requiredEquipmentDefinition) {
    return {
      key: `definition:${exact.requiredEquipmentDefinition.id}`,
      targetBroad: null,
    };
  }
  if (!exact.requiredProfileKind && !exact.requiresKnownGeometry) return null;
  const physicalBroad = snapshot.broad.filter(
    (requirement) => requirement.equipmentType !== "bodyweight",
  );
  const compatibleBroad = exact.requiredProfileKind == null
    ? physicalBroad
    : physicalBroad.filter((requirement) =>
        broadSupportsProfileKind(requirement, exact.requiredProfileKind!),
      );
  const targetBroad = compatibleBroad.length === 1
    ? compatibleBroad[0]
    : null;
  return {
    key: targetBroad == null
      ? `exact-requirement:${exact.sourceRequirementId}`
      : broadIdentity(targetBroad),
    targetBroad,
  };
}

/**
 * Proves one projected non-attachment row from every contributing session
 * exercise's own frozen broad and primary exact predicates. Aggregated display
 * fields are intentionally not evidence because revisions may share a row key.
 */
export function retainedPrimaryRequirementRowHasSavedSetup(input: {
  rowKey: string;
  sourceSessionExerciseIds: string[];
  snapshotsBySessionExerciseId: ReadonlyMap<
    string,
    SessionEquipmentRequirementsSnapshot
  >;
  inventory: RetainedSavedEquipmentItem[];
  hasPlates: boolean;
  exactCandidates: RetainedExecutableSetupCandidate[];
}) {
  if (input.sourceSessionExerciseIds.length === 0) return false;
  return input.sourceSessionExerciseIds.every((sessionExerciseId) => {
    const snapshot = input.snapshotsBySessionExerciseId.get(sessionExerciseId);
    if (snapshot == null) return false;
    const broad = snapshot.broad.filter((requirement) =>
      requirement.equipmentType !== "bodyweight" &&
      broadIdentity(requirement) === input.rowKey
    );
    const primaryProjection = retainedExactPrimaryProjection(snapshot);
    const exact = primaryProjection?.key === input.rowKey
      ? snapshot.exact
      : null;
    if (broad.length === 0 && exact == null) return false;
    if (broad.some((requirement) => requirement.equipmentType === "plates")) {
      return broad.every((requirement) =>
        requirement.equipmentDefinition == null && input.hasPlates
      );
    }
    // A projected broad row answers only whether the frozen broad requirement
    // is represented in saved inventory. Exact profile, geometry, and
    // attachment predicates belong to the separate executable-setup verdict;
    // requiring them here would mislabel owned equipment as unavailable rather
    // than present but incompatible.
    if (broad.length > 0) {
      return input.inventory.some((candidate) =>
        candidate.available &&
        retainedPrimaryEquipmentCandidateMatchesBroad(broad, candidate)
      );
    }
    // Exact-only rows have no broad identity to prove presence, so their
    // retained exact evidence remains authoritative and deliberately strict.
    if (exact != null) {
      if (
        exact.requiredProfileKind == null &&
        !exact.requiresKnownGeometry
      ) {
        return input.inventory.some((candidate) =>
          candidate.available &&
          (exact.requiredEquipmentDefinition == null ||
            candidate.equipmentDefinitionId ===
              exact.requiredEquipmentDefinition.id) &&
          (broad.length === 0 ||
            retainedPrimaryEquipmentCandidateMatchesBroad(broad, candidate))
        );
      }
      return input.exactCandidates.some((candidate) =>
        retainedExactPrimaryMatchesCandidate(exact, candidate)
      );
    }
    return false;
  });
}

function appendRow(
  rows: Map<string, PendingRow>,
  key: string,
  candidate: Omit<PendingRow, "usageLabels"> & { usageLabel: string },
) {
  const existing = rows.get(key);
  if (!existing) {
    rows.set(key, {
      ...candidate,
      usageLabels: [candidate.usageLabel],
    });
    return;
  }
  if (candidate.minWeight != null) {
    existing.minWeight = existing.minWeight == null
      ? candidate.minWeight
      : Math.max(existing.minWeight, candidate.minWeight);
  }
  for (const id of candidate.sourceExerciseIds) {
    if (!existing.sourceExerciseIds.includes(id)) existing.sourceExerciseIds.push(id);
  }
  for (const id of candidate.sourceSessionExerciseIds) {
    if (!existing.sourceSessionExerciseIds.includes(id)) {
      existing.sourceSessionExerciseIds.push(id);
    }
  }
  for (const id of candidate.sourceRequirementIds) {
    if (!existing.sourceRequirementIds.includes(id)) {
      existing.sourceRequirementIds.push(id);
    }
  }
  if (!existing.usageLabels.includes(candidate.usageLabel)) {
    existing.usageLabels.push(candidate.usageLabel);
  }
  existing.requiresKnownGeometry ||= candidate.requiresKnownGeometry;
  existing.requiredProfileKind ??= candidate.requiredProfileKind;
  existing.requiredAttachmentKind ??= candidate.requiredAttachmentKind;
}

function rowStatusText(status: SessionPreparationRequirementStatus) {
  if (status === "available") return "In saved equipment";
  if (status === "unavailable") return "Unavailable in saved equipment";
  if (status === "incompatible") return "No compatible saved setup";
  return "Availability unknown";
}

/**
 * Produces the stable-ID, provenance-linked checklist shown before warm-up.
 * Display labels are never identities. The optional resolver owns live
 * inventory truth; absent evidence remains explicitly unknown.
 */
export function projectSessionEquipmentPreparation(
  exercises: SessionPreparationExerciseRequirements[],
  resolveStatus?: ResolveSessionPreparationRequirementStatus,
  sourceHistoryRevision: number | null = null,
): SessionPreparationEquipmentProjection {
  const rows = new Map<string, PendingRow>();
  let unknownExerciseCount = 0;
  const ordered = [...exercises].sort(
    (left, right) => left.orderIdx - right.orderIdx ||
      left.sessionExerciseId.localeCompare(right.sessionExerciseId),
  );

  for (const exercise of ordered) {
    const evidence = parseSessionEquipmentRequirementsEvidence(
      exercise.semanticsVersion,
      exercise.snapshot,
      exercise.exerciseId,
    );
    if (evidence.state !== "retained") {
      unknownExerciseCount += 1;
      continue;
    }

    const { snapshot } = evidence;
    snapshot.broad.forEach((requirement, localOrder) => {
      if (requirement.equipmentType === "bodyweight") return;
      const definition = requirement.equipmentDefinition;
      appendRow(rows, broadIdentity(requirement), {
        key: broadIdentity(requirement),
        label: definition?.label ?? equipmentRequirementLabel(requirement.equipmentType),
        equipmentType: requirement.equipmentType,
        equipmentDefinitionId: definition?.id ?? null,
        requiredProfileKind: null,
        requiredAttachmentKind: null,
        requiresKnownGeometry: false,
        minWeight: requirement.minWeight,
        sourceExerciseIds: [snapshot.sourceExerciseId],
        sourceRequirementIds: [requirement.sourceRequirementId],
        sourceSessionExerciseIds: [exercise.sessionExerciseId],
        firstOrder: exercise.orderIdx,
        firstLocalOrder: localOrder,
        usageLabel: exercise.exerciseLabel,
      });
    });

    const exact = snapshot.exact;
    if (!exact) continue;
    const baseOrder = snapshot.broad.length;
    const primaryProjection = retainedExactPrimaryProjection(snapshot);
    if (primaryProjection) {
      const equipmentDefinition = exact.requiredEquipmentDefinition;
      const targetBroad = primaryProjection.targetBroad;
      appendRow(rows, primaryProjection.key, {
        key: primaryProjection.key,
        label: equipmentDefinition?.label ??
          targetBroad?.equipmentDefinition?.label ??
          (targetBroad
            ? equipmentRequirementLabel(targetBroad.equipmentType)
            : exact.requiredProfileKind?.replaceAll("_", " ") ??
              "Known equipment setup"),
        equipmentType: equipmentDefinition == null
          ? targetBroad?.equipmentType ?? null
          : null,
        equipmentDefinitionId: equipmentDefinition?.id ??
          targetBroad?.equipmentDefinition?.id ?? null,
        requiredProfileKind: exact.requiredProfileKind,
        requiredAttachmentKind: null,
        requiresKnownGeometry: exact.requiresKnownGeometry,
        minWeight: equipmentDefinition == null
          ? targetBroad?.minWeight ?? null
          : null,
        sourceExerciseIds: [snapshot.sourceExerciseId],
        sourceRequirementIds: [exact.sourceRequirementId],
        sourceSessionExerciseIds: [exercise.sessionExerciseId],
        firstOrder: exercise.orderIdx,
        firstLocalOrder: baseOrder,
        usageLabel: exercise.exerciseLabel,
      });
    }

    const attachmentDefinition = exact.requiredAttachmentDefinition;
    if (attachmentDefinition || exact.requiredAttachmentKind) {
      const key = attachmentDefinition
        ? `attachment-definition:${attachmentDefinition.id}`
        : `attachment-kind:${exact.requiredAttachmentKind}`;
      appendRow(rows, key, {
        key,
        label: attachmentDefinition?.label ??
          `${exact.requiredAttachmentKind!.replaceAll("_", " ")} attachment`,
        equipmentType: null,
        equipmentDefinitionId: attachmentDefinition?.id ?? null,
        requiredProfileKind: null,
        requiredAttachmentKind: exact.requiredAttachmentKind,
        requiresKnownGeometry: false,
        minWeight: null,
        sourceExerciseIds: [snapshot.sourceExerciseId],
        sourceRequirementIds: [exact.sourceRequirementId],
        sourceSessionExerciseIds: [exercise.sessionExerciseId],
        firstOrder: exercise.orderIdx,
        firstLocalOrder: baseOrder + 1,
        usageLabel: exercise.exerciseLabel,
      });
    }
  }

  const projectedRows = [...rows.values()]
    .sort((left, right) =>
      left.firstOrder - right.firstOrder ||
      left.firstLocalOrder - right.firstLocalOrder ||
      left.key.localeCompare(right.key),
    )
    .map((pending) => {
      const row = {
        key: pending.key,
        label: pending.label,
        equipmentType: pending.equipmentType,
        equipmentDefinitionId: pending.equipmentDefinitionId,
        requiredProfileKind: pending.requiredProfileKind,
        requiredAttachmentKind: pending.requiredAttachmentKind,
        requiresKnownGeometry: pending.requiresKnownGeometry,
        minWeight: pending.minWeight,
        sourceExerciseIds: pending.sourceExerciseIds,
        sourceRequirementIds: pending.sourceRequirementIds,
      };
      const status = resolveStatus?.(
        row,
        pending.sourceSessionExerciseIds,
      ) ?? "unknown";
      return {
        ...row,
        classification: status === "available" ? "confirmed" as const : "attention" as const,
        status,
        statusText: rowStatusText(status),
        usageContext: pending.usageLabels.length === 0
          ? null
          : `Used for ${pending.usageLabels.join(", ")}`,
      };
    });

  const hasUnavailable = projectedRows.some((row) => row.status === "unavailable");
  const hasIncompatible = projectedRows.some(
    (row) => row.status === "incompatible",
  );
  const hasUnknown = unknownExerciseCount > 0 ||
    projectedRows.some((row) => row.status === "unknown");
  let state: SessionPreparationAggregateStatus = "available";
  if (hasUnavailable || hasIncompatible) state = "unavailable";
  else if (hasUnknown) state = "unknown";
  const evidenceState = unknownExerciseCount === 0
    ? "retained" as const
    : unknownExerciseCount === exercises.length
      ? "unknown" as const
      : "partial_unknown" as const;
  const statusText = hasUnavailable && hasIncompatible
    ? "Some requirements are unavailable or have no compatible saved setup."
    : hasUnavailable
      ? "Some requirements are unavailable in saved equipment."
      : hasIncompatible
        ? "Saved equipment is present, but no compatible setup covers this workout."
        : state === "unknown"
          ? "Some equipment requirements are unknown."
          : projectedRows.length === 0
            ? "No equipment needed."
            : "Saved equipment covers this workout.";
  return {
    state,
    statusText,
    evidenceState,
    sourceHistoryRevision,
    rows: projectedRows,
  };
}
