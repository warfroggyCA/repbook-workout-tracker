import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import {
  resolveExerciseEquipmentFit,
  type ExerciseEquipmentFitAssertion,
  type ExerciseEquipmentFitItem,
  type ExerciseEquipmentFitRequirement,
  type ExerciseEquipmentFitResolution,
} from "@/lib/exercise-equipment-fit";
import { exerciseEquipmentFitEvidenceRevisionExpression } from "@/services/exercise-equipment-fit-evidence";
import { resultRows } from "@/db/result";

export type ExerciseEquipmentFitSettings = {
  assertionsByExerciseId: Map<string, ExerciseEquipmentFitAssertion[]>;
  currentEvidenceRevisionsByExerciseId: Map<string, Map<string, string>>;
};

/**
 * Owner-scoped current evidence only. The caller supplies exercise identities
 * from its already-authorized catalog query; an empty list never broadens the
 * read to another owner or the complete assertion table.
 */
export async function loadExerciseEquipmentFitSettings(
  db: Db,
  userId: string,
  exerciseIds: string[],
): Promise<ExerciseEquipmentFitSettings> {
  const uniqueExerciseIds = [...new Set(exerciseIds)];
  if (uniqueExerciseIds.length === 0) {
    return {
      assertionsByExerciseId: new Map(),
      currentEvidenceRevisionsByExerciseId: new Map(),
    };
  }
  const rows = resultRows(await db.execute(sql`
    SELECT assertion.*,
           ${exerciseEquipmentFitEvidenceRevisionExpression(
             userId,
             sql`assertion.exercise_id`,
             sql`assertion.equipment_item_id`,
           )} AS current_evidence_revision
    FROM exercise_equipment_fit_assertions assertion
    WHERE assertion.user_id = ${userId}::uuid
      AND assertion.exercise_id IN (${sql.join(
        uniqueExerciseIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `)) as Array<Record<string, unknown>>;
  const assertionsByExerciseId = new Map<
    string,
    ExerciseEquipmentFitAssertion[]
  >();
  for (const row of rows) {
    const exerciseId = String(row.exercise_id);
    const equipmentItemId = String(row.equipment_item_id);
    const current = assertionsByExerciseId.get(exerciseId) ?? [];
    current.push({
      id: String(row.id),
      exerciseId,
      equipmentItemId,
      verdict: String(row.verdict) as ExerciseEquipmentFitAssertion["verdict"],
      reasonCode: String(row.reason_code) as ExerciseEquipmentFitAssertion["reasonCode"],
      reasonNote: row.reason_note == null ? null : String(row.reason_note),
      provenance: "owner_review",
      semanticsVersion: Number(row.semantics_version),
      evidenceRevision: String(row.evidence_revision),
      revision: Number(row.revision),
      reviewedAt: row.reviewed_at as Date | string,
    });
    assertionsByExerciseId.set(exerciseId, current);
  }
  const currentEvidenceRevisionsByExerciseId = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const exerciseId = String(row.exercise_id);
    const exercise = currentEvidenceRevisionsByExerciseId.get(exerciseId) ?? new Map();
    exercise.set(String(row.equipment_item_id), String(row.current_evidence_revision));
    currentEvidenceRevisionsByExerciseId.set(exerciseId, exercise);
  }

  return {
    assertionsByExerciseId,
    currentEvidenceRevisionsByExerciseId,
  };
}

export function resolveExerciseEquipmentFitFromSettings(input: {
  exerciseId: string;
  requirements: ExerciseEquipmentFitRequirement[];
  equipmentItems: ExerciseEquipmentFitItem[];
  settings: ExerciseEquipmentFitSettings;
}): ExerciseEquipmentFitResolution {
  return resolveExerciseEquipmentFit({
    exerciseId: input.exerciseId,
    requirements: input.requirements,
    items: input.equipmentItems,
    assertions: input.settings.assertionsByExerciseId.get(input.exerciseId) ?? [],
    currentEvidenceRevisions:
      input.settings.currentEvidenceRevisionsByExerciseId.get(input.exerciseId),
  });
}

/** Atomic fail-closed gate for one broad exercise/equipment requirement. */
export function exerciseEquipmentRequirementFitSatisfiedExpression(input: {
  userId: string;
  exerciseId: string | SQL;
  equipmentType: string | SQL;
  equipmentDefinitionId: string | SQL;
  minWeight: number | SQL;
}) {
  return sql`(
    ${input.equipmentType}::equipment_type = 'bodyweight'::equipment_type
    OR (
      ${input.equipmentType}::equipment_type = 'plates'::equipment_type
      AND EXISTS (
        SELECT 1 FROM plate_inventory plate
        WHERE plate.user_id = ${input.userId}::uuid
      )
    )
    OR (
      ${input.equipmentType}::equipment_type <> 'plates'::equipment_type
      AND EXISTS (
        SELECT 1
        FROM equipment_items fit_item
        JOIN exercise_equipment_fit_assertions fit_assertion
          ON fit_assertion.user_id = fit_item.user_id
         AND fit_assertion.exercise_id = ${input.exerciseId}::uuid
         AND fit_assertion.equipment_item_id = fit_item.id
         AND fit_assertion.verdict = 'compatible'
         AND fit_assertion.reason_code = 'owner_verified'
         AND fit_assertion.provenance = 'owner_review'
         AND fit_assertion.semantics_version = 1
         AND fit_assertion.revision >= 1
         AND fit_assertion.evidence_revision = ${exerciseEquipmentFitEvidenceRevisionExpression(
           input.userId,
           input.exerciseId,
           sql`fit_item.id`,
         )}
        WHERE fit_item.user_id = ${input.userId}::uuid
          AND fit_item.available
          AND fit_item.type = ${input.equipmentType}::equipment_type
          AND (
            ${input.equipmentDefinitionId}::uuid IS NULL
            OR fit_item.definition_id = ${input.equipmentDefinitionId}::uuid
          )
          AND (
            ${input.minWeight}::numeric IS NULL
            OR COALESCE((fit_item.attrs->>'maxWeight')::double precision, -1)
              >= ${input.minWeight}::numeric
          )
      )
    )
  )`;
}
