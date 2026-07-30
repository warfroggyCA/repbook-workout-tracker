import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import type { RoutineWarmupSet } from "@/db/schema/user";
import type { LoadUnit } from "@/lib/units";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
  programDocumentSchema,
  type ProgramDocumentDay,
} from "@/lib/program-document";
import { runProgramPreflight } from "@/lib/program-preflight";
import { loadProgramPreflightContext } from "@/services/program-preflight";

export type ProgramActivationExercise = {
  exerciseId: string;
  sets: number;
  repMin: number;
  repMax: number;
  targetLoad: number | null;
  restSec: number;
  supersetKey: string | null;
  supersetRestAfterRoundSec?: number;
  notes: string | null;
  warmupNotes?: string | null;
  warmupSets?: RoutineWarmupSet[];
  setNotes?: Array<string | null>;
};

export type ProgramActivationDay = {
  name: string;
  notes?: string | null;
  warmupNotes?: string | null;
  exercises: ProgramActivationExercise[];
};

export type AtomicProgramActivationInput = {
  userId: string;
  loadUnit: LoadUnit;
  programName: string;
  days: ProgramActivationDay[];
  changeSummary: string;
  auditAction: "program.activate" | "import.confirm";
  auditSummary: string;
  importEventId?: string | null;
  aiEventIds?: string[];
  confirmedPayload?: unknown;
  expectedSetupDraft?: unknown;
  completeSetup?: boolean;
  /** True only when the immediately preceding user-facing review showed the structured suggestions. */
  structuredIntentReviewed?: boolean;
};

export type AtomicProgramActivationResult =
  | { ok: true; programId: string; programVersionId: string; replacedPrograms: number }
  | { ok: false; reason: string };

/**
 * Build, activate, version the replaced program, confirm its source event,
 * and audit the replacement in one data-modifying statement.
 */
export async function activateProgramAtomically(
  db: Db,
  input: AtomicProgramActivationInput
): Promise<AtomicProgramActivationResult> {
  const programId = randomUUID();
  const programVersionId = randomUUID();
  const templates: Array<Record<string, unknown>> = [];
  const groups: Array<Record<string, unknown>> = [];
  const slots: Array<Record<string, unknown>> = [];
  const prescriptions: Array<Record<string, unknown>> = [];
  const intentDays: ProgramDocumentDay[] = [];
  const structuredIntentReviewed = input.structuredIntentReviewed === true;

  for (const [dayIndex, day] of input.days.entries()) {
    const templateId = randomUUID();
    const dayLineageId = randomUUID();
    const templateRow: Record<string, unknown> = {
      id: templateId,
      program_version_id: programVersionId,
      lineage_id: dayLineageId,
      name: day.name,
      order_idx: dayIndex,
      notes: day.notes ?? null,
      warmup_notes: day.warmupNotes ?? null,
      intent: null,
    };
    templates.push(templateRow);

    const groupIdByKey = new Map<string, string>();
    const groupLineageByKey = new Map<string, string>();
    const documentGroups: ProgramDocumentDay["supersets"] = [];
    for (const exercise of day.exercises) {
      if (!exercise.supersetKey || groupIdByKey.has(exercise.supersetKey)) continue;
      const groupId = randomUUID();
      const groupLineageId = randomUUID();
      groupIdByKey.set(exercise.supersetKey, groupId);
      groupLineageByKey.set(exercise.supersetKey, groupLineageId);
      groups.push({
        id: groupId,
        workout_template_id: templateId,
        lineage_id: groupLineageId,
        name: `Superset ${groupIdByKey.size}`,
        order_idx: groupIdByKey.size - 1,
        rest_after_round_sec: exercise.supersetRestAfterRoundSec ?? 90,
      });
      documentGroups.push({
        key: groupLineageId,
        name: `Superset ${groupIdByKey.size}`,
        restAfterRoundSec: exercise.supersetRestAfterRoundSec ?? 90,
      });
    }

    const documentSlots: ProgramDocumentDay["exercises"] = [];
    for (const [exerciseIndex, exercise] of day.exercises.entries()) {
      const warmupSets = exercise.warmupSets ?? [];
      if (
        warmupSets.some(
          (set) => (set.load == null) !== (set.loadUnit == null)
        )
      ) {
        return {
          ok: false,
          reason: "A numeric warm-up load is missing its recorded unit.",
        };
      }
      const slotId = randomUUID();
      const slotLineageId = randomUUID();
      const normalizedSetNotes = Array.from(
        { length: exercise.sets },
        (_, index) => exercise.setNotes?.[index] ?? null,
      );
      const slotIntent = structuredIntentReviewed
        ? createSuggestedSlotIntent(exercise.sets, exerciseIndex)
        : null;
      slots.push({
        id: slotId,
        workout_template_id: templateId,
        exercise_id: exercise.exerciseId,
        lineage_id: slotLineageId,
        order_idx: exerciseIndex,
        superset_group_id: exercise.supersetKey
          ? (groupIdByKey.get(exercise.supersetKey) ?? null)
          : null,
        rest_sec: exercise.restSec,
        notes: exercise.notes,
        warmup_notes: exercise.warmupNotes ?? null,
        warmup_sets: warmupSets,
        set_notes: exercise.setNotes ?? [],
        intent: slotIntent,
      });
      prescriptions.push({
        id: randomUUID(),
        template_exercise_id: slotId,
        sets: exercise.sets,
        rep_range_min: exercise.repMin,
        rep_range_max: exercise.repMax,
        target_load: exercise.targetLoad,
        target_load_unit:
          exercise.targetLoad == null ? null : input.loadUnit,
      });
      if (structuredIntentReviewed) {
        documentSlots.push({
          lineageId: slotLineageId,
          exerciseId: exercise.exerciseId,
          sets: exercise.sets,
          repMin: exercise.repMin,
          repMax: exercise.repMax,
          targetLoad: exercise.targetLoad,
          targetLoadUnit: exercise.targetLoad == null ? null : input.loadUnit,
          progressionRuleId: "double_progression",
          restSec: exercise.restSec,
          supersetKey: exercise.supersetKey
            ? (groupLineageByKey.get(exercise.supersetKey) ?? null)
            : null,
          notes: exercise.notes,
          warmupNotes: exercise.warmupNotes ?? null,
          warmupSets,
          setNotes: normalizedSetNotes,
          intent: slotIntent!,
        });
      }
    }
    if (structuredIntentReviewed) {
      const dayIntent = createSuggestedDayIntent(documentSlots);
      templateRow.intent = dayIntent;
      intentDays.push({
        lineageId: dayLineageId,
        name: day.name,
        notes: day.notes ?? null,
        warmupNotes: day.warmupNotes ?? null,
        intent: dayIntent,
        supersets: documentGroups,
        exercises: documentSlots,
      });
    }
  }

  const intentDocument = structuredIntentReviewed
    ? programDocumentSchema.parse({
        schemaVersion: "2",
        programId,
        baseVersionId: programVersionId,
        name: input.programName,
        days: intentDays,
      })
    : null;
  const publicationPreflight = intentDocument
    ? runProgramPreflight(
        intentDocument,
        await loadProgramPreflightContext(db, input.userId, intentDocument),
      )
    : null;
  const blockingFinding = publicationPreflight?.findings.find(
    (finding) => finding.severity === "blocking",
  );
  if (blockingFinding) {
    return { ok: false, reason: blockingFinding.reason };
  }

  const importEventId = input.importEventId ?? null;
  const aiEventIds = [...new Set(input.aiEventIds ?? [])];
  const expectedSetupDraft = input.expectedSetupDraft ?? null;
  const completeSetup = input.completeSetup ?? false;
  const query = sql`
    WITH publish_authorization AS MATERIALIZED (
      SELECT set_config('workout_tracker.program_publish', 'authorized', true) AS allowed
    ), template_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(templates)}::jsonb) AS x(
        id uuid, program_version_id uuid, lineage_id uuid, name text, order_idx integer, notes text,
        warmup_notes text, intent jsonb
      )
    ), group_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(groups)}::jsonb) AS x(
        id uuid, workout_template_id uuid, lineage_id uuid, name text, order_idx integer,
        rest_after_round_sec integer
      )
    ), slot_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(slots)}::jsonb) AS x(
        id uuid, workout_template_id uuid, exercise_id uuid, lineage_id uuid, order_idx integer,
        superset_group_id uuid, rest_sec integer, notes text,
        warmup_notes text, warmup_sets jsonb, set_notes jsonb, intent jsonb
      )
    ), prescription_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(prescriptions)}::jsonb) AS x(
        id uuid, template_exercise_id uuid, sets integer,
        rep_range_min integer, rep_range_max integer, target_load numeric(7,2),
        target_load_unit unit
      )
    ), target_profile AS MATERIALIZED (
      SELECT id, setup_state, setup_completed_at
      FROM user_profiles
      WHERE user_id = ${input.userId}::uuid
      FOR UPDATE
    ), target_import AS MATERIALIZED (
      SELECT id
      FROM import_events
      WHERE id = ${importEventId}::uuid
        AND user_id = ${input.userId}::uuid
        AND status = 'parsed'
      FOR UPDATE
    ), valid_ai_events AS MATERIALIZED (
      SELECT id
      FROM ai_parsing_events
      WHERE user_id = ${input.userId}::uuid
        AND id IN (
          SELECT value::uuid
          FROM jsonb_array_elements_text(${JSON.stringify(aiEventIds)}::jsonb)
        )
    ), activation_gate AS MATERIALIZED (
      SELECT profile.id
      FROM target_profile profile
      WHERE (${importEventId === null}::boolean OR EXISTS (SELECT 1 FROM target_import))
        AND (${!completeSetup}::boolean OR profile.setup_completed_at IS NULL)
        AND (
          ${expectedSetupDraft === null}::boolean
          OR profile.setup_state->'routineDraft' = ${JSON.stringify(expectedSetupDraft)}::jsonb
        )
        AND (SELECT count(*) FROM valid_ai_events) = ${aiEventIds.length}::int
        AND NOT EXISTS (
          SELECT 1
          FROM slot_input slot
          LEFT JOIN exercises exercise ON exercise.id = slot.exercise_id
          WHERE exercise.id IS NULL
             OR (exercise.user_id IS NOT NULL AND exercise.user_id <> ${input.userId}::uuid)
        )
    ), current_programs AS MATERIALIZED (
      SELECT program.*, version.version_no, to_jsonb(program) AS before_data
      FROM programs program
      JOIN program_versions version ON version.id = program.current_version_id
      WHERE program.user_id = ${input.userId}::uuid
        AND program.status = 'active'
        AND program.archived_at IS NULL
      FOR UPDATE OF program
    ), new_program AS (
      INSERT INTO programs (id, user_id, name, status, current_version_id)
      SELECT ${programId}::uuid, ${input.userId}::uuid, ${input.programName}, 'active', ${programVersionId}::uuid
      FROM activation_gate
      WHERE NOT EXISTS (SELECT 1 FROM current_programs)
      RETURNING *
    ), target_program AS MATERIALIZED (
      SELECT id, current_version_id, version_no, before_data
      FROM current_programs
      UNION ALL
      SELECT id, NULL::uuid, 0, to_jsonb(new_program)
      FROM new_program
    ), new_version AS (
      INSERT INTO program_versions (
        id, program_id, version_no, name, parent_version_id,
        publication_source, activated_at, source_import_event_id, change_summary,
        document_schema_version, publication_preflight
      )
      SELECT
        ${programVersionId}::uuid, target.id, target.version_no + 1,
        ${input.programName}, target.current_version_id,
        ${importEventId ? "import" : "setup"}, now(),
        ${importEventId}::uuid, ${input.changeSummary},
        ${structuredIntentReviewed ? 2 : 1}::int,
        ${publicationPreflight ? JSON.stringify(publicationPreflight) : null}::jsonb
      FROM target_program target CROSS JOIN publish_authorization
      WHERE EXISTS (SELECT 1 FROM activation_gate)
      RETURNING *
    ), inserted_templates AS (
      INSERT INTO workout_templates (
        id, program_version_id, lineage_id, name, order_idx, notes, warmup_notes, intent
      )
      SELECT input.id, input.program_version_id, input.lineage_id, input.name, input.order_idx, input.notes, input.warmup_notes, input.intent
      FROM template_input input CROSS JOIN publish_authorization
      WHERE EXISTS (SELECT 1 FROM new_version)
      RETURNING id
    ), inserted_groups AS (
      INSERT INTO superset_groups (
        id, workout_template_id, lineage_id, name, order_idx, rest_after_round_sec
      )
      SELECT
        input.id, input.workout_template_id, input.lineage_id, input.name, input.order_idx,
        input.rest_after_round_sec
      FROM group_input input CROSS JOIN publish_authorization
      WHERE EXISTS (SELECT 1 FROM new_version)
      RETURNING id
    ), inserted_slots AS (
      INSERT INTO workout_template_exercises (
        id, workout_template_id, exercise_id, lineage_id, order_idx,
        superset_group_id, rest_sec, notes, warmup_notes,
        warmup_sets, set_notes, intent
      )
      SELECT
        input.id, input.workout_template_id, input.exercise_id, input.lineage_id,
        input.order_idx, input.superset_group_id, input.rest_sec,
        input.notes, input.warmup_notes, input.warmup_sets, input.set_notes, input.intent
      FROM slot_input input CROSS JOIN publish_authorization
      WHERE EXISTS (SELECT 1 FROM new_version)
      RETURNING id
    ), inserted_prescriptions AS (
      INSERT INTO exercise_prescriptions (
        id, template_exercise_id, sets, rep_range_min,
        rep_range_max, target_load, target_load_unit
      )
      SELECT
        input.id, input.template_exercise_id, input.sets,
        input.rep_range_min, input.rep_range_max, input.target_load,
        input.target_load_unit
      FROM prescription_input input CROSS JOIN publish_authorization
      WHERE EXISTS (SELECT 1 FROM new_version)
      RETURNING id
    ), updated_program AS (
      UPDATE programs program
      SET name = ${input.programName},
          status = 'active',
          archived_at = NULL,
          current_version_id = ${programVersionId}::uuid
      FROM new_version
      WHERE program.id = new_version.program_id
        AND EXISTS (SELECT 1 FROM current_programs current WHERE current.id = program.id)
        AND (SELECT count(*) FROM inserted_templates) = ${templates.length}::int
        AND (SELECT count(*) FROM inserted_groups) = ${groups.length}::int
        AND (SELECT count(*) FROM inserted_slots) = ${slots.length}::int
        AND (SELECT count(*) FROM inserted_prescriptions) = ${prescriptions.length}::int
      RETURNING program.*
    ), activated_program AS MATERIALIZED (
      SELECT * FROM updated_program
      UNION ALL
      SELECT * FROM new_program
    ), reconciled_recommendations AS (
      UPDATE recommendations recommendation
      SET status = 'expired', reconciled_at = now(),
          reconciliation_reason = 'The Program was replaced through setup or routine import, so this older suggestion no longer has the same source exercise.',
          reconciled_by_program_version_id = ${programVersionId}::uuid
      WHERE recommendation.user_id = ${input.userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM updated_program)
      RETURNING recommendation.id
    ), discarded_stale_drafts AS (
      UPDATE program_drafts draft
      SET status = 'discarded', discarded_at = now(), updated_at = now()
      WHERE draft.user_id = ${input.userId}::uuid
        AND draft.status = 'open'
        AND EXISTS (SELECT 1 FROM updated_program)
      RETURNING draft.id
    ), program_versions_ledger AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields, source_version_id
      )
      SELECT
        ${input.userId}::uuid, 'program', updated.id,
        'program.publish_version', target.before_data, to_jsonb(updated),
        ARRAY['name', 'current_version_id']::text[], target.current_version_id
      FROM updated_program updated
      JOIN target_program target ON target.id = updated.id
      UNION ALL
      SELECT
        ${input.userId}::uuid, 'program', created.id,
        'program.activate', '{}'::jsonb, to_jsonb(created),
        ARRAY['name', 'status', 'current_version_id']::text[], NULL::uuid
      FROM new_program created
      CROSS JOIN (SELECT count(*) FROM reconciled_recommendations) recommendation_result
      CROSS JOIN (SELECT count(*) FROM discarded_stale_drafts) draft_result
      RETURNING id
    ), updated_import AS (
      UPDATE import_events
      SET status = 'confirmed',
          result_program_version_id = ${programVersionId}::uuid,
          confirmed_payload = ${JSON.stringify(input.confirmedPayload ?? null)}::jsonb,
          raw_payload = '',
          parsed_payload = NULL,
          raw_redacted_at = now(),
          retention_expires_at = NULL
      WHERE id IN (SELECT id FROM target_import)
        AND EXISTS (SELECT 1 FROM activated_program)
      RETURNING id
    ), updated_ai_events AS (
      UPDATE ai_parsing_events
      SET confirmed = true,
          confirmed_payload = ${JSON.stringify(input.confirmedPayload ?? null)}::jsonb,
          raw_input = '',
          raw_output = NULL,
          parsed_json = NULL,
          ambiguities = '[]'::jsonb,
          raw_redacted_at = now(),
          retention_expires_at = NULL
      WHERE id IN (SELECT id FROM valid_ai_events)
        AND EXISTS (SELECT 1 FROM activated_program)
      RETURNING id
    ), updated_profile AS (
      UPDATE user_profiles
      SET setup_completed_at = now(),
          setup_state = jsonb_set(
            setup_state,
            '{completedSteps}',
            (
              SELECT COALESCE(jsonb_agg(value ORDER BY first_seen), '[]'::jsonb)
              FROM (
                SELECT value, min(ordinality) AS first_seen
                FROM jsonb_array_elements_text(
                  COALESCE(setup_state->'completedSteps', '[]'::jsonb) || '"review"'::jsonb
                ) WITH ORDINALITY AS steps(value, ordinality)
                GROUP BY value
              ) unique_steps
            ),
            true
          ),
          updated_at = now()
      WHERE id IN (SELECT id FROM activation_gate)
        AND ${completeSetup}::boolean
        AND EXISTS (SELECT 1 FROM activated_program)
      RETURNING id
    ), inserted_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        CASE WHEN
          (SELECT count(*) FROM program_versions_ledger) = 1
          AND (SELECT count(*) FROM updated_import) = ${importEventId ? 1 : 0}::int
          AND (SELECT count(*) FROM updated_ai_events) = ${aiEventIds.length}::int
          AND (SELECT count(*) FROM updated_profile) = ${completeSetup ? 1 : 0}::int
          THEN ${input.userId}::uuid ELSE NULL::uuid END,
        'user',
        ${input.auditAction},
        'program_version',
        new_version.id::text,
        ${input.auditSummary},
        jsonb_build_object(
          'programId', activated_program.id,
          'importEventId', ${importEventId}::text,
          'replacedPrograms', 0,
          'programVersionIds', (SELECT jsonb_agg(id) FROM program_versions_ledger)
        )
      FROM new_version
      JOIN activated_program ON activated_program.id = new_version.program_id
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM activation_gate) AS gates,
      (SELECT id::text FROM activated_program) AS program_id,
      (SELECT id::text FROM new_version) AS version_id,
      0::int AS archived_programs,
      (SELECT count(*)::int FROM inserted_templates) AS templates,
      (SELECT count(*)::int FROM inserted_groups) AS groups,
      (SELECT count(*)::int FROM inserted_slots) AS slots,
      (SELECT count(*)::int FROM inserted_prescriptions) AS prescriptions,
      (SELECT count(*)::int FROM updated_import) AS imports,
      (SELECT count(*)::int FROM updated_ai_events) AS ai_events,
      (SELECT count(*)::int FROM updated_profile) AS profiles,
      (SELECT count(*)::int FROM inserted_audit) AS audits
  `;
  const row = resultRows(await db.execute(query))[0];
  const expectedImportUpdates = importEventId ? 1 : 0;
  const expectedProfileUpdates = completeSetup ? 1 : 0;
  if (
    !row ||
    Number(row.gates) !== 1 ||
    !row.program_id ||
    !row.version_id ||
    Number(row.templates) !== templates.length ||
    Number(row.groups) !== groups.length ||
    Number(row.slots) !== slots.length ||
    Number(row.prescriptions) !== prescriptions.length ||
    Number(row.imports) !== expectedImportUpdates ||
    Number(row.ai_events) !== aiEventIds.length ||
    Number(row.profiles) !== expectedProfileUpdates ||
    Number(row.audits) !== 1
  ) {
    return {
      ok: false,
      reason: importEventId
        ? "This routine import was already confirmed or is no longer current."
        : "The setup routine changed before activation. Review it and try again.",
    };
  }
  return {
    ok: true,
    programId: String(row.program_id),
    programVersionId: String(row.version_id),
    replacedPrograms: Number(row.archived_programs),
  };
}
