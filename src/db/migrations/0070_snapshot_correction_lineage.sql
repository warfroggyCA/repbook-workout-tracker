-- Merge immutable record-version evidence during snapshot restore instead of
-- dropping source lineage or erasing destination-only history. When a restore
-- changes an existing performed set, append a new superseding transition so
-- the restored effective value and the complete correction trail still agree.
ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_without_record_version_merge;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid, p_scope text, p_expected_current jsonb, p_target_rows jsonb,
  p_dependency_rows jsonb, p_source_snapshot_id uuid, p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_expected_versions jsonb := COALESCE(p_expected_current->'record_versions', '[]'::jsonb);
  v_source_versions jsonb := COALESCE(p_target_rows->'record_versions', '[]'::jsonb);
  v_current_versions jsonb;
  v_result jsonb;
  v_merged integer := 0;
  v_transitions integer := 0;
BEGIN
  IF p_scope NOT IN ('full', 'history') THEN
    RAISE EXCEPTION 'Snapshot restore scope must be full or history.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 847221));
  LOCK TABLE record_versions IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_versions) source(value)
    WHERE source.value->>'user_id' IS DISTINCT FROM p_user_id::text
  ) THEN
    RAISE EXCEPTION 'Snapshot version history belongs to another account.'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(version) ORDER BY version.id), '[]'::jsonb)
    INTO v_current_versions
  FROM record_versions version
  WHERE version.user_id = p_user_id
    AND version.entity_type = 'completed_set'
    AND (
      p_scope = 'full'
      OR EXISTS (
        SELECT 1
        FROM completed_sets completed
        JOIN session_exercises exercise ON exercise.id = completed.session_exercise_id
        JOIN workout_sessions workout ON workout.id = exercise.session_id
        WHERE completed.id = version.entity_id
          AND workout.user_id = p_user_id
      )
    );

  IF v_current_versions IS DISTINCT FROM v_expected_versions THEN
    RAISE EXCEPTION 'Restore preview is stale for table record_versions.'
      USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_versions) source(value)
    JOIN record_versions existing
      ON existing.id = (source.value->>'id')::uuid
    WHERE to_jsonb(existing) IS DISTINCT FROM source.value
  ) THEN
    RAISE EXCEPTION 'Snapshot version identity conflicts with retained history.'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO record_versions
  SELECT source.*
  FROM jsonb_populate_recordset(NULL::record_versions, v_source_versions) source
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_merged = ROW_COUNT;

  v_result := restore_user_snapshot_without_record_version_merge(
    p_user_id,
    p_scope,
    p_expected_current - 'record_versions',
    p_target_rows - 'record_versions',
    p_dependency_rows - 'record_versions',
    p_source_snapshot_id,
    p_safety_snapshot_id,
    p_fail_after_table
  );

  WITH current_sets AS (
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_expected_current->'completed_sets', '[]'::jsonb))
  ), target_sets AS (
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_target_rows->'completed_sets', '[]'::jsonb))
  ), changed_sets AS (
    SELECT current.value AS before_data, target.value AS after_data
    FROM current_sets current
    JOIN target_sets target ON target.value->>'id' = current.value->>'id'
    WHERE current.value IS DISTINCT FROM target.value
  ), restore_context AS (
    SELECT
      changed.before_data,
      changed.after_data,
      target_workout.value AS target_workout,
      current_workout.value AS current_workout
    FROM changed_sets changed
    JOIN LATERAL (
      SELECT value
      FROM jsonb_array_elements(COALESCE(p_target_rows->'session_exercises', '[]'::jsonb))
      WHERE value->>'id' = changed.after_data->>'session_exercise_id'
    ) target_exercise ON TRUE
    JOIN LATERAL (
      SELECT value
      FROM jsonb_array_elements(COALESCE(p_target_rows->'workout_sessions', '[]'::jsonb))
      WHERE value->>'id' = target_exercise.value->>'session_id'
    ) target_workout ON TRUE
    JOIN LATERAL (
      SELECT value
      FROM jsonb_array_elements(COALESCE(p_expected_current->'session_exercises', '[]'::jsonb))
      WHERE value->>'id' = changed.before_data->>'session_exercise_id'
    ) current_exercise ON TRUE
    JOIN LATERAL (
      SELECT value
      FROM jsonb_array_elements(COALESCE(p_expected_current->'workout_sessions', '[]'::jsonb))
      WHERE value->>'id' = current_exercise.value->>'session_id'
    ) current_workout ON TRUE
  ), versioned AS (
    INSERT INTO record_versions (
      id, user_id, entity_type, entity_id, action,
      before_data, after_data, changed_fields, source_version_id, created_at
    )
    SELECT
      gen_random_uuid(),
      p_user_id,
      'completed_set',
      (context.after_data->>'id')::uuid,
      'set.snapshot_restore',
      context.before_data,
      context.after_data || jsonb_build_object(
        'repbook_correction',
        jsonb_build_object(
          'schemaVersion', 1,
          'writerVersion', 'repbook-v2-t02/1',
          'category', 'restore_snapshot',
          'reasonNote', NULL,
          'actorType', 'owner',
          'source', 'snapshot_restore',
          'decidedAt', statement_timestamp(),
          'decisionTimezone', context.target_workout->>'timezone',
          'decisionLocalDate', timezone(context.target_workout->>'timezone', statement_timestamp())::date,
          'sourceHistoryRevision', (context.current_workout->>'history_revision')::integer,
          'resultHistoryRevision', (context.target_workout->>'history_revision')::integer,
          'sourceLedgerRevision', ledger.source_ledger_revision,
          'resultLedgerRevision', ledger.source_ledger_revision + 1,
          'dependentConclusions', 'snapshot_state_reconciled',
          'expiredRecommendationCount', 0,
          'progressionJobId', NULL,
          'restoredFromVersionId', NULL,
          'restoredFromSnapshotId', p_source_snapshot_id
        )
      ),
      ARRAY(
        SELECT old_value.key
        FROM jsonb_each(context.before_data) old_value
        JOIN jsonb_each(context.after_data) new_value USING (key)
        WHERE old_value.value IS DISTINCT FROM new_value.value
        ORDER BY old_value.key
      ),
      NULL,
      statement_timestamp()
    FROM restore_context context
    CROSS JOIN LATERAL (
      SELECT COALESCE(max(
        CASE
          WHEN version.after_data #>> '{repbook_correction,resultLedgerRevision}' ~ '^[0-9]+$'
            THEN (version.after_data #>> '{repbook_correction,resultLedgerRevision}')::integer
          ELSE NULL
        END
      ), 0) AS source_ledger_revision
      FROM record_versions version
      WHERE version.user_id = p_user_id
        AND version.entity_type = 'completed_set'
        AND version.entity_id = (context.after_data->>'id')::uuid
    ) ledger
    RETURNING id
  )
  SELECT count(*)::integer INTO v_transitions FROM versioned;

  IF p_fail_after_table = 'record_versions' THEN
    RAISE EXCEPTION 'Injected restore failure after table record_versions.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_versions) source(value)
    LEFT JOIN record_versions restored
      ON restored.id = (source.value->>'id')::uuid
    WHERE restored.id IS NULL
      OR to_jsonb(restored) IS DISTINCT FROM source.value
  ) THEN
    RAISE EXCEPTION 'Merged snapshot version history failed final verification.'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{restoredRecords}',
    to_jsonb(
      COALESCE((v_result->>'restoredRecords')::integer, 0)
      + v_merged
      + v_transitions
    )
  );
END;
$$;
