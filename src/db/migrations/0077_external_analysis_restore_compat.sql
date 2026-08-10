-- Snapshot capture retains the bounded external-analysis import receipt while
-- redacting ordinary Coach model context. The legacy restore race check
-- predates that receipt kind and normalizes every coaching_insights row to the
-- ordinary schema-2 digest, so an otherwise valid external receipt can never
-- match its restore preview. Keep an exact external-aware guard at the outer
-- boundary, then adapt only the expected-current value for the legacy inner
-- comparator. Target rows and final restore verification remain unchanged.
ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_without_external_analysis_receipt_compat;
--> statement-breakpoint
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
  v_current_insights jsonb;
  v_legacy_expected_insights jsonb;
  v_legacy_expected jsonb := p_expected_current;
BEGIN
  IF p_expected_current ? 'coaching_insights' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 847221));
    PERFORM set_config('lock_timeout', '5s', true);
    LOCK TABLE coaching_insights IN SHARE ROW EXCLUSIVE MODE;

    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN insight.kind = 'external_analysis_import' THEN
            (
              to_jsonb(insight)
              - 'content_md'
              - 'model'
              - 'provider_item_id'
              - 'failure_reason'
            ) || jsonb_build_object(
              'content_md',
                'Selected external-analysis observations and proposal provenance.',
              'model', NULL::text,
              'provider_item_id', NULL::text,
              'failure_reason', NULL::text
            )
          ELSE
            (to_jsonb(insight) - 'data_digest') || jsonb_build_object(
              'data_digest', jsonb_strip_nulls(jsonb_build_object(
                'schemaVersion', '2',
                'question', CASE
                  WHEN insight.kind = 'qa' THEN insight.data_digest -> 'question'
                  ELSE NULL
                END,
                'generatedAt', COALESCE(
                  insight.data_digest -> 'generatedAt',
                  to_jsonb(insight.created_at)
                ),
                'windowDays', insight.data_digest -> 'windowDays',
                'sessionId', insight.session_id,
                'sessionExerciseId', insight.session_exercise_id,
                'completedSetId', insight.completed_set_id,
                'modelContextRetained', false,
                'retentionArchiveInsightId',
                  insight.data_digest -> 'retentionArchiveInsightId'
              ))
            )
        END
        ORDER BY insight.id
      ),
      '[]'::jsonb
    )
    INTO v_current_insights
    FROM coaching_insights insight
    WHERE insight.user_id = p_user_id;

    IF v_current_insights IS DISTINCT FROM p_expected_current -> 'coaching_insights' THEN
      RAISE EXCEPTION 'Restore preview is stale for table coaching_insights.'
        USING ERRCODE = '40001';
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN value->>'kind' = 'external_analysis_import' THEN
            (value - 'data_digest') || jsonb_build_object(
              'data_digest', jsonb_strip_nulls(jsonb_build_object(
                'schemaVersion', '2',
                'question', NULL,
                'generatedAt', value -> 'created_at',
                'windowDays', NULL,
                'sessionId', value -> 'session_id',
                'sessionExerciseId', value -> 'session_exercise_id',
                'completedSetId', value -> 'completed_set_id',
                'modelContextRetained', false,
                'retentionArchiveInsightId', NULL
              ))
            )
          ELSE value
        END
        ORDER BY value->>'id'
      ),
      '[]'::jsonb
    )
    INTO v_legacy_expected_insights
    FROM jsonb_array_elements(p_expected_current -> 'coaching_insights') rows(value);

    v_legacy_expected := jsonb_set(
      p_expected_current,
      '{coaching_insights}',
      v_legacy_expected_insights
    );
  END IF;

  RETURN restore_user_snapshot_without_external_analysis_receipt_compat(
    p_user_id,
    p_scope,
    v_legacy_expected,
    p_target_rows,
    p_dependency_rows,
    p_source_snapshot_id,
    p_safety_snapshot_id,
    p_fail_after_table
  );
END;
$$;
