import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  buildEquipmentAvailability,
  exerciseIsAvailable,
  requirementSatisfied,
  type InventoryItem,
} from "@/engine/equipment-filter";
import {
  exactExecutionCandidateMatches,
  type ExactExecutionCandidate,
  type ExactExecutionRequirement,
} from "@/engine/exact-equipment-availability";
import {
  buildSessionEquipmentConfigurationIdentity,
  sessionEquipmentGeometrySnapshotSchema,
  type SessionEquipmentGeometrySnapshot,
} from "@/lib/session-equipment-snapshot-contract";
import { buildSessionEquipmentPresentation } from "@/lib/session-equipment-presentation";
import { resolveProspectiveMachinePlates } from "@/lib/machine-plate-compatibility";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import {
  loadEquipmentLoadProfiles,
  type LoadedEquipmentLoadProfile,
} from "@/services/equipment-load-profiles";
import { inventoryRevisionExpression } from "@/services/equipment-inventory";
import {
  loadOwnerEquipmentFitReviewRevision,
  ownerEquipmentFitReviewRevisionExpression,
} from "@/services/equipment-fit-review-revision";
import {
  parseSessionEquipmentRequirementsEvidence,
  retainedPrimaryEquipmentCandidateMatchesBroad,
  type RetainedBroadEquipmentRequirement,
  type SessionEquipmentRequirementsSnapshot,
} from "@/lib/session-equipment-requirements";
import { isExerciseEquipmentItemFitRecommendationSafe } from "@/lib/exercise-equipment-fit";
import type { ExerciseEquipmentFitStatus } from "@/lib/exercise-equipment-fit";
import {
  loadExerciseEquipmentFitSettings,
  resolveExerciseEquipmentFitFromSettings,
} from "@/services/exercise-equipment-fit";
import { exerciseEquipmentFitEvidenceRevisionExpression } from "@/services/exercise-equipment-fit-evidence";
import { sessionEquipmentRequirementsSnapshotExpression } from "@/services/session-equipment-requirements";

export type SessionEquipmentSelectionInput =
  | {
      operation: "select";
      sessionExerciseId: string;
      equipmentItemId: string;
      attachmentItemId: string | null;
      expectedCurrentSnapshotId: string | null;
      clientKey: string;
      provenance: "auto_unique" | "user_selected";
    }
  | {
      operation: "clear";
      sessionExerciseId: string;
      expectedCurrentSnapshotId: string | null;
      clientKey: string;
    };

export type SessionEquipmentSelectionResult =
  | {
      outcome: "applied" | "no_change" | "replayed";
      snapshotId: string | null;
      occurrenceStates: EquipmentSelectionOccurrenceState[];
    }
  | {
      outcome:
        | "conflict"
        | "not_found"
        | "not_active"
        | "stale"
        | "invalid_setup"
        | "ambiguous";
    };

export type SessionEquipmentSelectionDependencies = {
  checkpoint?: (
    name: "before-selection-statement",
  ) => void | Promise<void>;
};

export type EquipmentSelectionOccurrenceState = {
  id: string;
  outcome: string;
  outcomeReason: string | null;
  outcomeNote: string | null;
  revision: number;
  resolvedAt: string | null;
  completedSetId: string | null;
};

type ContextRow = {
  session_id: string;
  exercise_id: string;
  load_type: string;
  uses_prescribed_meaning: boolean;
  target_load: number | string | null;
  target_load_unit: "lb" | "kg" | null;
  status: string;
  archived_at: Date | string | null;
  current_equipment_snapshot_id: string | null;
  equipment_requirements_semantics_version: number | null;
  equipment_requirements_snapshot: unknown;
  retained_requirements: SessionEquipmentRequirementsSnapshot | null;
  uses_retained_requirements: boolean;
  retained_requirements_match_current: boolean;
  source_revision: string;
};

type RawContextRow = Omit<
  ContextRow,
  | "retained_requirements"
  | "uses_retained_requirements"
>;

type ItemRow = {
  id: string;
  type: string;
  label: string;
  available: boolean;
  attrs: Record<string, unknown>;
  definition_id: string | null;
  definition_key: string | null;
};

type PlateRow = {
  id: string;
  denomination: number | string;
  quantity: number;
  unit: "lb" | "kg";
};

function payloadHash(input: SessionEquipmentSelectionInput): string {
  return sha256Hex(Buffer.from(canonicalJson(input), "utf8"));
}

async function loadOccurrenceStates(
  db: Db,
  userId: string,
  sessionExerciseId: string,
) {
  return resultRows(await db.execute(sql`
    SELECT occurrence.id, occurrence.outcome::text, occurrence.outcome_reason,
           occurrence.outcome_note, occurrence.revision, occurrence.resolved_at,
           occurrence.completed_set_id
    FROM session_occurrences occurrence
    JOIN workout_sessions session ON session.id = occurrence.session_id
    WHERE occurrence.session_exercise_id = ${sessionExerciseId}::uuid
      AND session.user_id = ${userId}::uuid
    ORDER BY occurrence.sequence_idx, occurrence.id
  `)).map((row) => ({
    id: String(row.id),
    outcome: String(row.outcome),
    outcomeReason: row.outcome_reason == null ? null : String(row.outcome_reason),
    outcomeNote: row.outcome_note == null ? null : String(row.outcome_note),
    revision: Number(row.revision),
    resolvedAt:
      row.resolved_at == null
        ? null
        : new Date(row.resolved_at as Date | string).toISOString(),
    completedSetId:
      row.completed_set_id == null ? null : String(row.completed_set_id),
  }));
}

async function attachOccurrenceStates(
  db: Db,
  userId: string,
  sessionExerciseId: string,
  result: SessionEquipmentSelectionResult,
): Promise<SessionEquipmentSelectionResult> {
  if (
    result.outcome !== "applied" &&
    result.outcome !== "no_change" &&
    result.outcome !== "replayed"
  ) {
    return result;
  }
  return {
    ...result,
    occurrenceStates: await loadOccurrenceStates(
      db,
      userId,
      sessionExerciseId,
    ),
  };
}

/** One CAS identity for every live fact copied into an equipment snapshot. */
export function sessionEquipmentSelectionSourceRevisionExpression(
  userId: string,
  exerciseId: string | SQL,
  includeCurrentRequirements = true,
  retainedRequirementsSnapshot: SQL = sql`NULL::jsonb`,
) {
  return sql`md5(
    ${inventoryRevisionExpression(userId)}
    || coalesce((${retainedRequirementsSnapshot})::text, 'legacy_unknown')
    || coalesce((SELECT jsonb_agg(jsonb_build_array(
         fit.id, fit.exercise_id, fit.equipment_item_id, fit.verdict,
         fit.reason_code, fit.reason_note, fit.provenance,
         fit.semantics_version, fit.evidence_revision, fit.revision,
         ${exerciseEquipmentFitEvidenceRevisionExpression(
           userId,
           sql`fit.exercise_id`,
           sql`fit.equipment_item_id`,
         )}
       ) ORDER BY fit.equipment_item_id)::text
       FROM exercise_equipment_fit_assertions fit
       WHERE fit.user_id = ${userId}::uuid
         AND fit.exercise_id = ${exerciseId}::uuid), '[]')
    || CASE WHEN ${includeCurrentRequirements}::boolean THEN
      coalesce((SELECT jsonb_agg(to_jsonb(requirement) ORDER BY requirement.id)::text
                 FROM exercise_equipment_requirements requirement
                 WHERE requirement.exercise_id = ${exerciseId}::uuid), '[]')
      || coalesce((SELECT jsonb_agg(to_jsonb(requirement) ORDER BY requirement.id)::text
                 FROM exercise_execution_requirements requirement
                 WHERE requirement.exercise_id = ${exerciseId}::uuid), '[]')
      ELSE ''
    END
  )`;
}

async function replayedReceipt(
  db: Db,
  userId: string,
  input: SessionEquipmentSelectionInput,
  hash: string,
): Promise<SessionEquipmentSelectionResult | null> {
  const receipt = resultRows(await db.execute(sql`
    SELECT receipt.operation, receipt.canonical_payload_hash,
           receipt.resulting_snapshot_id
    FROM session_equipment_selection_receipts receipt
    JOIN workout_sessions session ON session.id = receipt.session_id
    WHERE receipt.session_exercise_id = ${input.sessionExerciseId}::uuid
      AND receipt.client_key = ${input.clientKey}::uuid
      AND session.user_id = ${userId}::uuid
    LIMIT 1
  `))[0];
  if (!receipt) return null;
  if (
    receipt.operation !== input.operation ||
    receipt.canonical_payload_hash !== hash
  ) {
    return { outcome: "conflict" };
  }
  return {
    outcome: "replayed",
    snapshotId:
      receipt.resulting_snapshot_id == null
        ? null
        : String(receipt.resulting_snapshot_id),
    occurrenceStates: [],
  };
}

async function loadContext(db: Db, userId: string, sessionExerciseId: string) {
  const raw = resultRows<RawContextRow>(await db.execute(sql`
    SELECT session_exercise.session_id, session_exercise.exercise_id,
           CASE
             WHEN session_exercise.prescribed_semantics_version = 1
               AND session_exercise.modification_type NOT IN ('substituted', 'added')
             THEN session_exercise.prescribed_load_type
             ELSE catalog.load_type
           END::text AS load_type,
           coalesce((session_exercise.prescribed_semantics_version = 1
             AND session_exercise.modification_type NOT IN ('substituted', 'added')), false)
             AS uses_prescribed_meaning,
           session_exercise.target_load,
           session_exercise.target_load_unit::text, session.status,
           session.archived_at, session_exercise.current_equipment_snapshot_id,
           session_exercise.equipment_requirements_semantics_version,
           session_exercise.equipment_requirements_snapshot,
           coalesce(
             session_exercise.equipment_requirements_semantics_version = 1
             AND session_exercise.equipment_requirements_snapshot IS NOT NULL
             AND session_exercise.equipment_requirements_snapshot =
               ${sessionEquipmentRequirementsSnapshotExpression(
                 sql`session_exercise.exercise_id`,
             )},
             false
           ) AS retained_requirements_match_current,
           ${sessionEquipmentSelectionSourceRevisionExpression(
             userId,
             sql`session_exercise.exercise_id`,
             true,
             sql`session_exercise.equipment_requirements_snapshot`,
           )} AS source_revision
    FROM session_exercises session_exercise
    JOIN workout_sessions session ON session.id = session_exercise.session_id
    JOIN exercises catalog ON catalog.id = session_exercise.exercise_id
    WHERE session_exercise.id = ${sessionExerciseId}::uuid
      AND session.user_id = ${userId}::uuid
    LIMIT 1
  `))[0] ?? null;
  if (!raw) return null;
  const evidence = parseSessionEquipmentRequirementsEvidence(
    raw.equipment_requirements_semantics_version == null
      ? null
      : Number(raw.equipment_requirements_semantics_version),
    raw.equipment_requirements_snapshot,
    raw.exercise_id,
  );
  const usesRetainedRequirements = evidence.state === "retained";
  const context: ContextRow = {
    ...raw,
    retained_requirements: usesRetainedRequirements ? evidence.snapshot : null,
    uses_retained_requirements: usesRetainedRequirements,
    source_revision: String(raw.source_revision),
  };
  return context;
}

export type SessionEquipmentAvailabilityResolution = {
  exerciseId: string;
  sourceRevision: string;
  availableOptionCount: number;
  equipmentFitStatus: ExerciseEquipmentFitStatus;
  usesPrescribedMeaning: boolean;
  requirementsEvidence: "retained" | "legacy_unknown";
};

/**
 * Resolve the authoritative owner-scoped setup choices used by set logging.
 * The source revision is re-read after option construction so the atomic set
 * statement can reject a concurrent inventory or reviewed-requirement change.
 */
export async function resolveSessionEquipmentAvailability(
  db: Db,
  userId: string,
  sessionExerciseId: string,
): Promise<SessionEquipmentAvailabilityResolution | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const context = await loadContext(db, userId, sessionExerciseId);
    if (!context) return null;
    if (
      context.retained_requirements == null ||
      !context.retained_requirements_match_current
    ) {
      return {
        exerciseId: context.exercise_id,
        sourceRevision: context.source_revision,
        availableOptionCount: 0,
        equipmentFitStatus: "unknown",
        usesPrescribedMeaning: true,
        requirementsEvidence: "legacy_unknown",
      };
    }
    const [{ items, plates }, profiles, requirements] = await Promise.all([
      loadLiveInventory(db, userId),
      loadEquipmentLoadProfiles(db, userId),
      loadRequirementsForContext(context),
    ]);
    const fitSettings = await loadExerciseEquipmentFitSettings(
      db,
      userId,
      [context.exercise_id],
    );
    const equipmentFit = resolveExerciseEquipmentFitFromSettings({
      exerciseId: context.exercise_id,
      requirements: requirements.broad,
      equipmentItems: items.map((item) => ({
        id: item.id,
        type: item.type,
        definitionId: item.definition_id,
        available: item.available,
        attrs: item.attrs,
      })),
      settings: fitSettings,
    });
    const presentation = buildSessionEquipmentPresentation({
      exercise: {
        id: sessionExerciseId,
        exerciseId: context.exercise_id,
        loadType: context.load_type,
        targetLoad:
          context.target_load == null ? null : Number(context.target_load),
        targetLoadUnit: context.target_load_unit,
        requirements: requirements.broad,
        exactRequirement: requirements.exact,
        currentSelection: null,
      },
      profiles,
      inventory: items.map((item) => ({
        type: item.type,
        available: item.available,
        attrs: item.attrs ?? {},
      })),
      plates: plates.map((plate) => ({
        id: plate.id,
        denomination: Number(plate.denomination),
        quantity: Number(plate.quantity),
        unit: plate.unit,
      })),
    });
    const availableOptions = presentation.setup?.options.filter((option) => {
      const item = items.find(
        (candidate) => candidate.id === option.equipmentItemId,
      );
      if (
        item == null ||
        !isExerciseEquipmentItemFitRecommendationSafe(
          equipmentFit,
          item.id,
        )
      ) {
        return false;
      }
      return !context.retained_requirements || retainedPrimaryEquipmentCandidateMatchesBroad(
        context.retained_requirements.broad,
        {
          equipmentType: item.type,
          equipmentDefinitionId: item.definition_id,
          attrs: item.attrs,
        },
      );
    }) ?? [];
    const currentRevision = resultRows(await db.execute(sql`
      SELECT ${sessionEquipmentSelectionSourceRevisionExpression(
        userId,
        context.exercise_id,
        true,
        sql`session_exercise.equipment_requirements_snapshot`,
      )} AS source_revision
      FROM session_exercises session_exercise
      JOIN workout_sessions session ON session.id = session_exercise.session_id
      WHERE session_exercise.id = ${sessionExerciseId}::uuid
        AND session_exercise.exercise_id = ${context.exercise_id}::uuid
        AND session.user_id = ${userId}::uuid
    `))[0];
    if (
      currentRevision &&
      String(currentRevision.source_revision) === context.source_revision
    ) {
      return {
        exerciseId: context.exercise_id,
        sourceRevision: context.source_revision,
        availableOptionCount: availableOptions.length,
        equipmentFitStatus: equipmentFit.status,
        usesPrescribedMeaning: context.uses_prescribed_meaning,
        requirementsEvidence: context.uses_retained_requirements
          ? "retained"
          : "legacy_unknown",
      };
    }
  }
  throw new Error(
    "The available equipment changed while the set was being prepared.",
  );
}

async function loadLiveInventory(db: Db, userId: string) {
  const [items, plates] = await Promise.all([
    db.execute(sql`
      SELECT item.id, item.type::text, item.label, item.available, item.attrs,
             item.definition_id, definition.key AS definition_key
      FROM equipment_items item
      LEFT JOIN equipment_definitions definition ON definition.id = item.definition_id
      WHERE item.user_id = ${userId}::uuid
      ORDER BY item.id
    `),
    db.execute(sql`
      SELECT id, denomination, quantity, unit::text
      FROM plate_inventory
      WHERE user_id = ${userId}::uuid
      ORDER BY denomination DESC, id
    `),
  ]);
  return {
    items: resultRows<ItemRow>(items),
    plates: resultRows<PlateRow>(plates),
  };
}

function requirementsFromSnapshot(
  snapshot: SessionEquipmentRequirementsSnapshot,
) {
  return {
    broad: snapshot.broad.map((requirement) => ({
      id: requirement.sourceRequirementId,
      equipmentType: requirement.equipmentType,
      equipmentDefinitionId: requirement.equipmentDefinition?.id ?? null,
      minWeight: requirement.minWeight,
    })),
    exact: snapshot.exact == null
      ? null
      : {
          requiredProfileKind: snapshot.exact.requiredProfileKind,
          requiredEquipmentDefinitionId:
            snapshot.exact.requiredEquipmentDefinition?.id ?? null,
          requiredAttachmentKind: snapshot.exact.requiredAttachmentKind,
          requiredAttachmentDefinitionId:
            snapshot.exact.requiredAttachmentDefinition?.id ?? null,
          requiresKnownGeometry: snapshot.exact.requiresKnownGeometry,
        } satisfies ExactExecutionRequirement,
  };
}

function loadRequirementsForContext(context: ContextRow) {
  if (context.retained_requirements) {
    return requirementsFromSnapshot(context.retained_requirements);
  }
  return { broad: [], exact: null };
}

function retainedBroadRequirementSatisfied(
  requirement: RetainedBroadEquipmentRequirement,
  items: ItemRow[],
  plates: PlateRow[],
) {
  if (requirement.equipmentType === "bodyweight") return true;
  if (requirement.equipmentType === "plates") {
    return requirement.equipmentDefinition == null && plates.some(
      (plate) => Number(plate.quantity) > 0 && Number(plate.denomination) > 0,
    );
  }
  return items.some((item) =>
    item.available &&
    item.type === requirement.equipmentType &&
    (requirement.equipmentDefinition == null ||
      item.definition_id === requirement.equipmentDefinition.id) &&
    (requirement.minWeight == null || (
      typeof item.attrs.maxWeight === "number" &&
      Number.isFinite(item.attrs.maxWeight) &&
      item.attrs.maxWeight >= requirement.minWeight
    )),
  );
}

function profileCertainty(profile: LoadedEquipmentLoadProfile["profile"]) {
  return profile.kind === "plate_loaded_implement"
    ? "known" as const
    : profile.kind === "attachment"
      ? null
      : profile.geometryCertainty;
}

function exactCandidate(
  profile: LoadedEquipmentLoadProfile,
  items: Map<string, ItemRow>,
  profiles: LoadedEquipmentLoadProfile[],
  selectedAttachmentId?: string | null,
): ExactExecutionCandidate | null {
  if (profile.profile.kind === "attachment") return null;
  const item = items.get(profile.equipmentItemId);
  const compatibleIds = profile.profile.kind === "cable_machine"
    ? profile.profile.compatibleAttachmentItemIds
    : [];
  let attachmentIds = compatibleIds;
  if (selectedAttachmentId === null) attachmentIds = [];
  if (selectedAttachmentId !== undefined && selectedAttachmentId !== null) {
    attachmentIds = compatibleIds.filter((id) => id === selectedAttachmentId);
  }
  return {
    equipmentItemId: profile.equipmentItemId,
    available: profile.available,
    profileKind: profile.profile.kind,
    equipmentDefinitionId: item?.definition_id ?? null,
    geometryCertainty: profileCertainty(profile.profile),
    compatibleAttachments: attachmentIds.flatMap((attachmentId) => {
      const attachment = profiles.find(
        (entry) =>
          entry.equipmentItemId === attachmentId &&
          entry.profile.kind === "attachment",
      );
      const attachmentItem = items.get(attachmentId);
      if (!attachment || attachment.profile.kind !== "attachment") return [];
      return [{
        equipmentItemId: attachmentId,
        available: attachment.available,
        attachmentKind: attachment.profile.attachmentKind,
        equipmentDefinitionId: attachmentItem?.definition_id ?? null,
      }];
    }),
  };
}

function compatiblePlateSnapshot(
  profile: LoadedEquipmentLoadProfile["profile"],
  plates: PlateRow[],
) {
  const requiredUnit = profile.kind === "plate_loaded_implement"
    ? profile.unit
    : profile.kind === "plate_loaded_machine"
      ? profile.startingResistanceUnit
      : null;
  const compatiblePlates =
    profile.kind === "plate_loaded_machine"
      ? resolveProspectiveMachinePlates(profile, plates)
      : plates.filter(
          (plate) =>
            profile.kind === "plate_loaded_implement" &&
            profile.sharedPlatePoolCompatible &&
            plate.unit === requiredUnit,
        );
  return compatiblePlates
    .map((plate) => ({
      denomination: Number(plate.denomination),
      quantity: Number(plate.quantity),
      unit: plate.unit,
    }));
}

function geometrySnapshot(
  profile: LoadedEquipmentLoadProfile["profile"],
  plates: PlateRow[],
): SessionEquipmentGeometrySnapshot {
  if (profile.kind === "attachment") {
    throw new Error("An attachment cannot be the primary load profile.");
  }
  if (profile.kind === "plate_loaded_implement") {
    return sessionEquipmentGeometrySnapshotSchema.parse({
      version: 1,
      kind: profile.kind,
      loadingKind: profile.loadingKind,
      emptyWeight: profile.emptyWeight,
      collarWeight: profile.collarWeight,
      unit: profile.unit,
      sharedPlatePoolCompatible: profile.sharedPlatePoolCompatible,
      compatiblePlates: compatiblePlateSnapshot(profile, plates),
    });
  }
  if (profile.kind === "plate_loaded_machine") {
    return sessionEquipmentGeometrySnapshotSchema.parse({
      version: 1,
      kind: profile.kind,
      geometryCertainty: profile.geometryCertainty,
      startingResistance: profile.startingResistance,
      startingResistanceUnit: profile.startingResistanceUnit,
      loadingPointCount: profile.loadingPointCount,
      balancingRule: profile.balancingRule,
      targetEntryMeaning: profile.targetEntryMeaning,
      compatiblePlates: compatiblePlateSnapshot(profile, plates),
    });
  }
  return sessionEquipmentGeometrySnapshotSchema.parse({
    version: 1,
    kind: profile.kind,
    geometryCertainty: profile.geometryCertainty,
    stackCount: profile.stackCount,
    topology: profile.topology,
    displayedUnit: profile.displayedUnit,
    ratioStatus: profile.ratioStatus,
    ratioNumerator: profile.ratioNumerator,
    ratioDenominator: profile.ratioDenominator,
    stackSteps: profile.stackSteps.map((step) => ({
      stackIndex: step.stackIndex,
      stepIndex: step.stepIndex,
      displayedLoad: step.displayedLoad,
      positionLabel: step.positionLabel,
    })),
  });
}

type SnapshotCandidate = {
  snapshotId: string;
  profileId: string;
  equipmentItemId: string;
  equipmentLabel: string;
  equipmentDefinitionKey: string | null;
  attachmentItemId: string | null;
  attachmentProfileId: string | null;
  attachmentLabel: string | null;
  attachmentDefinitionKey: string | null;
  profileKind: "plate_loaded_implement" | "plate_loaded_machine" | "cable_machine";
  geometryCertainty: "known" | "partial" | "unknown";
  unit: "lb" | "kg" | null;
  provenance: "auto_unique" | "user_selected";
  geometry: SessionEquipmentGeometrySnapshot;
  configurationHash: string;
};

async function applySelection(
  db: Db,
  userId: string,
  context: ContextRow,
  input: Extract<SessionEquipmentSelectionInput, { operation: "select" }>,
  hash: string,
  snapshot: SnapshotCandidate,
  expectedEquipmentFitReviewRevision: string,
): Promise<SessionEquipmentSelectionResult> {
  const row = resultRows(await db.execute(sql`
    WITH target_profile AS MATERIALIZED (
      SELECT profile.user_id
      FROM user_profiles profile
      WHERE profile.user_id = ${userId}::uuid
      FOR UPDATE
    ), equipment_fit_gate AS MATERIALIZED (
      SELECT profile.user_id
      FROM target_profile profile
      WHERE ${ownerEquipmentFitReviewRevisionExpression(sql`profile.user_id`)}
        = ${expectedEquipmentFitReviewRevision}::text
    ), visible AS MATERIALIZED (
      SELECT exercise.*, session.user_id, session.status, session.archived_at,
             current_snapshot.configuration_hash AS current_hash
      FROM session_exercises exercise
      JOIN workout_sessions session ON session.id = exercise.session_id
      LEFT JOIN session_equipment_snapshots current_snapshot
        ON current_snapshot.id = exercise.current_equipment_snapshot_id
      WHERE exercise.id = ${input.sessionExerciseId}::uuid
        AND session.user_id = ${userId}::uuid
    ), existing AS MATERIALIZED (
      SELECT receipt.*
      FROM target_profile profile
      CROSS JOIN LATERAL session_equipment_selection_receipt_after_owner_lock(
        profile.user_id,
        ${input.sessionExerciseId}::uuid,
        ${input.clientKey}::uuid
      ) receipt
    ), eligible AS MATERIALIZED (
      SELECT visible.* FROM visible
      JOIN equipment_fit_gate fit_gate ON true
      WHERE status = 'in_progress' AND archived_at IS NULL
        AND exercise_id = ${context.exercise_id}::uuid
        AND current_equipment_snapshot_id IS NOT DISTINCT FROM ${input.expectedCurrentSnapshotId}::uuid
        AND ${sessionEquipmentSelectionSourceRevisionExpression(
          userId,
          context.exercise_id,
          true,
          sql`visible.equipment_requirements_snapshot`,
        )} = ${context.source_revision}
        AND NOT EXISTS (SELECT 1 FROM existing)
      FOR UPDATE
    ), inserted_snapshot AS (
      INSERT INTO session_equipment_snapshots (
        id, user_id, session_id, session_exercise_id, equipment_item_id,
        load_profile_id, attachment_item_id, attachment_profile_id,
        equipment_label, equipment_definition_key, attachment_label,
        attachment_definition_key, profile_kind, geometry_certainty, unit,
        selection_provenance, configuration_revision, configuration_hash,
        geometry_version, geometry_snapshot
      )
      SELECT ${snapshot.snapshotId}::uuid, ${userId}::uuid, eligible.session_id,
             eligible.id, ${snapshot.equipmentItemId}::uuid,
             ${snapshot.profileId}::uuid, ${snapshot.attachmentItemId}::uuid,
             ${snapshot.attachmentProfileId}::uuid, ${snapshot.equipmentLabel},
             ${snapshot.equipmentDefinitionKey}, ${snapshot.attachmentLabel},
             ${snapshot.attachmentDefinitionKey}, ${snapshot.profileKind},
             ${snapshot.geometryCertainty}, ${snapshot.unit}::unit,
             ${snapshot.provenance}, 1, ${snapshot.configurationHash}, 1,
             ${JSON.stringify(snapshot.geometry)}::jsonb
      FROM eligible
      WHERE eligible.current_hash IS DISTINCT FROM ${snapshot.configurationHash}
      RETURNING *
    ), selected_snapshot AS MATERIALIZED (
      SELECT id FROM inserted_snapshot
      UNION ALL
      SELECT current_equipment_snapshot_id AS id FROM eligible
      WHERE current_hash = ${snapshot.configurationHash}
      LIMIT 1
    ), updated_exercise AS (
      UPDATE session_exercises exercise
      SET current_equipment_snapshot_id = selected_snapshot.id
      FROM eligible, selected_snapshot
      WHERE exercise.id = eligible.id
      RETURNING exercise.id, exercise.session_id,
                selected_snapshot.id AS resulting_snapshot_id,
                eligible.current_equipment_snapshot_id AS prior_snapshot_id,
                (eligible.current_equipment_snapshot_id IS DISTINCT FROM selected_snapshot.id) AS changed
    ), updated_occurrences AS (
      UPDATE session_occurrences occurrence
      SET equipment_snapshot_id = updated_exercise.resulting_snapshot_id,
          revision = occurrence.revision + 1
      FROM updated_exercise
      WHERE occurrence.session_exercise_id = updated_exercise.id
        AND occurrence.session_id = updated_exercise.session_id
        AND occurrence.outcome = 'pending'
        AND occurrence.equipment_snapshot_id IS DISTINCT FROM updated_exercise.resulting_snapshot_id
      RETURNING occurrence.id
    ), saved_receipt AS (
      INSERT INTO session_equipment_selection_receipts (
        user_id, session_id, session_exercise_id, client_key, operation,
        canonical_payload_hash, prior_snapshot_id, resulting_snapshot_id,
        result_code
      )
      SELECT ${userId}::uuid, updated_exercise.session_id, updated_exercise.id,
             ${input.clientKey}::uuid, 'select', ${hash},
             updated_exercise.prior_snapshot_id,
             updated_exercise.resulting_snapshot_id,
             CASE WHEN updated_exercise.changed
                    OR EXISTS (SELECT 1 FROM updated_occurrences)
                  THEN 'applied' ELSE 'no_change' END
      FROM updated_exercise
      RETURNING *
    )
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM existing WHERE canonical_payload_hash <> ${hash}) THEN 'conflict'
      WHEN EXISTS (SELECT 1 FROM existing) THEN 'replayed'
      WHEN EXISTS (SELECT 1 FROM saved_receipt WHERE result_code = 'applied') THEN 'applied'
      WHEN EXISTS (SELECT 1 FROM saved_receipt) THEN 'no_change'
      WHEN EXISTS (SELECT 1 FROM visible WHERE status <> 'in_progress' OR archived_at IS NOT NULL) THEN 'not_active'
      WHEN EXISTS (SELECT 1 FROM visible) THEN 'stale'
      ELSE 'not_found'
    END AS outcome,
    COALESCE(
      (SELECT resulting_snapshot_id FROM saved_receipt),
      (SELECT resulting_snapshot_id FROM existing)
    ) AS snapshot_id
  `))[0];
  if (!row) throw new Error("Equipment selection returned no outcome.");
  const outcome = String(row.outcome) as SessionEquipmentSelectionResult["outcome"];
  if (outcome === "applied" || outcome === "no_change" || outcome === "replayed") {
    return {
      outcome,
      snapshotId: row.snapshot_id == null ? null : String(row.snapshot_id),
      occurrenceStates: [],
    };
  }
  return { outcome } as SessionEquipmentSelectionResult;
}

async function applyClear(
  db: Db,
  userId: string,
  input: Extract<SessionEquipmentSelectionInput, { operation: "clear" }>,
  hash: string,
): Promise<SessionEquipmentSelectionResult> {
  const row = resultRows(await db.execute(sql`
    WITH target_profile AS MATERIALIZED (
      SELECT profile.user_id
      FROM user_profiles profile
      WHERE profile.user_id = ${userId}::uuid
      FOR UPDATE
    ), visible AS MATERIALIZED (
      SELECT exercise.*, session.user_id, session.status, session.archived_at
      FROM session_exercises exercise
      JOIN workout_sessions session ON session.id = exercise.session_id
      WHERE exercise.id = ${input.sessionExerciseId}::uuid
        AND session.user_id = ${userId}::uuid
    ), existing AS MATERIALIZED (
      SELECT receipt.*
      FROM target_profile profile
      CROSS JOIN LATERAL session_equipment_selection_receipt_after_owner_lock(
        profile.user_id,
        ${input.sessionExerciseId}::uuid,
        ${input.clientKey}::uuid
      ) receipt
    ), eligible AS MATERIALIZED (
      SELECT * FROM visible
      WHERE status = 'in_progress' AND archived_at IS NULL
        AND current_equipment_snapshot_id IS NOT DISTINCT FROM ${input.expectedCurrentSnapshotId}::uuid
        AND NOT EXISTS (SELECT 1 FROM existing)
      FOR UPDATE
    ), updated_exercise AS (
      UPDATE session_exercises exercise
      SET current_equipment_snapshot_id = NULL
      FROM eligible
      WHERE exercise.id = eligible.id
      RETURNING exercise.id, exercise.session_id,
                eligible.current_equipment_snapshot_id AS prior_snapshot_id,
                (eligible.current_equipment_snapshot_id IS NOT NULL) AS changed
    ), updated_occurrences AS (
      UPDATE session_occurrences occurrence
      SET equipment_snapshot_id = NULL, revision = occurrence.revision + 1
      FROM updated_exercise
      WHERE occurrence.session_exercise_id = updated_exercise.id
        AND occurrence.session_id = updated_exercise.session_id
        AND occurrence.outcome = 'pending'
        AND occurrence.equipment_snapshot_id IS NOT NULL
      RETURNING occurrence.id
    ), saved_receipt AS (
      INSERT INTO session_equipment_selection_receipts (
        user_id, session_id, session_exercise_id, client_key, operation,
        canonical_payload_hash, prior_snapshot_id, resulting_snapshot_id,
        result_code
      )
      SELECT ${userId}::uuid, updated_exercise.session_id, updated_exercise.id,
             ${input.clientKey}::uuid, 'clear', ${hash},
             updated_exercise.prior_snapshot_id, NULL,
             CASE WHEN updated_exercise.changed
                    OR EXISTS (SELECT 1 FROM updated_occurrences)
                  THEN 'applied' ELSE 'no_change' END
      FROM updated_exercise
      RETURNING *
    )
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM existing WHERE canonical_payload_hash <> ${hash}) THEN 'conflict'
      WHEN EXISTS (SELECT 1 FROM existing) THEN 'replayed'
      WHEN EXISTS (SELECT 1 FROM saved_receipt WHERE result_code = 'applied') THEN 'applied'
      WHEN EXISTS (SELECT 1 FROM saved_receipt) THEN 'no_change'
      WHEN EXISTS (SELECT 1 FROM visible WHERE status <> 'in_progress' OR archived_at IS NOT NULL) THEN 'not_active'
      WHEN EXISTS (SELECT 1 FROM visible) THEN 'stale'
      ELSE 'not_found'
    END AS outcome,
    NULL::uuid AS snapshot_id
  `))[0];
  if (!row) throw new Error("Equipment clear returned no outcome.");
  const outcome = String(row.outcome) as SessionEquipmentSelectionResult["outcome"];
  if (outcome === "applied" || outcome === "no_change" || outcome === "replayed") {
    return { outcome, snapshotId: null, occurrenceStates: [] };
  }
  return { outcome } as SessionEquipmentSelectionResult;
}

export async function mutateSessionEquipmentSelection(
  db: Db,
  userId: string,
  input: SessionEquipmentSelectionInput,
  dependencies: SessionEquipmentSelectionDependencies = {},
): Promise<SessionEquipmentSelectionResult> {
  const hash = payloadHash(input);
  const replay = await replayedReceipt(db, userId, input, hash);
  if (replay) {
    return attachOccurrenceStates(
      db,
      userId,
      input.sessionExerciseId,
      replay,
    );
  }

  const context = await loadContext(db, userId, input.sessionExerciseId);
  if (!context) return { outcome: "not_found" };
  if (context.status !== "in_progress" || context.archived_at != null) {
    return { outcome: "not_active" };
  }
  if (context.current_equipment_snapshot_id !== input.expectedCurrentSnapshotId) {
    return { outcome: "stale" };
  }
  if (input.operation === "clear") {
    return attachOccurrenceStates(
      db,
      userId,
      input.sessionExerciseId,
      await applyClear(db, userId, input, hash),
    );
  }
  if (
    context.retained_requirements == null ||
    !context.retained_requirements_match_current
  ) {
    return { outcome: "invalid_setup" };
  }

  const [{ items, plates }, profiles, requirements] = await Promise.all([
    loadLiveInventory(db, userId),
    loadEquipmentLoadProfiles(db, userId),
    loadRequirementsForContext(context),
  ]);
  const fitSettings = await loadExerciseEquipmentFitSettings(
    db,
    userId,
    [context.exercise_id],
  );
  const equipmentFit = resolveExerciseEquipmentFitFromSettings({
    exerciseId: context.exercise_id,
    requirements: requirements.broad,
    equipmentItems: items.map((item) => ({
      id: item.id,
      type: item.type,
      definitionId: item.definition_id,
      available: item.available,
      attrs: item.attrs,
    })),
    settings: fitSettings,
  });
  if (
    !isExerciseEquipmentItemFitRecommendationSafe(
      equipmentFit,
      input.equipmentItemId,
    )
  ) {
    return { outcome: "invalid_setup" };
  }
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const inventory: InventoryItem[] = items.map((item) => ({
    type: item.type,
    available: item.available,
    attrs: item.attrs ?? {},
  }));
  const broadRequirementsAvailable = context.retained_requirements
    ? context.retained_requirements.broad.every((requirement) =>
        retainedBroadRequirementSatisfied(requirement, items, plates),
      )
    : exerciseIsAvailable(
        requirements.broad,
        buildEquipmentAvailability(
          inventory,
          plates.map((plate) => ({ denomination: Number(plate.denomination) })),
        ),
      );
  if (
    (context.uses_retained_requirements || !context.uses_prescribed_meaning) &&
    !broadRequirementsAvailable
  ) {
    return { outcome: "invalid_setup" };
  }

  const primary = profiles.find(
    (entry) =>
      entry.equipmentItemId === input.equipmentItemId &&
      entry.profile.kind !== "attachment",
  );
  const primaryItem = itemMap.get(input.equipmentItemId);
  if (!primary || !primaryItem || !primary.available || primary.profile.id == null) {
    return { outcome: "invalid_setup" };
  }
  const primaryProfileId = primary.profile.id;
  if (primary.profile.kind === "attachment") {
    return { outcome: "invalid_setup" };
  }
  const primaryProfile = primary.profile;
  const primaryBroadRequirements = requirements.broad.filter(
    (requirement) => requirement.equipmentType === primary.itemType,
  );
  const primaryInventoryItem: InventoryItem = {
    type: primaryItem.type,
    available: primaryItem.available,
    attrs: primaryItem.attrs ?? {},
  };
  if (
    (context.retained_requirements != null &&
      !retainedPrimaryEquipmentCandidateMatchesBroad(
        context.retained_requirements.broad,
        {
          equipmentType: primaryItem.type,
          equipmentDefinitionId: primaryItem.definition_id,
          attrs: primaryItem.attrs,
        },
      )) ||
    (context.retained_requirements == null &&
      requirements.broad.length > 0 && primaryBroadRequirements.length === 0) ||
    !primaryBroadRequirements.every((requirement) =>
      requirementSatisfied(requirement, [primaryInventoryItem]),
    )
  ) {
    return { outcome: "invalid_setup" };
  }

  if (context.uses_prescribed_meaning) {
    const presentation = buildSessionEquipmentPresentation({
      exercise: {
        id: input.sessionExerciseId,
        exerciseId: context.exercise_id,
        loadType: context.load_type,
        targetLoad:
          context.target_load == null ? null : Number(context.target_load),
        targetLoadUnit: context.target_load_unit,
        requirements: requirements.broad,
        exactRequirement: requirements.exact,
        currentSelection: null,
      },
      profiles,
      inventory,
      plates: plates.map((plate) => ({
        id: plate.id,
        denomination: Number(plate.denomination),
        quantity: Number(plate.quantity),
        unit: plate.unit,
      })),
    });
    const selectedWasOffered = presentation.setup?.options.some(
      (option) =>
        option.equipmentItemId === input.equipmentItemId &&
        option.attachmentItemId === input.attachmentItemId,
    ) ?? false;
    if (!selectedWasOffered) return { outcome: "invalid_setup" };
  }

  const selectedCandidate = exactCandidate(
    primary,
    itemMap,
    profiles,
    input.attachmentItemId,
  );
  if (!selectedCandidate) return { outcome: "invalid_setup" };
  if (
    requirements.exact &&
    !exactExecutionCandidateMatches(requirements.exact, selectedCandidate)
  ) {
    return { outcome: "invalid_setup" };
  }

  const compatibleIds = primaryProfile.kind === "cable_machine"
    ? primaryProfile.compatibleAttachmentItemIds
    : [];
  if (
    input.attachmentItemId != null &&
    !compatibleIds.includes(input.attachmentItemId)
  ) {
    return { outcome: "invalid_setup" };
  }
  const attachment = input.attachmentItemId == null
    ? null
    : profiles.find(
        (entry) =>
          entry.equipmentItemId === input.attachmentItemId &&
          entry.profile.kind === "attachment" &&
          entry.available,
      ) ?? null;
  const attachmentItem = input.attachmentItemId == null
    ? null
    : itemMap.get(input.attachmentItemId) ?? null;
  if (
    input.attachmentItemId != null &&
    (!attachment || attachment.profile.kind !== "attachment" || !attachmentItem)
  ) {
    return { outcome: "invalid_setup" };
  }
  if (primaryProfile.kind !== "cable_machine" && input.attachmentItemId != null) {
    return { outcome: "invalid_setup" };
  }

  if (input.provenance === "auto_unique") {
    const plausible = profiles.filter((entry) => {
      const candidate = exactCandidate(entry, itemMap, profiles);
      if (!candidate || entry.itemType !== primary.itemType) return false;
      if (!isExerciseEquipmentItemFitRecommendationSafe(
        equipmentFit,
        entry.equipmentItemId,
      )) return false;
      return requirements.exact == null ||
        exactExecutionCandidateMatches(requirements.exact, candidate);
    });
    const setupCount = plausible.reduce((count, entry) => {
      if (
        requirements.exact?.requiredAttachmentKind != null ||
        requirements.exact?.requiredAttachmentDefinitionId != null
      ) {
        const candidate = exactCandidate(entry, itemMap, profiles);
        return count + (candidate?.compatibleAttachments.filter((candidateAttachment) =>
          candidateAttachment.available &&
          (requirements.exact!.requiredAttachmentKind == null ||
            candidateAttachment.attachmentKind === requirements.exact!.requiredAttachmentKind) &&
          (requirements.exact!.requiredAttachmentDefinitionId == null ||
            candidateAttachment.equipmentDefinitionId === requirements.exact!.requiredAttachmentDefinitionId)
        ).length ?? 0);
      }
      return count + 1;
    }, 0);
    if (setupCount !== 1) return { outcome: "ambiguous" };
  }

  const geometry = geometrySnapshot(primaryProfile, plates);
  const attachmentProfile =
    attachment?.profile.kind === "attachment" ? attachment.profile : null;
  const configurationIdentity = buildSessionEquipmentConfigurationIdentity({
    equipmentItemId: primary.equipmentItemId,
    equipmentLabel: primary.itemLabel,
    equipmentDefinitionKey: primaryItem.definition_key,
    attachmentItemId: attachment?.equipmentItemId ?? null,
    attachmentLabel: attachment?.itemLabel ?? null,
    attachmentDefinitionKey: attachmentItem?.definition_key ?? null,
    attachmentKind: attachmentProfile?.attachmentKind ?? null,
    geometry,
  });
  const snapshot: SnapshotCandidate = {
    snapshotId: randomUUID(),
    profileId: primaryProfileId,
    equipmentItemId: primary.equipmentItemId,
    equipmentLabel: primary.itemLabel,
    equipmentDefinitionKey: primaryItem.definition_key,
    attachmentItemId: attachment?.equipmentItemId ?? null,
    attachmentProfileId: attachmentProfile?.id ?? null,
    attachmentLabel: attachment?.itemLabel ?? null,
    attachmentDefinitionKey: attachmentItem?.definition_key ?? null,
    profileKind: primaryProfile.kind,
    geometryCertainty: profileCertainty(primaryProfile) ?? "unknown",
    unit: primaryProfile.kind === "plate_loaded_implement"
      ? primaryProfile.unit
      : primaryProfile.kind === "plate_loaded_machine"
        ? primaryProfile.startingResistanceUnit
        : primaryProfile.displayedUnit,
    provenance: input.provenance,
    geometry,
    configurationHash: sha256Hex(
      Buffer.from(canonicalJson(configurationIdentity), "utf8"),
    ),
  };
  const expectedEquipmentFitReviewRevision =
    await loadOwnerEquipmentFitReviewRevision(db, userId);
  if (!expectedEquipmentFitReviewRevision) return { outcome: "stale" };
  await dependencies.checkpoint?.("before-selection-statement");
  return attachOccurrenceStates(
    db,
    userId,
    input.sessionExerciseId,
    await applySelection(
      db,
      userId,
      context,
      input,
      hash,
      snapshot,
      expectedEquipmentFitReviewRevision,
    ),
  );
}
