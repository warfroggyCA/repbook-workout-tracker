import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import type { WorkoutTimingCorrectionInput } from "@/lib/workout-timing-correction";
import { normalizeWorkoutTimingCorrection } from "@/lib/workout-timing-correction";
import { historyRevisionLockSql } from "@/services/history-revision-lock";

export type WorkoutTimingCorrectionResult =
  | {
      ok: true;
      outcome: "corrected" | "replayed";
      sessionId: string;
      versionId: string;
      historyRevision: number;
    }
  | {
      ok: false;
      code:
        | "stale"
        | "conflict"
        | "invalid_state"
        | "observed_set_conflict"
        | "failed";
      reason: string;
    };

export async function correctCompletedWorkoutTiming(
  db: Db,
  userId: string,
  input: WorkoutTimingCorrectionInput,
  now = new Date(),
): Promise<WorkoutTimingCorrectionResult> {
  const normalized = normalizeWorkoutTimingCorrection(input, now);
  const { parsed } = normalized;
  const progressionJobId = randomUUID();
  const query = sql`
    WITH history_revision_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), existing_version AS MATERIALIZED (
      SELECT version.*
      FROM record_versions version
      WHERE version.id = ${parsed.clientMutationId}::uuid
    ), owned_target AS MATERIALIZED (
      SELECT session.status, session.archived_at
      FROM workout_sessions session
      CROSS JOIN history_revision_lock
      WHERE session.id = ${parsed.sessionId}::uuid
        AND session.user_id = ${userId}::uuid
    ), current_record AS MATERIALIZED (
      SELECT session.*, to_jsonb(session) AS before_data
      FROM workout_sessions session
      CROSS JOIN history_revision_lock
      WHERE session.id = ${parsed.sessionId}::uuid
        AND session.user_id = ${userId}::uuid
        AND session.status = 'completed'
        AND session.archived_at IS NULL
        AND session.history_revision = ${parsed.expectedHistoryRevision}
        AND ROW(
          session.started_at,
          session.finished_at,
          session.timezone,
          session.local_date,
          session.performed_time_precision,
          session.exclude_duration_from_analytics
        ) IS NOT DISTINCT FROM ROW(
          ${parsed.expected.startedAtISO}::timestamptz,
          ${parsed.expected.finishedAtISO}::timestamptz,
          ${parsed.expected.timezone}::text,
          ${parsed.expected.localDate}::date,
          ${parsed.expected.precision}::text,
          ${parsed.expected.excludeDurationFromAnalytics}::boolean
        )
        AND NOT EXISTS (SELECT 1 FROM existing_version)
      FOR UPDATE OF session
    ), observed_set_conflict AS MATERIALIZED (
      SELECT 1 AS conflict
      FROM current_record current
      JOIN session_exercises exercise ON exercise.session_id = current.id
      JOIN completed_sets completed_set
        ON completed_set.session_exercise_id = exercise.id
       AND completed_set.archived_at IS NULL
       AND completed_set.observed_completed_at IS NOT NULL
      WHERE
        ${normalized.performedTimePrecision} = 'date_only'
        OR timezone(
          ${parsed.proposed.timezone},
          completed_set.observed_completed_at
        )::date <> ${parsed.proposed.localDate}::date
        OR completed_set.observed_completed_at < ${normalized.startedAt.toISOString()}::timestamptz
        OR (
          ${normalized.finishedAt?.toISOString() ?? null}::timestamptz IS NOT NULL
          AND completed_set.observed_completed_at >
            ${normalized.finishedAt?.toISOString() ?? null}::timestamptz
        )
      LIMIT 1
    ), updated AS (
      UPDATE workout_sessions session
      SET started_at = ${normalized.startedAt.toISOString()}::timestamptz,
          finished_at = ${normalized.finishedAt?.toISOString() ?? null}::timestamptz,
          timezone = ${parsed.proposed.timezone},
          local_date = ${parsed.proposed.localDate}::date,
          performed_time_precision = ${normalized.performedTimePrecision},
          exclude_duration_from_analytics = ${normalized.excludeDurationFromAnalytics},
          data_quality_flags =
            (session.data_quality_flags - 'unknown_time') ||
            CASE WHEN ${normalized.performedTimePrecision} = 'date_only'
              THEN '["unknown_time"]'::jsonb
              ELSE '[]'::jsonb
            END,
          history_revision = session.history_revision + 1
      FROM current_record current
      WHERE session.id = current.id
        AND NOT EXISTS (SELECT 1 FROM observed_set_conflict)
        AND ROW(
          current.started_at,
          current.finished_at,
          current.timezone,
          current.local_date,
          current.performed_time_precision,
          current.exclude_duration_from_analytics
        ) IS DISTINCT FROM ROW(
          ${normalized.startedAt.toISOString()}::timestamptz,
          ${normalized.finishedAt?.toISOString() ?? null}::timestamptz,
          ${parsed.proposed.timezone}::text,
          ${parsed.proposed.localDate}::date,
          ${normalized.performedTimePrecision}::text,
          ${normalized.excludeDurationFromAnalytics}::boolean
        )
      RETURNING session.*
    ), versioned AS (
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${parsed.clientMutationId}::uuid,
        ${userId}::uuid,
        'workout_session',
        current.id,
        'workout_session.timing_correction',
        current.before_data,
        to_jsonb(updated),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(to_jsonb(updated)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
            AND old_value.key IN (
              'started_at', 'finished_at', 'timezone', 'local_date',
              'performed_time_precision', 'exclude_duration_from_analytics',
              'data_quality_flags'
            )
          ORDER BY old_value.key
        )
      FROM current_record current
      JOIN updated ON updated.id = current.id
      RETURNING id, entity_id, changed_fields
    ), affected_lineages AS MATERIALIZED (
      SELECT DISTINCT exercise.source_slot_lineage_id
      FROM current_record current
      JOIN session_exercises exercise ON exercise.session_id = current.id
      WHERE exercise.source_slot_lineage_id IS NOT NULL
    ), reconciled_recommendations AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          reconciled_at = statement_timestamp(),
          reconciliation_reason =
            'The completed workout timing was corrected, so this suggestion no longer reflects the current history revision.'
      FROM affected_lineages lineage
      JOIN versioned ON TRUE
      WHERE recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.source_slot_lineage_id =
          lineage.source_slot_lineage_id
      RETURNING recommendation.id
    ), queued_progression AS (
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision,
        coaching_prefs, next_attempt_at
      )
      SELECT
        ${progressionJobId}::uuid,
        updated.user_id,
        updated.id,
        updated.history_revision,
        profile.coaching_prefs,
        statement_timestamp()
      FROM updated
      JOIN versioned ON versioned.entity_id = updated.id
      JOIN user_profiles profile ON profile.user_id = updated.user_id
      ON CONFLICT (session_id, source_session_revision) DO NOTHING
      RETURNING id
    ), audited AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        'workout_session.timing_correction',
        'workout_session',
        updated.id::text,
        'Corrected completed workout timing and retained the previous values',
        jsonb_build_object(
          'versionId', versioned.id,
          'changedFields', versioned.changed_fields,
          'historyRevision', updated.history_revision,
          'progressionJobId', (SELECT id FROM queued_progression)
        )
      FROM updated
      JOIN versioned ON versioned.entity_id = updated.id
    )
    SELECT
      coalesce(updated.id, existing.entity_id) AS session_id,
      coalesce(versioned.id, existing.id) AS version_id,
      coalesce(updated.history_revision, ${parsed.expectedHistoryRevision} + 1)
        AS history_revision,
      (existing.id IS NOT NULL) AS replayed,
      (observed.conflict IS NOT NULL) AS observed_set_conflict,
      (target.status IS NOT NULL) AS owned_target_exists,
      target.status AS target_status,
      (target.archived_at IS NOT NULL) AS target_archived,
      (
        existing.id IS NOT NULL
        AND NOT (
          existing.user_id = ${userId}::uuid
          AND existing.entity_type = 'workout_session'
          AND existing.entity_id = ${parsed.sessionId}::uuid
          AND existing.action = 'workout_session.timing_correction'
          AND (existing.after_data->>'started_at')::timestamptz =
            ${normalized.startedAt.toISOString()}::timestamptz
          AND (existing.after_data->>'finished_at')::timestamptz
            IS NOT DISTINCT FROM
            ${normalized.finishedAt?.toISOString() ?? null}::timestamptz
          AND existing.after_data->>'timezone' = ${parsed.proposed.timezone}
          AND (existing.after_data->>'local_date')::date =
            ${parsed.proposed.localDate}::date
          AND existing.after_data->>'performed_time_precision' =
            ${normalized.performedTimePrecision}
        )
      ) AS replay_conflict
    FROM (SELECT 1) singleton
    LEFT JOIN updated ON TRUE
    LEFT JOIN versioned ON TRUE
    LEFT JOIN existing_version existing ON TRUE
    LEFT JOIN observed_set_conflict observed ON TRUE
    LEFT JOIN owned_target target ON TRUE
  `;
  const row = resultRows(await db.execute(query))[0];
  if (row?.replay_conflict) {
    return {
      ok: false,
      code: "conflict",
      reason: "That correction identity already belongs to different timing values.",
    };
  }
  if (row?.replayed) {
    return {
      ok: true,
      outcome: "replayed",
      sessionId: String(row.session_id),
      versionId: String(row.version_id),
      historyRevision: Number(row.history_revision),
    };
  }
  if (row?.observed_set_conflict) {
    return {
      ok: false,
      code: "observed_set_conflict",
      reason:
        "This workout has exact set-completion times that would conflict with the proposed workout timing. Nothing was changed.",
    };
  }
  if (!row?.owned_target_exists) {
    return {
      ok: false,
      code: "invalid_state",
      reason: "This completed workout is not available for correction.",
    };
  }
  if (row?.target_archived) {
    return {
      ok: false,
      code: "invalid_state",
      reason:
        "This workout is archived. Restore it from Archive before correcting its timing.",
    };
  }
  if (row?.target_status !== "completed") {
    return {
      ok: false,
      code: "invalid_state",
      reason: "Only completed workouts can have historical timing corrected.",
    };
  }
  if (!row?.session_id) {
    return {
      ok: false,
      code: "stale",
      reason:
        "This workout changed after the correction form opened. Reload it and review the latest timing before trying again.",
    };
  }
  return {
    ok: true,
    outcome: "corrected",
    sessionId: String(row.session_id),
    versionId: String(row.version_id),
    historyRevision: Number(row.history_revision),
  };
}

export async function restoreWorkoutTimingVersion(
  db: Db,
  userId: string,
  sourceVersionId: string,
  options: {
    clientMutationId: string;
    expectedHistoryRevision: number;
  },
) {
  const progressionJobId = randomUUID();
  const query = sql`
    WITH history_revision_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), existing_restore AS MATERIALIZED (
      SELECT version.*
      FROM record_versions version
      WHERE version.id = ${options.clientMutationId}::uuid
    ), selected_version AS MATERIALIZED (
      SELECT version.*
      FROM record_versions version
      WHERE version.id = ${sourceVersionId}::uuid
        AND version.user_id = ${userId}::uuid
        AND version.entity_type = 'workout_session'
    ), current_record AS MATERIALIZED (
      SELECT session.*, to_jsonb(session) AS before_data
      FROM workout_sessions session
      CROSS JOIN history_revision_lock
      JOIN selected_version selected ON selected.entity_id = session.id
      WHERE session.user_id = ${userId}::uuid
        AND session.status = 'completed'
        AND session.archived_at IS NULL
        AND session.history_revision = ${options.expectedHistoryRevision}
        AND ROW(
          session.started_at, session.finished_at, session.timezone,
          session.local_date, session.performed_time_precision,
          session.exclude_duration_from_analytics
        ) IS NOT DISTINCT FROM ROW(
          (selected.after_data->>'started_at')::timestamptz,
          (selected.after_data->>'finished_at')::timestamptz,
          selected.after_data->>'timezone',
          (selected.after_data->>'local_date')::date,
          selected.after_data->>'performed_time_precision',
          (selected.after_data->>'exclude_duration_from_analytics')::boolean
        )
        AND NOT EXISTS (SELECT 1 FROM existing_restore)
      FOR UPDATE OF session
    ), observed_set_conflict AS MATERIALIZED (
      SELECT 1 AS conflict
      FROM current_record current
      JOIN selected_version selected ON selected.entity_id = current.id
      JOIN session_exercises exercise ON exercise.session_id = current.id
      JOIN completed_sets completed_set
        ON completed_set.session_exercise_id = exercise.id
       AND completed_set.archived_at IS NULL
       AND completed_set.observed_completed_at IS NOT NULL
      WHERE
        selected.before_data->>'performed_time_precision' = 'date_only'
        OR timezone(
          selected.before_data->>'timezone',
          completed_set.observed_completed_at
        )::date <> (selected.before_data->>'local_date')::date
        OR completed_set.observed_completed_at <
          (selected.before_data->>'started_at')::timestamptz
        OR (
          (selected.before_data->>'finished_at') IS NOT NULL
          AND completed_set.observed_completed_at >
            (selected.before_data->>'finished_at')::timestamptz
        )
      LIMIT 1
    ), restored AS (
      UPDATE workout_sessions session
      SET started_at = (selected.before_data->>'started_at')::timestamptz,
          finished_at = (selected.before_data->>'finished_at')::timestamptz,
          timezone = selected.before_data->>'timezone',
          local_date = (selected.before_data->>'local_date')::date,
          performed_time_precision =
            selected.before_data->>'performed_time_precision',
          exclude_duration_from_analytics =
            (selected.before_data->>'exclude_duration_from_analytics')::boolean,
          data_quality_flags =
            coalesce(selected.before_data->'data_quality_flags', '[]'::jsonb),
          history_revision = session.history_revision + 1
      FROM selected_version selected
      JOIN current_record current ON current.id = selected.entity_id
      WHERE session.id = current.id
        AND NOT EXISTS (SELECT 1 FROM observed_set_conflict)
      RETURNING session.*
    ), versioned AS (
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields, source_version_id
      )
      SELECT
        ${options.clientMutationId}::uuid,
        ${userId}::uuid,
        'workout_session',
        current.id,
        'workout_session.version_restore',
        current.before_data,
        to_jsonb(restored),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(to_jsonb(restored)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
            AND old_value.key IN (
              'started_at', 'finished_at', 'timezone', 'local_date',
              'performed_time_precision', 'exclude_duration_from_analytics',
              'data_quality_flags'
            )
          ORDER BY old_value.key
        ),
        selected.id
      FROM selected_version selected
      JOIN current_record current ON current.id = selected.entity_id
      JOIN restored ON restored.id = current.id
      RETURNING id, entity_id, changed_fields
    ), affected_lineages AS MATERIALIZED (
      SELECT DISTINCT exercise.source_slot_lineage_id
      FROM restored
      JOIN session_exercises exercise ON exercise.session_id = restored.id
      WHERE exercise.source_slot_lineage_id IS NOT NULL
    ), reconciled_recommendations AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          reconciled_at = statement_timestamp(),
          reconciliation_reason =
            'Completed workout timing was restored to earlier evidence, so this suggestion no longer reflects current history.'
      FROM affected_lineages lineage
      JOIN versioned ON TRUE
      WHERE recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.source_slot_lineage_id =
          lineage.source_slot_lineage_id
      RETURNING recommendation.id
    ), queued_progression AS (
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision,
        coaching_prefs, next_attempt_at
      )
      SELECT
        ${progressionJobId}::uuid,
        restored.user_id,
        restored.id,
        restored.history_revision,
        profile.coaching_prefs,
        statement_timestamp()
      FROM restored
      JOIN versioned ON versioned.entity_id = restored.id
      JOIN user_profiles profile ON profile.user_id = restored.user_id
      ON CONFLICT (session_id, source_session_revision) DO NOTHING
      RETURNING id
    ), audited AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        'workout_session.version_restore',
        'workout_session',
        restored.id::text,
        'Restored earlier workout timing and retained the replaced values',
        jsonb_build_object(
          'versionId', versioned.id,
          'sourceVersionId', selected.id,
          'changedFields', versioned.changed_fields,
          'historyRevision', restored.history_revision,
          'progressionJobId', (SELECT id FROM queued_progression)
        )
      FROM selected_version selected
      JOIN restored ON restored.id = selected.entity_id
      JOIN versioned ON versioned.entity_id = restored.id
    )
    SELECT
      coalesce(restored.id, existing.entity_id) AS id,
      coalesce(versioned.id, existing.id) AS version_id,
      (existing.id IS NOT NULL) AS replayed,
      (observed.conflict IS NOT NULL) AS observed_set_conflict,
      (
        existing.id IS NOT NULL
        AND NOT (
          existing.user_id = ${userId}::uuid
          AND existing.entity_type = 'workout_session'
          AND existing.entity_id = selected.entity_id
          AND existing.action = 'workout_session.version_restore'
          AND existing.source_version_id = selected.id
        )
      ) AS replay_conflict
    FROM selected_version selected
    LEFT JOIN restored ON restored.id = selected.entity_id
    LEFT JOIN versioned ON TRUE
    LEFT JOIN existing_restore existing ON TRUE
    LEFT JOIN observed_set_conflict observed ON TRUE
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) return { ok: false as const, reason: "Version not found." };
  if (row.replay_conflict) {
    return {
      ok: false as const,
      reason: "That restore identity already belongs to a different operation.",
    };
  }
  if (row.replayed) {
    return {
      ok: true as const,
      id: String(row.id),
      changed: false,
      versionId: String(row.version_id),
    };
  }
  if (row.observed_set_conflict) {
    return {
      ok: false as const,
      reason:
        "Nothing was restored because exact set-completion times would conflict with the earlier workout timing.",
    };
  }
  if (!row.id) {
    return {
      ok: false as const,
      reason:
        "The workout changed after this version was recorded. Reload and review the current timing before restoring.",
    };
  }
  return {
    ok: true as const,
    id: String(row.id),
    changed: true,
    versionId: String(row.version_id),
  };
}
