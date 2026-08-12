import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  EXERCISE_EQUIPMENT_FIT_REASON_CODES,
  type ExerciseEquipmentFitReasonCode,
} from "@/db/schema/exercise-equipment-fit";
import { exerciseEquipmentFitEvidenceRevisionExpression } from "@/services/exercise-equipment-fit-evidence";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";

export { EXERCISE_EQUIPMENT_FIT_REASON_CODES };
export type { ExerciseEquipmentFitReasonCode };

export type ExerciseEquipmentFitManagementDocument = {
  exerciseOptions: Array<{
    id: string;
    name: string;
    equipmentTypes: string[];
  }>;
  equipmentOptions: Array<{
    id: string;
    label: string;
    type: string;
    available: boolean;
  }>;
  assertions: Array<{
    id: string;
    exerciseId: string;
    exerciseName: string;
    equipmentItemId: string;
    equipmentLabel: string;
    equipmentType: string;
    equipmentAvailable: boolean;
    verdict: "compatible" | "incompatible";
    reasonCode: ExerciseEquipmentFitReasonCode;
    reasonNote: string | null;
    provenance: "owner_review";
    semanticsVersion: 1;
    revision: number;
    evidenceCurrent: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
};

const saveSchema = z
  .object({
    mutationId: z.string().uuid(),
    assertionId: z.string().uuid().nullable(),
    exerciseId: z.string().uuid(),
    equipmentItemId: z.string().uuid(),
    verdict: z.enum(["compatible", "incompatible"]),
    reasonCode: z.enum(EXERCISE_EQUIPMENT_FIT_REASON_CODES),
    reasonNote: z.string().trim().min(1).max(500).nullable(),
    expectedRevision: z.number().int().positive().nullable(),
  })
  .superRefine((value, context) => {
    const isCreate = value.assertionId === null;
    if (isCreate !== (value.expectedRevision === null)) {
      context.addIssue({
        code: "custom",
        path: ["expectedRevision"],
        message: "The retained review revision is inconsistent.",
      });
    }
    if (
      (value.verdict === "compatible") !==
      (value.reasonCode === "owner_verified")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "Choose a reason that matches the compatibility verdict.",
      });
    }
    if (value.reasonCode === "other" && value.reasonNote === null) {
      context.addIssue({
        code: "custom",
        path: ["reasonNote"],
        message: "Describe the other physical limitation.",
      });
    }
  });

const removeSchema = z.object({
  mutationId: z.string().uuid(),
  assertionId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
});

export type ExerciseEquipmentFitMutationResult =
  | {
      ok: true;
      changed: boolean;
      assertionId: string;
      revision: number | null;
    }
  | {
      ok: false;
      code: "invalid" | "stale" | "idempotency_conflict" | "failed";
      reason: string;
    };

type MutationRow = Record<string, unknown> & {
  outcome?: unknown;
  assertion_id?: unknown;
  revision?: unknown;
};

function mutationResult(row: MutationRow | undefined): ExerciseEquipmentFitMutationResult {
  const outcome = String(row?.outcome ?? "failed");
  if (outcome === "saved" || outcome === "replayed" || outcome === "unchanged") {
    return {
      ok: true,
      changed: outcome === "saved",
      assertionId: String(row?.assertion_id ?? ""),
      revision: row?.revision == null ? null : Number(row.revision),
    };
  }
  if (outcome === "idempotency_conflict") {
    return {
      ok: false,
      code: "idempotency_conflict",
      reason:
        "That save request was already used for different values. Reload the retained reviews before trying again.",
    };
  }
  if (outcome === "stale") {
    return {
      ok: false,
      code: "stale",
      reason:
        "This retained review changed elsewhere. Reload it before saving so newer evidence is not overwritten.",
    };
  }
  return {
    ok: false,
    code: "failed",
    reason: "The retained review could not be saved. Nothing changed.",
  };
}

/**
 * Owner-scoped Settings document. IDs drive every decision; labels are
 * presentation only and intentionally may collide.
 */
export async function loadExerciseEquipmentFitManagementDocument(
  db: Db,
  userId: string,
): Promise<ExerciseEquipmentFitManagementDocument> {
  const currentEvidenceRevision = exerciseEquipmentFitEvidenceRevisionExpression(
    userId,
    sql`assertion.exercise_id`,
    sql`assertion.equipment_item_id`,
  );
  const row = resultRows(
    await db.execute(sql`
      SELECT jsonb_build_object(
        'exerciseOptions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', e.id,
            'name', e.name,
            'equipmentTypes', requirements.equipment_types
          ) ORDER BY e.name, e.id)
          FROM exercises e
          JOIN LATERAL (
            SELECT array_agg(DISTINCT requirement.equipment_type::text ORDER BY requirement.equipment_type::text) AS equipment_types
            FROM exercise_equipment_requirements requirement
            WHERE requirement.exercise_id = e.id
              AND requirement.equipment_type <> 'bodyweight'::equipment_type
          ) requirements ON cardinality(requirements.equipment_types) > 0
          WHERE e.user_id IS NULL OR e.user_id = ${userId}::uuid
        ), '[]'::jsonb),
        'equipmentOptions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', item.id,
            'label', item.label,
            'type', item.type::text,
            'available', item.available
          ) ORDER BY item.available DESC, item.label, item.id)
          FROM equipment_items item
          WHERE item.user_id = ${userId}::uuid
        ), '[]'::jsonb),
        'assertions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', assertion.id,
            'exerciseId', assertion.exercise_id,
            'exerciseName', exercise.name,
            'equipmentItemId', assertion.equipment_item_id,
            'equipmentLabel', item.label,
            'equipmentType', item.type::text,
            'equipmentAvailable', item.available,
            'verdict', assertion.verdict,
            'reasonCode', assertion.reason_code,
            'reasonNote', assertion.reason_note,
            'provenance', assertion.provenance,
            'semanticsVersion', assertion.semantics_version,
            'revision', assertion.revision,
            'evidenceCurrent', assertion.evidence_revision = ${currentEvidenceRevision},
            'createdAt', assertion.created_at,
            'updatedAt', assertion.updated_at
          ) ORDER BY exercise.name, item.label, assertion.id)
          FROM exercise_equipment_fit_assertions assertion
          JOIN exercises exercise ON exercise.id = assertion.exercise_id
          JOIN equipment_items item
            ON item.id = assertion.equipment_item_id
           AND item.user_id = assertion.user_id
          WHERE assertion.user_id = ${userId}::uuid
        ), '[]'::jsonb)
      ) AS document
    `),
  )[0];
  const document = row?.document;
  if (!document || typeof document !== "object") {
    return { exerciseOptions: [], equipmentOptions: [], assertions: [] };
  }
  return document as ExerciseEquipmentFitManagementDocument;
}

/**
 * Atomic create/update with an owner-profile lock, stable-identity checks,
 * optimistic revision fencing, durable exact retry receipt, version evidence,
 * and coarse audit evidence. Cross-owner/missing IDs share the stale result.
 */
export async function saveExerciseEquipmentFitAssertion(
  db: Db,
  userId: string,
  input: unknown,
): Promise<ExerciseEquipmentFitMutationResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid",
      reason: parsed.error.issues[0]?.message ?? "Check the retained review.",
    };
  }
  const value = parsed.data;
  const candidateId = randomUUID();
  const currentEvidenceRevision = exerciseEquipmentFitEvidenceRevisionExpression(
    userId,
    value.exerciseId,
    value.equipmentItemId,
  );
  const idempotencyKey = `exercise-equipment-fit:${value.mutationId}`;
  const payloadHash = sha256Hex(
    Buffer.from(
      canonicalJson({
        operation: "save",
        assertionId: value.assertionId,
        exerciseId: value.exerciseId,
        equipmentItemId: value.equipmentItemId,
        verdict: value.verdict,
        reasonCode: value.reasonCode,
        reasonNote: value.reasonNote,
        expectedRevision: value.expectedRevision,
      }),
      "utf8",
    ),
  );

  const row = resultRows<MutationRow>(
    await db.execute(sql`
      WITH target_profile AS MATERIALIZED (
        SELECT user_id
        FROM user_profiles
        WHERE user_id = ${userId}::uuid
        FOR UPDATE
      ), prior_receipt AS MATERIALIZED (
        SELECT receipt.cause_ref
        FROM target_profile profile
        CROSS JOIN LATERAL (
          SELECT exercise_equipment_fit_receipt_after_owner_lock(
            profile.user_id,
            ${idempotencyKey}
          ) AS cause_ref
        ) receipt
        WHERE receipt.cause_ref IS NOT NULL
      ), eligible_exercise AS MATERIALIZED (
        SELECT id
        FROM exercises
        WHERE id = ${value.exerciseId}::uuid
          AND (user_id IS NULL OR user_id = ${userId}::uuid)
      ), eligible_equipment AS MATERIALIZED (
        SELECT id, type, available
        FROM equipment_items
        WHERE id = ${value.equipmentItemId}::uuid
          AND user_id = ${userId}::uuid
      ), eligible_pair AS MATERIALIZED (
        SELECT 1 AS allowed
        FROM eligible_exercise exercise
        JOIN eligible_equipment item ON true
        WHERE EXISTS (
          SELECT 1
          FROM exercise_equipment_requirements requirement
          WHERE requirement.exercise_id = exercise.id
            AND requirement.equipment_type = item.type
            AND requirement.equipment_type <> 'bodyweight'::equipment_type
        )
      ), current_assertion AS MATERIALIZED (
        SELECT assertion.*, to_jsonb(assertion) AS before_data
        FROM exercise_equipment_fit_assertions assertion
        WHERE assertion.user_id = ${userId}::uuid
          AND (
            assertion.id = ${value.assertionId}::uuid
            OR (
              assertion.exercise_id = ${value.exerciseId}::uuid
              AND assertion.equipment_item_id = ${value.equipmentItemId}::uuid
            )
          )
        FOR UPDATE
      ), current_evidence AS MATERIALIZED (
        SELECT ${currentEvidenceRevision} AS revision
        FROM eligible_pair
      ), updated_assertion AS (
        UPDATE exercise_equipment_fit_assertions assertion
        SET verdict = ${value.verdict},
            reason_code = ${value.reasonCode},
            reason_note = ${value.reasonNote},
            evidence_revision = (SELECT revision FROM current_evidence),
            revision = assertion.revision + 1,
            updated_at = now(),
            reviewed_at = now()
        FROM current_assertion current
        WHERE assertion.id = current.id
          AND ${value.assertionId}::uuid IS NOT NULL
          AND assertion.id = ${value.assertionId}::uuid
          AND assertion.exercise_id = ${value.exerciseId}::uuid
          AND assertion.equipment_item_id = ${value.equipmentItemId}::uuid
          AND assertion.revision = ${value.expectedRevision}
          AND EXISTS (SELECT 1 FROM target_profile)
          AND EXISTS (SELECT 1 FROM eligible_pair)
          AND EXISTS (SELECT 1 FROM current_evidence)
          AND NOT EXISTS (SELECT 1 FROM prior_receipt)
          AND ROW(assertion.verdict, assertion.reason_code, assertion.reason_note, assertion.evidence_revision)
            IS DISTINCT FROM ROW(${value.verdict}, ${value.reasonCode}, ${value.reasonNote}, (SELECT revision FROM current_evidence))
        RETURNING assertion.*
      ), inserted_assertion AS (
        INSERT INTO exercise_equipment_fit_assertions (
          id, user_id, exercise_id, equipment_item_id, verdict,
          reason_code, reason_note, provenance, semantics_version, revision,
          evidence_revision
        )
        SELECT
          ${candidateId}::uuid, ${userId}::uuid, ${value.exerciseId}::uuid,
          ${value.equipmentItemId}::uuid, ${value.verdict}, ${value.reasonCode},
          ${value.reasonNote}, 'owner_review', 1, 1,
          (SELECT revision FROM current_evidence)
        WHERE ${value.assertionId}::uuid IS NULL
          AND ${value.expectedRevision}::integer IS NULL
          AND EXISTS (SELECT 1 FROM target_profile)
          AND EXISTS (SELECT 1 FROM eligible_pair)
          AND EXISTS (SELECT 1 FROM current_evidence)
          AND EXISTS (SELECT 1 FROM eligible_equipment WHERE available)
          AND NOT EXISTS (SELECT 1 FROM current_assertion)
          AND NOT EXISTS (SELECT 1 FROM prior_receipt)
        RETURNING *
      ), applied_assertion AS MATERIALIZED (
        SELECT *, 'create'::text AS mutation_action FROM inserted_assertion
        UNION ALL
        SELECT *, 'update'::text AS mutation_action FROM updated_assertion
      ), unchanged_assertion AS MATERIALIZED (
        SELECT current.*
        FROM current_assertion current
        WHERE current.id = ${value.assertionId}::uuid
          AND current.exercise_id = ${value.exerciseId}::uuid
          AND current.equipment_item_id = ${value.equipmentItemId}::uuid
          AND current.revision = ${value.expectedRevision}
          AND ROW(current.verdict, current.reason_code, current.reason_note, current.evidence_revision)
            IS NOT DISTINCT FROM ROW(${value.verdict}, ${value.reasonCode}, ${value.reasonNote}, (SELECT revision FROM current_evidence))
          AND EXISTS (SELECT 1 FROM target_profile)
          AND EXISTS (SELECT 1 FROM eligible_pair)
          AND NOT EXISTS (SELECT 1 FROM prior_receipt)
          AND NOT EXISTS (SELECT 1 FROM applied_assertion)
      ), versions AS (
        INSERT INTO record_versions (
          user_id, entity_type, entity_id, action,
          before_data, after_data, changed_fields
        )
        SELECT
          ${userId}::uuid,
          'exercise_equipment_fit_assertion',
          applied.id,
          CASE WHEN applied.mutation_action = 'create'
            THEN 'exercise_equipment_fit.create'
            ELSE 'exercise_equipment_fit.update'
          END,
          CASE WHEN applied.mutation_action = 'create'
            THEN '{}'::jsonb
            ELSE current.before_data
          END,
          to_jsonb(applied) - 'mutation_action',
          CASE WHEN applied.mutation_action = 'create'
            THEN ARRAY['exercise_id', 'equipment_item_id', 'verdict', 'reason_code', 'reason_note', 'provenance', 'semantics_version', 'evidence_revision']::text[]
            ELSE ARRAY(
              SELECT before_entry.key
              FROM jsonb_each(current.before_data) before_entry
              JOIN jsonb_each(to_jsonb(applied) - 'mutation_action') after_entry USING (key)
              WHERE before_entry.value IS DISTINCT FROM after_entry.value
                AND before_entry.key NOT IN ('updated_at', 'revision')
              ORDER BY before_entry.key
            )
          END
        FROM applied_assertion applied
        LEFT JOIN current_assertion current ON current.id = applied.id
        RETURNING id
      ), receipt_subject AS MATERIALIZED (
        SELECT applied.id, applied.revision, applied.mutation_action
        FROM applied_assertion applied
        UNION ALL
        SELECT unchanged.id, unchanged.revision, 'confirm'::text AS mutation_action
        FROM unchanged_assertion unchanged
      ), receipt AS (
        INSERT INTO audit_logs (
          user_id, actor_type, action, entity_type, entity_id,
          summary, cause_ref, idempotency_key
        )
        SELECT
          ${userId}::uuid,
          'user',
          CASE WHEN subject.mutation_action = 'create'
            THEN 'exercise_equipment_fit.create'
            WHEN subject.mutation_action = 'confirm'
            THEN 'exercise_equipment_fit.confirm'
            ELSE 'exercise_equipment_fit.update'
          END,
          'exercise_equipment_fit_assertion',
          subject.id::text,
          CASE WHEN subject.mutation_action = 'create'
            THEN 'Recorded an owner-reviewed exercise and equipment fit'
            WHEN subject.mutation_action = 'confirm'
            THEN 'Confirmed an unchanged owner-reviewed exercise and equipment fit'
            ELSE 'Changed an owner-reviewed exercise and equipment fit'
          END,
          jsonb_build_object(
            'payloadHash', ${payloadHash}::text,
            'result', jsonb_build_object(
              'assertionId', subject.id,
              'revision', subject.revision
            )
          ),
          ${idempotencyKey}
        FROM receipt_subject subject
        RETURNING cause_ref
      )
      SELECT
        CASE
          WHEN prior.cause_ref IS NOT NULL
            AND prior.cause_ref->>'payloadHash' = ${payloadHash}::text
            THEN 'replayed'
          WHEN prior.cause_ref IS NOT NULL THEN 'idempotency_conflict'
          WHEN applied.id IS NOT NULL THEN 'saved'
          WHEN unchanged.id IS NOT NULL THEN 'unchanged'
          ELSE 'stale'
        END AS outcome,
        COALESCE(
          (prior.cause_ref->'result'->>'assertionId')::uuid,
          applied.id,
          unchanged.id,
          current.id
        ) AS assertion_id,
        COALESCE(
          (prior.cause_ref->'result'->>'revision')::integer,
          applied.revision,
          unchanged.revision,
          current.revision
        ) AS revision
      FROM (SELECT 1) seed
      LEFT JOIN prior_receipt prior ON true
      LEFT JOIN applied_assertion applied ON true
      LEFT JOIN unchanged_assertion unchanged ON true
      LEFT JOIN current_assertion current ON true
    `),
  )[0];
  return mutationResult(row);
}

/** Removing a retained assertion returns the pair to unknown, never compatible. */
export async function removeExerciseEquipmentFitAssertion(
  db: Db,
  userId: string,
  input: unknown,
): Promise<ExerciseEquipmentFitMutationResult> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid",
      reason: parsed.error.issues[0]?.message ?? "Check the retained review.",
    };
  }
  const value = parsed.data;
  const idempotencyKey = `exercise-equipment-fit:${value.mutationId}`;
  const payloadHash = sha256Hex(
    Buffer.from(
      canonicalJson({
        operation: "remove",
        assertionId: value.assertionId,
        expectedRevision: value.expectedRevision,
      }),
      "utf8",
    ),
  );

  const row = resultRows<MutationRow>(
    await db.execute(sql`
      WITH target_profile AS MATERIALIZED (
        SELECT user_id
        FROM user_profiles
        WHERE user_id = ${userId}::uuid
        FOR UPDATE
      ), prior_receipt AS MATERIALIZED (
        SELECT receipt.cause_ref
        FROM target_profile profile
        CROSS JOIN LATERAL (
          SELECT exercise_equipment_fit_receipt_after_owner_lock(
            profile.user_id,
            ${idempotencyKey}
          ) AS cause_ref
        ) receipt
        WHERE receipt.cause_ref IS NOT NULL
      ), current_assertion AS MATERIALIZED (
        SELECT assertion.*, to_jsonb(assertion) AS before_data
        FROM exercise_equipment_fit_assertions assertion
        WHERE assertion.id = ${value.assertionId}::uuid
          AND assertion.user_id = ${userId}::uuid
        FOR UPDATE
      ), removed_assertion AS (
        DELETE FROM exercise_equipment_fit_assertions assertion
        USING current_assertion current
        WHERE assertion.id = current.id
          AND assertion.user_id = ${userId}::uuid
          AND assertion.revision = ${value.expectedRevision}
          AND EXISTS (SELECT 1 FROM target_profile)
          AND NOT EXISTS (SELECT 1 FROM prior_receipt)
        RETURNING assertion.*
      ), versions AS (
        INSERT INTO record_versions (
          user_id, entity_type, entity_id, action,
          before_data, after_data, changed_fields
        )
        SELECT
          ${userId}::uuid,
          'exercise_equipment_fit_assertion',
          removed.id,
          'exercise_equipment_fit.remove',
          current.before_data,
          '{}'::jsonb,
          ARRAY['exercise_id', 'equipment_item_id', 'verdict', 'reason_code', 'reason_note', 'provenance', 'semantics_version', 'evidence_revision']::text[]
        FROM removed_assertion removed
        JOIN current_assertion current ON current.id = removed.id
        RETURNING id
      ), receipt AS (
        INSERT INTO audit_logs (
          user_id, actor_type, action, entity_type, entity_id,
          summary, cause_ref, idempotency_key
        )
        SELECT
          ${userId}::uuid,
          'user',
          'exercise_equipment_fit.remove',
          'exercise_equipment_fit_assertion',
          removed.id::text,
          'Removed an owner-reviewed exercise and equipment fit; the pair is unknown again',
          jsonb_build_object(
            'payloadHash', ${payloadHash}::text,
            'result', jsonb_build_object(
              'assertionId', removed.id,
              'revision', NULL
            )
          ),
          ${idempotencyKey}
        FROM removed_assertion removed
        RETURNING cause_ref
      )
      SELECT
        CASE
          WHEN prior.cause_ref IS NOT NULL
            AND prior.cause_ref->>'payloadHash' = ${payloadHash}::text
            THEN 'replayed'
          WHEN prior.cause_ref IS NOT NULL THEN 'idempotency_conflict'
          WHEN removed.id IS NOT NULL THEN 'saved'
          ELSE 'stale'
        END AS outcome,
        COALESCE(
          (prior.cause_ref->'result'->>'assertionId')::uuid,
          removed.id
        ) AS assertion_id,
        NULL::integer AS revision
      FROM (SELECT 1) seed
      LEFT JOIN prior_receipt prior ON true
      LEFT JOIN removed_assertion removed ON true
    `),
  )[0];
  return mutationResult(row);
}
