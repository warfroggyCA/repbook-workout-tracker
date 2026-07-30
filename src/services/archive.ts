import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  archiveOperationRecords,
  archiveOperations,
  completedSets,
  sessionExercises,
} from "@/db/schema";
import { TEST_DATA_PREFIX } from "@/services/workout-test-data";
import { historyRevisionLockSql } from "@/services/history-revision-lock";

export type ArchiveActionResult =
  | {
      ok: true;
      operationId: string;
      summary: string;
      counts: Record<string, number>;
    }
  | { ok: false; reason: string };

export type ArchiveListItem = {
  operationId: string;
  action: string;
  summary: string;
  counts: Record<string, number>;
  archivedAt: Date;
  rootType: string;
  rootId: string;
};

export type WorkoutArchivePreview = {
  workouts: number;
  sessionExerciseGroups: number;
  exerciseOccurrences: number;
  sessionOccurrences: number;
  sessionOccurrenceMutations: number;
  sets: number;
  notes: number;
  contextualNotes: number;
  painLogs: number;
  fatigueLogs: number;
  coachingMessages: number;
  recommendations: number;
  progressionJobs: number;
  progressionJobInputSessions: number;
  recordVersions: number;
};

export type BulkActivityArchivePreview = {
  activities: number;
  earliest: string | null;
  latest: string | null;
};

export type SampleHistoryArchivePreview = {
  workouts: number;
  sessionExerciseGroups: number;
  exerciseOccurrences: number;
  sessionOccurrences: number;
  sessionOccurrenceMutations: number;
  sets: number;
  notes: number;
  contextualNotes: number;
  painLogs: number;
  fatigueLogs: number;
  coachingMessages: number;
  recommendations: number;
  progressionJobs: number;
  progressionJobInputSessions: number;
  recordVersions: number;
};

export type ImportBatchArchivePreview = {
  importBatches: number;
  importFiles: number;
  workouts: number;
  previouslyArchivedWorkouts: number;
  sessionExerciseGroups: number;
  exerciseOccurrences: number;
  sessionOccurrences: number;
  sessionOccurrenceMutations: number;
  sets: number;
  notes: number;
  contextualNotes: number;
  painLogs: number;
  fatigueLogs: number;
  coachingMessages: number;
  recommendations: number;
  progressionJobs: number;
  progressionJobInputSessions: number;
  recordVersions: number;
  reviewedMappings: number;
  reviewDecisions: number;
  customExercises: number;
  warnings: number;
};

function countsFrom(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, count]) => [key, Number(count)])
  );
}

function actionResult(
  row: Record<string, unknown> | undefined,
  notFound: string
): ArchiveActionResult {
  if (!row) return { ok: false, reason: notFound };
  return {
    ok: true,
    operationId: String(row.operation_id),
    summary: String(row.summary),
    counts: countsFrom(row.record_counts),
  };
}

export async function archiveActivityRecord(
  db: Db,
  userId: string,
  activityId: string
): Promise<ArchiveActionResult> {
  const operationId = randomUUID();
  const query = sql`
    WITH target AS (
      SELECT id, activity_type, started_at
      FROM health_activities
      WHERE id = ${activityId}::uuid
        AND user_id = ${userId}::uuid
        AND source = 'manual'
        AND archived_at IS NULL
    ), new_operation AS (
      INSERT INTO archive_operations (
        id, user_id, action, status, summary, record_counts
      )
      SELECT
        ${operationId}::uuid,
        ${userId}::uuid,
        'activity.archive',
        'active',
        'Archived ' || activity_type || ' activity from ' || started_at::date,
        jsonb_build_object('activities', 1)
      FROM target
      RETURNING id, summary, record_counts
    ), archived_activity AS (
      UPDATE health_activities
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), recorded_member AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid,
        'health_activity', id::text, 'root'
      FROM archived_activity
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'activity.archive', 'health_activity',
        target.id::text, new_operation.summary,
        jsonb_build_object('archiveOperationId', ${operationId}::text)
      FROM target CROSS JOIN new_operation
      RETURNING id
    )
    SELECT id AS operation_id, summary, record_counts FROM new_operation
  `;
  return actionResult(
    resultRows(await db.execute(query))[0],
    "Active manual activity not found."
  );
}

export async function archiveCompletedSetRecord(
  db: Db,
  userId: string,
  setId: string,
  options: { activeOnly?: boolean } = {}
): Promise<ArchiveActionResult> {
  const operationId = randomUUID();
  const progressionJobId = randomUUID();
  const query = sql`
    WITH owner_history_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), target AS (
      SELECT cs.id, cs.session_exercise_id, ws.id AS session_id,
        ws.template_name, ws.started_at, ws.status, ws.history_revision,
        se.source_slot_lineage_id
      FROM completed_sets cs
      JOIN session_exercises se ON se.id = cs.session_exercise_id
      JOIN workout_sessions ws ON ws.id = se.session_id
      CROSS JOIN owner_history_lock
      WHERE cs.id = ${setId}::uuid
        AND ws.user_id = ${userId}::uuid
        AND cs.archived_at IS NULL
        AND ws.archived_at IS NULL
        AND (NOT ${options.activeOnly ?? false}::boolean OR ws.status = 'in_progress')
      FOR UPDATE OF cs, ws
    ), new_operation AS (
      INSERT INTO archive_operations (
        id, user_id, action, status, summary, record_counts
      )
      SELECT
        ${operationId}::uuid,
        ${userId}::uuid,
        'set.archive',
        'active',
        'Archived one set from ' || coalesce(template_name, 'workout') ||
          ' on ' || started_at::date,
        jsonb_build_object(
          'sets', 1,
          'contextualNotes', (
            SELECT count(*)::int FROM contextual_notes note
            WHERE note.user_id = ${userId}::uuid
              AND (
                note.completed_set_id = target.id
                OR EXISTS (
                  SELECT 1 FROM session_occurrences occurrence
                  WHERE occurrence.id = note.occurrence_id
                    AND occurrence.completed_set_id = target.id
                )
              )
              AND note.archived_at IS NULL
          ),
          'sessionOccurrences', (
            SELECT count(*)::int FROM session_occurrences occurrence
            WHERE occurrence.completed_set_id = target.id
          ),
          'sessionOccurrenceMutations', (
            SELECT count(*)::int
            FROM session_occurrence_mutations mutation
            JOIN session_occurrences occurrence
              ON occurrence.id = mutation.occurrence_id
            WHERE occurrence.completed_set_id = target.id
          ),
          'recordVersions', (
            SELECT count(*)::int FROM record_versions version
            WHERE version.user_id = ${userId}::uuid
              AND version.entity_type = 'completed_set'
              AND version.entity_id = target.id
          )
        )
      FROM target
      RETURNING id, summary, record_counts
    ), archived_set AS (
      UPDATE completed_sets
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), revised_session AS (
      UPDATE workout_sessions session
      SET history_revision = session.history_revision + 1
      FROM target
      WHERE session.id = target.session_id
        AND target.status = 'completed'
        AND session.history_revision = target.history_revision
        AND EXISTS (SELECT 1 FROM archived_set)
      RETURNING session.id, session.user_id, session.history_revision
    ), reconciled_recommendations AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          reconciled_at = statement_timestamp(),
          reconciliation_reason =
            'A completed set was archived, so this suggestion no longer reflects the current workout history.'
      FROM target
      JOIN revised_session revised ON revised.id = target.session_id
      WHERE recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND target.source_slot_lineage_id IS NOT NULL
        AND recommendation.source_slot_lineage_id =
          target.source_slot_lineage_id
      RETURNING recommendation.id
    ), queued_progression AS (
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision,
        coaching_prefs, next_attempt_at
      )
      SELECT
        ${progressionJobId}::uuid,
        revised.user_id,
        revised.id,
        revised.history_revision,
        profile.coaching_prefs,
        statement_timestamp()
      FROM revised_session revised
      JOIN user_profiles profile ON profile.user_id = revised.user_id
      ON CONFLICT (session_id, source_session_revision) DO NOTHING
      RETURNING id
    ), archived_contextual_notes AS (
      UPDATE contextual_notes
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE user_id = ${userId}::uuid
        AND (
          completed_set_id IN (SELECT id FROM target)
          OR EXISTS (
            SELECT 1 FROM session_occurrences occurrence
            WHERE occurrence.id = contextual_notes.occurrence_id
              AND occurrence.completed_set_id IN (SELECT id FROM target)
          )
        )
        AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), recorded_member AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role,
        parent_entity_type, parent_entity_id
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid,
        'completed_set', archived_set.id::text, 'root',
        'workout_session', target.session_id::text
      FROM archived_set JOIN target ON true
      RETURNING id
    ), recorded_occurrences AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role,
        parent_entity_type, parent_entity_id
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid,
        'session_occurrence', occurrence.id::text, 'linked',
        'completed_set', target.id::text
      FROM target
      JOIN session_occurrences occurrence
        ON occurrence.completed_set_id = target.id
      WHERE EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), recorded_contextual_notes AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role,
        parent_entity_type, parent_entity_id
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid,
        'contextual_note', note.id::text, 'linked',
        'completed_set', target.id::text
      FROM archived_contextual_notes note CROSS JOIN target
      RETURNING id
    ), recorded_mutations AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role,
        parent_entity_type, parent_entity_id
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid,
        'session_occurrence_mutation', mutation.id::text, 'linked',
        'completed_set', target.id::text
      FROM target
      JOIN session_occurrences occurrence
        ON occurrence.completed_set_id = target.id
      JOIN session_occurrence_mutations mutation
        ON mutation.occurrence_id = occurrence.id
      WHERE EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'set.archive', 'completed_set',
        target.id::text, new_operation.summary,
        jsonb_build_object(
          'archiveOperationId', ${operationId}::text,
          'historyRevision', (SELECT history_revision FROM revised_session),
          'progressionJobId', (SELECT id FROM queued_progression)
        )
      FROM target CROSS JOIN new_operation
      RETURNING id
    )
    SELECT id AS operation_id, summary, record_counts FROM new_operation
  `;
  return actionResult(
    resultRows(await db.execute(query))[0],
    "Active set not found."
  );
}

export async function getWorkoutArchivePreview(
  db: Db,
  userId: string,
  sessionId: string
): Promise<WorkoutArchivePreview | null> {
  const query = sql`
    WITH target AS (
      SELECT *
      FROM workout_sessions
      WHERE id = ${sessionId}::uuid
        AND user_id = ${userId}::uuid
        AND status IN ('completed', 'abandoned')
        AND archived_at IS NULL
    ), affected_jobs AS (
      SELECT job.id
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND (
          job.session_id IN (SELECT id FROM target)
          OR EXISTS (
            SELECT 1 FROM progression_job_input_sessions input
            WHERE input.job_id = job.id
              AND input.session_id IN (SELECT id FROM target)
          )
        )
    )
    SELECT
      1::int AS workouts,
      (SELECT count(*)::int FROM session_exercise_groups seg
        WHERE seg.session_id = ws.id) AS session_exercise_groups,
      (SELECT count(*)::int FROM session_exercises se
        WHERE se.session_id = ws.id) AS exercise_occurrences,
      (SELECT count(*)::int FROM session_occurrences occurrence
        WHERE occurrence.session_id = ws.id) AS session_occurrences,
      (SELECT count(*)::int FROM session_occurrence_mutations mutation
        JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
        WHERE occurrence.session_id = ws.id) AS session_occurrence_mutations,
      (SELECT count(*)::int FROM completed_sets cs
        JOIN session_exercises se ON se.id = cs.session_exercise_id
        WHERE se.session_id = ws.id AND cs.archived_at IS NULL) AS sets,
      (SELECT count(*)::int FROM session_notes sn
        WHERE sn.session_id = ws.id AND sn.archived_at IS NULL) AS notes,
      (SELECT count(*)::int FROM contextual_notes note
        WHERE note.session_id = ws.id AND note.archived_at IS NULL) AS contextual_notes,
      (SELECT count(*)::int FROM pain_logs pl
        WHERE pl.session_id = ws.id AND pl.archived_at IS NULL) AS pain_logs,
      (SELECT count(*)::int FROM fatigue_logs fl
        WHERE fl.session_id = ws.id AND fl.archived_at IS NULL) AS fatigue_logs,
      (SELECT count(*)::int FROM coaching_insights ci
        WHERE ci.session_id = ws.id
          AND ci.kind IN ('live_user', 'live_assistant')
          AND ci.archived_at IS NULL) AS coaching_messages,
      (SELECT count(*)::int FROM recommendations r
        WHERE r.user_id = ws.user_id
          AND r.archived_at IS NULL
          AND (
            coalesce(r.evidence->'sessionIds', '[]'::jsonb) ? ws.id::text
            OR r.progression_job_id IN (SELECT id FROM affected_jobs)
          )
      ) AS recommendations,
      (SELECT count(*)::int FROM affected_jobs) AS progression_jobs,
      (SELECT count(*)::int FROM progression_job_input_sessions input
        WHERE input.job_id IN (SELECT id FROM affected_jobs)
      ) AS progression_job_input_sessions,
      (SELECT count(*)::int FROM record_versions version
        WHERE version.user_id = ws.user_id
          AND (
            (version.entity_type = 'workout_session' AND version.entity_id = ws.id)
            OR (
              version.entity_type = 'session_exercise'
              AND version.entity_id IN (
                SELECT exercise.id FROM session_exercises exercise
                WHERE exercise.session_id = ws.id
              )
            )
            OR (
              version.entity_type = 'completed_set'
              AND version.entity_id IN (
                SELECT completed.id FROM completed_sets completed
                JOIN session_exercises exercise
                  ON exercise.id = completed.session_exercise_id
                WHERE exercise.session_id = ws.id
              )
            )
          )
      ) AS record_versions
    FROM target ws
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) return null;
  return {
    workouts: Number(row.workouts),
    sessionExerciseGroups: Number(row.session_exercise_groups),
    exerciseOccurrences: Number(row.exercise_occurrences),
    sessionOccurrences: Number(row.session_occurrences),
    sessionOccurrenceMutations: Number(row.session_occurrence_mutations),
    sets: Number(row.sets),
    notes: Number(row.notes),
    contextualNotes: Number(row.contextual_notes),
    painLogs: Number(row.pain_logs),
    fatigueLogs: Number(row.fatigue_logs),
    coachingMessages: Number(row.coaching_messages),
    recommendations: Number(row.recommendations),
    progressionJobs: Number(row.progression_jobs),
    progressionJobInputSessions: Number(row.progression_job_input_sessions),
    recordVersions: Number(row.record_versions),
  };
}

export async function archiveWorkoutRecord(
  db: Db,
  userId: string,
  sessionId: string
): Promise<ArchiveActionResult> {
  const operationId = randomUUID();
  const query = sql`
    WITH owner_history_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), target AS (
      SELECT id, user_id, template_name, started_at
      FROM workout_sessions
      CROSS JOIN owner_history_lock
      WHERE id = ${sessionId}::uuid
        AND user_id = ${userId}::uuid
        AND status IN ('completed', 'abandoned')
        AND archived_at IS NULL
    ), affected_jobs AS (
      SELECT job.id
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND (
          job.session_id IN (SELECT id FROM target)
          OR EXISTS (
            SELECT 1 FROM progression_job_input_sessions input
            WHERE input.job_id = job.id
              AND input.session_id IN (SELECT id FROM target)
          )
        )
    ), counts AS (
      SELECT
        1::int AS workouts,
        (SELECT count(*)::int FROM session_exercise_groups seg
          WHERE seg.session_id = target.id) AS session_exercise_groups,
        (SELECT count(*)::int FROM session_exercises se
          WHERE se.session_id = target.id) AS exercise_occurrences,
        (SELECT count(*)::int FROM session_occurrences occurrence
          WHERE occurrence.session_id = target.id) AS session_occurrences,
        (SELECT count(*)::int FROM session_occurrence_mutations mutation
          JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
          WHERE occurrence.session_id = target.id) AS session_occurrence_mutations,
        (SELECT count(*)::int FROM completed_sets cs
          JOIN session_exercises se ON se.id = cs.session_exercise_id
          WHERE se.session_id = target.id AND cs.archived_at IS NULL) AS sets,
        (SELECT count(*)::int FROM session_notes sn
          WHERE sn.session_id = target.id AND sn.archived_at IS NULL) AS notes,
        (SELECT count(*)::int FROM contextual_notes note
          WHERE note.session_id = target.id AND note.archived_at IS NULL) AS contextual_notes,
        (SELECT count(*)::int FROM pain_logs pl
          WHERE pl.session_id = target.id AND pl.archived_at IS NULL) AS pain_logs,
        (SELECT count(*)::int FROM fatigue_logs fl
          WHERE fl.session_id = target.id AND fl.archived_at IS NULL) AS fatigue_logs,
        (SELECT count(*)::int FROM coaching_insights ci
          WHERE ci.session_id = target.id
            AND ci.kind IN ('live_user', 'live_assistant')
            AND ci.archived_at IS NULL) AS coaching_messages,
        (SELECT count(*)::int FROM recommendations r
          WHERE r.user_id = target.user_id
            AND r.archived_at IS NULL
            AND (
              coalesce(r.evidence->'sessionIds', '[]'::jsonb) ? target.id::text
              OR r.progression_job_id IN (SELECT id FROM affected_jobs)
            )
        ) AS recommendations,
        (SELECT count(*)::int FROM affected_jobs) AS progression_jobs,
        (SELECT count(*)::int FROM progression_job_input_sessions input
          WHERE input.job_id IN (SELECT id FROM affected_jobs)
        ) AS progression_job_input_sessions,
        (SELECT count(*)::int FROM record_versions version
          WHERE version.user_id = target.user_id
            AND (
              (version.entity_type = 'workout_session'
                AND version.entity_id = target.id)
              OR (
                version.entity_type = 'session_exercise'
                AND version.entity_id IN (
                  SELECT exercise.id FROM session_exercises exercise
                  WHERE exercise.session_id = target.id
                )
              )
              OR (
                version.entity_type = 'completed_set'
                AND version.entity_id IN (
                  SELECT completed.id FROM completed_sets completed
                  JOIN session_exercises exercise
                    ON exercise.id = completed.session_exercise_id
                  WHERE exercise.session_id = target.id
                )
              )
            )
        ) AS record_versions
      FROM target
    ), new_operation AS (
      INSERT INTO archive_operations (
        id, user_id, action, status, summary, record_counts
      )
      SELECT
        ${operationId}::uuid,
        ${userId}::uuid,
        'workout.archive',
        'active',
        'Archived ' || coalesce(target.template_name, 'workout') ||
          ' from ' || target.started_at::date,
        jsonb_build_object(
          'workouts', counts.workouts,
          'sessionExerciseGroups', counts.session_exercise_groups,
          'exerciseOccurrences', counts.exercise_occurrences,
          'sessionOccurrences', counts.session_occurrences,
          'sessionOccurrenceMutations', counts.session_occurrence_mutations,
          'sets', counts.sets,
          'notes', counts.notes,
          'contextualNotes', counts.contextual_notes,
          'painLogs', counts.pain_logs,
          'fatigueLogs', counts.fatigue_logs,
          'coachingMessages', counts.coaching_messages,
          'recommendations', counts.recommendations,
          'progressionJobs', counts.progression_jobs,
          'progressionJobInputSessions', counts.progression_job_input_sessions,
          'recordVersions', counts.record_versions
        )
      FROM target CROSS JOIN counts
      RETURNING id, summary, record_counts
    ), archived_workout AS (
      UPDATE workout_sessions
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_recommendations AS (
      UPDATE recommendations
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE user_id = ${userId}::uuid
        AND archived_at IS NULL
        AND (
          coalesce(evidence->'sessionIds', '[]'::jsonb) ? ${sessionId}::text
          OR progression_job_id IN (SELECT id FROM affected_jobs)
        )
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_coaching AS (
      UPDATE coaching_insights
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE user_id = ${userId}::uuid
        AND session_id = ${sessionId}::uuid
        AND kind IN ('live_user', 'live_assistant')
        AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_contextual_notes AS (
      UPDATE contextual_notes
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE user_id = ${userId}::uuid
        AND session_id = ${sessionId}::uuid
        AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), member_input AS (
      SELECT 'workout_session'::text AS entity_type, id::text AS entity_id,
        'root'::text AS relationship_role,
        NULL::text AS parent_entity_type, NULL::text AS parent_entity_id
      FROM archived_workout
      UNION ALL
      SELECT 'session_exercise_group', seg.id::text, 'linked',
        'workout_session', target.id::text
      FROM session_exercise_groups seg CROSS JOIN target
      WHERE seg.session_id = target.id
      UNION ALL
      SELECT 'session_exercise', se.id::text, 'linked',
        'workout_session', target.id::text
      FROM session_exercises se CROSS JOIN target
      WHERE se.session_id = target.id
      UNION ALL
      SELECT 'completed_set', cs.id::text, 'linked',
        'workout_session', target.id::text
      FROM completed_sets cs
      JOIN session_exercises se ON se.id = cs.session_exercise_id
      CROSS JOIN target
      WHERE se.session_id = target.id AND cs.archived_at IS NULL
      UNION ALL
      SELECT 'session_occurrence', occurrence.id::text, 'linked',
        'workout_session', target.id::text
      FROM session_occurrences occurrence CROSS JOIN target
      WHERE occurrence.session_id = target.id
      UNION ALL
      SELECT 'session_occurrence_mutation', mutation.id::text, 'linked',
        'workout_session', target.id::text
      FROM session_occurrence_mutations mutation
      JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
      CROSS JOIN target
      WHERE occurrence.session_id = target.id
      UNION ALL
      SELECT 'session_note', sn.id::text, 'linked',
        'workout_session', target.id::text
      FROM session_notes sn CROSS JOIN target
      WHERE sn.session_id = target.id AND sn.archived_at IS NULL
      UNION ALL
      SELECT 'contextual_note', note.id::text, 'linked',
        'workout_session', target.id::text
      FROM archived_contextual_notes note CROSS JOIN target
      UNION ALL
      SELECT 'pain_log', pl.id::text, 'linked',
        'workout_session', target.id::text
      FROM pain_logs pl CROSS JOIN target
      WHERE pl.session_id = target.id AND pl.archived_at IS NULL
      UNION ALL
      SELECT 'fatigue_log', fl.id::text, 'linked',
        'workout_session', target.id::text
      FROM fatigue_logs fl CROSS JOIN target
      WHERE fl.session_id = target.id AND fl.archived_at IS NULL
      UNION ALL
      SELECT 'coaching_insight', id::text, 'linked',
        'workout_session', ${sessionId}::text
      FROM archived_coaching
      UNION ALL
      SELECT 'recommendation', id::text, 'derived',
        'workout_session', ${sessionId}::text
      FROM archived_recommendations
    ), recorded_members AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role,
        parent_entity_type, parent_entity_id
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid, entity_type, entity_id,
        relationship_role, parent_entity_type, parent_entity_id
      FROM member_input
      WHERE EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'workout.archive', 'workout_session',
        target.id::text, new_operation.summary,
        jsonb_build_object(
          'archiveOperationId', ${operationId}::text,
          'recordCounts', new_operation.record_counts
        )
      FROM target CROSS JOIN new_operation
      RETURNING id
    )
    SELECT id AS operation_id, summary, record_counts FROM new_operation
  `;
  return actionResult(
    resultRows(await db.execute(query))[0],
    "Active completed workout not found."
  );
}

export async function getImportBatchArchivePreview(
  db: Db,
  userId: string,
  batchId: string
): Promise<ImportBatchArchivePreview | null> {
  const query = sql`
    WITH target AS (
      SELECT hib.id, hib.import_event_id, hib.summary, ie.parsed_payload,
        ie.confirmed_payload
      FROM history_import_batches hib
      JOIN import_events ie ON ie.id = hib.import_event_id
      WHERE hib.id = ${batchId}::uuid
        AND hib.user_id = ${userId}::uuid
        AND hib.status = 'confirmed'
        AND hib.archived_at IS NULL
    ), active_sessions AS (
      SELECT ws.id
      FROM workout_sessions ws
      WHERE ws.import_batch_id IN (SELECT id FROM target)
        AND ws.archived_at IS NULL
    ), affected_jobs AS (
      SELECT job.id
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND (
          job.session_id IN (SELECT id FROM active_sessions)
          OR EXISTS (
            SELECT 1 FROM progression_job_input_sessions input
            WHERE input.job_id = job.id
              AND input.session_id IN (SELECT id FROM active_sessions)
          )
        )
    ), linked_mappings AS (
      SELECT DISTINCT eem.id
      FROM external_exercise_mappings eem
      JOIN session_exercises se ON se.source_exercise_name = eem.source_name
      JOIN workout_sessions ws ON ws.id = se.session_id
      WHERE eem.user_id = ${userId}::uuid
        AND eem.source = 'hevy'
        AND ws.import_batch_id IN (SELECT id FROM target)
    )
    SELECT
      1::int AS import_batches,
      1::int AS import_files,
      (SELECT count(*)::int FROM active_sessions) AS workouts,
      (SELECT count(*)::int FROM workout_sessions ws
        WHERE ws.import_batch_id = target.id
          AND ws.archived_at IS NOT NULL) AS previously_archived_workouts,
      (SELECT count(*)::int FROM session_exercise_groups seg
        WHERE seg.session_id IN (SELECT id FROM active_sessions)) AS session_exercise_groups,
      (SELECT count(*)::int FROM session_exercises se
        WHERE se.session_id IN (SELECT id FROM active_sessions)) AS exercise_occurrences,
      (SELECT count(*)::int FROM session_occurrences occurrence
        WHERE occurrence.session_id IN (SELECT id FROM active_sessions)) AS session_occurrences,
      (SELECT count(*)::int FROM session_occurrence_mutations mutation
        JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
        WHERE occurrence.session_id IN (SELECT id FROM active_sessions)) AS session_occurrence_mutations,
      (SELECT count(*)::int FROM completed_sets cs
        JOIN session_exercises se ON se.id = cs.session_exercise_id
        WHERE se.session_id IN (SELECT id FROM active_sessions)
          AND cs.archived_at IS NULL) AS sets,
      (SELECT count(*)::int FROM session_notes sn
        WHERE sn.session_id IN (SELECT id FROM active_sessions)
          AND sn.archived_at IS NULL) AS notes,
      (SELECT count(*)::int FROM contextual_notes note
        WHERE note.session_id IN (SELECT id FROM active_sessions)
          AND note.archived_at IS NULL) AS contextual_notes,
      (SELECT count(*)::int FROM pain_logs pl
        WHERE pl.session_id IN (SELECT id FROM active_sessions)
          AND pl.archived_at IS NULL) AS pain_logs,
      (SELECT count(*)::int FROM fatigue_logs fl
        WHERE fl.session_id IN (SELECT id FROM active_sessions)
          AND fl.archived_at IS NULL) AS fatigue_logs,
      (SELECT count(*)::int FROM coaching_insights ci
        WHERE ci.session_id IN (SELECT id FROM active_sessions)
          AND ci.kind IN ('live_user', 'live_assistant')
          AND ci.archived_at IS NULL) AS coaching_messages,
      (SELECT count(*)::int FROM recommendations r
        WHERE r.user_id = ${userId}::uuid
          AND r.archived_at IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM active_sessions ws
              WHERE coalesce(r.evidence->'sessionIds', '[]'::jsonb) ? ws.id::text
            )
            OR r.progression_job_id IN (SELECT id FROM affected_jobs)
          )) AS recommendations,
      (SELECT count(*)::int FROM affected_jobs) AS progression_jobs,
      (SELECT count(*)::int FROM progression_job_input_sessions input
        WHERE input.job_id IN (SELECT id FROM affected_jobs)
      ) AS progression_job_input_sessions,
      (SELECT count(*)::int FROM record_versions version
        WHERE version.user_id = ${userId}::uuid
          AND (
            (version.entity_type = 'workout_session'
              AND version.entity_id IN (SELECT id FROM active_sessions))
            OR (
              version.entity_type = 'session_exercise'
              AND version.entity_id IN (
                SELECT exercise.id FROM session_exercises exercise
                WHERE exercise.session_id IN (SELECT id FROM active_sessions)
              )
            )
            OR (
              version.entity_type = 'completed_set'
              AND version.entity_id IN (
                SELECT completed.id FROM completed_sets completed
                JOIN session_exercises exercise
                  ON exercise.id = completed.session_exercise_id
                WHERE exercise.session_id IN (SELECT id FROM active_sessions)
              )
            )
          )
      ) AS record_versions,
      (SELECT count(*)::int FROM linked_mappings) AS reviewed_mappings,
      coalesce(
        jsonb_array_length(target.confirmed_payload->'resolutions'),
        jsonb_array_length(coalesce(target.parsed_payload->'exercises', '[]'::jsonb))
      )::int AS review_decisions,
      (SELECT count(*)::int FROM exercises e
        WHERE e.created_from_import_event_id = target.import_event_id) AS custom_exercises,
      coalesce((target.summary->>'warnings')::int, 0) AS warnings
    FROM target
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) return null;
  return {
    importBatches: Number(row.import_batches),
    importFiles: Number(row.import_files),
    workouts: Number(row.workouts),
    previouslyArchivedWorkouts: Number(row.previously_archived_workouts),
    sessionExerciseGroups: Number(row.session_exercise_groups),
    exerciseOccurrences: Number(row.exercise_occurrences),
    sessionOccurrences: Number(row.session_occurrences),
    sessionOccurrenceMutations: Number(row.session_occurrence_mutations),
    sets: Number(row.sets),
    notes: Number(row.notes),
    contextualNotes: Number(row.contextual_notes),
    painLogs: Number(row.pain_logs),
    fatigueLogs: Number(row.fatigue_logs),
    coachingMessages: Number(row.coaching_messages),
    recommendations: Number(row.recommendations),
    progressionJobs: Number(row.progression_jobs),
    progressionJobInputSessions: Number(row.progression_job_input_sessions),
    recordVersions: Number(row.record_versions),
    reviewedMappings: Number(row.reviewed_mappings),
    reviewDecisions: Number(row.review_decisions),
    customExercises: Number(row.custom_exercises),
    warnings: Number(row.warnings),
  };
}

export async function archiveImportBatchRecord(
  db: Db,
  userId: string,
  batchId: string,
  expected?: ImportBatchArchivePreview
): Promise<ArchiveActionResult> {
  const operationId = randomUUID();
  const expectedCounts = expected ? JSON.stringify(expected) : null;
  const query = sql`
    WITH owner_history_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), target AS (
      SELECT hib.id, hib.import_event_id, hib.original_filename, hib.summary,
        ie.parsed_payload, ie.confirmed_payload
      FROM history_import_batches hib
      JOIN import_events ie ON ie.id = hib.import_event_id
      CROSS JOIN owner_history_lock
      WHERE hib.id = ${batchId}::uuid
        AND hib.user_id = ${userId}::uuid
        AND hib.status = 'confirmed'
        AND hib.archived_at IS NULL
    ), active_sessions AS (
      SELECT ws.id
      FROM workout_sessions ws
      WHERE ws.import_batch_id IN (SELECT id FROM target)
        AND ws.archived_at IS NULL
    ), affected_jobs AS (
      SELECT job.id
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND (
          job.session_id IN (SELECT id FROM active_sessions)
          OR EXISTS (
            SELECT 1 FROM progression_job_input_sessions input
            WHERE input.job_id = job.id
              AND input.session_id IN (SELECT id FROM active_sessions)
          )
        )
    ), linked_mappings AS (
      SELECT DISTINCT eem.id
      FROM external_exercise_mappings eem
      JOIN session_exercises se ON se.source_exercise_name = eem.source_name
      JOIN workout_sessions ws ON ws.id = se.session_id
      WHERE eem.user_id = ${userId}::uuid
        AND eem.source = 'hevy'
        AND ws.import_batch_id IN (SELECT id FROM target)
    ), created_exercises AS (
      SELECT e.id
      FROM exercises e
      WHERE e.created_from_import_event_id IN (SELECT import_event_id FROM target)
    ), linked_recommendations AS (
      SELECT r.id
      FROM recommendations r
      WHERE r.user_id = ${userId}::uuid
        AND r.archived_at IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM active_sessions ws
            WHERE coalesce(r.evidence->'sessionIds', '[]'::jsonb) ? ws.id::text
          )
          OR r.progression_job_id IN (SELECT id FROM affected_jobs)
        )
    ), linked_coaching AS (
      SELECT ci.id
      FROM coaching_insights ci
      WHERE ci.user_id = ${userId}::uuid
        AND ci.session_id IN (SELECT id FROM active_sessions)
        AND ci.kind IN ('live_user', 'live_assistant')
        AND ci.archived_at IS NULL
    ), counts AS (
      SELECT
        1::int AS import_batches,
        1::int AS import_files,
        (SELECT count(*)::int FROM active_sessions) AS workouts,
        (SELECT count(*)::int FROM workout_sessions ws
          WHERE ws.import_batch_id = target.id
            AND ws.archived_at IS NOT NULL) AS previously_archived_workouts,
        (SELECT count(*)::int FROM session_exercise_groups seg
          WHERE seg.session_id IN (SELECT id FROM active_sessions)) AS session_exercise_groups,
        (SELECT count(*)::int FROM session_exercises se
          WHERE se.session_id IN (SELECT id FROM active_sessions)) AS exercise_occurrences,
        (SELECT count(*)::int FROM session_occurrences occurrence
          WHERE occurrence.session_id IN (SELECT id FROM active_sessions)) AS session_occurrences,
        (SELECT count(*)::int FROM session_occurrence_mutations mutation
          JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
          WHERE occurrence.session_id IN (SELECT id FROM active_sessions)) AS session_occurrence_mutations,
        (SELECT count(*)::int FROM completed_sets cs
          JOIN session_exercises se ON se.id = cs.session_exercise_id
          WHERE se.session_id IN (SELECT id FROM active_sessions)
            AND cs.archived_at IS NULL) AS sets,
        (SELECT count(*)::int FROM session_notes sn
          WHERE sn.session_id IN (SELECT id FROM active_sessions)
            AND sn.archived_at IS NULL) AS notes,
        (SELECT count(*)::int FROM contextual_notes note
          WHERE note.session_id IN (SELECT id FROM active_sessions)
            AND note.archived_at IS NULL) AS contextual_notes,
        (SELECT count(*)::int FROM pain_logs pl
          WHERE pl.session_id IN (SELECT id FROM active_sessions)
            AND pl.archived_at IS NULL) AS pain_logs,
        (SELECT count(*)::int FROM fatigue_logs fl
          WHERE fl.session_id IN (SELECT id FROM active_sessions)
            AND fl.archived_at IS NULL) AS fatigue_logs,
        (SELECT count(*)::int FROM linked_coaching) AS coaching_messages,
        (SELECT count(*)::int FROM linked_recommendations) AS recommendations,
        (SELECT count(*)::int FROM affected_jobs) AS progression_jobs,
        (SELECT count(*)::int FROM progression_job_input_sessions input
          WHERE input.job_id IN (SELECT id FROM affected_jobs)
        ) AS progression_job_input_sessions,
        (SELECT count(*)::int FROM record_versions version
          WHERE version.user_id = ${userId}::uuid
            AND (
              (version.entity_type = 'workout_session'
                AND version.entity_id IN (SELECT id FROM active_sessions))
              OR (
                version.entity_type = 'session_exercise'
                AND version.entity_id IN (
                  SELECT exercise.id FROM session_exercises exercise
                  WHERE exercise.session_id IN (SELECT id FROM active_sessions)
                )
              )
              OR (
                version.entity_type = 'completed_set'
                AND version.entity_id IN (
                  SELECT completed.id FROM completed_sets completed
                  JOIN session_exercises exercise
                    ON exercise.id = completed.session_exercise_id
                  WHERE exercise.session_id IN (SELECT id FROM active_sessions)
                )
              )
            )
        ) AS record_versions,
        (SELECT count(*)::int FROM linked_mappings) AS reviewed_mappings,
        coalesce(
          jsonb_array_length(target.confirmed_payload->'resolutions'),
          jsonb_array_length(coalesce(target.parsed_payload->'exercises', '[]'::jsonb))
        )::int AS review_decisions,
        (SELECT count(*)::int FROM created_exercises) AS custom_exercises,
        coalesce((target.summary->>'warnings')::int, 0) AS warnings
      FROM target
    ), scope AS (
      SELECT counts.*, jsonb_build_object(
        'importBatches', counts.import_batches,
        'importFiles', counts.import_files,
        'workouts', counts.workouts,
        'previouslyArchivedWorkouts', counts.previously_archived_workouts,
        'sessionExerciseGroups', counts.session_exercise_groups,
        'exerciseOccurrences', counts.exercise_occurrences,
        'sessionOccurrences', counts.session_occurrences,
        'sessionOccurrenceMutations', counts.session_occurrence_mutations,
        'sets', counts.sets,
        'notes', counts.notes,
        'contextualNotes', counts.contextual_notes,
        'painLogs', counts.pain_logs,
        'fatigueLogs', counts.fatigue_logs,
        'coachingMessages', counts.coaching_messages,
        'recommendations', counts.recommendations,
        'progressionJobs', counts.progression_jobs,
        'progressionJobInputSessions', counts.progression_job_input_sessions,
        'recordVersions', counts.record_versions,
        'reviewedMappings', counts.reviewed_mappings,
        'reviewDecisions', counts.review_decisions,
        'customExercises', counts.custom_exercises,
        'warnings', counts.warnings
      ) AS record_counts
      FROM counts
    ), new_operation AS (
      INSERT INTO archive_operations (
        id, user_id, action, status, summary, record_counts
      )
      SELECT
        ${operationId}::uuid,
        ${userId}::uuid,
        'history_import_batch.archive',
        'active',
        'Archived Hevy import ' || target.original_filename,
        scope.record_counts
      FROM target CROSS JOIN scope
      WHERE ${expectedCounts}::jsonb IS NULL
        OR scope.record_counts = ${expectedCounts}::jsonb
      RETURNING id, summary, record_counts
    ), archived_batch AS (
      UPDATE history_import_batches
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_sessions AS (
      UPDATE workout_sessions
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM active_sessions)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_recommendations AS (
      UPDATE recommendations
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM linked_recommendations)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_coaching AS (
      UPDATE coaching_insights
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM linked_coaching)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_contextual_notes AS (
      UPDATE contextual_notes
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE user_id = ${userId}::uuid
        AND session_id IN (SELECT id FROM active_sessions)
        AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), member_input AS (
      SELECT 'history_import_batch'::text AS entity_type, id::text AS entity_id,
        'root'::text AS relationship_role,
        NULL::text AS parent_entity_type, NULL::text AS parent_entity_id
      FROM archived_batch
      UNION ALL
      SELECT 'import_event', target.import_event_id::text, 'preserved',
        'history_import_batch', target.id::text
      FROM target
      UNION ALL
      SELECT 'workout_session', id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM archived_sessions
      UNION ALL
      SELECT 'session_exercise_group', seg.id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM session_exercise_groups seg
      WHERE seg.session_id IN (SELECT id FROM active_sessions)
      UNION ALL
      SELECT 'session_exercise', se.id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM session_exercises se
      WHERE se.session_id IN (SELECT id FROM active_sessions)
      UNION ALL
      SELECT 'completed_set', cs.id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM completed_sets cs
      JOIN session_exercises se ON se.id = cs.session_exercise_id
      WHERE se.session_id IN (SELECT id FROM active_sessions)
        AND cs.archived_at IS NULL
      UNION ALL
      SELECT 'session_occurrence', occurrence.id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM session_occurrences occurrence
      WHERE occurrence.session_id IN (SELECT id FROM active_sessions)
      UNION ALL
      SELECT 'session_occurrence_mutation', mutation.id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM session_occurrence_mutations mutation
      JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
      WHERE occurrence.session_id IN (SELECT id FROM active_sessions)
      UNION ALL
      SELECT 'session_note', sn.id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM session_notes sn
      WHERE sn.session_id IN (SELECT id FROM active_sessions)
        AND sn.archived_at IS NULL
      UNION ALL
      SELECT 'contextual_note', note.id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM archived_contextual_notes note
      UNION ALL
      SELECT 'pain_log', pl.id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM pain_logs pl
      WHERE pl.session_id IN (SELECT id FROM active_sessions)
        AND pl.archived_at IS NULL
      UNION ALL
      SELECT 'fatigue_log', fl.id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM fatigue_logs fl
      WHERE fl.session_id IN (SELECT id FROM active_sessions)
        AND fl.archived_at IS NULL
      UNION ALL
      SELECT 'coaching_insight', id::text, 'linked',
        'history_import_batch', ${batchId}::text
      FROM archived_coaching
      UNION ALL
      SELECT 'recommendation', id::text, 'derived',
        'history_import_batch', ${batchId}::text
      FROM archived_recommendations
      UNION ALL
      SELECT 'exercise', id::text, 'preserved',
        'history_import_batch', ${batchId}::text
      FROM created_exercises
      UNION ALL
      SELECT 'external_exercise_mapping', id::text, 'preserved',
        'history_import_batch', ${batchId}::text
      FROM linked_mappings
    ), recorded_members AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role,
        parent_entity_type, parent_entity_id
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid, entity_type, entity_id,
        relationship_role, parent_entity_type, parent_entity_id
      FROM member_input
      WHERE EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'history_import_batch.archive',
        'history_import_batch', target.id::text, new_operation.summary,
        jsonb_build_object(
          'archiveOperationId', ${operationId}::text,
          'recordCounts', new_operation.record_counts,
          'importEventId', target.import_event_id::text
        )
      FROM target CROSS JOIN new_operation
      RETURNING id
    )
    SELECT id AS operation_id, summary, record_counts FROM new_operation
  `;
  return actionResult(
    resultRows(await db.execute(query))[0],
    "Active confirmed import batch not found."
  );
}

export async function getBulkActivityArchivePreview(
  db: Db,
  userId: string
): Promise<BulkActivityArchivePreview> {
  const row = resultRows(
    await db.execute(sql`
      SELECT count(*)::int AS activities,
        min(started_at)::date::text AS earliest,
        max(started_at)::date::text AS latest
      FROM health_activities
      WHERE user_id = ${userId}::uuid
        AND source = 'manual'
        AND archived_at IS NULL
    `)
  )[0];
  return {
    activities: Number(row?.activities ?? 0),
    earliest: row?.earliest == null ? null : String(row.earliest),
    latest: row?.latest == null ? null : String(row.latest),
  };
}

/**
 * Bulk archive of every active manual activity as one atomic operation.
 * The caller's previewed count is revalidated inside the statement, so a
 * stale confirmation makes no changes. Activities archived earlier keep
 * their original operation and are not claimed by this one.
 */
export async function archiveAllManualActivityRecords(
  db: Db,
  userId: string,
  expectedActivities: number
): Promise<ArchiveActionResult> {
  const operationId = randomUUID();
  const query = sql`
    WITH target AS (
      SELECT id, started_at
      FROM health_activities
      WHERE user_id = ${userId}::uuid
        AND source = 'manual'
        AND archived_at IS NULL
    ), counts AS (
      SELECT count(*)::int AS activities,
        min(started_at)::date AS earliest,
        max(started_at)::date AS latest
      FROM target
    ), new_operation AS (
      INSERT INTO archive_operations (
        id, user_id, action, status, summary, record_counts
      )
      SELECT
        ${operationId}::uuid,
        ${userId}::uuid,
        'activity_history.archive',
        'active',
        'Archived all ' || counts.activities || ' manual activities (' ||
          counts.earliest || ' to ' || counts.latest || ')',
        jsonb_build_object('activities', counts.activities)
      FROM counts
      WHERE counts.activities > 0
        AND counts.activities = ${expectedActivities}::int
      RETURNING id, summary, record_counts
    ), archived_activities AS (
      UPDATE health_activities
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), member_input AS (
      SELECT 'activity_history'::text AS entity_type,
        ${operationId}::text AS entity_id, 'root'::text AS relationship_role,
        NULL::text AS parent_entity_type, NULL::text AS parent_entity_id
      WHERE EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'health_activity', id::text, 'linked',
        'activity_history', ${operationId}::text
      FROM archived_activities
    ), recorded_members AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role,
        parent_entity_type, parent_entity_id
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid, entity_type, entity_id,
        relationship_role, parent_entity_type, parent_entity_id
      FROM member_input
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'activity_history.archive',
        'archive_operation', new_operation.id::text, new_operation.summary,
        jsonb_build_object(
          'archiveOperationId', ${operationId}::text,
          'recordCounts', new_operation.record_counts
        )
      FROM new_operation
      RETURNING id
    )
    SELECT id AS operation_id, summary, record_counts FROM new_operation
  `;
  return actionResult(
    resultRows(await db.execute(query))[0],
    "The activity list changed since the preview. Review the updated count and confirm again."
  );
}

export async function getSampleHistoryArchivePreview(
  db: Db,
  userId: string
): Promise<SampleHistoryArchivePreview> {
  const prefixPattern = `${TEST_DATA_PREFIX}%`;
  const row = resultRows(
    await db.execute(sql`
      WITH target AS (
        SELECT id, user_id FROM workout_sessions
        WHERE user_id = ${userId}::uuid
          AND template_name LIKE ${prefixPattern}
          AND archived_at IS NULL
      ), affected_jobs AS (
        SELECT job.id
        FROM progression_jobs job
        WHERE job.user_id = ${userId}::uuid
          AND (
            job.session_id IN (SELECT id FROM target)
            OR EXISTS (
              SELECT 1 FROM progression_job_input_sessions input
              WHERE input.job_id = job.id
                AND input.session_id IN (SELECT id FROM target)
            )
          )
      )
      SELECT
        (SELECT count(*)::int FROM target) AS workouts,
        (SELECT count(*)::int FROM session_exercise_groups seg
          WHERE seg.session_id IN (SELECT id FROM target)) AS session_exercise_groups,
        (SELECT count(*)::int FROM session_exercises se
          WHERE se.session_id IN (SELECT id FROM target)) AS exercise_occurrences,
        (SELECT count(*)::int FROM session_occurrences occurrence
          WHERE occurrence.session_id IN (SELECT id FROM target)) AS session_occurrences,
        (SELECT count(*)::int FROM session_occurrence_mutations mutation
          JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
          WHERE occurrence.session_id IN (SELECT id FROM target)) AS session_occurrence_mutations,
        (SELECT count(*)::int FROM completed_sets cs
          JOIN session_exercises se ON se.id = cs.session_exercise_id
          WHERE se.session_id IN (SELECT id FROM target)
            AND cs.archived_at IS NULL) AS sets,
        (SELECT count(*)::int FROM session_notes sn
          WHERE sn.session_id IN (SELECT id FROM target)
            AND sn.archived_at IS NULL) AS notes,
        (SELECT count(*)::int FROM contextual_notes note
          WHERE note.session_id IN (SELECT id FROM target)
            AND note.archived_at IS NULL) AS contextual_notes,
        (SELECT count(*)::int FROM pain_logs pl
          WHERE pl.session_id IN (SELECT id FROM target)
            AND pl.archived_at IS NULL) AS pain_logs,
        (SELECT count(*)::int FROM fatigue_logs fl
          WHERE fl.session_id IN (SELECT id FROM target)
            AND fl.archived_at IS NULL) AS fatigue_logs,
        (SELECT count(*)::int FROM coaching_insights ci
          WHERE ci.session_id IN (SELECT id FROM target)
            AND ci.kind IN ('live_user', 'live_assistant')
            AND ci.archived_at IS NULL) AS coaching_messages,
        (SELECT count(*)::int FROM recommendations r
          WHERE r.user_id = ${userId}::uuid
            AND r.archived_at IS NULL
            AND (
              EXISTS (
                SELECT 1 FROM target
                WHERE coalesce(r.evidence->'sessionIds', '[]'::jsonb) ? target.id::text
              )
              OR r.progression_job_id IN (SELECT id FROM affected_jobs)
            )) AS recommendations,
        (SELECT count(*)::int FROM affected_jobs) AS progression_jobs,
        (SELECT count(*)::int FROM progression_job_input_sessions input
          WHERE input.job_id IN (SELECT id FROM affected_jobs)
        ) AS progression_job_input_sessions,
        (SELECT count(*)::int FROM record_versions version
          WHERE version.user_id = ${userId}::uuid
            AND (
              (version.entity_type = 'workout_session'
                AND version.entity_id IN (SELECT id FROM target))
              OR (
                version.entity_type = 'session_exercise'
                AND version.entity_id IN (
                  SELECT exercise.id FROM session_exercises exercise
                  WHERE exercise.session_id IN (SELECT id FROM target)
                )
              )
              OR (
                version.entity_type = 'completed_set'
                AND version.entity_id IN (
                  SELECT completed.id FROM completed_sets completed
                  JOIN session_exercises exercise
                    ON exercise.id = completed.session_exercise_id
                  WHERE exercise.session_id IN (SELECT id FROM target)
                )
              )
            )
        ) AS record_versions
    `)
  )[0];
  return {
    workouts: Number(row?.workouts ?? 0),
    sessionExerciseGroups: Number(row?.session_exercise_groups ?? 0),
    exerciseOccurrences: Number(row?.exercise_occurrences ?? 0),
    sessionOccurrences: Number(row?.session_occurrences ?? 0),
    sessionOccurrenceMutations: Number(row?.session_occurrence_mutations ?? 0),
    sets: Number(row?.sets ?? 0),
    notes: Number(row?.notes ?? 0),
    contextualNotes: Number(row?.contextual_notes ?? 0),
    painLogs: Number(row?.pain_logs ?? 0),
    fatigueLogs: Number(row?.fatigue_logs ?? 0),
    coachingMessages: Number(row?.coaching_messages ?? 0),
    recommendations: Number(row?.recommendations ?? 0),
    progressionJobs: Number(row?.progression_jobs ?? 0),
    progressionJobInputSessions: Number(
      row?.progression_job_input_sessions ?? 0
    ),
    recordVersions: Number(row?.record_versions ?? 0),
  };
}

/**
 * Bulk archive of every active sample workout (template name carries the
 * sample-data prefix) plus their linked evidence, exactly like a single
 * workout archive but as one operation with one Undo. The full previewed
 * scope is revalidated inside the statement, so a stale confirmation makes
 * no changes. Sample rows keep their IDs, children, and provenance.
 */
export async function archiveSampleHistoryRecords(
  db: Db,
  userId: string,
  expected: SampleHistoryArchivePreview
): Promise<ArchiveActionResult> {
  const operationId = randomUUID();
  const prefixPattern = `${TEST_DATA_PREFIX}%`;
  const expectedCounts = JSON.stringify(expected);
  const query = sql`
    WITH owner_history_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), target AS (
      SELECT id FROM workout_sessions
      CROSS JOIN owner_history_lock
      WHERE user_id = ${userId}::uuid
        AND template_name LIKE ${prefixPattern}
        AND archived_at IS NULL
    ), affected_jobs AS (
      SELECT job.id
      FROM progression_jobs job
      WHERE job.user_id = ${userId}::uuid
        AND (
          job.session_id IN (SELECT id FROM target)
          OR EXISTS (
            SELECT 1 FROM progression_job_input_sessions input
            WHERE input.job_id = job.id
              AND input.session_id IN (SELECT id FROM target)
          )
        )
    ), linked_recommendations AS (
      SELECT r.id
      FROM recommendations r
      WHERE r.user_id = ${userId}::uuid
        AND r.archived_at IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM target
            WHERE coalesce(r.evidence->'sessionIds', '[]'::jsonb) ? target.id::text
          )
          OR r.progression_job_id IN (SELECT id FROM affected_jobs)
        )
    ), linked_coaching AS (
      SELECT ci.id
      FROM coaching_insights ci
      WHERE ci.user_id = ${userId}::uuid
        AND ci.session_id IN (SELECT id FROM target)
        AND ci.kind IN ('live_user', 'live_assistant')
        AND ci.archived_at IS NULL
    ), counts AS (
      SELECT
        (SELECT count(*)::int FROM target) AS workouts,
        (SELECT count(*)::int FROM session_exercise_groups seg
          WHERE seg.session_id IN (SELECT id FROM target)) AS session_exercise_groups,
        (SELECT count(*)::int FROM session_exercises se
          WHERE se.session_id IN (SELECT id FROM target)) AS exercise_occurrences,
        (SELECT count(*)::int FROM session_occurrences occurrence
          WHERE occurrence.session_id IN (SELECT id FROM target)) AS session_occurrences,
        (SELECT count(*)::int FROM session_occurrence_mutations mutation
          JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
          WHERE occurrence.session_id IN (SELECT id FROM target)) AS session_occurrence_mutations,
        (SELECT count(*)::int FROM completed_sets cs
          JOIN session_exercises se ON se.id = cs.session_exercise_id
          WHERE se.session_id IN (SELECT id FROM target)
            AND cs.archived_at IS NULL) AS sets,
        (SELECT count(*)::int FROM session_notes sn
          WHERE sn.session_id IN (SELECT id FROM target)
            AND sn.archived_at IS NULL) AS notes,
        (SELECT count(*)::int FROM contextual_notes note
          WHERE note.session_id IN (SELECT id FROM target)
            AND note.archived_at IS NULL) AS contextual_notes,
        (SELECT count(*)::int FROM pain_logs pl
          WHERE pl.session_id IN (SELECT id FROM target)
            AND pl.archived_at IS NULL) AS pain_logs,
        (SELECT count(*)::int FROM fatigue_logs fl
          WHERE fl.session_id IN (SELECT id FROM target)
            AND fl.archived_at IS NULL) AS fatigue_logs,
        (SELECT count(*)::int FROM linked_coaching) AS coaching_messages,
        (SELECT count(*)::int FROM linked_recommendations) AS recommendations,
        (SELECT count(*)::int FROM affected_jobs) AS progression_jobs,
        (SELECT count(*)::int FROM progression_job_input_sessions input
          WHERE input.job_id IN (SELECT id FROM affected_jobs)
        ) AS progression_job_input_sessions,
        (SELECT count(*)::int FROM record_versions version
          WHERE version.user_id = ${userId}::uuid
            AND (
              (version.entity_type = 'workout_session'
                AND version.entity_id IN (SELECT id FROM target))
              OR (
                version.entity_type = 'session_exercise'
                AND version.entity_id IN (
                  SELECT exercise.id FROM session_exercises exercise
                  WHERE exercise.session_id IN (SELECT id FROM target)
                )
              )
              OR (
                version.entity_type = 'completed_set'
                AND version.entity_id IN (
                  SELECT completed.id FROM completed_sets completed
                  JOIN session_exercises exercise
                    ON exercise.id = completed.session_exercise_id
                  WHERE exercise.session_id IN (SELECT id FROM target)
                )
              )
            )
        ) AS record_versions
    ), scope AS (
      SELECT counts.*, jsonb_build_object(
        'workouts', counts.workouts,
        'sessionExerciseGroups', counts.session_exercise_groups,
        'exerciseOccurrences', counts.exercise_occurrences,
        'sessionOccurrences', counts.session_occurrences,
        'sessionOccurrenceMutations', counts.session_occurrence_mutations,
        'sets', counts.sets,
        'notes', counts.notes,
        'contextualNotes', counts.contextual_notes,
        'painLogs', counts.pain_logs,
        'fatigueLogs', counts.fatigue_logs,
        'coachingMessages', counts.coaching_messages,
        'recommendations', counts.recommendations,
        'progressionJobs', counts.progression_jobs,
        'progressionJobInputSessions', counts.progression_job_input_sessions,
        'recordVersions', counts.record_versions
      ) AS record_counts
      FROM counts
    ), new_operation AS (
      INSERT INTO archive_operations (
        id, user_id, action, status, summary, record_counts
      )
      SELECT
        ${operationId}::uuid,
        ${userId}::uuid,
        'sample_history.archive',
        'active',
        'Archived ' || scope.workouts || ' sample workouts and linked records',
        scope.record_counts
      FROM scope
      WHERE scope.workouts > 0
        AND scope.record_counts = ${expectedCounts}::jsonb
      RETURNING id, summary, record_counts
    ), archived_sessions AS (
      UPDATE workout_sessions
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_recommendations AS (
      UPDATE recommendations
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM linked_recommendations)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_coaching AS (
      UPDATE coaching_insights
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE id IN (SELECT id FROM linked_coaching)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), archived_contextual_notes AS (
      UPDATE contextual_notes
      SET archived_at = now(), archive_operation_id = ${operationId}::uuid
      WHERE user_id = ${userId}::uuid
        AND session_id IN (SELECT id FROM target)
        AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING id
    ), member_input AS (
      SELECT 'sample_history'::text AS entity_type,
        ${operationId}::text AS entity_id, 'root'::text AS relationship_role,
        NULL::text AS parent_entity_type, NULL::text AS parent_entity_id
      WHERE EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'workout_session', id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM archived_sessions
      UNION ALL
      SELECT 'session_exercise_group', seg.id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM session_exercise_groups seg
      WHERE seg.session_id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'session_exercise', se.id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM session_exercises se
      WHERE se.session_id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'completed_set', cs.id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM completed_sets cs
      JOIN session_exercises se ON se.id = cs.session_exercise_id
      WHERE se.session_id IN (SELECT id FROM target)
        AND cs.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'session_occurrence', occurrence.id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM session_occurrences occurrence
      WHERE occurrence.session_id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'session_occurrence_mutation', mutation.id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM session_occurrence_mutations mutation
      JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
      WHERE occurrence.session_id IN (SELECT id FROM target)
        AND EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'session_note', sn.id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM session_notes sn
      WHERE sn.session_id IN (SELECT id FROM target)
        AND sn.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'contextual_note', note.id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM archived_contextual_notes note
      UNION ALL
      SELECT 'pain_log', pl.id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM pain_logs pl
      WHERE pl.session_id IN (SELECT id FROM target)
        AND pl.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'fatigue_log', fl.id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM fatigue_logs fl
      WHERE fl.session_id IN (SELECT id FROM target)
        AND fl.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'coaching_insight', id::text, 'linked',
        'sample_history', ${operationId}::text
      FROM archived_coaching
      UNION ALL
      SELECT 'recommendation', id::text, 'derived',
        'sample_history', ${operationId}::text
      FROM archived_recommendations
    ), recorded_members AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role,
        parent_entity_type, parent_entity_id
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid, entity_type, entity_id,
        relationship_role, parent_entity_type, parent_entity_id
      FROM member_input
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'sample_history.archive',
        'archive_operation', new_operation.id::text, new_operation.summary,
        jsonb_build_object(
          'archiveOperationId', ${operationId}::text,
          'recordCounts', new_operation.record_counts
        )
      FROM new_operation
      RETURNING id
    )
    SELECT id AS operation_id, summary, record_counts FROM new_operation
  `;
  return actionResult(
    resultRows(await db.execute(query))[0],
    "The sample history changed since the preview. Review the updated scope and confirm again."
  );
}

export async function restoreArchiveOperation(
  db: Db,
  userId: string,
  operationId: string
): Promise<ArchiveActionResult> {
  const query = sql`
    WITH owner_history_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), target AS (
      SELECT id, action, summary, record_counts
      FROM archive_operations
      CROSS JOIN owner_history_lock
      WHERE id = ${operationId}::uuid
        AND user_id = ${userId}::uuid
        AND status = 'active'
    ), restored_workouts AS (
      UPDATE workout_sessions
      SET archived_at = NULL,
          archive_operation_id = NULL,
          history_revision = CASE
            WHEN status = 'completed' THEN history_revision + 1
            ELSE history_revision
          END
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id, user_id, status, history_revision
    ), restored_sets AS (
      UPDATE completed_sets SET archived_at = NULL, archive_operation_id = NULL
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id
    ), restored_activities AS (
      UPDATE health_activities SET archived_at = NULL, archive_operation_id = NULL
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id
    ), restored_notes AS (
      UPDATE session_notes SET archived_at = NULL, archive_operation_id = NULL
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id
    ), restored_contextual_notes AS (
      UPDATE contextual_notes SET archived_at = NULL, archive_operation_id = NULL
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id
    ), restored_pain AS (
      UPDATE pain_logs SET archived_at = NULL, archive_operation_id = NULL
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id
    ), restored_fatigue AS (
      UPDATE fatigue_logs SET archived_at = NULL, archive_operation_id = NULL
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id
    ), restored_programs AS (
      UPDATE programs SET archived_at = NULL, archive_operation_id = NULL
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id
    ), restored_batches AS (
      UPDATE history_import_batches SET archived_at = NULL, archive_operation_id = NULL
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id
    ), restored_recommendations AS (
      UPDATE recommendations SET archived_at = NULL, archive_operation_id = NULL
      WHERE (
          archive_operation_id IN (SELECT id FROM target)
          OR id::text IN (
            SELECT member.entity_id
            FROM archive_operation_records member
            WHERE member.operation_id IN (SELECT id FROM target)
              AND member.user_id = ${userId}::uuid
              AND member.entity_type = 'recommendation'
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM archive_operation_records other_member
          JOIN archive_operations other_operation
            ON other_operation.id = other_member.operation_id
          WHERE other_operation.user_id = ${userId}::uuid
            AND other_operation.status = 'active'
            AND other_operation.id NOT IN (SELECT id FROM target)
            AND other_member.entity_type = 'recommendation'
            AND other_member.entity_id = recommendations.id::text
        )
      RETURNING id
    ), restored_insights AS (
      UPDATE coaching_insights SET archived_at = NULL, archive_operation_id = NULL
      WHERE archive_operation_id IN (SELECT id FROM target)
      RETURNING id
    ), affected_completed_set_sessions AS MATERIALIZED (
      SELECT DISTINCT session.id, session.user_id, session.history_revision
      FROM workout_sessions session
      WHERE session.user_id = ${userId}::uuid
        AND session.status = 'completed'
        AND session.id NOT IN (SELECT id FROM restored_workouts)
        AND EXISTS (
          SELECT 1
          FROM completed_sets completed
          JOIN session_exercises exercise
            ON exercise.id = completed.session_exercise_id
          WHERE completed.id IN (SELECT id FROM restored_sets)
            AND exercise.session_id = session.id
        )
    ), revised_set_sessions AS (
      UPDATE workout_sessions session
      SET history_revision = session.history_revision + 1
      FROM affected_completed_set_sessions affected
      WHERE session.id = affected.id
        AND session.history_revision = affected.history_revision
      RETURNING session.id, session.user_id, session.history_revision
    ), revised_sessions AS MATERIALIZED (
      SELECT id, user_id, history_revision
      FROM restored_workouts
      WHERE status = 'completed'
      UNION ALL
      SELECT id, user_id, history_revision
      FROM revised_set_sessions
    ), affected_lineages AS MATERIALIZED (
      SELECT DISTINCT exercise.source_slot_lineage_id
      FROM session_exercises exercise
      JOIN revised_sessions revised ON revised.id = exercise.session_id
      WHERE exercise.source_slot_lineage_id IS NOT NULL
        AND (
          exercise.session_id IN (SELECT id FROM restored_workouts)
          OR EXISTS (
            SELECT 1
            FROM completed_sets completed
            WHERE completed.id IN (SELECT id FROM restored_sets)
              AND completed.session_exercise_id = exercise.id
          )
        )
    ), reconciled_recommendations AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          reconciled_at = statement_timestamp(),
          reconciliation_reason =
            'Archived workout evidence was restored, so this suggestion no longer reflects the current workout history.'
      WHERE recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.source_slot_lineage_id IN (
          SELECT source_slot_lineage_id FROM affected_lineages
        )
      RETURNING recommendation.id
    ), queued_progression AS (
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision,
        coaching_prefs, next_attempt_at
      )
      SELECT
        gen_random_uuid(),
        revised.user_id,
        revised.id,
        revised.history_revision,
        profile.coaching_prefs,
        statement_timestamp()
      FROM revised_sessions revised
      JOIN user_profiles profile ON profile.user_id = revised.user_id
      ON CONFLICT (session_id, source_session_revision) DO NOTHING
      RETURNING id
    ), restored_operation AS (
      UPDATE archive_operations
      SET status = 'restored', restored_at = now()
      WHERE id IN (SELECT id FROM target)
      RETURNING id, summary, record_counts
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'archive.restore', 'archive_operation',
        restored_operation.id::text,
        'Restored archived records: ' || restored_operation.summary,
        jsonb_build_object(
          'archiveOperationId', restored_operation.id::text,
          'recordCounts', restored_operation.record_counts,
          'revisedWorkoutCount', (SELECT count(*) FROM revised_sessions),
          'progressionJobCount', (SELECT count(*) FROM queued_progression)
        )
      FROM restored_operation
      RETURNING id
    )
    SELECT id AS operation_id, summary, record_counts FROM restored_operation
  `;
  return actionResult(
    resultRows(await db.execute(query))[0],
    "Active archive operation not found."
  );
}

export type ArchiveRootEntityType =
  | "workout_session"
  | "health_activity"
  | "completed_set"
  | "history_import_batch"
  | "activity_history"
  | "sample_history"
  | "ai_history";

export async function getArchiveList(
  db: Db,
  userId: string,
  entityTypes?: ArchiveRootEntityType[],
  archivedFrom?: Date,
  archivedUntil?: Date
): Promise<ArchiveListItem[]> {
  const operations = await db.query.archiveOperations.findMany({
    where: and(
      eq(archiveOperations.userId, userId),
      eq(archiveOperations.status, "active"),
      ...(archivedFrom ? [gte(archiveOperations.createdAt, archivedFrom)] : []),
      ...(archivedUntil ? [lte(archiveOperations.createdAt, archivedUntil)] : [])
    ),
    orderBy: desc(archiveOperations.createdAt),
    with: {
      records: {
        where: entityTypes?.length
          ? and(
              eq(archiveOperationRecords.relationshipRole, "root"),
              inArray(archiveOperationRecords.entityType, entityTypes)
            )
          : eq(archiveOperationRecords.relationshipRole, "root"),
      },
    },
  });

  return operations.flatMap((operation) =>
    operation.records.map((record) => ({
      operationId: operation.id,
      action: operation.action,
      summary: operation.summary,
      counts: operation.recordCounts,
      archivedAt: operation.createdAt,
      rootType: record.entityType,
      rootId: record.entityId,
    }))
  );
}

export async function getSetParentSessionId(
  db: Db,
  setId: string
): Promise<string | null> {
  const row = await db
    .select({ sessionId: sessionExercises.sessionId })
    .from(completedSets)
    .innerJoin(
      sessionExercises,
      eq(completedSets.sessionExerciseId, sessionExercises.id)
    )
    .where(eq(completedSets.id, setId))
    .limit(1);
  return row[0]?.sessionId ?? null;
}
