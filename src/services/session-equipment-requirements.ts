import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  createUpdatingSessionEquipmentProjection,
  parseSessionEquipmentRequirementsEvidence,
  projectSessionEquipmentPreparation,
  retainedAttachmentRequirementHasSavedSetup,
  retainedExactRequirementRowHasSavedSetup,
  retainedExerciseHasExecutableSetup,
  retainedPrimaryRequirementRowHasSavedSetup,
  SESSION_EQUIPMENT_REQUIREMENTS_SEMANTICS_VERSION,
  type RetainedExactEquipmentRequirement,
  type RetainedExecutableSetupCandidate,
  type RetainedSavedAttachmentItem,
  type RetainedSavedEquipmentItem,
  type SessionEquipmentRequirementsSnapshot,
  type SessionPreparationEquipmentProjection,
  type SessionPreparationRequirementRow,
} from "@/lib/session-equipment-requirements";
import {
  loadEquipmentLoadProfiles,
  type LoadedEquipmentLoadProfile,
} from "@/services/equipment-load-profiles";
import { inventoryRevisionExpression } from "@/services/equipment-inventory";

/**
 * Freeze reviewed requirement meaning in the same statement that creates or
 * changes a session exercise. Definition identity and its then-current label
 * are both retained; mutable catalog rows are never needed to interpret it.
 */
export function sessionEquipmentRequirementsSnapshotExpression(
  exerciseId: SQL,
) {
  return sql`jsonb_build_object(
    'sourceExerciseId', (${exerciseId})::text,
    'broad', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'sourceRequirementId', requirement.id::text,
          'equipmentType', requirement.equipment_type::text,
          'equipmentDefinition', CASE WHEN definition.id IS NULL THEN NULL ELSE
            jsonb_build_object(
              'id', definition.id::text,
              'key', definition.key,
              'label', definition.label
            )
          END,
          'minWeight', requirement.min_weight
        ) ORDER BY requirement.id
      )
      FROM exercise_equipment_requirements requirement
      LEFT JOIN equipment_definitions definition
        ON definition.id = requirement.equipment_definition_id
      WHERE requirement.exercise_id = (${exerciseId})::uuid
    ), '[]'::jsonb),
    'exact', (
      SELECT jsonb_build_object(
        'sourceRequirementId', requirement.id::text,
        'requiredProfileKind', requirement.required_profile_kind,
        'requiredEquipmentDefinition', CASE WHEN equipment_definition.id IS NULL THEN NULL ELSE
          jsonb_build_object(
            'id', equipment_definition.id::text,
            'key', equipment_definition.key,
            'label', equipment_definition.label
          )
        END,
        'requiredAttachmentKind', requirement.required_attachment_kind,
        'requiredAttachmentDefinition', CASE WHEN attachment_definition.id IS NULL THEN NULL ELSE
          jsonb_build_object(
            'id', attachment_definition.id::text,
            'key', attachment_definition.key,
            'label', attachment_definition.label
          )
        END,
        'requiresKnownGeometry', requirement.requires_known_geometry
      )
      FROM exercise_execution_requirements requirement
      LEFT JOIN equipment_definitions equipment_definition
        ON equipment_definition.id = requirement.required_equipment_definition_id
      LEFT JOIN equipment_definitions attachment_definition
        ON attachment_definition.id = requirement.required_attachment_definition_id
      WHERE requirement.exercise_id = (${exerciseId})::uuid
      LIMIT 1
    )
  )`;
}

type PreparationExerciseRow = {
  session_exercise_id: string;
  exercise_id: string;
  exercise_label: string;
  order_idx: number;
  equipment_requirements_semantics_version: number | null;
  equipment_requirements_snapshot: unknown;
  source_history_revision: number;
};

type PreparationInventoryRow = {
  id: string;
  type: string;
  definition_id: string | null;
  available: boolean;
  attrs: Record<string, unknown>;
};

type PreparationEvidenceRevisionRow = {
  source_history_revision: number;
  evidence_revision: string;
};

async function loadPreparationEvidenceRevision(
  db: Db,
  userId: string,
  sessionId: string,
) {
  return resultRows<PreparationEvidenceRevisionRow>(await db.execute(sql`
    SELECT session.history_revision AS source_history_revision,
           md5(
             ${inventoryRevisionExpression(userId)} || coalesce((
               SELECT jsonb_agg(jsonb_build_array(
                 session_exercise.id,
                 session_exercise.exercise_id,
                 session_exercise.order_idx,
                 session_exercise.prescribed_semantics_version,
                 session_exercise.modification_type,
                 session_exercise.prescribed_exercise_name,
                 session_exercise.equipment_requirements_semantics_version,
                 session_exercise.equipment_requirements_snapshot,
                 exercise.name
               ) ORDER BY session_exercise.order_idx, session_exercise.id)::text
               FROM session_exercises session_exercise
               JOIN exercises exercise ON exercise.id = session_exercise.exercise_id
               WHERE session_exercise.session_id = session.id
             ), '[]')
           ) AS evidence_revision
    FROM workout_sessions session
    WHERE session.id = ${sessionId}::uuid
      AND session.user_id = ${userId}::uuid
      AND session.archived_at IS NULL
    LIMIT 1
  `))[0] ?? null;
}

function profileGeometryCertainty(
  profile: LoadedEquipmentLoadProfile["profile"],
) {
  if (profile.kind === "plate_loaded_implement") return "known" as const;
  if (profile.kind === "attachment") return null;
  return profile.geometryCertainty;
}

function savedInventorySatisfies(
  row: Omit<
    SessionPreparationRequirementRow,
    "classification" | "status" | "statusText" | "usageContext"
  >,
  inventory: RetainedSavedEquipmentItem[],
  savedAttachments: RetainedSavedAttachmentItem[],
  hasPlates: boolean,
  sourceSessionExerciseIds: string[],
  snapshotsBySessionExerciseId: Map<
    string,
    SessionEquipmentRequirementsSnapshot
  >,
  exactRequirementsBySessionExerciseId: Map<
    string,
    RetainedExactEquipmentRequirement
  >,
  exactCandidates: RetainedExecutableSetupCandidate[],
) {
  if (row.key.startsWith("attachment-")) {
    return retainedAttachmentRequirementHasSavedSetup({
      equipmentDefinitionId: row.equipmentDefinitionId,
      requiredAttachmentKind: row.requiredAttachmentKind,
      sourceSessionExerciseIds,
      exactRequirementsBySessionExerciseId,
      savedAttachments,
    });
  }
  if (
    row.key.startsWith("exact-requirement:") &&
    row.equipmentType == null &&
    row.equipmentDefinitionId == null
  ) {
    return retainedExactRequirementRowHasSavedSetup({
      sourceRequirementIds: row.sourceRequirementIds,
      sourceSessionExerciseIds,
      exactRequirementsBySessionExerciseId,
      exactCandidates,
    });
  }
  return retainedPrimaryRequirementRowHasSavedSetup({
    rowKey: row.key,
    sourceSessionExerciseIds,
    snapshotsBySessionExerciseId,
    inventory,
    hasPlates,
    exactCandidates,
  });
}

function retainedExecutableCandidates(
  inventory: PreparationInventoryRow[],
  profiles: LoadedEquipmentLoadProfile[],
): RetainedExecutableSetupCandidate[] {
  const itemById = new Map(inventory.map((item) => [item.id, item]));
  return profiles.flatMap((primary) => {
    if (primary.profile.kind === "attachment") return [];
    const item = itemById.get(primary.equipmentItemId);
    if (!item) return [];
    const compatibleAttachmentIds = primary.profile.kind === "cable_machine"
      ? primary.profile.compatibleAttachmentItemIds
      : [];
    return [{
      equipmentItemId: primary.equipmentItemId,
      equipmentType: item.type,
      equipmentDefinitionId: item.definition_id,
      attrs: item.attrs,
      available: item.available && primary.available,
      profileKind: primary.profile.kind,
      geometryCertainty: profileGeometryCertainty(primary.profile),
      compatibleAttachments: compatibleAttachmentIds.flatMap(
        (attachmentId) => {
          const attachment = profiles.find((entry) =>
            entry.equipmentItemId === attachmentId &&
            entry.profile.kind === "attachment"
          );
          const attachmentItem = itemById.get(attachmentId);
          if (
            !attachment ||
            attachment.profile.kind !== "attachment" ||
            !attachmentItem
          ) {
            return [];
          }
          return [{
            equipmentItemId: attachmentId,
            available: attachment.available && attachmentItem.available,
            attachmentKind: attachment.profile.attachmentKind,
            equipmentDefinitionId: attachmentItem.definition_id,
          }];
        },
      ),
    }];
  });
}

function retainedSavedAttachments(
  inventory: PreparationInventoryRow[],
  profiles: LoadedEquipmentLoadProfile[],
): RetainedSavedAttachmentItem[] {
  const itemById = new Map(inventory.map((item) => [item.id, item]));
  return profiles.flatMap((entry) => {
    if (entry.profile.kind !== "attachment") return [];
    const item = itemById.get(entry.equipmentItemId);
    if (item == null) return [];
    return [{
      equipmentItemId: entry.equipmentItemId,
      equipmentDefinitionId: item.definition_id,
      attachmentKind: entry.profile.attachmentKind,
      available: entry.available && item.available,
    }];
  });
}

function projectPreparationWithSavedInventory(input: {
  exerciseRows: PreparationExerciseRow[];
  inventory: PreparationInventoryRow[];
  hasPlates: boolean;
  profiles: LoadedEquipmentLoadProfile[];
  sourceHistoryRevision: number | null;
}) {
  const retainedInventory: RetainedSavedEquipmentItem[] = input.inventory.map(
    (item) => ({
      equipmentItemId: item.id,
      equipmentType: item.type,
      equipmentDefinitionId: item.definition_id,
      attrs: item.attrs,
      available: item.available,
    }),
  );
  const exactCandidates = retainedExecutableCandidates(
    input.inventory,
    input.profiles,
  );
  const savedAttachments = retainedSavedAttachments(
    input.inventory,
    input.profiles,
  );
  const executableBySessionExerciseId = new Map<string, boolean>();
  const snapshotsBySessionExerciseId = new Map<
    string,
    SessionEquipmentRequirementsSnapshot
  >();
  const exactRequirementsBySessionExerciseId = new Map<
    string,
    RetainedExactEquipmentRequirement
  >();
  for (const exercise of input.exerciseRows) {
    const evidence = parseSessionEquipmentRequirementsEvidence(
      exercise.equipment_requirements_semantics_version == null
        ? null
        : Number(exercise.equipment_requirements_semantics_version),
      exercise.equipment_requirements_snapshot,
      String(exercise.exercise_id),
    );
    if (evidence.state === "retained") {
      snapshotsBySessionExerciseId.set(
        String(exercise.session_exercise_id),
        evidence.snapshot,
      );
      if (evidence.snapshot.exact) {
        exactRequirementsBySessionExerciseId.set(
          String(exercise.session_exercise_id),
          evidence.snapshot.exact,
        );
      }
      executableBySessionExerciseId.set(
        String(exercise.session_exercise_id),
        retainedExerciseHasExecutableSetup({
          snapshot: evidence.snapshot,
          inventory: retainedInventory,
          hasPlates: input.hasPlates,
          exactCandidates,
        }),
      );
    }
  }
  return projectSessionEquipmentPreparation(
    input.exerciseRows.map((exercise) => ({
      sessionExerciseId: String(exercise.session_exercise_id),
      exerciseId: String(exercise.exercise_id),
      exerciseLabel: String(exercise.exercise_label),
      orderIdx: Number(exercise.order_idx),
      semanticsVersion:
        exercise.equipment_requirements_semantics_version == null
          ? null
          : Number(exercise.equipment_requirements_semantics_version),
      snapshot: exercise.equipment_requirements_snapshot,
    })),
    (row, sourceSessionExerciseIds) => {
      if (!savedInventorySatisfies(
        row,
        retainedInventory,
        savedAttachments,
        input.hasPlates,
        sourceSessionExerciseIds,
        snapshotsBySessionExerciseId,
        exactRequirementsBySessionExerciseId,
        exactCandidates,
      )) {
        return "unavailable";
      }
      return sourceSessionExerciseIds.every((sessionExerciseId) =>
        executableBySessionExerciseId.get(sessionExerciseId) === true
      ) ? "available" : "incompatible";
    },
    input.sourceHistoryRevision,
  );
}

/**
 * Read-only pre-Start equipment check for one current Program day. Reviewed
 * catalogue identities supply requirement meaning; saved owner inventory
 * supplies availability. Starting the workout remains an independent action.
 */
export async function resolveTemplatePreparationEquipmentProjection(
  db: Db,
  userId: string,
  templateId: string,
): Promise<SessionPreparationEquipmentProjection | null> {
  const exerciseRows = resultRows<PreparationExerciseRow>(await db.execute(sql`
    SELECT slot.id AS session_exercise_id,
           exercise.id AS exercise_id,
           exercise.name AS exercise_label,
           slot.order_idx,
           ${SESSION_EQUIPMENT_REQUIREMENTS_SEMANTICS_VERSION}::integer
             AS equipment_requirements_semantics_version,
           ${sessionEquipmentRequirementsSnapshotExpression(sql`slot.exercise_id`)}
             AS equipment_requirements_snapshot,
           0::integer AS source_history_revision
    FROM workout_template_exercises slot
    JOIN workout_templates template ON template.id = slot.workout_template_id
    JOIN program_versions version ON version.id = template.program_version_id
    JOIN programs program ON program.id = version.program_id
    JOIN exercises exercise ON exercise.id = slot.exercise_id
    WHERE template.id = ${templateId}::uuid
      AND program.user_id = ${userId}::uuid
      AND program.status = 'active'
      AND program.archived_at IS NULL
      AND program.current_version_id = version.id
    ORDER BY slot.order_idx, slot.id
  `));
  if (exerciseRows.length === 0) return null;

  const [inventoryResult, plateResult, profiles] = await Promise.all([
    db.execute(sql`
      SELECT id, type::text, definition_id, available, attrs
      FROM equipment_items
      WHERE user_id = ${userId}::uuid
      ORDER BY id
    `),
    db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM plate_inventory
        WHERE user_id = ${userId}::uuid
          AND quantity > 0
          AND denomination > 0
      ) AS has_plates
    `),
    loadEquipmentLoadProfiles(db, userId),
  ]);

  return projectPreparationWithSavedInventory({
    exerciseRows,
    inventory: resultRows<PreparationInventoryRow>(inventoryResult),
    hasPlates: Boolean(resultRows(plateResult)[0]?.has_plates),
    profiles,
    sourceHistoryRevision: null,
  });
}

/**
 * Owner-scoped, server-side preparation projection. Requirement meaning comes
 * only from the retained session snapshot; current saved inventory supplies
 * availability, never replacement semantics.
 */
export async function resolveSessionPreparationEquipmentProjection(
  db: Db,
  userId: string,
  sessionId: string,
  expectedHistoryRevision?: number,
): Promise<SessionPreparationEquipmentProjection | null> {
  // neon-http does not support interactive transactions. Fence the separate
  // owner-scoped reads with one digest that covers retained requirement rows
  // and every live inventory/profile table. A restore or inventory change
  // straddling these reads therefore yields the explicit updating state.
  const initialEvidence = await loadPreparationEvidenceRevision(
    db,
    userId,
    sessionId,
  );
  if (!initialEvidence) return null;
  const sourceHistoryRevision = Number(
    initialEvidence.source_history_revision,
  );
  if (
    expectedHistoryRevision != null &&
    sourceHistoryRevision !== expectedHistoryRevision
  ) {
    return createUpdatingSessionEquipmentProjection(sourceHistoryRevision);
  }
  const exerciseRows = resultRows<PreparationExerciseRow>(await db.execute(sql`
    SELECT session_exercise.id AS session_exercise_id,
           session_exercise.exercise_id,
           CASE
             WHEN session_exercise.prescribed_semantics_version = 1
               AND session_exercise.modification_type NOT IN ('substituted', 'added')
             THEN session_exercise.prescribed_exercise_name
             ELSE exercise.name
           END AS exercise_label,
           session_exercise.order_idx,
           session_exercise.equipment_requirements_semantics_version,
           session_exercise.equipment_requirements_snapshot,
           session.history_revision AS source_history_revision
    FROM session_exercises session_exercise
    JOIN workout_sessions session ON session.id = session_exercise.session_id
    JOIN exercises exercise ON exercise.id = session_exercise.exercise_id
    WHERE session.id = ${sessionId}::uuid
      AND session.user_id = ${userId}::uuid
      AND session.archived_at IS NULL
    ORDER BY session_exercise.order_idx, session_exercise.id
  `));

  const inventoryResult = await db.execute(sql`
      SELECT id, type::text, definition_id, available, attrs
      FROM equipment_items
      WHERE user_id = ${userId}::uuid
      ORDER BY id
    `);
  const plateResult = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM plate_inventory
        WHERE user_id = ${userId}::uuid
          AND quantity > 0
          AND denomination > 0
      ) AS has_plates
    `);
  const profiles = await loadEquipmentLoadProfiles(db, userId);
  const inventory = resultRows<PreparationInventoryRow>(inventoryResult);
  const hasPlates = Boolean(resultRows(plateResult)[0]?.has_plates);
  const currentEvidence = await loadPreparationEvidenceRevision(
    db,
    userId,
    sessionId,
  );
  if (!currentEvidence) return null;
  const currentHistoryRevision = Number(currentEvidence.source_history_revision);
  if (
    currentEvidence.evidence_revision !== initialEvidence.evidence_revision ||
    currentHistoryRevision !== sourceHistoryRevision ||
    (expectedHistoryRevision != null &&
      currentHistoryRevision !== expectedHistoryRevision)
  ) {
    return createUpdatingSessionEquipmentProjection(currentHistoryRevision);
  }
  return projectPreparationWithSavedInventory({
    exerciseRows,
    inventory,
    hasPlates,
    profiles,
    sourceHistoryRevision,
  });
}
