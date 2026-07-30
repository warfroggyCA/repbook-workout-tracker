import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import type {
  BulkActivityArchivePreview,
  SampleHistoryArchivePreview,
} from "@/services/archive";
import { TEST_DATA_PREFIX } from "@/services/workout-test-data";

export type CompletedHistoryContextualNote = {
  id: string;
  body: string;
  coachVisible: boolean;
  inputMode: "typed" | "reviewed_dictation";
  attachmentKind: string;
  sessionExerciseId: string | null;
  occurrenceId: string | null;
  completedSetId: string | null;
  capturedContext: Record<string, unknown>;
  revision: number;
  recordedAt: Date;
};

/** Owner-visible observations for one completed workout, bounded and ordered. */
export async function getCompletedHistoryContextualNotes(
  db: Db,
  userId: string,
  sessionId: string
): Promise<CompletedHistoryContextualNote[]> {
  const rows = resultRows(await db.execute(sql`
    SELECT note.id, note.body, note.coach_visible, note.input_mode,
      note.attachment_kind, note.session_exercise_id, note.occurrence_id,
      note.completed_set_id, note.captured_context, note.revision,
      note.recorded_at
    FROM contextual_notes note
    JOIN workout_sessions session ON session.id = note.session_id
    WHERE note.user_id = ${userId}::uuid
      AND note.session_id = ${sessionId}::uuid
      AND note.archived_at IS NULL
      AND session.user_id = ${userId}::uuid
      AND session.status = 'completed'
      AND session.archived_at IS NULL
    ORDER BY note.recorded_at, note.id
  `));
  return rows.map((row) => ({
    id: String(row.id),
    body: String(row.body),
    coachVisible: Boolean(row.coach_visible),
    inputMode:
      row.input_mode === "reviewed_dictation" ? "reviewed_dictation" : "typed",
    attachmentKind: String(row.attachment_kind),
    sessionExerciseId:
      row.session_exercise_id == null ? null : String(row.session_exercise_id),
    occurrenceId: row.occurrence_id == null ? null : String(row.occurrence_id),
    completedSetId:
      row.completed_set_id == null ? null : String(row.completed_set_id),
    capturedContext:
      row.captured_context && typeof row.captured_context === "object"
        ? (row.captured_context as Record<string, unknown>)
        : {},
    revision: Number(row.revision),
    recordedAt: new Date(String(row.recorded_at)),
  }));
}

/** Fixed-size maintenance controls for the History page in one read. */
export async function getHistoryPageMaintenance(db: Db, userId: string) {
  const prefixPattern = `${TEST_DATA_PREFIX}%`;
  const row = resultRows(
    await db.execute(sql`
      WITH target AS MATERIALIZED (
        SELECT id FROM workout_sessions
        WHERE user_id = ${userId}::uuid
          AND template_name LIKE ${prefixPattern}
          AND archived_at IS NULL
      ), affected_jobs AS MATERIALIZED (
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
      ), activity_preview AS (
        SELECT count(*)::int AS activities,
               min(started_at)::date::text AS earliest,
               max(started_at)::date::text AS latest
        FROM health_activities
        WHERE user_id = ${userId}::uuid
          AND source = 'manual'
          AND archived_at IS NULL
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
        ) AS record_versions,
        activity_preview.activities,
        activity_preview.earliest,
        activity_preview.latest
      FROM activity_preview
    `)
  )[0];
  const samplePreview: SampleHistoryArchivePreview = {
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
  const activityArchivePreview: BulkActivityArchivePreview = {
    activities: Number(row?.activities ?? 0),
    earliest: row?.earliest == null ? null : String(row.earliest),
    latest: row?.latest == null ? null : String(row.latest),
  };
  return {
    testSessionCount: samplePreview.workouts,
    samplePreview,
    activityArchivePreview,
  };
}
