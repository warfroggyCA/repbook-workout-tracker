import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  exercises,
  programDrafts,
  programs,
  programVersions,
  recommendations,
  type RecommendationPayload,
} from "@/db/schema";
import { progressionConfig as cfg } from "@/engine/progression/config";
import {
  isIntentBearingProgramDocument,
  projectIntentProgramDocumentV2,
  programDocumentV3Schema,
  storedProgramDocumentSchema,
  type StoredProgramDocument,
} from "@/lib/program-document";
import { runProgramPreflight } from "@/lib/program-preflight";
import {
  programReviewSchema,
  type PublishableProgramReview,
} from "@/lib/program-review-contract";
import { KG_TO_LB, LOAD_COMPARISON_EPSILON } from "@/lib/units";
import { hashProgramDocument } from "@/services/program-document-hash";
import { getCurrentProgramDocument } from "@/services/program-documents";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import { loadProgramPreflightContext } from "@/services/program-preflight";
import { eligibleTotalSystemLoadSql } from "@/lib/set-metric-semantics-sql";

type PublicationMode = "editor" | "restore" | "recommendation";

type RecommendationPublication = {
  recommendationId: string;
  expectedPayload: RecommendationPayload;
  appliedPayload: RecommendationPayload;
  decision: "approve" | "edit";
  /** Test-only transaction failure injection. */
  failureAt?: string;
};

type PublishDocumentInput = {
  document: StoredProgramDocument;
  mode: PublicationMode;
  reviewHash: string;
  changeSummary: string;
  draft?: { id: string; expectedRevision: number };
  restoredFromVersionId?: string | null;
  recommendation?: RecommendationPublication;
  expectedRecommendationRevision?: number;
  failureAt?: string | null;
};

export type ProgramPublicationResult =
  | { ok: true; programVersionId: string; versionNo: number }
  | { ok: false; reason: "not_pending" | "stale" | "invalid" | "conflict" };

type PublishableDraft = {
  draft: typeof programDrafts.$inferSelect;
  document: ReturnType<typeof programDocumentV3Schema.parse>;
  review: PublishableProgramReview;
};

async function loadPublishableProgramDraft(
  db: Db,
  userId: string,
  input: { draftId: string; expectedRevision: number; reviewHash: string },
): Promise<
  | { ok: true; value: PublishableDraft }
  | { ok: false; reason: "stale" | "invalid" | "conflict" }
> {
  const draft = await db.query.programDrafts.findFirst({
    where: and(
      eq(programDrafts.id, input.draftId),
      eq(programDrafts.userId, userId),
    ),
  });
  if (!draft || draft.status !== "open") {
    return { ok: false, reason: "stale" };
  }
  const document = programDocumentV3Schema.safeParse(draft.document);
  const review = programReviewSchema.safeParse(draft.reviewSummary);
  if (
    !document.success ||
    !review.success ||
    review.data.status !== "publishable" ||
    draft.revision !== input.expectedRevision ||
    draft.reviewedRevision !== input.expectedRevision ||
    draft.reviewHash !== input.reviewHash ||
    review.data.reviewedRevision !== input.expectedRevision ||
    review.data.hash !== input.reviewHash ||
    review.data.changes.length === 0 ||
    document.data.programId !== draft.programId ||
    document.data.baseVersionId !== draft.baseVersionId ||
    hashProgramDocument(document.data) !== draft.contentHash
  ) {
    return { ok: false, reason: "invalid" };
  }
  const program = await db.query.programs.findFirst({
    where: and(
      eq(programs.id, draft.programId),
      eq(programs.userId, userId),
      eq(programs.status, "active"),
      isNull(programs.archivedAt),
    ),
    columns: { currentVersionId: true, recommendationRevision: true },
  });
  if (!program || program.currentVersionId !== draft.baseVersionId) {
    return { ok: false, reason: "conflict" };
  }
  if (program.recommendationRevision !== review.data.recommendationRevision) {
    return { ok: false, reason: "invalid" };
  }
  return {
    ok: true,
    value: { draft, document: document.data, review: review.data },
  };
}

export async function validateProgramDraftPublication(
  db: Db,
  userId: string,
  input: { draftId: string; expectedRevision: number; reviewHash: string },
): Promise<{ ok: true } | { ok: false; reason: "stale" | "invalid" | "conflict" }> {
  const result = await loadPublishableProgramDraft(db, userId, input);
  return result.ok ? { ok: true } : result;
}

export async function getPublishedProgramDraftReplay(
  db: Db,
  userId: string,
  input: { draftId: string; expectedRevision: number; reviewHash: string }
): Promise<Extract<ProgramPublicationResult, { ok: true }> | null> {
  const draft = await db.query.programDrafts.findFirst({
    where: and(
      eq(programDrafts.id, input.draftId),
      eq(programDrafts.userId, userId),
      eq(programDrafts.status, "published"),
      eq(programDrafts.revision, input.expectedRevision),
      eq(programDrafts.reviewHash, input.reviewHash)
    ),
  });
  if (!draft?.publishedVersionId) return null;
  const published = await db.query.programVersions.findFirst({
    where: and(
      eq(programVersions.id, draft.publishedVersionId),
      eq(programVersions.programId, draft.programId)
    ),
    columns: { id: true, versionNo: true },
  });
  return published
    ? { ok: true, programVersionId: published.id, versionNo: published.versionNo }
    : null;
}

function buildTree(document: StoredProgramDocument, versionId: string) {
  const templates: Array<Record<string, unknown>> = [];
  const groups: Array<Record<string, unknown>> = [];
  const slots: Array<Record<string, unknown>> = [];
  const prescriptions: Array<Record<string, unknown>> = [];
  for (const [dayIndex, day] of document.days.entries()) {
    const templateId = randomUUID();
    templates.push({
      id: templateId,
      program_version_id: versionId,
      lineage_id: day.lineageId,
      name: day.name,
      order_idx: dayIndex,
      notes: day.notes,
      warmup_notes: day.warmupNotes,
      warmup_items: "warmupItems" in day ? day.warmupItems : [],
      intent: "intent" in day ? day.intent : null,
    });
    const groupIds = new Map<string, string>();
    for (const [groupIndex, group] of day.supersets.entries()) {
      const groupId = randomUUID();
      groupIds.set(group.key, groupId);
      groups.push({
        id: groupId,
        workout_template_id: templateId,
        lineage_id: group.key,
        name: group.name,
        order_idx: groupIndex,
        rest_after_round_sec: group.restAfterRoundSec,
        planned_rounds: "plannedRounds" in group ? group.plannedRounds : null,
        rest_between_members_sec:
          "restBetweenMembersSec" in group ? group.restBetweenMembersSec : null,
      });
    }
    for (const [slotIndex, slot] of day.exercises.entries()) {
      const slotId = randomUUID();
      slots.push({
        id: slotId,
        workout_template_id: templateId,
        exercise_id: slot.exerciseId,
        lineage_id: slot.lineageId,
        order_idx: slotIndex,
        superset_group_id: slot.supersetKey ? groupIds.get(slot.supersetKey) : null,
        group_member_order_idx:
          "groupMemberOrderIdx" in slot ? slot.groupMemberOrderIdx : null,
        rest_sec: slot.restSec,
        notes: slot.notes,
        warmup_notes: slot.warmupNotes,
        warmup_sets: slot.warmupSets,
        set_notes: slot.setNotes,
        intent: "intent" in slot ? slot.intent : null,
      });
      prescriptions.push({
        id: randomUUID(),
        template_exercise_id: slotId,
        slot_lineage_id: slot.lineageId,
        sets: slot.sets,
        rep_range_min: slot.repMin,
        rep_range_max: slot.repMax,
        target_load: slot.targetLoad,
        target_load_unit: slot.targetLoadUnit,
        progression_rule_id: slot.progressionRuleId,
      });
    }
  }
  return { templates, groups, slots, prescriptions };
}

async function documentExercisesAreOwned(db: Db, userId: string, document: StoredProgramDocument) {
  const ids = [...new Set(document.days.flatMap((day) => day.exercises.map((slot) => slot.exerciseId)))];
  const rows = await db.query.exercises.findMany({
    where: and(
      sql`${exercises.id} IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`,
      or(isNull(exercises.userId), eq(exercises.userId, userId))
    ),
    columns: { id: true },
  });
  return rows.length === ids.length;
}

async function publishDocumentAtomically(
  db: Db,
  userId: string,
  input: PublishDocumentInput
): Promise<ProgramPublicationResult> {
  const parsed = storedProgramDocumentSchema.safeParse(input.document);
  if (!parsed.success || !(await documentExercisesAreOwned(db, userId, parsed.data))) {
    return { ok: false, reason: "invalid" };
  }
  const document = parsed.data;
  const versionId = randomUUID();
  const decisionId = randomUUID();
  const adaptationId = randomUUID();
  const { templates, groups, slots, prescriptions } = buildTree(document, versionId);
  const recommendation = input.recommendation ?? null;
  const draft = input.draft ?? null;
  const isDraft = draft !== null;
  const isRecommendation = recommendation !== null;
  const publicationSource = input.mode;
  const expectedPayload = JSON.stringify(recommendation?.expectedPayload ?? null);
  const appliedPayload = JSON.stringify(recommendation?.appliedPayload ?? null);
  const documentHash = hashProgramDocument(document);
  const publicationPreflight = isIntentBearingProgramDocument(document)
    ? runProgramPreflight(
        projectIntentProgramDocumentV2(document),
        await loadProgramPreflightContext(
          db,
          userId,
          projectIntentProgramDocumentV2(document),
        ),
      )
    : null;
  if (publicationPreflight?.findings.some((finding) => finding.severity === "blocking")) {
    return { ok: false, reason: "invalid" };
  }

  const rows = resultRows(await db.execute(sql`
    WITH publish_authorization AS MATERIALIZED (
      SELECT set_config('workout_tracker.program_publish', 'authorized', true) AS allowed
    ), template_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(templates)}::jsonb) AS x(
        id uuid, program_version_id uuid, lineage_id uuid, name text,
        order_idx integer, notes text, warmup_notes text, warmup_items jsonb,
        intent jsonb
      )
    ), group_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(groups)}::jsonb) AS x(
        id uuid, workout_template_id uuid, lineage_id uuid, name text,
        order_idx integer, rest_after_round_sec integer, planned_rounds integer,
        rest_between_members_sec integer
      )
    ), slot_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(slots)}::jsonb) AS x(
        id uuid, workout_template_id uuid, exercise_id uuid, lineage_id uuid,
        order_idx integer, superset_group_id uuid, group_member_order_idx integer,
        rest_sec integer, notes text,
        warmup_notes text, warmup_sets jsonb, set_notes jsonb, intent jsonb
      )
    ), prescription_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(prescriptions)}::jsonb) AS x(
        id uuid, template_exercise_id uuid, slot_lineage_id uuid, sets integer,
        rep_range_min integer, rep_range_max integer, target_load numeric(7,2),
        target_load_unit unit, progression_rule_id text
      )
    ), current_program AS MATERIALIZED (
      SELECT program.*, version.version_no, to_jsonb(program) AS before_data
      FROM programs program
      JOIN program_versions version ON version.id = program.current_version_id
      WHERE program.id = ${document.programId}::uuid
        AND program.user_id = ${userId}::uuid
        AND program.status = 'active'
        AND program.archived_at IS NULL
        AND program.current_version_id = ${document.baseVersionId}::uuid
        AND (${input.expectedRecommendationRevision ?? null}::int IS NULL
          OR program.recommendation_revision = ${input.expectedRecommendationRevision ?? null}::int)
      FOR UPDATE OF program
    ), target_draft AS MATERIALIZED (
      SELECT draft.id
      FROM program_drafts draft
      JOIN current_program program ON program.id = draft.program_id
      WHERE ${isDraft}::boolean
        AND draft.id = ${draft?.id ?? null}::uuid
        AND draft.user_id = ${userId}::uuid
        AND draft.status = 'open'
        AND draft.base_version_id = program.current_version_id
        AND draft.revision = ${draft?.expectedRevision ?? -1}::int
        AND draft.reviewed_revision = draft.revision
        AND draft.review_hash = ${input.reviewHash}
        AND COALESCE((draft.review_summary->>'recommendationRevision')::int, -1) = program.recommendation_revision
        AND draft.content_hash = ${documentHash}
      FOR UPDATE
    ), target_recommendation AS MATERIALIZED (
      SELECT recommendation.id
      FROM recommendations recommendation
      JOIN current_program program ON true
      JOIN workout_template_exercises slot
        ON slot.id = recommendation.source_template_exercise_id
      JOIN workout_templates day ON day.id = slot.workout_template_id
      JOIN exercises current_exercise ON current_exercise.id = slot.exercise_id
      JOIN exercise_prescriptions current_target
        ON current_target.template_exercise_id = slot.id
       AND current_target.superseded_by_id IS NULL
      WHERE ${isRecommendation}::boolean
        AND recommendation.id = ${recommendation?.recommendationId ?? null}::uuid
        AND recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.payload = ${expectedPayload}::jsonb
        AND day.program_version_id = program.current_version_id
        AND recommendation.source_slot_lineage_id = slot.lineage_id
        AND recommendation.payload->>'templateExerciseId' = slot.id::text
        AND (
          recommendation.payload->>'kind' <> 'load_change'
          OR (
            jsonb_typeof(recommendation.evidence->'setIds') = 'array'
            AND jsonb_array_length(recommendation.evidence->'setIds') > 0
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                recommendation.evidence->'setIds'
              ) evidence_set(id)
              LEFT JOIN completed_sets completed
                ON completed.id::text = evidence_set.id
              LEFT JOIN session_exercises evidence_exercise
                ON evidence_exercise.id = completed.session_exercise_id
              LEFT JOIN workout_sessions evidence_session
                ON evidence_session.id = evidence_exercise.session_id
              LEFT JOIN exercises evidence_catalog
                ON evidence_catalog.id = evidence_exercise.exercise_id
              LEFT JOIN session_occurrences evidence_occurrence
                ON evidence_occurrence.completed_set_id = completed.id
               AND evidence_occurrence.session_exercise_id = evidence_exercise.id
               AND evidence_occurrence.kind = 'working_set'
               AND evidence_occurrence.outcome = 'completed'
              WHERE completed.id IS NULL
                OR evidence_session.user_id <> ${userId}::uuid
                OR evidence_session.status <> 'completed'
                OR evidence_session.archived_at IS NOT NULL
                OR evidence_exercise.modification_type <> 'as_planned'
                OR evidence_exercise.exercise_id <> recommendation.exercise_id
                OR evidence_exercise.source_slot_lineage_id
                  IS DISTINCT FROM recommendation.source_slot_lineage_id
                OR completed.archived_at IS NOT NULL
                OR evidence_occurrence.id IS NULL
                OR NOT ${eligibleTotalSystemLoadSql({
                  recordedMetricType: sql`completed.metric_type`,
                  performedSemanticsVersion: sql`completed.performed_semantics_version`,
                  performedLoadType: sql`completed.performed_load_type`,
                  performedLoadSemantics: sql`completed.performed_load_semantics`,
                  exerciseMetricType: sql`evidence_catalog.metric_type`,
                  loadType: sql`evidence_catalog.load_type`,
                  loadSemantics: sql`evidence_catalog.load_semantics`,
                  loadEntryMeaning: sql`completed.load_entry_meaning`,
                  weight: sql`completed.weight`,
                  reps: sql`completed.reps`,
                  excludeFromAnalytics: sql`completed.exclude_from_analytics`,
                })}
            )
          )
        )
        AND (
          recommendation.payload->>'kind' <> 'substitution'
          OR recommendation.payload->>'fromExerciseId' = slot.exercise_id::text
        )
        AND (
          recommendation.payload->>'kind' <> 'load_change'
          OR (
            (${recommendation?.expectedPayload.kind === "load_change" ? recommendation.expectedPayload.fromLoad : null}::double precision IS NULL AND current_target.target_load IS NULL)
            OR (
              ${recommendation?.expectedPayload.kind === "load_change" ? recommendation.expectedPayload.fromLoad : null}::double precision IS NOT NULL
              AND current_target.target_load IS NOT NULL
              AND abs(
                CASE
                  WHEN current_target.target_load_unit::text = ${recommendation?.expectedPayload.kind === "load_change" ? recommendation.expectedPayload.loadUnit : null}::text
                    THEN current_target.target_load
                  WHEN current_target.target_load_unit = 'kg'::unit
                    THEN current_target.target_load * ${KG_TO_LB}::double precision
                  ELSE current_target.target_load / ${KG_TO_LB}::double precision
                END - ${recommendation?.expectedPayload.kind === "load_change" ? recommendation.expectedPayload.fromLoad : null}::double precision
              ) < ${LOAD_COMPARISON_EPSILON}::double precision
            )
          )
        )
        AND (
          recommendation.payload->>'kind' <> 'load_change'
          OR ${recommendation?.expectedPayload.kind === "load_change" ? recommendation.expectedPayload.fromLoad : null}::double precision IS NULL
          OR ${recommendation?.appliedPayload.kind === "load_change" ? recommendation.appliedPayload.toLoad : 0}::double precision <= COALESCE(${recommendation?.expectedPayload.kind === "load_change" ? recommendation.expectedPayload.fromLoad : null}::double precision, 0)
          OR ${recommendation?.appliedPayload.kind === "load_change" ? recommendation.appliedPayload.toLoad : 0}::double precision
             <= ${recommendation?.expectedPayload.kind === "load_change" ? recommendation.expectedPayload.fromLoad : null}::double precision * ${1 + cfg.maxLoadJumpPct}
        )
        AND NOT (
          recommendation.payload->>'kind' = 'load_change'
          AND (${recommendation?.expectedPayload.kind === "load_change" ? recommendation.expectedPayload.fromLoad : null}::double precision IS NULL
               OR ${recommendation?.appliedPayload.kind === "load_change" ? recommendation.appliedPayload.toLoad : 0}::double precision > ${recommendation?.expectedPayload.kind === "load_change" ? recommendation.expectedPayload.fromLoad : null}::double precision)
          AND EXISTS (
            SELECT 1
            FROM pain_logs pain
            JOIN workout_sessions pain_session ON pain_session.id = pain.session_id
            WHERE pain.user_id = ${userId}::uuid
              AND pain_session.user_id = ${userId}::uuid
              AND pain_session.status = 'completed'
              AND pain_session.archived_at IS NULL
              AND pain.archived_at IS NULL
              AND pain.exercise_id = current_exercise.id
              AND pain.created_at > statement_timestamp() - make_interval(days => ${cfg.painWindowDays})
              AND pain.created_at <= statement_timestamp()
            GROUP BY pain.exercise_id
            HAVING max(pain.severity) >= ${cfg.painFreezeThreshold}
              OR count(DISTINCT CASE
                   WHEN pain.severity > 0 THEN pain.session_id
                 END) >= ${cfg.painRepeatCount}
          )
        )
      FOR UPDATE OF recommendation
    ), gate AS MATERIALIZED (
      SELECT program.* FROM current_program program
      WHERE (${isDraft}::boolean AND (SELECT count(*) FROM target_draft) = 1)
         OR (${isRecommendation}::boolean AND (SELECT count(*) FROM target_recommendation) = 1)
    ), available_exercises AS MATERIALIZED (
      SELECT count(*)::int AS valid_count
      FROM slot_input slot
      JOIN exercises exercise ON exercise.id = slot.exercise_id
      WHERE (exercise.user_id IS NULL OR exercise.user_id = ${userId}::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM constraints safety
          WHERE safety.user_id = ${userId}::uuid
            AND safety.avoid
            AND safety.affected_patterns ? exercise.movement_pattern::text
        )
        AND NOT EXISTS (
          SELECT 1 FROM exercise_equipment_requirements requirement
          WHERE requirement.exercise_id = exercise.id
            AND requirement.equipment_type <> 'bodyweight'::equipment_type
            AND NOT EXISTS (
              SELECT 1
              WHERE (
                requirement.equipment_type = 'plates'::equipment_type
                AND EXISTS (
                  SELECT 1 FROM plate_inventory plate
                  WHERE plate.user_id = ${userId}::uuid
                )
              ) OR (
                requirement.equipment_type <> 'plates'::equipment_type
                AND EXISTS (
                  SELECT 1 FROM equipment_items item
                  WHERE item.user_id = ${userId}::uuid
                    AND item.available
                    AND item.type = requirement.equipment_type
                    AND item.type <> 'bodyweight'::equipment_type
                    AND (
                      requirement.min_weight IS NULL
                      OR COALESCE((item.attrs->>'maxWeight')::double precision, -1) >= requirement.min_weight
                    )
                )
              )
            )
        )
    ), new_version AS (
      INSERT INTO program_versions (
        id, program_id, version_no, name, parent_version_id,
        restored_from_version_id, publication_source, review_hash,
        activated_at, change_summary, document_schema_version, publication_preflight
      )
      SELECT ${versionId}::uuid, gate.id, gate.version_no + 1,
             ${document.name}, gate.current_version_id,
             ${input.restoredFromVersionId ?? null}::uuid,
             ${publicationSource}, ${input.reviewHash}, now(), ${input.changeSummary},
             ${Number(document.schemaVersion)},
             ${publicationPreflight ? JSON.stringify(publicationPreflight) : null}::jsonb
      FROM gate CROSS JOIN publish_authorization CROSS JOIN available_exercises
      WHERE available_exercises.valid_count = (SELECT count(*) FROM slot_input)
        AND ${input.failureAt ?? null}::text IS NULL
      RETURNING *
    ), inserted_templates AS (
      INSERT INTO workout_templates (id, program_version_id, lineage_id, name, order_idx, notes, warmup_notes, warmup_items, intent)
      SELECT input.id, input.program_version_id, input.lineage_id, input.name, input.order_idx, input.notes, input.warmup_notes, input.warmup_items, input.intent
      FROM template_input input CROSS JOIN publish_authorization
      WHERE EXISTS (SELECT 1 FROM new_version)
      RETURNING *
    ), inserted_groups AS (
      INSERT INTO superset_groups (id, workout_template_id, lineage_id, name, order_idx, rest_after_round_sec, planned_rounds, rest_between_members_sec)
      SELECT input.id, input.workout_template_id, input.lineage_id, input.name, input.order_idx, input.rest_after_round_sec, input.planned_rounds, input.rest_between_members_sec
      FROM group_input input CROSS JOIN publish_authorization
      WHERE EXISTS (SELECT 1 FROM new_version)
      RETURNING *
    ), inserted_slots AS (
      INSERT INTO workout_template_exercises (
        id, workout_template_id, exercise_id, lineage_id, order_idx,
        superset_group_id, group_member_order_idx, rest_sec, notes, warmup_notes, warmup_sets, set_notes, intent
      )
      SELECT input.id, input.workout_template_id, input.exercise_id, input.lineage_id,
             input.order_idx, input.superset_group_id, input.group_member_order_idx, input.rest_sec, input.notes,
             input.warmup_notes, input.warmup_sets, input.set_notes, input.intent
      FROM slot_input input CROSS JOIN publish_authorization
      WHERE EXISTS (SELECT 1 FROM new_version)
      RETURNING *
    ), inserted_prescriptions AS (
      INSERT INTO exercise_prescriptions (
        id, template_exercise_id, sets, rep_range_min, rep_range_max,
        target_load, target_load_unit, progression_rule_id
      )
      SELECT input.id, input.template_exercise_id, input.sets, input.rep_range_min,
             input.rep_range_max, input.target_load, input.target_load_unit,
             input.progression_rule_id
      FROM prescription_input input CROSS JOIN publish_authorization
      WHERE EXISTS (SELECT 1 FROM new_version)
      RETURNING *
    ), old_slot_state AS MATERIALIZED (
      SELECT slot.lineage_id, slot.id, slot.exercise_id,
             target.sets, target.rep_range_max, target.target_load, target.target_load_unit
      FROM workout_template_exercises slot
      JOIN workout_templates day ON day.id = slot.workout_template_id
      JOIN exercise_prescriptions target ON target.template_exercise_id = slot.id AND target.superseded_by_id IS NULL
      WHERE day.program_version_id = ${document.baseVersionId}::uuid
    ), new_slot_state AS MATERIALIZED (
      SELECT slot.id, slot.lineage_id, slot.exercise_id,
             target.sets, target.rep_range_max, target.target_load, target.target_load_unit
      FROM inserted_slots slot
      JOIN inserted_prescriptions target ON target.template_exercise_id = slot.id
    ), pending AS MATERIALIZED (
      SELECT recommendation.*, old_slot.exercise_id AS old_exercise_id,
             old_slot.sets AS old_sets, old_slot.rep_range_max AS old_rep_max,
             old_slot.target_load AS old_target_load,
             old_slot.target_load_unit AS old_target_load_unit,
             new_slot.id AS new_slot_id, new_slot.exercise_id AS new_exercise_id,
             new_slot.sets AS new_sets, new_slot.rep_range_max AS new_rep_max,
             new_slot.target_load AS new_target_load,
             new_slot.target_load_unit AS new_target_load_unit
      FROM recommendations recommendation
      LEFT JOIN old_slot_state old_slot ON old_slot.lineage_id = recommendation.source_slot_lineage_id
      LEFT JOIN new_slot_state new_slot ON new_slot.lineage_id = old_slot.lineage_id
      WHERE recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.id IS DISTINCT FROM ${recommendation?.recommendationId ?? null}::uuid
        AND (recommendation.payload->>'kind' = 'deload' OR old_slot.id IS NOT NULL)
      FOR UPDATE OF recommendation
    ), active_pain_state AS MATERIALIZED (
      SELECT pending.id,
             max(pain.severity) >= ${cfg.painFreezeThreshold}
               OR count(DISTINCT CASE WHEN pain.severity > 0 THEN pain.session_id END) >= ${cfg.painRepeatCount}
               AS blocks_progression,
             max(pain.severity) >= ${cfg.painSubstituteThreshold}
               OR count(DISTINCT CASE WHEN pain.severity > 0 THEN pain.session_id END) >= ${cfg.painRepeatCount}
               AS needs_substitution_review
      FROM pending
      JOIN pain_logs pain ON pain.exercise_id = pending.old_exercise_id
      JOIN workout_sessions pain_session ON pain_session.id = pain.session_id
      WHERE pain.user_id = ${userId}::uuid
        AND pain_session.user_id = ${userId}::uuid
        AND pain_session.status = 'completed'
        AND pain_session.archived_at IS NULL
        AND pain.archived_at IS NULL
        AND pain.created_at > statement_timestamp() - make_interval(days => ${cfg.painWindowDays})
        AND pain.created_at <= statement_timestamp()
      GROUP BY pending.id
    ), reconciliation_plan AS MATERIALIZED (
      SELECT pending.*,
        CASE
          WHEN payload->>'kind' = 'deload' THEN false
          WHEN new_slot_id IS NULL THEN false
          WHEN payload->>'kind' = 'load_change'
            THEN (
               (new_target_load IS NULL AND old_target_load IS NULL)
               OR (
                 new_target_load IS NOT NULL
                 AND old_target_load IS NOT NULL
                 AND abs(new_target_load - old_target_load) < ${LOAD_COMPARISON_EPSILON}::double precision
               )
             )
             AND new_target_load_unit IS NOT DISTINCT FROM old_target_load_unit
             AND (
               ((payload->>'fromLoad')::double precision IS NULL AND old_target_load IS NULL)
               OR (
                 (payload->>'fromLoad')::double precision IS NOT NULL
                 AND old_target_load IS NOT NULL
                 AND abs((payload->>'fromLoad')::double precision - old_target_load) < ${LOAD_COMPARISON_EPSILON}::double precision
               )
             )
             AND (
               ((payload->>'fromLoad')::double precision IS NULL AND old_target_load_unit IS NULL)
               OR (
                 (payload->>'fromLoad')::double precision IS NOT NULL
                 AND payload->>'loadUnit' = old_target_load_unit::text
               )
             )
          WHEN payload->>'kind' = 'substitution'
            THEN new_exercise_id = old_exercise_id
             AND payload->>'fromExerciseId' = old_exercise_id::text
             AND (
               rule_id IS DISTINCT FROM 'pain_substitute'
               OR EXISTS (
                 SELECT 1
                 FROM active_pain_state pain_state
                 WHERE pain_state.id = pending.id
                   AND pain_state.needs_substitution_review
               )
             )
          WHEN payload->>'kind' = 'rep_target_change'
            THEN new_rep_max = old_rep_max
             AND (payload->>'fromRepMax')::integer = old_rep_max
          WHEN payload->>'kind' = 'set_count_change'
            THEN new_sets = old_sets
             AND (payload->>'fromSets')::integer = old_sets
          WHEN payload->>'kind' = 'hold'
            THEN new_exercise_id = old_exercise_id
             AND EXISTS (
               SELECT 1
               FROM active_pain_state pain_state
               WHERE pain_state.id = pending.id
                 AND (
                   (
                     rule_id = 'pain_freeze'
                     AND pain_state.blocks_progression
                     AND NOT pain_state.needs_substitution_review
                   )
                   OR (
                     rule_id = 'pain_substitute'
                     AND pain_state.needs_substitution_review
                   )
                 )
             )
          ELSE false
        END AS carry,
        CASE
          WHEN payload->>'kind' = 'deload' THEN 'program_changed'
          WHEN payload->>'kind' = 'remove_exercise' AND new_slot_id IS NULL THEN 'already_satisfied'
          WHEN new_slot_id IS NULL THEN 'source_removed'
          WHEN payload->>'kind' = 'load_change'
            AND new_target_load IS NOT NULL
            AND abs(new_target_load - (payload->>'toLoad')::double precision) < ${LOAD_COMPARISON_EPSILON}::double precision
            AND new_target_load_unit::text = payload->>'loadUnit' THEN 'already_satisfied'
          WHEN payload->>'kind' = 'substitution'
            AND new_exercise_id::text = payload->>'toExerciseId' THEN 'already_satisfied'
          WHEN payload->>'kind' = 'rep_target_change'
            AND new_rep_max = (payload->>'toRepMax')::integer THEN 'already_satisfied'
          WHEN payload->>'kind' = 'set_count_change'
            AND new_sets = (payload->>'toSets')::integer THEN 'already_satisfied'
          ELSE 'program_changed'
        END AS outcome
      FROM pending
    ), reconciled AS (
      UPDATE recommendations recommendation
      SET status = CASE WHEN plan.carry THEN 'pending'::recommendation_status ELSE 'expired'::recommendation_status END,
          source_template_exercise_id = CASE WHEN plan.carry THEN plan.new_slot_id ELSE recommendation.source_template_exercise_id END,
          payload = CASE
            WHEN plan.carry AND recommendation.payload ? 'templateExerciseId'
              THEN jsonb_set(recommendation.payload, '{templateExerciseId}', to_jsonb(plan.new_slot_id::text), false)
            ELSE recommendation.payload
          END,
          reconciled_at = now(),
          reconciliation_reason = CASE
            WHEN plan.carry THEN 'Carried forward to the matching exercise in the new Program version.'
            WHEN plan.outcome = 'already_satisfied' THEN 'The new Program version already includes this recommendation.'
            WHEN plan.outcome = 'source_removed' THEN 'The source exercise was removed from the new Program version.'
            WHEN plan.outcome = 'program_changed' THEN 'The edited Program changed the same target, so the older recommendation expired.'
            ELSE 'The recommendation was reconciled with the new Program version.'
          END,
          reconciled_by_program_version_id = ${versionId}::uuid
      FROM reconciliation_plan plan
      WHERE recommendation.id = plan.id AND EXISTS (SELECT 1 FROM new_version)
      RETURNING recommendation.id
    ), claimed_recommendation AS (
      UPDATE recommendations recommendation
      SET status = ${recommendation?.decision === "edit" ? "edited" : "approved"}::recommendation_status,
          decided_at = now(), reconciled_at = now(),
          reconciliation_reason = 'Applied by publishing a new immutable Program version.',
          reconciled_by_program_version_id = ${versionId}::uuid
      WHERE recommendation.id IN (SELECT id FROM target_recommendation)
        AND EXISTS (SELECT 1 FROM new_version)
      RETURNING recommendation.*
    ), recorded_decision AS (
      INSERT INTO user_decisions (id, recommendation_id, decision, edited_payload)
      SELECT ${decisionId}::uuid, claimed.id,
             ${recommendation?.decision ?? "approve"}::decision,
             CASE WHEN ${recommendation?.decision === "edit"}::boolean THEN ${appliedPayload}::jsonb ELSE NULL END
      FROM claimed_recommendation claimed
      RETURNING id
    ), recorded_adaptation AS (
      INSERT INTO adaptation_events (id, user_id, recommendation_id, before_snapshot, after_snapshot)
      SELECT ${adaptationId}::uuid, ${userId}::uuid, claimed.id,
             jsonb_build_object('programVersionId', ${document.baseVersionId}::uuid, 'payload', ${expectedPayload}::jsonb),
             jsonb_build_object('programVersionId', ${versionId}::uuid, 'payload', ${appliedPayload}::jsonb)
      FROM claimed_recommendation claimed
      RETURNING id
    ), updated_program AS (
      UPDATE programs program
      SET name = ${document.name}, current_version_id = ${versionId}::uuid
      FROM new_version
      WHERE program.id = new_version.program_id
        AND (SELECT count(*) FROM inserted_templates) = ${templates.length}::int
        AND (SELECT count(*) FROM inserted_groups) = ${groups.length}::int
        AND (SELECT count(*) FROM inserted_slots) = ${slots.length}::int
        AND (SELECT count(*) FROM inserted_prescriptions) = ${prescriptions.length}::int
        AND (NOT ${isRecommendation}::boolean OR (
          (SELECT count(*) FROM claimed_recommendation) = 1
          AND (SELECT count(*) FROM recorded_decision) = 1
          AND (SELECT count(*) FROM recorded_adaptation) = 1
        ))
      RETURNING program.*
    ), published_draft AS (
      UPDATE program_drafts draft
      SET status = 'published', published_version_id = ${versionId}::uuid,
          published_at = now(), updated_at = now()
      WHERE draft.id IN (SELECT id FROM target_draft)
        AND EXISTS (SELECT 1 FROM updated_program)
      RETURNING draft.id
    ), discarded_stale_drafts AS (
      UPDATE program_drafts draft
      SET status = 'discarded', discarded_at = now(), updated_at = now()
      FROM updated_program program
      WHERE draft.program_id = program.id
        AND draft.user_id = ${userId}::uuid
        AND draft.status = 'open'
        AND draft.id IS DISTINCT FROM ${draft?.id ?? null}::uuid
      RETURNING draft.id
    ), recorded_version AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action, before_data, after_data,
        changed_fields, source_version_id
      )
      SELECT ${userId}::uuid, 'program', updated.id,
             ${input.mode === "restore" ? "program.restore_version" : "program.publish_version"},
             gate.before_data,
             to_jsonb(updated) || jsonb_build_object('publishedVersionId', ${versionId}::uuid, 'documentHash', ${documentHash}::text),
             ARRAY['name', 'current_version_id']::text[], gate.current_version_id
      FROM updated_program updated JOIN gate ON gate.id = updated.id
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT ${userId}::uuid, 'user',
             ${isRecommendation ? "recommendation.approve" : input.mode === "restore" ? "program.restore_version" : "program.publish_version"},
             'program_version', ${versionId}::text, ${input.changeSummary},
             jsonb_build_object(
               'programId', updated.id, 'baseVersionId', ${document.baseVersionId}::uuid,
               'draftId', ${draft?.id ?? null}::uuid,
               'recommendationId', ${recommendation?.recommendationId ?? null}::uuid,
               'reconciledRecommendations', (SELECT count(*) FROM reconciled),
               'discardedStaleDrafts', (SELECT count(*) FROM discarded_stale_drafts)
             ),
             CASE WHEN ${isRecommendation}::boolean
               THEN 'recommendation:' || ${recommendation?.recommendationId ?? null}::text || ':decision'
               ELSE 'program-draft:' || ${draft?.id ?? null}::text || ':publish'
             END
      FROM updated_program updated
      WHERE EXISTS (SELECT 1 FROM recorded_version)
        AND (NOT ${isDraft}::boolean OR (SELECT count(*) FROM published_draft) = 1)
      RETURNING id
    ), publication_integrity AS MATERIALIZED (
      SELECT 1 / CASE
        WHEN EXISTS (SELECT 1 FROM new_version)
         AND NOT EXISTS (SELECT 1 FROM recorded_audit)
        THEN 0 ELSE 1
      END AS valid
    )
    SELECT ${versionId}::text AS version_id,
           (SELECT version_no::int FROM new_version) AS version_no
    FROM publication_integrity
    CROSS JOIN recorded_audit
  `));
  if (rows.length === 1) {
    return {
      ok: true,
      programVersionId: versionId,
      versionNo: Number(rows[0].version_no),
    };
  }
  if (isRecommendation) {
    const latest = await db.query.recommendations.findFirst({
      where: and(eq(recommendations.id, recommendation!.recommendationId), eq(recommendations.userId, userId)),
    });
    if (latest && latest.status !== "pending") return { ok: false, reason: "not_pending" };
  }
  const current = await db.query.programs.findFirst({
    where: and(eq(programs.id, document.programId), eq(programs.userId, userId)),
  });
  return { ok: false, reason: current?.currentVersionId === document.baseVersionId ? "invalid" : "conflict" };
}

export async function publishProgramDraft(
  db: Db,
  userId: string,
  input: { draftId: string; expectedRevision: number; reviewHash: string; failureAt?: string }
): Promise<ProgramPublicationResult> {
  const replay = await getPublishedProgramDraftReplay(db, userId, input);
  if (replay) return replay;
  const eligible = await loadPublishableProgramDraft(db, userId, input);
  if (!eligible.ok) return eligible;
  const { draft, document, review } = eligible.value;
  const changeCount = review.changes.length;
  return publishDocumentAtomically(db, userId, {
    document,
    mode: draft.restoredFromVersionId ? "restore" : "editor",
    reviewHash: input.reviewHash,
    changeSummary: draft.restoredFromVersionId
      ? `Restored an earlier Program as a new version (${changeCount} reviewed changes)`
      : `Published ${changeCount} reviewed Program change${changeCount === 1 ? "" : "s"}`,
    draft: { id: draft.id, expectedRevision: input.expectedRevision },
    restoredFromVersionId: draft.restoredFromVersionId,
    failureAt: input.failureAt,
  });
}

export async function publishRecommendationProgramVersion(
  db: Db,
  userId: string,
  input: RecommendationPublication
): Promise<ProgramPublicationResult> {
  const [recommendation, current, program] = await Promise.all([
    db.query.recommendations.findFirst({
      where: and(
        eq(recommendations.id, input.recommendationId),
        eq(recommendations.userId, userId),
        eq(recommendations.status, "pending"),
        isNull(recommendations.archivedAt)
      ),
    }),
    getCurrentProgramDocument(db, userId),
    db.query.programs.findFirst({
      where: and(
        eq(programs.userId, userId),
        eq(programs.status, "active"),
        isNull(programs.archivedAt)
      ),
      columns: { recommendationRevision: true },
    }),
  ]);
  if (!recommendation) return { ok: false, reason: "not_pending" };
  if (!current || !program || !recommendation.sourceSlotLineageId) return { ok: false, reason: "stale" };
  const document = structuredClone(current);
  let found = false;
  for (const day of document.days) {
    const index = day.exercises.findIndex((slot) => slot.lineageId === recommendation.sourceSlotLineageId);
    if (index < 0) continue;
    found = true;
    const slot = day.exercises[index];
    const payload = input.appliedPayload;
    if (payload.kind === "load_change") {
      day.exercises[index] = { ...slot, targetLoad: payload.toLoad, targetLoadUnit: payload.loadUnit };
    } else if (payload.kind === "substitution") {
      const nextLineageId = randomUUID();
      day.exercises[index] = {
        ...slot,
        exerciseId: payload.toExerciseId,
        lineageId: nextLineageId,
        supersetKey: null,
        targetLoad: null,
        targetLoadUnit: null,
      };
      if ("intent" in day) {
        day.intent = {
          ...day.intent,
          identity: {
            ...day.intent.identity,
            anchorSlotLineageIds: day.intent.identity.anchorSlotLineageIds.map(
              (lineageId) => lineageId === slot.lineageId ? nextLineageId : lineageId,
            ),
          },
        };
      }
    } else {
      return { ok: false, reason: "invalid" };
    }
    break;
  }
  if (!found) return { ok: false, reason: "stale" };
  const reviewHash = sha256Hex(Buffer.from(canonicalJson({
    recommendationId: input.recommendationId,
    expectedPayload: input.expectedPayload,
    appliedPayload: input.appliedPayload,
    baseVersionId: document.baseVersionId,
  }), "utf8"));
  return publishDocumentAtomically(db, userId, {
    document,
    mode: "recommendation",
    reviewHash,
    changeSummary: input.decision === "edit"
      ? "Applied a recommendation with reviewed edits"
      : "Applied an approved recommendation",
    recommendation: input,
    expectedRecommendationRevision: program.recommendationRevision,
    failureAt: input.failureAt,
  });
}
