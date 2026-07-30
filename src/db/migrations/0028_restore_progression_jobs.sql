-- The established restore function predates durable progression jobs. This
-- wrapper keeps the original table restore intact while bridging the new
-- job/recommendation foreign-key cycle in the same transaction.
CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid,
  p_scope text,
  p_expected_current jsonb,
  p_target_rows jsonb,
  p_dependency_rows jsonb,
  p_source_snapshot_id uuid,
  p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_expected_without_jobs jsonb;
  v_target_without_jobs jsonb;
  v_sanitized_recommendations jsonb;
  v_current_rows jsonb;
  v_result jsonb;
  v_job_count integer;
BEGIN
  IF NOT (p_expected_current ? 'progression_jobs')
     OR NOT (p_target_rows ? 'progression_jobs') THEN
    RAISE EXCEPTION 'Snapshot restore is missing table progression_jobs.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE workout_sessions, progression_jobs, recommendations
    IN SHARE ROW EXCLUSIVE MODE;

  SELECT COALESCE(jsonb_agg(to_jsonb(job) ORDER BY job.id), '[]'::jsonb)
    INTO v_current_rows
  FROM progression_jobs job
  WHERE job.user_id = p_user_id;
  IF v_current_rows IS DISTINCT FROM p_expected_current -> 'progression_jobs' THEN
    RAISE EXCEPTION 'Restore preview is stale for table progression_jobs.'
      USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(rec) ORDER BY rec.id), '[]'::jsonb)
    INTO v_current_rows
  FROM recommendations rec
  WHERE rec.user_id = p_user_id;
  IF v_current_rows IS DISTINCT FROM p_expected_current -> 'recommendations' THEN
    RAISE EXCEPTION 'Restore preview is stale for table recommendations.'
      USING ERRCODE = '40001';
  END IF;

  -- Null the current links before the legacy restore removes workout sessions;
  -- any later error rolls this change back with the rest of the function.
  UPDATE recommendations
  SET progression_job_id = NULL
  WHERE user_id = p_user_id
    AND progression_job_id IS NOT NULL;

  SELECT COALESCE(
      jsonb_agg(
        jsonb_set(value, '{progression_job_id}', 'null'::jsonb, true)
        ORDER BY value->>'id'
      ),
      '[]'::jsonb
    )
    INTO v_sanitized_recommendations
  FROM jsonb_array_elements(p_expected_current -> 'recommendations') value;
  v_expected_without_jobs := jsonb_set(
    p_expected_current - 'progression_jobs',
    '{recommendations}',
    v_sanitized_recommendations
  );

  SELECT COALESCE(
      jsonb_agg(
        jsonb_set(value, '{progression_job_id}', 'null'::jsonb, true)
        ORDER BY value->>'id'
      ),
      '[]'::jsonb
    )
    INTO v_sanitized_recommendations
  FROM jsonb_array_elements(p_target_rows -> 'recommendations') value;
  v_target_without_jobs := jsonb_set(
    p_target_rows - 'progression_jobs',
    '{recommendations}',
    v_sanitized_recommendations
  );

  PERFORM set_config('workout_tracker.authorized_delete', 'snapshot_restore', true);
  v_result := restore_user_snapshot_unguarded(
    p_user_id,
    p_scope,
    v_expected_without_jobs,
    v_target_without_jobs,
    p_dependency_rows,
    p_source_snapshot_id,
    p_safety_snapshot_id,
    p_fail_after_table
  );

  INSERT INTO progression_jobs
  SELECT *
  FROM jsonb_populate_recordset(
    NULL::progression_jobs,
    p_target_rows -> 'progression_jobs'
  );
  v_job_count := jsonb_array_length(p_target_rows -> 'progression_jobs');

  UPDATE recommendations recommendation
  SET progression_job_id = (target.value->>'progression_job_id')::uuid
  FROM jsonb_array_elements(p_target_rows -> 'recommendations') target(value)
  WHERE recommendation.id = (target.value->>'id')::uuid
    AND recommendation.user_id = p_user_id
    AND target.value->>'progression_job_id' IS NOT NULL;

  IF p_fail_after_table = 'progression_jobs' THEN
    RAISE EXCEPTION 'Injected restore failure after table progression_jobs.';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(job) ORDER BY job.id), '[]'::jsonb)
    INTO v_current_rows
  FROM progression_jobs job
  WHERE job.user_id = p_user_id;
  IF v_current_rows IS DISTINCT FROM p_target_rows -> 'progression_jobs' THEN
    RAISE EXCEPTION 'Restored table progression_jobs failed final verification.';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(rec) ORDER BY rec.id), '[]'::jsonb)
    INTO v_current_rows
  FROM recommendations rec
  WHERE rec.user_id = p_user_id;
  IF v_current_rows IS DISTINCT FROM p_target_rows -> 'recommendations' THEN
    RAISE EXCEPTION 'Restored table recommendations failed final verification.';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{restoredRecords}',
    to_jsonb((v_result->>'restoredRecords')::integer + v_job_count)
  );
END;
$$;
--> statement-breakpoint
ALTER FUNCTION permanent_delete_archive_preview(uuid, uuid)
  RENAME TO permanent_delete_archive_preview_without_progression_jobs;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanent_delete_archive_preview(
  p_user_id uuid,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH base AS (
  SELECT permanent_delete_archive_preview_without_progression_jobs(
    p_user_id,
    p_operation_id
  ) AS preview
), progression_count AS (
  SELECT count(*)::integer AS count
  FROM progression_jobs job
  JOIN workout_sessions session ON session.id = job.session_id
  JOIN archive_operation_records member
    ON member.operation_id = p_operation_id
   AND member.user_id = p_user_id
   AND member.entity_type = 'workout_session'
   AND member.entity_id = session.id::text
  WHERE job.user_id = p_user_id
)
SELECT CASE
  WHEN base.preview IS NULL THEN NULL
  ELSE jsonb_set(
    base.preview,
    '{deleteCounts,progressionJobs}',
    to_jsonb(progression_count.count),
    true
  )
END
FROM base CROSS JOIN progression_count;
$$;
--> statement-breakpoint
CREATE TRIGGER protected_delete_guard
BEFORE DELETE ON progression_jobs
FOR EACH ROW EXECUTE FUNCTION guard_protected_delete();
