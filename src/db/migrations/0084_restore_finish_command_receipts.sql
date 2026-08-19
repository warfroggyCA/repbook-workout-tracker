-- Preserve the exact durable Finish command receipt when a recovery snapshot
-- restores its completed workout. The receipt remains an immutable audit row;
-- destination-only audit history is merged, never replaced.

ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_without_finish_command_receipts;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid, p_scope text, p_expected_current jsonb, p_target_rows jsonb,
  p_dependency_rows jsonb, p_source_snapshot_id uuid, p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_expected_audits jsonb := COALESCE(
    p_expected_current->'audit_logs',
    '[]'::jsonb
  );
  v_source_audits jsonb := COALESCE(
    p_target_rows->'audit_logs',
    '[]'::jsonb
  );
  v_expected_receipts jsonb;
  v_source_receipts jsonb;
  v_base_expected_audits jsonb;
  v_base_source_audits jsonb;
  v_current_receipts jsonb;
  v_base_expected jsonb;
  v_base_target jsonb;
  v_result jsonb;
  v_merged_receipts integer := 0;
BEGIN
  IF p_scope NOT IN ('full', 'history') THEN
    RAISE EXCEPTION 'Snapshot restore scope must be full or history.'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(
    jsonb_agg(item.value ORDER BY item.value->>'id'),
    '[]'::jsonb
  ) INTO v_expected_receipts
  FROM jsonb_array_elements(v_expected_audits) item(value)
  WHERE item.value->>'action' = 'session.complete';

  SELECT COALESCE(
    jsonb_agg(item.value ORDER BY item.value->>'id'),
    '[]'::jsonb
  ) INTO v_source_receipts
  FROM jsonb_array_elements(v_source_audits) item(value)
  WHERE item.value->>'action' = 'session.complete';

  SELECT COALESCE(
    jsonb_agg(item.value ORDER BY item.value->>'id'),
    '[]'::jsonb
  ) INTO v_base_expected_audits
  FROM jsonb_array_elements(v_expected_audits) item(value)
  WHERE item.value->>'action' IS DISTINCT FROM 'session.complete';

  SELECT COALESCE(
    jsonb_agg(item.value ORDER BY item.value->>'id'),
    '[]'::jsonb
  ) INTO v_base_source_audits
  FROM jsonb_array_elements(v_source_audits) item(value)
  WHERE item.value->>'action' IS DISTINCT FROM 'session.complete';

  v_base_expected := jsonb_set(
    p_expected_current,
    '{audit_logs}',
    v_base_expected_audits,
    true
  );
  v_base_target := jsonb_set(
    p_target_rows,
    '{audit_logs}',
    v_base_source_audits,
    true
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 847221));
  LOCK TABLE audit_logs IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_receipts) source(value)
    WHERE source.value->>'user_id' IS DISTINCT FROM p_user_id::text
      OR source.value->>'actor_type' IS DISTINCT FROM 'user'
      OR source.value->>'action' IS DISTINCT FROM 'session.complete'
      OR source.value->>'entity_type' IS DISTINCT FROM 'workout_session'
      OR jsonb_typeof(source.value->'cause_ref') IS DISTINCT FROM 'object'
      OR source.value #>> '{cause_ref,finishCommandHash}' IS NULL
      OR source.value #>> '{cause_ref,finishCommandHash}'
        !~ '^[0-9a-f]{64}$'
      OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          COALESCE(p_target_rows->'workout_sessions', '[]'::jsonb)
        ) workout(value)
        WHERE workout.value->>'id' = source.value->>'entity_id'
          AND workout.value->>'user_id' = p_user_id::text
          AND workout.value->>'status' = 'completed'
          AND workout.value->>'completion_semantics_version' = '1'
          AND source.value #>> '{cause_ref,completionSemanticsVersion}' = '1'
          AND source.value #>> '{cause_ref,completionState}' =
            workout.value->>'completion_state'
          AND source.value #>> '{cause_ref,completionReason}'
            IS NOT DISTINCT FROM workout.value->>'completion_reason'
      )
  ) THEN
    RAISE EXCEPTION 'Snapshot Finish receipt is cross-owner or contradictory.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      COALESCE(p_target_rows->'workout_sessions', '[]'::jsonb)
    ) workout(value)
    WHERE workout.value->>'source' IS DISTINCT FROM 'history_manual'
      AND workout.value->>'status' = 'completed'
      AND workout.value->>'completion_semantics_version' = '1'
      AND workout.value->>'completion_state'
        IS DISTINCT FROM 'completed_without_prescription'
      AND (
        SELECT count(*)
        FROM jsonb_array_elements(v_source_receipts) receipt(value)
        WHERE receipt.value->>'entity_id' = workout.value->>'id'
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'Snapshot current completion is missing its exact Finish receipt.'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(audit) ORDER BY audit.id),
    '[]'::jsonb
  ) INTO v_current_receipts
  FROM audit_logs audit
  JOIN workout_sessions workout
    ON workout.id::text = audit.entity_id
   AND workout.user_id = audit.user_id
  WHERE audit.user_id = p_user_id
    AND audit.actor_type = 'user'
    AND audit.action = 'session.complete'
    AND audit.entity_type = 'workout_session'
    AND workout.status = 'completed'
    AND workout.completion_semantics_version = 1;

  IF v_current_receipts IS DISTINCT FROM v_expected_receipts THEN
    RAISE EXCEPTION 'Restore preview is stale for Finish command receipts.'
      USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_receipts) source(value)
    JOIN audit_logs existing
      ON existing.id = (source.value->>'id')::uuid
    WHERE to_jsonb(existing) IS DISTINCT FROM source.value
  ) THEN
    RAISE EXCEPTION 'Snapshot Finish receipt identity conflicts with retained history.'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_receipts) source(value)
    JOIN audit_logs existing
      ON existing.user_id = p_user_id
     AND existing.action = 'session.complete'
     AND existing.entity_type = 'workout_session'
     AND existing.entity_id = source.value->>'entity_id'
     AND existing.id <> (source.value->>'id')::uuid
     AND existing.cause_ref ? 'finishCommandHash'
  ) THEN
    RAISE EXCEPTION 'Snapshot Finish receipt conflicts with a retained workout receipt.'
      USING ERRCODE = '23505';
  END IF;

  v_result := restore_user_snapshot_without_finish_command_receipts(
    p_user_id,
    p_scope,
    v_base_expected,
    v_base_target,
    p_dependency_rows - 'audit_logs',
    p_source_snapshot_id,
    p_safety_snapshot_id,
    p_fail_after_table
  );

  INSERT INTO audit_logs
  SELECT source.*
  FROM jsonb_populate_recordset(NULL::audit_logs, v_source_receipts) source
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_merged_receipts = ROW_COUNT;

  IF p_fail_after_table = 'finish_command_receipts' THEN
    RAISE EXCEPTION 'Injected restore failure after Finish command receipts.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_receipts) source(value)
    LEFT JOIN audit_logs restored
      ON restored.id = (source.value->>'id')::uuid
    WHERE restored.id IS NULL
      OR to_jsonb(restored) IS DISTINCT FROM source.value
  ) THEN
    RAISE EXCEPTION 'Merged snapshot Finish receipts failed final verification.'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{restoredRecords}',
    to_jsonb(
      COALESCE((v_result->>'restoredRecords')::integer, 0)
      + v_merged_receipts
    )
  );
END;
$$;
