import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { dataSnapshots, programDrafts, recoveryRuns, sessionCompilerProposals } from "@/db/schema";
import { canonicalizeProgramDraftIdentity } from "@/services/program-document-integrity";
import { sessionCompilerInputSchema, sessionCompilerOutputSchema } from "@/lib/session-compiler";
import { programPreflightResultSchema } from "@/lib/program-preflight";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import {
  readVerifiedDataSnapshot,
  type SnapshotDependencies,
} from "@/services/snapshots";

export type RecoveryRunKind =
  | "database_backup"
  | "restore_drill"
  | "snapshot_integrity"
  | "application_integrity";

export type RecoveryRunStatus = "passed" | "warning" | "failed";

export type IntegrityFinding = {
  checkKey: string;
  severity: "warning" | "error";
  entityType: string | null;
  entityId: string | null;
  message: string;
  details: Record<string, unknown>;
};

export type RecoveryRunInput = {
  kind: RecoveryRunKind;
  status: RecoveryRunStatus;
  provider?: string | null;
  sourceRef?: string | null;
  summary: string;
  details?: Record<string, unknown>;
  findings?: IntegrityFinding[];
  startedAt: Date;
  completedAt: Date;
};

function normalizeFinding(row: Record<string, unknown>): IntegrityFinding {
  return {
    checkKey: String(row.check_key),
    severity: row.severity === "error" ? "error" : "warning",
    entityType: row.entity_type == null ? null : String(row.entity_type),
    entityId: row.entity_id == null ? null : String(row.entity_id),
    message: String(row.message),
    details:
      row.details && typeof row.details === "object"
        ? (row.details as Record<string, unknown>)
        : {},
  };
}

export async function evaluateApplicationIntegrity(
  db: Db,
  userId: string
): Promise<IntegrityFinding[]> {
  const query = sql`
    WITH user_sessions AS (
      SELECT * FROM workout_sessions WHERE user_id = ${userId}::uuid
    ), user_session_exercises AS (
      SELECT se.* FROM session_exercises se
      JOIN user_sessions ws ON ws.id = se.session_id
    ), user_sets AS (
      SELECT cs.* FROM completed_sets cs
      JOIN user_session_exercises se ON se.id = cs.session_exercise_id
    ), user_session_groups AS (
      SELECT grp.* FROM session_exercise_groups grp
      JOIN user_sessions ws ON ws.id = grp.session_id
    ), user_occurrences AS (
      SELECT occurrence.* FROM session_occurrences occurrence
      JOIN user_sessions ws ON ws.id = occurrence.session_id
    ), user_occurrence_receipts AS (
      SELECT receipt.* FROM session_occurrence_mutations receipt
      JOIN user_occurrences occurrence ON occurrence.id = receipt.occurrence_id
    ), user_programs AS (
      SELECT * FROM programs WHERE user_id = ${userId}::uuid
    ), user_program_versions AS (
      SELECT pv.* FROM program_versions pv
      JOIN user_programs p ON p.id = pv.program_id
    ), user_program_schedules AS (
      SELECT * FROM program_schedules WHERE user_id = ${userId}::uuid
    ), user_program_schedule_versions AS (
      SELECT * FROM program_schedule_versions WHERE user_id = ${userId}::uuid
    ), user_scheduled_program_events AS (
      SELECT * FROM scheduled_program_events WHERE user_id = ${userId}::uuid
    ), user_templates AS (
      SELECT wt.* FROM workout_templates wt
      JOIN user_program_versions pv ON pv.id = wt.program_version_id
    ), user_program_drafts AS (
      SELECT draft.* FROM program_drafts draft
      WHERE draft.user_id = ${userId}::uuid
    ), user_compiler_proposals AS (
      SELECT * FROM session_compiler_proposals
      WHERE user_id = ${userId}::uuid
    ), user_template_exercises AS (
      SELECT wte.* FROM workout_template_exercises wte
      JOIN user_templates wt ON wt.id = wte.workout_template_id
    ), user_contextual_notes AS (
      SELECT * FROM contextual_notes WHERE user_id = ${userId}::uuid
    ), findings AS (
      SELECT
        'session_exercise.exercise'::text AS check_key,
        'error'::text AS severity,
        'session_exercise'::text AS entity_type,
        se.id::text AS entity_id,
        'A workout exercise points to an unavailable exercise.'::text AS message,
        jsonb_build_object('exerciseId', se.exercise_id) AS details
      FROM user_session_exercises se
      LEFT JOIN exercises e ON e.id = se.exercise_id
      WHERE e.id IS NULL OR (e.user_id IS NOT NULL AND e.user_id <> ${userId}::uuid)

      UNION ALL
      SELECT 'workout_session.start_request_identity', 'error', 'workout_session', ws.id::text,
        'A workout has incomplete, malformed, or reused Start request identity.',
        jsonb_build_object(
          'startRequestKey', ws.start_request_key,
          'startRequestHash', ws.start_request_hash
        )
      FROM user_sessions ws
      WHERE (ws.start_request_key IS NULL) <> (ws.start_request_hash IS NULL)
        OR (ws.start_request_key IS NOT NULL AND (
          ws.start_request_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR ws.start_request_hash !~ '^[0-9a-f]{64}$'
          OR EXISTS (
            SELECT 1 FROM user_sessions duplicate
            WHERE duplicate.start_request_key = ws.start_request_key
              AND duplicate.id <> ws.id
          )
        ))

      UNION ALL
      SELECT 'session_exercise.prescribed_semantics', 'error', 'session_exercise', se.id::text,
        'A workout exercise has incomplete or invalid prescribed meaning.',
        jsonb_build_object(
          'version', se.prescribed_semantics_version,
          'name', se.prescribed_exercise_name,
          'metricType', se.prescribed_metric_type,
          'loadType', se.prescribed_load_type,
          'loadSemantics', se.prescribed_load_semantics
        )
      FROM user_session_exercises se
      WHERE num_nonnulls(
          se.prescribed_semantics_version,
          se.prescribed_exercise_name,
          se.prescribed_metric_type,
          se.prescribed_load_type,
          se.prescribed_load_semantics
        ) NOT IN (0, 5)
        OR (se.prescribed_semantics_version IS NOT NULL AND (
          se.prescribed_semantics_version <> 1
          OR length(btrim(se.prescribed_exercise_name)) NOT BETWEEN 1 AND 300
          OR length(btrim(se.prescribed_load_type)) NOT BETWEEN 1 AND 50
        ))

      UNION ALL
      SELECT 'session_exercise.substitution', 'error', 'session_exercise', se.id::text,
        'A workout substitution points to an unavailable original exercise.',
        jsonb_build_object('exerciseId', se.substituted_for_exercise_id)
      FROM user_session_exercises se
      LEFT JOIN exercises e ON e.id = se.substituted_for_exercise_id
      WHERE se.substituted_for_exercise_id IS NOT NULL
        AND (e.id IS NULL OR (e.user_id IS NOT NULL AND e.user_id <> ${userId}::uuid))

      UNION ALL
      SELECT 'session_exercise.substitution_metadata', 'error', 'session_exercise', se.id::text,
        'A workout alternative has incomplete reason or timing evidence.',
        jsonb_build_object(
          'originalExerciseId', se.substituted_for_exercise_id,
          'reason', se.substitution_reason,
          'substitutedAt', se.substituted_at
        )
      FROM user_session_exercises se
      WHERE (
          se.substituted_for_exercise_id IS NULL
          AND (se.substitution_reason IS NOT NULL OR se.substituted_at IS NOT NULL)
        ) OR (
          se.substituted_for_exercise_id IS NOT NULL
          AND (se.substitution_reason IS NULL OR se.substituted_at IS NULL)
        )

      UNION ALL
      SELECT 'completed_set.values', 'error', 'completed_set', cs.id::text,
        'A logged set contains an invalid set number or measurement.',
        jsonb_build_object(
          'setNo', cs.set_no, 'weight', cs.weight, 'reps', cs.reps,
          'rpe', cs.rpe, 'rir', cs.rir,
          'techniqueIssue', cs.technique_issue,
          'limitationCause', cs.limitation_cause,
          'distanceKm', cs.distance_km,
          'durationSeconds', cs.duration_seconds
        )
      FROM user_sets cs
      WHERE cs.set_no <= 0
        OR cs.weight < 0
        OR cs.reps < 0
        OR cs.rpe < 0 OR cs.rpe > 10
        OR cs.rir < 0 OR cs.rir > 10
        OR (cs.rir IS NOT NULL AND cs.rpe IS NOT NULL)
        OR cs.technique_issue NOT IN (
          'bracing', 'range_of_motion', 'control', 'balance', 'positioning',
          'tempo', 'other'
        )
        OR cs.limitation_cause NOT IN (
          'strength_fatigue', 'breathing_conditioning', 'grip', 'mobility',
          'pain', 'technique', 'equipment_setup', 'time', 'other'
        )
        OR cs.distance_km < 0
        OR cs.duration_seconds < 0

      UNION ALL
      SELECT 'session_exercise.group', 'error', 'session_exercise', se.id::text,
        'A workout exercise points to a group outside its workout or has invalid member order.',
        jsonb_build_object(
          'sessionId', se.session_id,
          'groupSnapshotId', se.group_snapshot_id,
          'groupMemberOrderIdx', se.group_member_order_idx
        )
      FROM user_session_exercises se
      LEFT JOIN user_session_groups grp ON grp.id = se.group_snapshot_id
      WHERE (se.group_snapshot_id IS NULL) <> (se.group_member_order_idx IS NULL)
        OR (se.group_snapshot_id IS NOT NULL
          AND (grp.id IS NULL OR grp.session_id <> se.session_id))

      UNION ALL
      SELECT 'session_group.members', 'error', 'session_exercise_group', grp.id::text,
        'A workout group member count or member order does not match its immutable snapshot.',
        jsonb_build_object(
          'declaredMemberCount', grp.member_count,
          'actualMemberCount', members.actual_count,
          'orderedMemberCount', members.ordered_count
        )
      FROM user_session_groups grp
      CROSS JOIN LATERAL (
        SELECT
          count(*)::integer AS actual_count,
          count(DISTINCT se.group_member_order_idx)::integer AS ordered_count,
          coalesce(min(se.group_member_order_idx), 0)::integer AS minimum_order,
          coalesce(max(se.group_member_order_idx), -1)::integer AS maximum_order
        FROM user_session_exercises se
        WHERE se.group_snapshot_id = grp.id
      ) members
      WHERE members.actual_count <> grp.member_count
        OR members.ordered_count <> members.actual_count
        OR (members.actual_count > 0 AND (
          members.minimum_order <> 0
          OR members.maximum_order <> members.actual_count - 1
        ))

      UNION ALL
      SELECT 'session_occurrence.exercise', 'error', 'session_occurrence', occurrence.id::text,
        'A workout occurrence points to an exercise outside its workout.',
        jsonb_build_object(
          'sessionId', occurrence.session_id,
          'sessionExerciseId', occurrence.session_exercise_id
        )
      FROM user_occurrences occurrence
      LEFT JOIN user_session_exercises se ON se.id = occurrence.session_exercise_id
      WHERE occurrence.session_exercise_id IS NOT NULL
        AND (se.id IS NULL OR se.session_id <> occurrence.session_id)

      UNION ALL
      SELECT 'session_occurrence.group', 'error', 'session_occurrence', occurrence.id::text,
        'A grouped workout occurrence has inconsistent group coordinates.',
        jsonb_build_object(
          'groupSnapshotId', occurrence.group_snapshot_id,
          'groupRound', occurrence.group_round,
          'groupMemberOrderIdx', occurrence.group_member_order_idx
        )
      FROM user_occurrences occurrence
      LEFT JOIN user_session_groups grp ON grp.id = occurrence.group_snapshot_id
      WHERE (
          occurrence.group_snapshot_id IS NULL
          AND (occurrence.group_round IS NOT NULL OR occurrence.group_member_order_idx IS NOT NULL)
        ) OR (
          occurrence.group_snapshot_id IS NOT NULL
          AND (
            grp.id IS NULL OR grp.session_id <> occurrence.session_id
            OR occurrence.group_round IS NULL
            OR occurrence.group_member_order_idx IS NULL
            OR occurrence.group_member_order_idx < 0
            OR occurrence.group_member_order_idx >= grp.member_count
            OR (grp.planned_rounds IS NOT NULL AND occurrence.group_round > grp.planned_rounds)
          )
        )

      UNION ALL
      SELECT 'session_occurrence.sequence', 'error', 'session_occurrence', ordered.id::text,
        'A workout occurrence is out of sequence or has an invalid kind-local ordinal.',
        jsonb_build_object(
          'sequenceIdx', ordered.sequence_idx,
          'expectedSequenceIdx', ordered.expected_sequence,
          'kindOrdinal', ordered.kind_ordinal,
          'expectedKindOrdinal', ordered.expected_kind_ordinal
        )
      FROM (
        SELECT occurrence.*,
          row_number() OVER (
            PARTITION BY occurrence.session_id
            ORDER BY occurrence.sequence_idx, occurrence.id
          )::integer - 1 AS expected_sequence,
          row_number() OVER (
            PARTITION BY occurrence.session_id, occurrence.kind,
              occurrence.session_exercise_id
            ORDER BY occurrence.kind_ordinal, occurrence.sequence_idx, occurrence.id
          )::integer - 1 AS expected_kind_ordinal
        FROM user_occurrences occurrence
      ) ordered
      WHERE ordered.sequence_idx <> ordered.expected_sequence
        OR ordered.kind_ordinal <> ordered.expected_kind_ordinal

      UNION ALL
      SELECT 'session_occurrence.outcome', 'error', 'session_occurrence', occurrence.id::text,
        'A workout occurrence outcome does not match its performed result.',
        jsonb_build_object(
          'kind', occurrence.kind,
          'outcome', occurrence.outcome,
          'completedSetId', occurrence.completed_set_id,
          'completedSetExerciseId', result.session_exercise_id
        )
      FROM user_occurrences occurrence
      LEFT JOIN user_sets result ON result.id = occurrence.completed_set_id
      WHERE (
          occurrence.outcome = 'completed'
          AND occurrence.kind = 'working_set'
          AND (
            result.id IS NULL
            OR result.session_exercise_id <> occurrence.session_exercise_id
          )
        ) OR (
          (occurrence.outcome <> 'completed' OR occurrence.kind <> 'working_set')
          AND occurrence.completed_set_id IS NOT NULL
        )

      UNION ALL
      SELECT 'session_occurrence.receipt', 'error', 'session_occurrence_mutation', receipt.id::text,
        'A workout occurrence receipt has an impossible revision result.',
        jsonb_build_object(
          'occurrenceId', receipt.occurrence_id,
          'expectedRevision', receipt.expected_revision,
          'resultingRevision', receipt.resulting_revision,
          'occurrenceRevision', occurrence.revision
        )
      FROM user_occurrence_receipts receipt
      JOIN user_occurrences occurrence ON occurrence.id = receipt.occurrence_id
      WHERE receipt.resulting_revision <> receipt.expected_revision + 1
        OR receipt.resulting_revision > occurrence.revision

      UNION ALL
      SELECT 'workout_session.time_order', 'error', 'workout_session', ws.id::text,
        'A workout finishes before it starts.',
        jsonb_build_object('startedAt', ws.started_at, 'finishedAt', ws.finished_at)
      FROM user_sessions ws
      WHERE ws.finished_at IS NOT NULL AND ws.finished_at < ws.started_at

      UNION ALL
      SELECT 'pain_log.session', 'error', 'pain_log', p.id::text,
        'A pain record points to a missing or different owner workout.',
        jsonb_build_object('sessionId', p.session_id)
      FROM pain_logs p
      LEFT JOIN workout_sessions ws ON ws.id = p.session_id
      WHERE p.user_id = ${userId}::uuid
        AND p.session_id IS NOT NULL
        AND (ws.id IS NULL OR ws.user_id <> ${userId}::uuid)

      UNION ALL
      SELECT 'pain_log.completed_set', 'error', 'pain_log', p.id::text,
        'A pain record points to a missing set.',
        jsonb_build_object('completedSetId', p.completed_set_id)
      FROM pain_logs p
      LEFT JOIN user_sets cs ON cs.id = p.completed_set_id
      WHERE p.user_id = ${userId}::uuid
        AND p.completed_set_id IS NOT NULL
        AND cs.id IS NULL

      UNION ALL
      SELECT 'pain_log.completed_set_context', 'error', 'pain_log', p.id::text,
        'A set-linked pain record contradicts its completed set context.',
        jsonb_build_object(
          'completedSetId', p.completed_set_id,
          'sessionId', p.session_id,
          'exerciseId', p.exercise_id
        )
      FROM pain_logs p
      JOIN user_sets cs ON cs.id = p.completed_set_id
      JOIN user_session_exercises se ON se.id = cs.session_exercise_id
      WHERE p.user_id = ${userId}::uuid
        AND (
          p.session_id IS DISTINCT FROM se.session_id
          OR p.exercise_id IS DISTINCT FROM se.exercise_id
          OR p.body_part NOT IN (
            'shoulder', 'knee', 'back', 'elbow', 'wrist', 'hip', 'other'
          )
          OR p.severity NOT BETWEEN 1 AND 10
          OR p.source NOT IN ('set_flag', 'set_exception')
          OR length(coalesce(p.note, '')) > 500
        )

      UNION ALL
      SELECT 'pain_log.completed_set_unique', 'error', 'completed_set', p.completed_set_id::text,
        'A completed set has more than one active pain record.',
        jsonb_build_object(
          'completedSetId', p.completed_set_id,
          'activeCount', count(*)
        )
      FROM pain_logs p
      WHERE p.user_id = ${userId}::uuid
        AND p.completed_set_id IS NOT NULL
        AND p.archived_at IS NULL
      GROUP BY p.completed_set_id
      HAVING count(*) > 1

      UNION ALL
      SELECT 'pain_log.severity', 'error', 'pain_log', p.id::text,
        'A pain severity is outside the supported 0–10 range.',
        jsonb_build_object('severity', p.severity)
      FROM pain_logs p
      WHERE p.user_id = ${userId}::uuid AND (p.severity < 0 OR p.severity > 10)

      UNION ALL
      SELECT 'fatigue_log.session', 'error', 'fatigue_log', f.id::text,
        'A fatigue record points to a missing or different owner workout.',
        jsonb_build_object('sessionId', f.session_id)
      FROM fatigue_logs f
      LEFT JOIN workout_sessions ws ON ws.id = f.session_id
      WHERE f.user_id = ${userId}::uuid
        AND f.session_id IS NOT NULL
        AND (ws.id IS NULL OR ws.user_id <> ${userId}::uuid)

      UNION ALL
      SELECT 'fatigue_log.severity', 'error', 'fatigue_log', f.id::text,
        'A fatigue severity is outside the supported 1–5 range.',
        jsonb_build_object('severity', f.severity)
      FROM fatigue_logs f
      WHERE f.user_id = ${userId}::uuid AND (f.severity < 1 OR f.severity > 5)

      UNION ALL
      SELECT 'contextual_note.workout_attachment', 'error', 'contextual_note', note.id::text,
        'A contextual note points across workout attachment boundaries.',
        jsonb_build_object(
          'sessionId', note.session_id,
          'sessionExerciseId', note.session_exercise_id,
          'occurrenceId', note.occurrence_id,
          'completedSetId', note.completed_set_id
        )
      FROM user_contextual_notes note
      LEFT JOIN user_sessions session ON session.id = note.session_id
      LEFT JOIN user_session_exercises session_exercise ON session_exercise.id = note.session_exercise_id
      LEFT JOIN user_occurrences occurrence ON occurrence.id = note.occurrence_id
      LEFT JOIN user_sets completed_set ON completed_set.id = note.completed_set_id
      LEFT JOIN user_session_exercises set_exercise ON set_exercise.id = completed_set.session_exercise_id
      WHERE (note.session_id IS NOT NULL AND session.id IS NULL)
        OR (note.session_exercise_id IS NOT NULL AND (
          session_exercise.id IS NULL OR session_exercise.session_id <> note.session_id
        ))
        OR (note.occurrence_id IS NOT NULL AND (
          occurrence.id IS NULL OR occurrence.session_id <> note.session_id
          OR (note.session_exercise_id IS NOT NULL
            AND occurrence.session_exercise_id IS DISTINCT FROM note.session_exercise_id)
        ))
        OR (note.completed_set_id IS NOT NULL AND (
          completed_set.id IS NULL OR set_exercise.session_id <> note.session_id
          OR (note.session_exercise_id IS NOT NULL
            AND completed_set.session_exercise_id <> note.session_exercise_id)
        ))

      UNION ALL
      SELECT 'contextual_note.program_attachment', 'error', 'contextual_note', note.id::text,
        'A contextual note points across Program attachment boundaries.',
        jsonb_build_object(
          'programId', note.program_id,
          'programVersionId', note.program_version_id,
          'workoutTemplateId', note.workout_template_id,
          'workoutTemplateExerciseId', note.workout_template_exercise_id
        )
      FROM user_contextual_notes note
      LEFT JOIN user_programs program ON program.id = note.program_id
      LEFT JOIN user_program_versions version ON version.id = note.program_version_id
      LEFT JOIN user_templates template ON template.id = note.workout_template_id
      LEFT JOIN user_template_exercises item ON item.id = note.workout_template_exercise_id
      WHERE (note.program_id IS NOT NULL AND program.id IS NULL)
        OR (note.program_version_id IS NOT NULL AND (
          version.id IS NULL OR version.program_id IS DISTINCT FROM note.program_id
        ))
        OR (note.workout_template_id IS NOT NULL AND (
          template.id IS NULL OR template.program_version_id IS DISTINCT FROM note.program_version_id
        ))
        OR (note.workout_template_exercise_id IS NOT NULL AND (
          item.id IS NULL OR item.workout_template_id IS DISTINCT FROM note.workout_template_id
        ))

      UNION ALL
      SELECT 'contextual_note.revisions', 'error', 'contextual_note', note.id::text,
        'A contextual note has an incomplete or mismatched revision history.',
        jsonb_build_object(
          'revision', note.revision,
          'storedRevisionCount', revisions.revision_count,
          'maximumRevision', revisions.maximum_revision
        )
      FROM user_contextual_notes note
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS revision_count,
          max(revision.revision)::int AS maximum_revision,
          count(DISTINCT revision.revision)::int AS distinct_revisions,
          (array_agg(revision.body ORDER BY revision.revision DESC))[1] AS latest_body,
          (array_agg(revision.coach_visible ORDER BY revision.revision DESC))[1] AS latest_coach_visible,
          (array_agg(revision.input_mode ORDER BY revision.revision DESC))[1] AS latest_input_mode
        FROM contextual_note_revisions revision
        WHERE revision.note_id = note.id AND revision.user_id = note.user_id
      ) revisions ON true
      WHERE revisions.revision_count <> note.revision
        OR revisions.maximum_revision <> note.revision
        OR revisions.distinct_revisions <> note.revision
        OR revisions.latest_body IS DISTINCT FROM note.body
        OR revisions.latest_coach_visible IS DISTINCT FROM note.coach_visible
        OR revisions.latest_input_mode IS DISTINCT FROM note.input_mode

      UNION ALL
      SELECT 'live_coach.session', 'error', 'coaching_insight', ci.id::text,
        'A Live Coach message points to a missing or different owner workout.',
        jsonb_build_object('sessionId', ci.session_id)
      FROM coaching_insights ci
      LEFT JOIN workout_sessions ws ON ws.id = ci.session_id
      WHERE ci.user_id = ${userId}::uuid
        AND ci.kind IN ('live_user', 'live_assistant')
        AND (ci.session_id IS NULL OR ws.id IS NULL OR ws.user_id <> ${userId}::uuid)

      UNION ALL
      SELECT 'live_coach.exercise', 'error', 'coaching_insight', ci.id::text,
        'A Live Coach message points to an exercise outside its workout.',
        jsonb_build_object(
          'sessionId', ci.session_id,
          'sessionExerciseId', ci.session_exercise_id
        )
      FROM coaching_insights ci
      LEFT JOIN session_exercises se ON se.id = ci.session_exercise_id
      WHERE ci.user_id = ${userId}::uuid
        AND ci.kind IN ('live_user', 'live_assistant')
        AND ci.session_exercise_id IS NOT NULL
        AND (se.id IS NULL OR se.session_id <> ci.session_id)

      UNION ALL
      SELECT 'live_coach.reply', 'error', 'coaching_insight', ci.id::text,
        'A Live Coach response does not point to a saved question in the same workout.',
        jsonb_build_object('replyToId', ci.reply_to_id)
      FROM coaching_insights ci
      LEFT JOIN coaching_insights parent ON parent.id = ci.reply_to_id
      WHERE ci.user_id = ${userId}::uuid
        AND ci.kind = 'live_assistant'
        AND (
          ci.reply_to_id IS NULL
          OR parent.id IS NULL
          OR parent.user_id <> ci.user_id
          OR parent.session_id <> ci.session_id
          OR parent.kind <> 'live_user'
          OR parent.message_kind <> 'question'
        )

      UNION ALL
      SELECT 'live_coach.fields', 'error', 'coaching_insight', ci.id::text,
        'A Live Coach message is missing required conversation fields.',
        jsonb_build_object(
          'kind', ci.kind,
          'author', ci.author,
          'messageKind', ci.message_kind,
          'inputMode', ci.input_mode,
          'responseStatus', ci.response_status
        )
      FROM coaching_insights ci
      WHERE ci.user_id = ${userId}::uuid
        AND ci.kind IN ('live_user', 'live_assistant')
        AND (
          ci.author IS NULL OR ci.message_kind IS NULL OR ci.input_mode IS NULL
          OR ci.response_status IS NULL
          OR (ci.kind = 'live_user' AND length(trim(ci.content_md)) = 0)
          OR (ci.kind = 'live_assistant' AND ci.response_status = 'completed' AND length(trim(ci.content_md)) = 0)
        )

      UNION ALL
      SELECT 'quick_log.result_session', 'error', 'ai_parsing_event', event.id::text,
        'A confirmed quick log points to a missing or different owner workout.',
        jsonb_build_object('sessionId', event.result_session_id)
      FROM ai_parsing_events event
      LEFT JOIN workout_sessions session ON session.id = event.result_session_id
      LEFT JOIN workout_sessions recoverable_session
        ON event.result_session_id IS NULL
       AND event.confirmed_payload->>'sessionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND recoverable_session.id = (event.confirmed_payload->>'sessionId')::uuid
      WHERE event.user_id = ${userId}::uuid
        AND event.scope = 'log'
        AND event.confirmed = true
        AND (
          (event.result_session_id IS NULL
            AND recoverable_session.user_id = event.user_id)
          OR (event.result_session_id IS NOT NULL AND session.id IS NULL)
          OR session.user_id <> event.user_id
        )

      UNION ALL
      SELECT 'live_coach.pending', 'warning', 'coaching_insight', ci.id::text,
        'A Live Coach response has remained pending and can be retried.',
        jsonb_build_object('createdAt', ci.created_at, 'replyToId', ci.reply_to_id)
      FROM coaching_insights ci
      WHERE ci.user_id = ${userId}::uuid
        AND ci.kind = 'live_assistant'
        AND ci.response_status = 'pending'
        AND ci.created_at < now() - interval '10 minutes'

      UNION ALL
      SELECT 'workout.history_identity', 'error', 'workout_session', session.id::text,
        'A workout has invalid History revision, time precision, or partial source lineage.',
        jsonb_build_object(
          'historyRevision', session.history_revision,
          'performedTimePrecision', session.performed_time_precision,
          'sourceProgramId', session.source_program_id,
          'sourceProgramVersionId', session.source_program_version_id,
          'sourceDayLineageId', session.source_day_lineage_id
        )
      FROM workout_sessions session
      WHERE session.user_id = ${userId}::uuid
        AND (
          session.history_revision < 0
          OR session.performed_time_precision NOT IN ('instant', 'date_only')
          OR num_nonnulls(
            session.source_program_id,
            session.source_program_version_id,
            session.source_day_lineage_id
          ) NOT IN (0, 3)
        )

      UNION ALL
      SELECT 'completed_set.observed_completion', 'error', 'completed_set', completed.id::text,
        'A completed set has incoherent observed-completion provenance or quality.',
        jsonb_build_object(
          'observedCompletedAt', completed.observed_completed_at,
          'provenance', completed.observed_completion_provenance,
          'quality', completed.observed_completion_quality,
          'loggedAt', completed.logged_at
        )
      FROM completed_sets completed
      JOIN session_exercises exercise ON exercise.id = completed.session_exercise_id
      JOIN workout_sessions session ON session.id = exercise.session_id
      WHERE session.user_id = ${userId}::uuid
        AND NOT (
          (completed.observed_completed_at IS NULL
            AND completed.observed_completion_provenance = 'unknown'
            AND completed.observed_completion_quality = 'unknown')
          OR (completed.observed_completed_at IS NOT NULL
            AND completed.observed_completion_provenance = 'live_client'
            AND completed.observed_completion_quality = 'trustworthy')
          OR (completed.observed_completed_at IS NOT NULL
            AND completed.observed_completion_provenance = 'import_source'
            AND completed.observed_completion_quality = 'trustworthy')
          OR (completed.observed_completed_at IS NOT NULL
            AND completed.observed_completion_provenance = 'manual_explicit'
            AND completed.observed_completion_quality = 'owner_reported')
        )

      UNION ALL
      SELECT 'workout.source_lineage', 'error', 'workout_session', session.id::text,
        'A workout source lineage contradicts the retained physical Program chain.',
        jsonb_build_object(
          'sourceProgramId', session.source_program_id,
          'sourceProgramVersionId', session.source_program_version_id,
          'sourceDayLineageId', session.source_day_lineage_id,
          'templateId', session.template_id
        )
      FROM workout_sessions session
      LEFT JOIN programs program ON program.id = session.source_program_id
      LEFT JOIN program_versions version
        ON version.id = session.source_program_version_id
      LEFT JOIN workout_templates template ON template.id = session.template_id
      WHERE session.user_id = ${userId}::uuid
        AND session.source_program_id IS NOT NULL
        AND (
          (program.id IS NOT NULL AND program.user_id <> session.user_id)
          OR (version.id IS NOT NULL
            AND version.program_id <> session.source_program_id)
          OR (template.id IS NOT NULL AND (
            template.program_version_id <> session.source_program_version_id
            OR template.lineage_id <> session.source_day_lineage_id
          ))
        )

      UNION ALL
      SELECT 'session_exercise.source_lineage', 'error', 'session_exercise', exercise.id::text,
        'A workout exercise source slot contradicts its retained planned-slot lineage.',
        jsonb_build_object(
          'sourceSlotLineageId', exercise.source_slot_lineage_id,
          'plannedFromTemplateExerciseId', exercise.planned_from_template_exercise_id,
          'sessionId', exercise.session_id
        )
      FROM session_exercises exercise
      JOIN workout_sessions session ON session.id = exercise.session_id
      LEFT JOIN workout_template_exercises planned
        ON planned.id = exercise.planned_from_template_exercise_id
      WHERE session.user_id = ${userId}::uuid
        AND exercise.source_slot_lineage_id IS NOT NULL
        AND planned.id IS NOT NULL
        AND (
          planned.lineage_id <> exercise.source_slot_lineage_id
          OR (
            session.template_id IS NOT NULL
            AND planned.workout_template_id <> session.template_id
          )
        )

      UNION ALL
      SELECT 'workout.history_identity_duplicate', 'error', 'workout_session',
        (array_agg(session.id ORDER BY session.id))[1]::text,
        'More than one manual History workout uses the same retry identity.',
        jsonb_build_object(
          'sourceWorkoutKey', session.source_workout_key,
          'duplicateCount', count(*),
          'sessionIds', jsonb_agg(session.id ORDER BY session.id)
        )
      FROM workout_sessions session
      WHERE session.user_id = ${userId}::uuid
        AND session.source = 'history_manual'
        AND session.source_workout_key IS NOT NULL
      GROUP BY session.user_id, session.source_workout_key
      HAVING count(*) > 1

      UNION ALL
      SELECT 'progression_job.owner', 'error', 'progression_job', job.id::text,
        'A progression job points to a workout owned by a different account.',
        jsonb_build_object('sessionId', job.session_id, 'sessionOwnerId', session.user_id)
      FROM progression_jobs job
      JOIN workout_sessions session ON session.id = job.session_id
      WHERE job.user_id = ${userId}::uuid
        AND session.user_id <> job.user_id

      UNION ALL
      SELECT 'progression_job.stale_source_revision', 'warning', 'progression_job', job.id::text,
        'A queued progression job was superseded by a newer workout revision.',
        jsonb_build_object(
          'sessionId', job.session_id,
          'jobRevision', job.source_session_revision,
          'currentRevision', session.history_revision,
          'status', job.status
        )
      FROM progression_jobs job
      JOIN workout_sessions session ON session.id = job.session_id
      WHERE job.user_id = ${userId}::uuid
        AND job.status IN ('pending', 'processing')
        AND job.source_session_revision <> session.history_revision

      UNION ALL
      SELECT 'progression_job.stale_input_revision', 'warning', 'progression_job', job.id::text,
        'A queued progression job has superseded historical input evidence.',
        jsonb_build_object(
          'inputSessionId', input.session_id,
          'inputRevision', input.history_revision,
          'currentRevision', session.history_revision,
          'sourceSlotLineageId', input.source_slot_lineage_id
        )
      FROM progression_job_input_sessions input
      JOIN progression_jobs job ON job.id = input.job_id
      JOIN workout_sessions session ON session.id = input.session_id
      WHERE job.user_id = ${userId}::uuid
        AND job.status IN ('pending', 'processing')
        AND (
          input.user_id <> job.user_id
          OR session.user_id <> input.user_id
          OR input.history_revision <> session.history_revision
        )

      UNION ALL
      SELECT 'progression_job.input_membership', 'warning', 'progression_job',
        job.id::text,
        'A processing progression job no longer has the exact current four-session input membership.',
        jsonb_build_object('sessionId', job.session_id)
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND job.status = 'processing'
        AND EXISTS (
          WITH source_lineages AS MATERIALIZED (
            SELECT DISTINCT exercise.source_slot_lineage_id
            FROM session_exercises exercise
            WHERE exercise.session_id = job.session_id
              AND exercise.source_slot_lineage_id IS NOT NULL
              AND exercise.modification_type = 'as_planned'
          ), ranked_inputs AS MATERIALIZED (
            SELECT
              lineage.source_slot_lineage_id,
              session.id AS session_id,
              session.history_revision,
              dense_rank() OVER (
                PARTITION BY lineage.source_slot_lineage_id
                ORDER BY session.started_at DESC, session.id DESC
              ) AS exposure_rank
            FROM source_lineages lineage
            JOIN session_exercises exercise
              ON exercise.source_slot_lineage_id =
                lineage.source_slot_lineage_id
             AND exercise.modification_type = 'as_planned'
            JOIN workout_sessions session
              ON session.id = exercise.session_id
             AND session.user_id = job.user_id
             AND session.status = 'completed'
             AND session.archived_at IS NULL
            WHERE EXISTS (
              SELECT 1
              FROM completed_sets completed
              JOIN session_occurrences occurrence
                ON occurrence.completed_set_id = completed.id
               AND occurrence.session_exercise_id = exercise.id
               AND occurrence.kind = 'working_set'
               AND occurrence.outcome = 'completed'
              WHERE completed.session_exercise_id = exercise.id
                AND completed.archived_at IS NULL
                AND NOT completed.is_warmup
                AND completed.reps IS NOT NULL
            )
          ), current_inputs AS (
            SELECT source_slot_lineage_id, session_id, history_revision
            FROM ranked_inputs WHERE exposure_rank <= 4
          ), captured_inputs AS (
            SELECT source_slot_lineage_id, session_id, history_revision
            FROM progression_job_input_sessions input
            WHERE input.job_id = job.id AND input.user_id = job.user_id
          )
          (SELECT * FROM current_inputs EXCEPT SELECT * FROM captured_inputs)
          UNION ALL
          (SELECT * FROM captured_inputs EXCEPT SELECT * FROM current_inputs)
        )

      UNION ALL
      SELECT 'progression_job.current_revision_missing', 'warning', 'workout_session', session.id::text,
        'A linked completed workout is missing progression work for its current revision.',
        jsonb_build_object(
          'historyRevision', session.history_revision,
          'sourceDayLineageId', session.source_day_lineage_id
        )
      FROM workout_sessions session
      WHERE session.user_id = ${userId}::uuid
        AND session.status = 'completed'
        AND session.archived_at IS NULL
        AND session.source_day_lineage_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM progression_jobs job
          WHERE job.user_id = session.user_id
            AND job.session_id = session.id
            AND job.source_session_revision = session.history_revision
        )

      UNION ALL
      SELECT 'record_version.source_chain', 'error', 'record_version',
        version.id::text,
        'A History record version points outside its owner and entity chain.',
        jsonb_build_object('sourceVersionId', version.source_version_id)
      FROM record_versions version
      LEFT JOIN record_versions source
        ON source.id = version.source_version_id
      WHERE version.user_id = ${userId}::uuid
        AND version.entity_type IN (
          'workout_session',
          'session_exercise',
          'completed_set'
        )
        AND version.source_version_id IS NOT NULL
        AND (
          source.id IS NULL
          OR source.user_id <> version.user_id
          OR source.entity_type <> version.entity_type
          OR source.entity_id <> version.entity_id
        )

      UNION ALL
      SELECT 'record_version.history_chain', 'error', 'record_version',
        chain.id::text,
        'A History record version does not continue the prior immutable after-state.',
        jsonb_build_object('previousVersionId', chain.previous_id)
      FROM (
        SELECT
          version.*,
          lag(version.id) OVER (
            PARTITION BY version.user_id, version.entity_type, version.entity_id
            ORDER BY version.created_at, version.id
          ) AS previous_id,
          lag(version.after_data) OVER (
            PARTITION BY version.user_id, version.entity_type, version.entity_id
            ORDER BY version.created_at, version.id
          ) AS previous_after_data
        FROM record_versions version
        WHERE version.user_id = ${userId}::uuid
          AND version.entity_type IN (
            'workout_session',
            'session_exercise',
            'completed_set'
          )
      ) chain
      WHERE chain.previous_id IS NOT NULL
        AND CASE
          WHEN chain.entity_type = 'completed_set'
            THEN chain.before_data - 'repbook_correction'
          ELSE chain.before_data
        END IS DISTINCT FROM CASE
          WHEN chain.entity_type = 'completed_set'
            THEN chain.previous_after_data - 'repbook_correction'
          ELSE chain.previous_after_data
        END

      UNION ALL
      SELECT 'progression_job.failed', 'error', 'progression_job', job.id::text,
        'A workout progression job exhausted its automatic retries.',
        jsonb_build_object('attempts', job.attempts, 'lastError', job.last_error)
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND job.status = 'failed'

      UNION ALL
      SELECT 'progression_job.state', 'error', 'progression_job', job.id::text,
        'A progression job has an inconsistent completion or lease state.',
        jsonb_build_object(
          'status', job.status,
          'leaseToken', job.lease_token,
          'leasedUntil', job.leased_until,
          'completedAt', job.completed_at
        )
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND (
          (job.status = 'completed' AND job.completed_at IS NULL)
          OR (job.status <> 'completed' AND job.completed_at IS NOT NULL)
          OR (job.status = 'processing' AND job.lease_token IS NULL)
          OR (job.status <> 'processing' AND job.lease_token IS NOT NULL)
        )

      UNION ALL
      SELECT 'progression_job.expired_lease', 'warning', 'progression_job', job.id::text,
        'A progression job worker lease expired and the job can be retried.',
        jsonb_build_object('attempts', job.attempts, 'leasedUntil', job.leased_until)
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND job.status = 'processing'
        AND job.leased_until < now()

      UNION ALL
      SELECT 'progression_job.overdue', 'warning', 'progression_job', job.id::text,
        'A progression job has been ready for more than ten minutes.',
        jsonb_build_object('attempts', job.attempts, 'nextAttemptAt', job.next_attempt_at)
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND job.status = 'pending'
        AND job.next_attempt_at < now() - interval '10 minutes'

      UNION ALL
      SELECT 'recommendation.progression_owner', 'error', 'recommendation', recommendation.id::text,
        'A recommendation points to another account’s progression job.',
        jsonb_build_object('progressionJobId', recommendation.progression_job_id)
      FROM recommendations recommendation
      JOIN progression_jobs job ON job.id = recommendation.progression_job_id
      WHERE recommendation.user_id = ${userId}::uuid
        AND job.user_id <> recommendation.user_id

      UNION ALL
      SELECT 'recommendation.decision_state', 'error', 'recommendation', recommendation.id::text,
        'A recommendation status does not match its durable user decision.',
        jsonb_build_object(
          'status', recommendation.status,
          'decisionCount', decision_summary.decision_count,
          'decisions', decision_summary.decisions
        )
      FROM recommendations recommendation
      CROSS JOIN LATERAL (
        SELECT
          count(*)::integer AS decision_count,
          coalesce(jsonb_agg(decision.decision ORDER BY decision.decided_at, decision.id), '[]'::jsonb) AS decisions,
          count(*) FILTER (WHERE decision.decision = 'approve')::integer AS approvals,
          count(*) FILTER (WHERE decision.decision = 'edit')::integer AS edits,
          count(*) FILTER (WHERE decision.decision = 'reject')::integer AS rejections
        FROM user_decisions decision
        WHERE decision.recommendation_id = recommendation.id
      ) decision_summary
      WHERE recommendation.user_id = ${userId}::uuid
        AND (
          (recommendation.status = 'pending' AND decision_summary.decision_count <> 0)
          OR (recommendation.status = 'approved'
            AND (decision_summary.decision_count <> 1 OR decision_summary.approvals <> 1))
          OR (recommendation.status = 'edited'
            AND (decision_summary.decision_count <> 1 OR decision_summary.edits <> 1))
          OR (recommendation.status = 'rejected'
            AND (decision_summary.decision_count <> 1 OR decision_summary.rejections <> 1))
          OR (recommendation.status = 'expired' AND decision_summary.decision_count <> 0)
        )

      UNION ALL
      SELECT 'recommendation.adaptation_state', 'error', 'recommendation', recommendation.id::text,
        'A recommendation status does not match its durable program adaptation.',
        jsonb_build_object(
          'status', recommendation.status,
          'adaptationCount', adaptation_summary.adaptation_count,
          'adaptationIds', adaptation_summary.adaptation_ids
        )
      FROM recommendations recommendation
      CROSS JOIN LATERAL (
        SELECT
          count(*)::integer AS adaptation_count,
          coalesce(jsonb_agg(adaptation.id ORDER BY adaptation.applied_at, adaptation.id), '[]'::jsonb) AS adaptation_ids
        FROM adaptation_events adaptation
        WHERE adaptation.recommendation_id = recommendation.id
      ) adaptation_summary
      WHERE recommendation.user_id = ${userId}::uuid
        AND (
          (recommendation.status IN ('approved', 'edited')
            AND adaptation_summary.adaptation_count <> 1)
          OR (recommendation.status NOT IN ('approved', 'edited')
            AND adaptation_summary.adaptation_count <> 0)
        )

      UNION ALL
      SELECT 'activity.timezone', 'error', 'health_activity', a.id::text,
        'An activity timezone is not recognized by PostgreSQL.',
        jsonb_build_object('timezone', a.timezone)
      FROM health_activities a
      LEFT JOIN pg_timezone_names tz ON tz.name = a.timezone
      WHERE a.user_id = ${userId}::uuid AND tz.name IS NULL

      UNION ALL
      SELECT
        'durable_identity.' || replace(repair.issue, '.', '_'),
        'error',
        repair.entity_type,
        repair.entity_id,
        'A durable load unit or workout calendar identity needs repair.',
        jsonb_build_object(
          'issue', repair.issue,
          'field', repair.field,
          'currentValue', repair.current_value,
          'evidence', repair.evidence,
          'suggestedValue', repair.suggested_value
        )
      FROM production_data_repair_preview repair
      WHERE repair.user_id = ${userId}::uuid

      UNION ALL
      SELECT 'activity.fingerprint_duplicate', 'warning', 'health_activity', NULL,
        'Multiple activities share the same duplicate-protection fingerprint.',
        jsonb_build_object('fingerprint', fingerprint, 'count', count(*))
      FROM health_activities
      WHERE user_id = ${userId}::uuid
      GROUP BY fingerprint HAVING count(*) > 1

      UNION ALL
      SELECT 'activity.source_duplicate', 'error', 'health_activity', NULL,
        'Multiple activities share the same source record identity.',
        jsonb_build_object('source', source, 'sourceRecordId', source_record_id, 'count', count(*))
      FROM health_activities
      WHERE user_id = ${userId}::uuid AND source_record_id IS NOT NULL
      GROUP BY source, source_record_id HAVING count(*) > 1

      UNION ALL
      SELECT 'workout.source_duplicate', 'warning', 'workout_session', NULL,
        'Multiple workouts share the same source workout identity.',
        jsonb_build_object('source', source, 'sourceWorkoutKey', source_workout_key, 'count', count(*))
      FROM user_sessions
      WHERE source_workout_key IS NOT NULL
      GROUP BY source, source_workout_key HAVING count(*) > 1

      UNION ALL
      SELECT 'program_schedule.current_version', 'error', 'program_schedule', schedule.id::text,
        'A Program schedule does not point to its newest immutable owner version.',
        jsonb_build_object(
          'programId', schedule.program_id,
          'currentVersionId', schedule.current_version_id
        )
      FROM user_program_schedules schedule
      LEFT JOIN user_programs program ON program.id = schedule.program_id
      LEFT JOIN user_program_schedule_versions current_version
        ON current_version.id = schedule.current_version_id
      WHERE program.id IS NULL
        OR program.user_id <> schedule.user_id
        OR current_version.id IS NULL
        OR current_version.schedule_id <> schedule.id
        OR current_version.user_id <> schedule.user_id
        OR current_version.program_id <> schedule.program_id
        OR EXISTS (
          SELECT 1 FROM user_program_schedule_versions newer
          WHERE newer.schedule_id = schedule.id
            AND newer.version_no > current_version.version_no
        )

      UNION ALL
      SELECT 'program_schedule_version.relationships', 'error',
        'program_schedule_version', version.id::text,
        'A Program schedule version crosses an owner, Program, or version-lineage boundary.',
        jsonb_build_object(
          'scheduleId', version.schedule_id,
          'programId', version.program_id,
          'sourceProgramVersionId', version.source_program_version_id,
          'parentVersionId', version.parent_version_id
        )
      FROM user_program_schedule_versions version
      LEFT JOIN user_program_schedules schedule ON schedule.id = version.schedule_id
      LEFT JOIN user_program_versions source_version
        ON source_version.id = version.source_program_version_id
      LEFT JOIN user_program_schedule_versions parent
        ON parent.id = version.parent_version_id
      WHERE schedule.id IS NULL
        OR schedule.user_id <> version.user_id
        OR schedule.program_id <> version.program_id
        OR source_version.id IS NULL
        OR source_version.program_id <> version.program_id
        OR (
          version.parent_version_id IS NOT NULL
          AND (
            parent.id IS NULL
            OR parent.schedule_id <> version.schedule_id
            OR parent.user_id <> version.user_id
            OR parent.program_id <> version.program_id
            OR parent.version_no >= version.version_no
          )
        )

      UNION ALL
      SELECT 'scheduled_program_event.relationships', 'error',
        'scheduled_program_event', event.id::text,
        'A scheduled Program event crosses schedule intent or routine lineage boundaries.',
        jsonb_build_object(
          'scheduleId', event.schedule_id,
          'scheduleVersionId', event.schedule_version_id,
          'sourceProgramVersionId', event.source_program_version_id,
          'routineLineageId', event.routine_lineage_id
        )
      FROM user_scheduled_program_events event
      LEFT JOIN user_program_schedules schedule ON schedule.id = event.schedule_id
      LEFT JOIN user_program_schedule_versions version
        ON version.id = event.schedule_version_id
      LEFT JOIN user_templates routine
        ON routine.program_version_id = event.source_program_version_id
        AND routine.lineage_id = event.routine_lineage_id
      LEFT JOIN pg_timezone_names timezone ON timezone.name = event.timezone
      WHERE schedule.id IS NULL
        OR schedule.user_id <> event.user_id
        OR schedule.program_id <> event.program_id
        OR version.id IS NULL
        OR version.schedule_id <> event.schedule_id
        OR version.user_id <> event.user_id
        OR version.program_id <> event.program_id
        OR version.source_program_version_id <> event.source_program_version_id
        OR timezone.name IS NULL
        OR (event.kind = 'resistance' AND routine.id IS NULL)
        OR (event.kind <> 'resistance' AND event.routine_lineage_id IS NOT NULL)

      UNION ALL
      SELECT 'workout.program_schedule_snapshot', 'error', 'workout_session',
        session.id::text,
        'A workout has incomplete or contradictory self-contained Program schedule evidence.',
        jsonb_build_object('programScheduleSnapshot', session.program_schedule_snapshot)
      FROM user_sessions session
      LEFT JOIN pg_timezone_names snapshot_timezone
        ON snapshot_timezone.name = session.program_schedule_snapshot->>'timezone'
      WHERE session.program_schedule_snapshot IS NOT NULL
        AND (
          jsonb_typeof(session.program_schedule_snapshot) <> 'object'
          OR session.program_schedule_snapshot->>'schemaVersion' <> '1'
          OR NOT (session.program_schedule_snapshot ? 'scheduledProgramEventId')
          OR NOT (session.program_schedule_snapshot ? 'programScheduleId')
          OR NOT (session.program_schedule_snapshot ? 'programScheduleVersionId')
          OR NOT (session.program_schedule_snapshot ? 'programScheduleVersionHash')
          OR NOT (session.program_schedule_snapshot ? 'scheduleSourceProgramVersionId')
          OR NOT (session.program_schedule_snapshot ? 'resolvedProgramVersionId')
          OR NOT (session.program_schedule_snapshot ? 'sourcePhaseId')
          OR NOT (session.program_schedule_snapshot ? 'sourcePhaseName')
          OR NOT (session.program_schedule_snapshot ? 'scheduleKind')
          OR NOT (session.program_schedule_snapshot ? 'eventKind')
          OR NOT (session.program_schedule_snapshot ? 'sourceEventId')
          OR NOT (session.program_schedule_snapshot ? 'eventRevision')
          OR NOT (session.program_schedule_snapshot ? 'originalLocalDate')
          OR NOT (session.program_schedule_snapshot ? 'currentLocalDate')
          OR NOT (session.program_schedule_snapshot ? 'timezone')
          OR NOT (session.program_schedule_snapshot ? 'nominalProgramWeek')
          OR NOT (session.program_schedule_snapshot ? 'cyclePosition')
          OR NOT (session.program_schedule_snapshot ? 'routineLineageId')
          OR session.program_schedule_snapshot->>'programScheduleVersionHash'
            !~ '^[0-9a-f]{64}$'
          OR session.program_schedule_snapshot->>'scheduleSourceProgramVersionId'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR session.program_schedule_snapshot->>'resolvedProgramVersionId'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR length(btrim(session.program_schedule_snapshot->>'sourcePhaseName')) = 0
          OR session.program_schedule_snapshot->>'eventRevision' !~ '^\d+$'
          OR session.program_schedule_snapshot->>'nominalProgramWeek' !~ '^[1-9]\d*$'
          OR session.program_schedule_snapshot->>'cyclePosition' !~ '^[1-9]\d*$'
          OR session.program_schedule_snapshot->>'originalLocalDate'
            !~ '^\d{4}-\d{2}-\d{2}$'
          OR session.program_schedule_snapshot->>'currentLocalDate'
            !~ '^\d{4}-\d{2}-\d{2}$'
          OR snapshot_timezone.name IS NULL
          OR session.program_schedule_snapshot->>'scheduleKind'
            NOT IN ('fixed_7_day', 'rolling')
          OR session.program_schedule_snapshot->>'eventKind' <> 'resistance'
          OR (
            session.source_program_version_id::text IS DISTINCT FROM
              session.program_schedule_snapshot->>'resolvedProgramVersionId'
            OR session.source_day_lineage_id::text IS DISTINCT FROM
              session.program_schedule_snapshot->>'routineLineageId'
          )
        )

      UNION ALL
      SELECT 'program_version.import_event', 'error', 'program_version', pv.id::text,
        'A program version points to a missing or different owner import event.',
        jsonb_build_object('importEventId', pv.source_import_event_id)
      FROM user_program_versions pv
      LEFT JOIN import_events ie ON ie.id = pv.source_import_event_id
      WHERE pv.source_import_event_id IS NOT NULL
        AND (ie.id IS NULL OR ie.user_id <> ${userId}::uuid)

      UNION ALL
      SELECT 'program.current_version', 'error', 'program', program.id::text,
        'A usable Program does not point to one of its immutable versions.',
        jsonb_build_object('currentVersionId', program.current_version_id)
      FROM user_programs program
      LEFT JOIN program_versions version ON version.id = program.current_version_id
      WHERE program.status IN ('active', 'inactive')
        AND program.archived_at IS NULL
        AND (
          version.id IS NULL OR version.program_id <> program.id
          OR EXISTS (
            SELECT 1 FROM program_versions newer
            WHERE newer.program_id = program.id
              AND newer.version_no > version.version_no
          )
        )

      UNION ALL
      SELECT 'program.state', 'error', 'program', program.id::text,
        'A Program has inconsistent usable and archive state.',
        jsonb_build_object('status', program.status, 'archivedAt', program.archived_at)
      FROM user_programs program
      WHERE (program.status IN ('active', 'inactive') AND program.archived_at IS NOT NULL)
         OR (program.status = 'archived' AND program.archived_at IS NULL)
         OR program.status NOT IN ('active', 'inactive', 'archived')

      UNION ALL
      SELECT 'program_version.parent', 'error', 'program_version', version.id::text,
        'A Program version has an invalid parent in another lineage or time order.',
        jsonb_build_object(
          'parentVersionId', version.parent_version_id,
          'versionNo', version.version_no,
          'parentVersionNo', parent.version_no
        )
      FROM user_program_versions version
      LEFT JOIN program_versions parent ON parent.id = version.parent_version_id
      WHERE version.parent_version_id IS NOT NULL
        AND (
          parent.id IS NULL OR parent.program_id <> version.program_id
          OR parent.version_no >= version.version_no
        )

      UNION ALL
      SELECT 'program_version.restored_from', 'error', 'program_version', version.id::text,
        'A restored Program version points outside its Program history.',
        jsonb_build_object('restoredFromVersionId', version.restored_from_version_id)
      FROM user_program_versions version
      LEFT JOIN program_versions restored
        ON restored.id = version.restored_from_version_id
      WHERE version.restored_from_version_id IS NOT NULL
        AND (restored.id IS NULL OR restored.program_id <> version.program_id)

      UNION ALL
      SELECT 'program_version.intent_preflight', 'error', 'program_version', version.id::text,
        'A structured Program is missing reviewed intent or its publication-time Preflight result.',
        jsonb_build_object('documentSchemaVersion', version.document_schema_version)
      FROM user_program_versions version
      WHERE version.document_schema_version >= 2
        AND (
          version.publication_preflight IS NULL
          OR EXISTS (
            SELECT 1 FROM user_templates template
            WHERE template.program_version_id = version.id
              AND template.intent IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM user_template_exercises slot
            JOIN user_templates template ON template.id = slot.workout_template_id
            WHERE template.program_version_id = version.id
              AND slot.intent IS NULL
          )
        )

      UNION ALL
      SELECT 'program_draft.relationships', 'error', 'program_draft', draft.id::text,
        'A Program draft crosses account or Program version boundaries.',
        jsonb_build_object(
          'programId', draft.program_id,
          'baseVersionId', draft.base_version_id,
          'restoredFromVersionId', draft.restored_from_version_id,
          'publishedVersionId', draft.published_version_id
        )
      FROM user_program_drafts draft
      LEFT JOIN programs program ON program.id = draft.program_id
      LEFT JOIN program_versions base ON base.id = draft.base_version_id
      LEFT JOIN program_versions restored
        ON restored.id = draft.restored_from_version_id
      LEFT JOIN program_versions published ON published.id = draft.published_version_id
      WHERE program.id IS NULL OR program.user_id <> draft.user_id
        OR base.id IS NULL OR base.program_id <> draft.program_id
        OR (draft.restored_from_version_id IS NOT NULL
          AND (restored.id IS NULL OR restored.program_id <> draft.program_id
            OR restored.id = base.id))
        OR (draft.published_version_id IS NOT NULL
          AND (published.id IS NULL OR published.program_id <> draft.program_id))

      UNION ALL
      SELECT 'program_draft.document', 'error', 'program_draft', draft.id::text,
        'A Program draft document does not match its durable Program and base version.',
        jsonb_build_object(
          'schemaVersion', draft.document ->> 'schemaVersion',
          'documentProgramId', draft.document ->> 'programId',
          'documentBaseVersionId', draft.document ->> 'baseVersionId'
        )
      FROM user_program_drafts draft
      WHERE draft.document ->> 'schemaVersion' NOT IN ('1', '2', '3')
        OR draft.document ->> 'programId' <> draft.program_id::text
        OR draft.document ->> 'baseVersionId' <> draft.base_version_id::text
        OR jsonb_typeof(draft.document -> 'days') IS DISTINCT FROM 'array'

      UNION ALL
      SELECT 'program_draft.state', 'error', 'program_draft', draft.id::text,
        'A Program draft has inconsistent review, publication, or discard state.',
        jsonb_build_object(
          'status', draft.status,
          'revision', draft.revision,
          'reviewedRevision', draft.reviewed_revision,
          'publishedVersionId', draft.published_version_id,
          'publishedAt', draft.published_at,
          'discardedAt', draft.discarded_at
        )
      FROM user_program_drafts draft
      WHERE (draft.reviewed_revision IS NULL) <> (draft.review_hash IS NULL)
        OR draft.reviewed_revision > draft.revision
        OR (draft.status = 'open'
          AND (draft.published_version_id IS NOT NULL OR draft.published_at IS NOT NULL))
        OR (draft.status = 'published'
          AND (draft.published_version_id IS NULL OR draft.published_at IS NULL))
        OR (draft.status = 'discarded' AND draft.discarded_at IS NULL)

      UNION ALL
      SELECT 'template_exercise.exercise', 'error', 'workout_template_exercise', wte.id::text,
        'A program exercise points to an unavailable exercise.',
        jsonb_build_object('exerciseId', wte.exercise_id)
      FROM user_template_exercises wte
      LEFT JOIN exercises e ON e.id = wte.exercise_id
      WHERE e.id IS NULL OR (e.user_id IS NOT NULL AND e.user_id <> ${userId}::uuid)

      UNION ALL
      SELECT 'recommendation.slot_lineage', 'error', 'recommendation', recommendation.id::text,
        'A recommendation source does not match its stable Program slot lineage.',
        jsonb_build_object(
          'sourceTemplateExerciseId', recommendation.source_template_exercise_id,
          'sourceSlotLineageId', recommendation.source_slot_lineage_id,
          'actualSlotLineageId', slot.lineage_id
        )
      FROM recommendations recommendation
      LEFT JOIN user_template_exercises slot
        ON slot.id = recommendation.source_template_exercise_id
      WHERE recommendation.user_id = ${userId}::uuid
        AND (
          (recommendation.source_template_exercise_id IS NOT NULL
            AND (slot.id IS NULL OR recommendation.source_slot_lineage_id IS DISTINCT FROM slot.lineage_id))
          OR (recommendation.source_template_exercise_id IS NULL
            AND recommendation.source_slot_lineage_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM user_template_exercises known
              WHERE known.lineage_id = recommendation.source_slot_lineage_id
            ))
        )

      UNION ALL
      SELECT 'recommendation.current_source', 'error', 'recommendation', recommendation.id::text,
        'A pending recommendation does not reference its owner current Program slot.',
        jsonb_build_object(
          'sourceTemplateExerciseId', recommendation.source_template_exercise_id,
          'sourceSlotLineageId', recommendation.source_slot_lineage_id
        )
      FROM recommendations recommendation
      LEFT JOIN workout_template_exercises source_slot
        ON source_slot.id = recommendation.source_template_exercise_id
      LEFT JOIN workout_templates source_day ON source_day.id = source_slot.workout_template_id
      LEFT JOIN programs current_program
        ON current_program.user_id = recommendation.user_id
       AND current_program.status = 'active'
       AND current_program.archived_at IS NULL
      WHERE recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND NOT (
          recommendation.payload->>'kind' = 'deload'
          AND recommendation.source_template_exercise_id IS NULL
          AND recommendation.source_slot_lineage_id IS NULL
          AND current_program.id IS NOT NULL
          AND current_program.current_version_id IS NOT NULL
        )
        AND (
          recommendation.payload->>'kind' = 'deload'
          OR source_slot.id IS NULL
          OR recommendation.source_slot_lineage_id IS NULL
          OR source_slot.lineage_id IS DISTINCT FROM recommendation.source_slot_lineage_id
          OR source_day.program_version_id IS DISTINCT FROM current_program.current_version_id
        )

      UNION ALL
      SELECT 'recommendation.reconciliation', 'error', 'recommendation', recommendation.id::text,
        'A recommendation has inconsistent Program reconciliation evidence.',
        jsonb_build_object(
          'status', recommendation.status,
          'reconciledAt', recommendation.reconciled_at,
          'reconciliationReason', recommendation.reconciliation_reason,
          'reconciledByProgramVersionId', recommendation.reconciled_by_program_version_id
        )
      FROM recommendations recommendation
      LEFT JOIN user_program_versions version
        ON version.id = recommendation.reconciled_by_program_version_id
      WHERE recommendation.user_id = ${userId}::uuid
        AND (
          (recommendation.status = 'expired' AND (
            recommendation.reconciled_at IS NULL
            OR length(trim(coalesce(recommendation.reconciliation_reason, ''))) = 0
            OR (recommendation.reconciled_by_program_version_id IS NOT NULL AND version.id IS NULL)
          ))
          OR (recommendation.status IN ('pending', 'approved', 'edited') AND (
            (recommendation.reconciled_at IS NULL) <> (recommendation.reconciliation_reason IS NULL)
            OR (recommendation.reconciled_by_program_version_id IS NOT NULL AND (
              recommendation.reconciled_at IS NULL
              OR length(trim(coalesce(recommendation.reconciliation_reason, ''))) = 0
            ))
            OR (recommendation.reconciled_by_program_version_id IS NOT NULL AND version.id IS NULL)
          ))
          OR (recommendation.status = 'rejected' AND (
            recommendation.reconciled_at IS NOT NULL
            OR recommendation.reconciliation_reason IS NOT NULL
            OR recommendation.reconciled_by_program_version_id IS NOT NULL
          ))
        )

      UNION ALL
      SELECT 'prescription.superseded_by', 'error', 'exercise_prescription', ep.id::text,
        'A prescription points to a missing or different program slot version.',
        jsonb_build_object('supersededById', ep.superseded_by_id)
      FROM exercise_prescriptions ep
      JOIN user_template_exercises wte ON wte.id = ep.template_exercise_id
      LEFT JOIN exercise_prescriptions next_ep ON next_ep.id = ep.superseded_by_id
      WHERE ep.superseded_by_id IS NOT NULL
        AND (next_ep.id IS NULL OR next_ep.template_exercise_id <> ep.template_exercise_id)

      UNION ALL
      SELECT 'import_batch.import_event', 'error', 'history_import_batch', hib.id::text,
        'A history import points to a missing or different owner import event.',
        jsonb_build_object('importEventId', hib.import_event_id)
      FROM history_import_batches hib
      LEFT JOIN import_events ie ON ie.id = hib.import_event_id
      WHERE hib.user_id = ${userId}::uuid
        AND (ie.id IS NULL OR ie.user_id <> ${userId}::uuid)

      UNION ALL
      SELECT 'import_batch.summary', 'warning', 'history_import_batch', hib.id::text,
        'A stored import summary differs from the rows currently retained for that batch.',
        jsonb_build_object(
          'stored', hib.summary,
          'actual', jsonb_build_object(
            'workouts', counts.workouts,
            'exerciseOccurrences', counts.exercise_occurrences,
            'sets', counts.sets,
            'warmupSets', counts.warmup_sets
          )
        )
      FROM history_import_batches hib
      CROSS JOIN LATERAL (
        SELECT
          count(DISTINCT ws.id)::int AS workouts,
          count(DISTINCT se.id)::int AS exercise_occurrences,
          count(DISTINCT cs.id)::int AS sets,
          count(DISTINCT cs.id) FILTER (WHERE cs.is_warmup)::int AS warmup_sets
        FROM workout_sessions ws
        LEFT JOIN session_exercises se ON se.session_id = ws.id
        LEFT JOIN completed_sets cs ON cs.session_exercise_id = se.id
        WHERE ws.import_batch_id = hib.id
      ) counts
      WHERE hib.user_id = ${userId}::uuid
        AND (
          COALESCE((hib.summary ->> 'workouts')::int, -1) <> counts.workouts
          OR COALESCE((hib.summary ->> 'exerciseOccurrences')::int, -1) <> counts.exercise_occurrences
          OR COALESCE((hib.summary ->> 'sets')::int, -1) <> counts.sets
          OR COALESCE((hib.summary ->> 'warmupSets')::int, -1) <> counts.warmup_sets
        )

      UNION ALL
      SELECT 'external_mapping.exercise', 'error', 'external_exercise_mapping', m.id::text,
        'A reviewed source mapping points to an unavailable exercise.',
        jsonb_build_object('exerciseId', m.exercise_id)
      FROM external_exercise_mappings m
      LEFT JOIN exercises e ON e.id = m.exercise_id
      WHERE m.user_id = ${userId}::uuid
        AND (e.id IS NULL OR (e.user_id IS NOT NULL AND e.user_id <> ${userId}::uuid))

      UNION ALL
      SELECT 'archive_member.owner', 'error', 'archive_operation_record', r.id::text,
        'An archive member does not belong to the same owner as its operation.',
        jsonb_build_object('operationId', r.operation_id)
      FROM archive_operation_records r
      LEFT JOIN archive_operations op ON op.id = r.operation_id
      WHERE r.user_id = ${userId}::uuid
        AND (op.id IS NULL OR op.user_id <> ${userId}::uuid)

      UNION ALL
      SELECT 'archive_member.progression_job', 'error',
        'archive_operation_record', member.id::text,
        'An active Archive progression-job member is missing or belongs to another account.',
        jsonb_build_object(
          'operationId', member.operation_id,
          'progressionJobId', member.entity_id
        )
      FROM archive_operation_records member
      JOIN archive_operations operation ON operation.id = member.operation_id
      LEFT JOIN progression_jobs job ON job.id::text = member.entity_id
      WHERE member.user_id = ${userId}::uuid
        AND operation.status = 'active'
        AND member.entity_type = 'progression_job'
        AND (job.id IS NULL OR job.user_id <> member.user_id)

      UNION ALL
      SELECT 'archive_member.progression_input', 'error',
        'archive_operation_record', member.id::text,
        'An active Archive progression-input member is missing or belongs to another account.',
        jsonb_build_object(
          'operationId', member.operation_id,
          'progressionInputId', member.entity_id
        )
      FROM archive_operation_records member
      JOIN archive_operations operation ON operation.id = member.operation_id
      LEFT JOIN progression_job_input_sessions input
        ON input.job_id::text || ':' || input.source_slot_lineage_id::text ||
          ':' || input.session_id::text = member.entity_id
      WHERE member.user_id = ${userId}::uuid
        AND operation.status = 'active'
        AND member.entity_type = 'progression_job_input_session'
        AND (input.job_id IS NULL OR input.user_id <> member.user_id)

      UNION ALL
      SELECT 'archive_member.record_version', 'error',
        'archive_operation_record', member.id::text,
        'An active Archive version member is missing or belongs to another account.',
        jsonb_build_object(
          'operationId', member.operation_id,
          'recordVersionId', member.entity_id
        )
      FROM archive_operation_records member
      JOIN archive_operations operation ON operation.id = member.operation_id
      LEFT JOIN record_versions version ON version.id::text = member.entity_id
      WHERE member.user_id = ${userId}::uuid
        AND operation.status = 'active'
        AND member.entity_type = 'record_version'
        AND (version.id IS NULL OR version.user_id <> member.user_id)

      UNION ALL
      SELECT 'exercise_media.asset_fields', 'error', 'exercise_media_asset', ema.id::text,
        'An approved exercise reference asset is missing required identity or rights evidence.',
        jsonb_build_object(
          'mediaType', ema.media_type,
          'hosting', ema.hosting,
          'reviewedAt', ema.reviewed_at
        )
      FROM exercise_media_assets ema
      WHERE ema.status = 'approved'
        AND ema.disabled_at IS NULL
        AND ema.withdrawn_at IS NULL
        AND (
          length(trim(ema.display_url)) = 0
          OR length(trim(ema.original_asset_url)) = 0
          OR length(trim(ema.source_page_url)) = 0
          OR length(trim(ema.creator)) = 0
          OR length(trim(ema.license)) = 0
          OR ema.checksum_sha256 !~ '^[0-9a-f]{64}$'
          OR (ema.hosting = 'app_managed' AND NOT ema.redistribution_allowed)
          OR ema.reviewed_at > now()
        )

      UNION ALL
      SELECT 'exercise_media.unassociated', 'warning', 'exercise_media_asset', ema.id::text,
        'An approved exercise reference asset is not associated with an exercise.',
        jsonb_build_object('displayUrl', ema.display_url)
      FROM exercise_media_assets ema
      LEFT JOIN exercise_media_associations link ON link.asset_id = ema.id
      WHERE ema.status = 'approved'
        AND ema.disabled_at IS NULL
        AND ema.withdrawn_at IS NULL
        AND link.id IS NULL

      UNION ALL
      SELECT 'exercise_media.family_equivalence', 'error', 'exercise_media_association', link.id::text,
        'A family-level media link does not exactly match any family variant.',
        jsonb_build_object(
          'familyId', link.family_id,
          'equipmentSignature', link.equipment_signature,
          'variantAttributes', link.variant_attributes
        )
      FROM exercise_media_associations link
      WHERE link.match_scope = 'equivalent_family'
        AND NOT EXISTS (
          SELECT 1
          FROM exercises e
          WHERE e.family_id = link.family_id
            AND e.variant_attributes = link.variant_attributes
            AND (
              SELECT COALESCE(
                jsonb_agg(req.equipment_type ORDER BY req.equipment_type),
                '[]'::jsonb
              )
              FROM exercise_equipment_requirements req
              WHERE req.exercise_id = e.id
            ) = link.equipment_signature
        )

      UNION ALL
      SELECT 'snapshot.creation_stale', 'warning', 'data_snapshot', s.id::text,
        'A snapshot has remained in creation beyond the two-hour recovery deadline.',
        jsonb_build_object('updatedAt', s.updated_at, 'snapshotKind', s.snapshot_kind)
      FROM data_snapshots s
      WHERE s.user_id = ${userId}::uuid
        AND s.status = 'creating'
        AND s.updated_at <= now() - interval '2 hours'

      UNION ALL
      SELECT 'snapshot.deletion_failed', 'error', 'data_snapshot', s.id::text,
        'Automatic snapshot retention failed and will retry from its tombstone.',
        jsonb_build_object(
          'attempts', s.deletion_attempts,
          'reason', s.deletion_failure_reason,
          'requestedAt', s.deletion_requested_at
        )
      FROM data_snapshots s
      WHERE s.user_id = ${userId}::uuid
        AND s.deletion_status = 'delete_failed'

      UNION ALL
      SELECT 'snapshot.deletion_stalled', 'error', 'data_snapshot', s.id::text,
        'Automatic snapshot deletion lease expired before metadata cleanup finished.',
        jsonb_build_object(
          'attempts', s.deletion_attempts,
          'leaseExpiredAt', s.deletion_lease_expires_at
        )
      FROM data_snapshots s
      WHERE s.user_id = ${userId}::uuid
        AND s.deletion_status = 'deleting'
        AND s.deletion_lease_expires_at <= now()

      UNION ALL
      SELECT 'snapshot.verified_metadata', 'error', 'data_snapshot', s.id::text,
        'A verified snapshot is missing required verification metadata.',
        jsonb_build_object('status', s.status)
      FROM data_snapshots s
      WHERE s.user_id = ${userId}::uuid
        AND s.status = 'verified'
        AND (
          s.verified_at IS NULL OR s.object_etag IS NULL
          OR s.ciphertext_checksum IS NULL OR s.size_bytes <= 0
        )

      UNION ALL
      SELECT 'snapshot.record_counts', 'error', 'data_snapshot', s.id::text,
        'A snapshot total does not equal the sum of its table counts.',
        jsonb_build_object('storedTotal', s.record_counts ->> 'total', 'calculatedTotal', totals.total)
      FROM data_snapshots s
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(value::int), 0)::int AS total
        FROM jsonb_each_text(s.record_counts)
        WHERE key <> 'total'
      ) totals
      WHERE s.user_id = ${userId}::uuid
        AND COALESCE((s.record_counts ->> 'total')::int, -1) <> totals.total

      UNION ALL
      SELECT 'session_compiler.source', 'error', 'session_compiler_proposal', proposal.id::text,
        'A Session Compiler proposal does not point to one owned structured Program day.',
        jsonb_build_object('programId', proposal.program_id, 'programVersionId', proposal.program_version_id, 'templateId', proposal.workout_template_id)
      FROM user_compiler_proposals proposal
      LEFT JOIN user_programs program ON program.id = proposal.program_id
      LEFT JOIN user_program_versions version ON version.id = proposal.program_version_id AND version.program_id = proposal.program_id
      LEFT JOIN user_templates template ON template.id = proposal.workout_template_id AND template.program_version_id = proposal.program_version_id
      WHERE program.id IS NULL OR version.id IS NULL OR template.id IS NULL OR version.document_schema_version < 2

      UNION ALL
      SELECT 'session_compiler.acceptance', 'error', 'session_compiler_proposal', proposal.id::text,
        'An accepted Session Compiler proposal is missing its matching owned workout and immutable snapshot.',
        jsonb_build_object('sessionId', proposal.accepted_session_id, 'status', proposal.status)
      FROM user_compiler_proposals proposal
      LEFT JOIN user_sessions session ON session.id = proposal.accepted_session_id
      WHERE proposal.status = 'accepted'
        AND (
          session.id IS NULL
          OR session.source <> 'compiler'
          OR session.compilation_snapshot ->> 'proposalId' <> proposal.id::text
          OR session.compilation_snapshot ->> 'proposalHash' <> proposal.content_hash
          OR session.compilation_acceptance_key <> proposal.acceptance_key
          OR session.compilation_snapshot -> 'input' IS DISTINCT FROM proposal.input_snapshot
          OR session.compilation_snapshot -> 'output' IS DISTINCT FROM proposal.output_snapshot
          OR proposal.review_hash <> proposal.content_hash
        )

      UNION ALL
      SELECT 'workout_session.compiler_provenance', 'error', 'workout_session', session.id::text,
        'A workout has incomplete or mismatched Session Compiler provenance.',
        jsonb_build_object('source', session.source, 'acceptanceKey', session.compilation_acceptance_key)
      FROM user_sessions session
      WHERE (session.compilation_acceptance_key IS NULL) <> (session.compilation_snapshot IS NULL)
        OR (session.compilation_snapshot IS NOT NULL AND session.source <> 'compiler')
    )
    SELECT check_key, severity, entity_type, entity_id, message, details
    FROM findings
    ORDER BY severity DESC, check_key, entity_id NULLS FIRST
  `;
  const findings = resultRows(await db.execute(query)).map(normalizeFinding);
  const drafts = await db
    .select({
      id: programDrafts.id,
      document: programDrafts.document,
      contentHash: programDrafts.contentHash,
    })
    .from(programDrafts)
    .where(eq(programDrafts.userId, userId));
  for (const draft of drafts) {
    try {
      canonicalizeProgramDraftIdentity(draft.document, draft.contentHash);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("checksum does not match")
      ) {
        findings.push({
          checkKey: "program_draft.content_hash",
          severity: "error",
          entityType: "program_draft",
          entityId: draft.id,
          message: "A Program draft's saved content identity does not match its document.",
          details: { storedHash: draft.contentHash },
        });
        continue;
      }
      if (!findings.some((finding) =>
        finding.checkKey === "program_draft.document" && finding.entityId === draft.id
      )) {
        findings.push({
          checkKey: "program_draft.document",
          severity: "error",
          entityType: "program_draft",
          entityId: draft.id,
          message: "A Program draft document is malformed.",
          details: {},
        });
      }
    }
  }
  const proposals = await db
    .select({
      id: sessionCompilerProposals.id,
      input: sessionCompilerProposals.inputSnapshot,
      output: sessionCompilerProposals.outputSnapshot,
      preflight: sessionCompilerProposals.preflightSnapshot,
      contentHash: sessionCompilerProposals.contentHash,
    })
    .from(sessionCompilerProposals)
    .where(eq(sessionCompilerProposals.userId, userId));
  for (const proposal of proposals) {
    const input = sessionCompilerInputSchema.safeParse(proposal.input);
    const output = sessionCompilerOutputSchema.safeParse(proposal.output);
    const preflight = programPreflightResultSchema.safeParse(proposal.preflight);
    const identity = input.success && output.success
      ? {
          input: { ...input.data, preflight: { ...input.data.preflight, checkedAt: "evidence-time-excluded-from-identity" } },
          output: output.data,
        }
      : null;
    if (
      !input.success ||
      !output.success ||
      !preflight.success ||
      canonicalJson(preflight.data) !== canonicalJson(input.data.preflight) ||
      proposal.contentHash !== sha256Hex(Buffer.from(canonicalJson(identity), "utf8"))
    ) {
      findings.push({
        checkKey: "session_compiler.content_hash",
        severity: "error",
        entityType: "session_compiler_proposal",
        entityId: proposal.id,
        message: "A Session Compiler proposal's saved evidence identity does not match its content.",
        details: { storedHash: proposal.contentHash },
      });
    }
  }
  return findings;
}

export function recoveryStatusForFindings(
  findings: IntegrityFinding[]
): RecoveryRunStatus {
  if (findings.some((finding) => finding.severity === "error")) return "failed";
  return findings.length > 0 ? "warning" : "passed";
}

export async function recordRecoveryRun(
  db: Db,
  userId: string,
  input: RecoveryRunInput
) {
  const runId = randomUUID();
  const findings = (input.findings ?? []).map((finding) => ({
    id: randomUUID(),
    check_key: finding.checkKey,
    severity: finding.severity,
    entity_type: finding.entityType,
    entity_id: finding.entityId,
    message: finding.message,
    details: finding.details,
  }));
  const query = sql`
    WITH inserted_run AS (
      INSERT INTO recovery_runs (
        id, user_id, kind, status, provider, source_ref, summary, details,
        started_at, completed_at
      ) VALUES (
        ${runId}::uuid, ${userId}::uuid, ${input.kind}, ${input.status},
        ${input.provider ?? null}, ${input.sourceRef ?? null}, ${input.summary},
        ${JSON.stringify(input.details ?? {})}::jsonb,
        ${input.startedAt.toISOString()}::timestamptz,
        ${input.completedAt.toISOString()}::timestamptz
      )
      RETURNING id
    ), inserted_findings AS (
      INSERT INTO integrity_findings (
        id, run_id, user_id, check_key, severity, entity_type, entity_id,
        message, details
      )
      SELECT
        finding.id::uuid,
        inserted_run.id,
        ${userId}::uuid,
        finding.check_key,
        finding.severity,
        finding.entity_type,
        finding.entity_id,
        finding.message,
        finding.details
      FROM inserted_run
      CROSS JOIN jsonb_to_recordset(${JSON.stringify(findings)}::jsonb) AS finding(
        id text,
        check_key text,
        severity text,
        entity_type text,
        entity_id text,
        message text,
        details jsonb
      )
      RETURNING id
    )
    SELECT
      (SELECT id FROM inserted_run) AS id,
      (SELECT count(*)::int FROM inserted_findings) AS findings
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) throw new Error("Recovery run could not be recorded.");
  return { id: String(row.id), findings: Number(row.findings ?? 0) };
}

export async function runApplicationIntegrityCheck(db: Db, userId: string) {
  const startedAt = new Date();
  const findings = await evaluateApplicationIntegrity(db, userId);
  const completedAt = new Date();
  const status = recoveryStatusForFindings(findings);
  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.length - errorCount;
  const issueCount = errorCount + warningCount;
  const summary =
    status === "passed"
      ? "All application relationship and value checks passed."
      : `${errorCount} error${errorCount === 1 ? "" : "s"} and ${warningCount} warning${warningCount === 1 ? "" : "s"} ${issueCount === 1 ? "needs" : "need"} review.`;
  const recorded = await recordRecoveryRun(db, userId, {
    kind: "application_integrity",
    status,
    summary,
    details: { checksVersion: "1", errorCount, warningCount },
    findings,
    startedAt,
    completedAt,
  });
  return { ...recorded, status, findings, errorCount, warningCount };
}

export async function runSnapshotIntegrityCheck(
  db: Db,
  userId: string,
  dependencies: Pick<SnapshotDependencies, "store" | "keyring"> = {}
) {
  const startedAt = new Date();
  const snapshots = await db.query.dataSnapshots.findMany({
    where: and(
      eq(dataSnapshots.userId, userId),
      eq(dataSnapshots.status, "verified"),
      isNull(dataSnapshots.deletionStatus)
    ),
    orderBy: desc(dataSnapshots.createdAt),
    limit: 25,
  });
  const selected = snapshots
    .filter((snapshot, index) => snapshot.pinned || index === 0)
    .slice(0, 5);
  const findings: IntegrityFinding[] = [];
  let verifiedRecords = 0;
  for (const snapshot of selected) {
    try {
      const verified = await readVerifiedDataSnapshot(
        db,
        userId,
        snapshot.id,
        dependencies
      );
      verifiedRecords += Number(verified.snapshot.recordCounts.total ?? 0);
    } catch (error) {
      findings.push({
        checkKey: "snapshot.object_readback",
        severity: "error",
        entityType: "data_snapshot",
        entityId: snapshot.id,
        message: "A selected snapshot could not be read and verified again.",
        details: {
          reason: error instanceof Error ? error.message.slice(0, 500) : "Unknown error",
        },
      });
    }
  }
  if (selected.length === 0) {
    findings.push({
      checkKey: "snapshot.missing",
      severity: "error",
      entityType: null,
      entityId: null,
      message: "No verified snapshot is available for recovery.",
      details: {},
    });
  }
  const completedAt = new Date();
  const status = recoveryStatusForFindings(findings);
  const summary =
    status === "passed"
      ? `${selected.length} selected snapshot${selected.length === 1 ? "" : "s"} passed encrypted object read-back verification.`
      : `${findings.length} snapshot verification problem${findings.length === 1 ? "" : "s"} ${findings.length === 1 ? "needs" : "need"} review.`;
  const recorded = await recordRecoveryRun(db, userId, {
    kind: "snapshot_integrity",
    status,
    summary,
    details: {
      checkedSnapshots: selected.length,
      verifiedRecords,
      latestSnapshotId: selected[0]?.id ?? null,
    },
    findings,
    startedAt,
    completedAt,
  });
  return { ...recorded, status, findings, checkedSnapshots: selected.length };
}

export async function getRecoveryHealth(db: Db, userId: string) {
  const kinds: RecoveryRunKind[] = [
    "database_backup",
    "restore_drill",
    "snapshot_integrity",
    "application_integrity",
  ];
  const entries = await Promise.all(
    kinds.map(async (kind) => [
      kind,
      await db.query.recoveryRuns.findFirst({
        where: and(eq(recoveryRuns.userId, userId), eq(recoveryRuns.kind, kind)),
        orderBy: desc(recoveryRuns.completedAt),
        with: { findings: true },
      }),
    ] as const)
  );
  const latest = Object.fromEntries(entries) as Record<
    RecoveryRunKind,
    (typeof entries)[number][1]
  >;
  const latestFindings = [
    ...(latest.application_integrity?.findings ?? []),
    ...(latest.snapshot_integrity?.findings ?? []),
  ].filter((finding) => !finding.resolvedAt);
  return { latest, attentionCount: latestFindings.length, latestFindings };
}
