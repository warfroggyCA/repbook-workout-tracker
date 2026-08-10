-- Keep source wall-clock timestamps intact while recording separately reviewed
-- active-duration evidence. Existing rows remain legacy/unknown; there is no
-- historical backfill or reinterpretation.

ALTER TABLE "workout_sessions"
  ADD COLUMN "active_duration_semantics_version" integer,
  ADD COLUMN "active_duration_seconds" integer,
  ADD COLUMN "active_duration_basis" text;
--> statement-breakpoint

ALTER TABLE "workout_sessions"
  ADD CONSTRAINT "workout_sessions_active_duration_tuple_check"
  CHECK (
    (
      "active_duration_semantics_version" IS NULL
      AND "active_duration_seconds" IS NULL
      AND "active_duration_basis" IS NULL
    ) OR (
      "active_duration_semantics_version" = 1
      AND "active_duration_basis" IS NOT NULL
      AND (
        (
          "active_duration_basis" IN (
            'wall_clock_no_stale_signal',
            'owner_reported'
          )
          AND "active_duration_seconds" IS NOT NULL
          AND "active_duration_seconds" BETWEEN 0 AND 604800
        ) OR (
          "active_duration_basis" = 'interruption_unknown'
          AND "active_duration_seconds" IS NULL
        )
      )
    )
  );
--> statement-breakpoint

-- Restore immutable workout-timing correction evidence alongside the workout
-- row. Source versions and their exact audit rows are merged by UUID; rows
-- that exist only at the destination remain untouched.
ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_without_workout_timing_evidence_merge;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid, p_scope text, p_expected_current jsonb, p_target_rows jsonb,
  p_dependency_rows jsonb, p_source_snapshot_id uuid, p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_expected_versions jsonb := COALESCE(p_expected_current->'record_versions', '[]'::jsonb);
  v_source_versions jsonb := COALESCE(p_target_rows->'record_versions', '[]'::jsonb);
  v_expected_timing_versions jsonb;
  v_source_timing_versions jsonb;
  v_base_expected_versions jsonb;
  v_base_source_versions jsonb;
  v_expected_audits jsonb := COALESCE(p_expected_current->'audit_logs', '[]'::jsonb);
  v_source_audits jsonb := COALESCE(p_target_rows->'audit_logs', '[]'::jsonb);
  v_current_timing_versions jsonb;
  v_current_timing_audits jsonb;
  v_base_expected jsonb;
  v_base_target jsonb;
  v_result jsonb;
  v_merged_versions integer := 0;
  v_merged_audits integer := 0;
  v_transitions integer := 0;
BEGIN
  IF p_scope NOT IN ('full', 'history') THEN
    RAISE EXCEPTION 'Snapshot restore scope must be full or history.'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_expected_timing_versions
  FROM jsonb_array_elements(v_expected_versions) item(value)
  WHERE item.value->>'entity_type' = 'workout_session'
    AND item.value->>'action' IN (
      'workout_session.duration_correction',
      'workout_session.snapshot_restore',
      'workout_session.timing_correction',
      'workout_session.version_restore'
    );

  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_source_timing_versions
  FROM jsonb_array_elements(v_source_versions) item(value)
  WHERE item.value->>'entity_type' = 'workout_session'
    AND item.value->>'action' IN (
      'workout_session.duration_correction',
      'workout_session.snapshot_restore',
      'workout_session.timing_correction',
      'workout_session.version_restore'
    );

  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_base_expected_versions
  FROM jsonb_array_elements(v_expected_versions) item(value)
  WHERE NOT (
    item.value->>'entity_type' = 'workout_session'
    AND item.value->>'action' IN (
      'workout_session.duration_correction',
      'workout_session.snapshot_restore',
      'workout_session.timing_correction',
      'workout_session.version_restore'
    )
  );

  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_base_source_versions
  FROM jsonb_array_elements(v_source_versions) item(value)
  WHERE NOT (
    item.value->>'entity_type' = 'workout_session'
    AND item.value->>'action' IN (
      'workout_session.duration_correction',
      'workout_session.snapshot_restore',
      'workout_session.timing_correction',
      'workout_session.version_restore'
    )
  );

  v_base_expected := jsonb_set(
    p_expected_current - 'audit_logs',
    '{record_versions}',
    v_base_expected_versions,
    true
  );
  v_base_target := jsonb_set(
    p_target_rows - 'audit_logs',
    '{record_versions}',
    v_base_source_versions,
    true
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 847221));
  LOCK TABLE record_versions IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE audit_logs IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_timing_versions) source(value)
    WHERE source.value->>'user_id' IS DISTINCT FROM p_user_id::text
      OR source.value->>'entity_type' IS DISTINCT FROM 'workout_session'
      OR source.value->>'action' NOT IN (
        'workout_session.duration_correction',
        'workout_session.snapshot_restore',
        'workout_session.timing_correction',
        'workout_session.version_restore'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(p_target_rows->'workout_sessions', '[]'::jsonb)) workout(value)
        WHERE workout.value->>'id' = source.value->>'entity_id'
          AND workout.value->>'user_id' = p_user_id::text
      )
      OR (
        source.value->>'action' = 'workout_session.version_restore'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_source_timing_versions) original(value)
          WHERE original.value->>'id' = source.value->>'source_version_id'
            AND original.value->>'entity_id' = source.value->>'entity_id'
        )
      )
      OR (
        source.value->>'action' = 'workout_session.snapshot_restore'
        AND source.value->>'source_version_id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_source_timing_versions) original(value)
          WHERE original.value->>'id' = source.value->>'source_version_id'
            AND original.value->>'entity_id' = source.value->>'entity_id'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Snapshot workout-timing version evidence is not owned by this account.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_audits) source(value)
    WHERE source.value->>'user_id' IS DISTINCT FROM p_user_id::text
      OR source.value->>'entity_type' IS DISTINCT FROM 'workout_session'
      OR source.value->>'action' NOT IN (
        'workout_session.duration_correction',
        'workout_session.snapshot_restore',
        'workout_session.timing_correction',
        'workout_session.version_restore'
      )
      OR (
        source.value->>'action' = 'workout_session.snapshot_restore'
        AND source.value->>'actor_type' IS DISTINCT FROM 'user'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_source_timing_versions) version(value)
        WHERE version.value->>'id' = source.value #>> '{cause_ref,versionId}'
          AND version.value->>'action' = source.value->>'action'
          AND version.value->>'entity_id' = source.value->>'entity_id'
          AND (
            version.value->>'action' NOT IN (
              'workout_session.snapshot_restore',
              'workout_session.version_restore'
            )
            OR version.value->>'source_version_id' IS NOT DISTINCT FROM
              source.value #>> '{cause_ref,sourceVersionId}'
          )
      )
  ) THEN
    RAISE EXCEPTION 'Snapshot workout-timing audit is missing its exact version evidence.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_timing_versions) version(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_source_audits) audit(value)
      WHERE audit.value #>> '{cause_ref,versionId}' = version.value->>'id'
        AND audit.value->>'action' = version.value->>'action'
        AND audit.value->>'entity_id' = version.value->>'entity_id'
    )
  ) THEN
    RAISE EXCEPTION 'Snapshot workout-timing version is missing its exact audit evidence.'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(version) ORDER BY version.id), '[]'::jsonb)
    INTO v_current_timing_versions
  FROM record_versions version
  WHERE version.user_id = p_user_id
    AND version.entity_type = 'workout_session'
    AND version.action IN (
      'workout_session.duration_correction',
      'workout_session.snapshot_restore',
      'workout_session.timing_correction',
      'workout_session.version_restore'
    )
    AND EXISTS (
      SELECT 1
      FROM workout_sessions workout
      WHERE workout.id = version.entity_id
        AND workout.user_id = p_user_id
    );

  IF v_current_timing_versions IS DISTINCT FROM v_expected_timing_versions THEN
    RAISE EXCEPTION 'Restore preview is stale for workout-timing version evidence.'
      USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(audit) ORDER BY audit.id), '[]'::jsonb)
    INTO v_current_timing_audits
  FROM audit_logs audit
  JOIN record_versions version
    ON version.id::text = audit.cause_ref->>'versionId'
   AND version.user_id = audit.user_id
   AND version.entity_type = audit.entity_type
   AND version.entity_id::text = audit.entity_id
   AND version.action = audit.action
  WHERE audit.user_id = p_user_id
    AND audit.entity_type = 'workout_session'
    AND audit.action IN (
      'workout_session.duration_correction',
      'workout_session.snapshot_restore',
      'workout_session.timing_correction',
      'workout_session.version_restore'
    )
    AND EXISTS (
      SELECT 1
      FROM workout_sessions workout
      WHERE workout.id = version.entity_id
        AND workout.user_id = p_user_id
    );

  IF v_current_timing_audits IS DISTINCT FROM v_expected_audits THEN
    RAISE EXCEPTION 'Restore preview is stale for workout-timing audit evidence.'
      USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_timing_versions) source(value)
    JOIN record_versions existing ON existing.id = (source.value->>'id')::uuid
    WHERE to_jsonb(existing) IS DISTINCT FROM source.value
  ) THEN
    RAISE EXCEPTION 'Snapshot workout-timing version identity conflicts with retained history.'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_audits) source(value)
    JOIN audit_logs existing ON existing.id = (source.value->>'id')::uuid
    WHERE to_jsonb(existing) IS DISTINCT FROM source.value
  ) THEN
    RAISE EXCEPTION 'Snapshot workout-timing audit identity conflicts with retained history.'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO record_versions
  SELECT source.*
  FROM jsonb_populate_recordset(NULL::record_versions, v_source_timing_versions) source
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_merged_versions = ROW_COUNT;

  INSERT INTO audit_logs
  SELECT source.*
  FROM jsonb_populate_recordset(NULL::audit_logs, v_source_audits) source
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_merged_audits = ROW_COUNT;

  v_result := restore_user_snapshot_without_workout_timing_evidence_merge(
    p_user_id,
    p_scope,
    v_base_expected,
    v_base_target,
    p_dependency_rows - 'audit_logs',
    p_source_snapshot_id,
    p_safety_snapshot_id,
    p_fail_after_table
  );

  -- A snapshot may restore an earlier effective timing fact while later
  -- destination-only corrections remain immutable. Keep the workout revision
  -- monotonic and append a transition that explains the now-effective record.
  WITH current_workouts AS MATERIALIZED (
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_expected_current->'workout_sessions', '[]'::jsonb))
  ), target_workouts AS MATERIALIZED (
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_target_rows->'workout_sessions', '[]'::jsonb))
  ), restore_context AS MATERIALIZED (
    SELECT
      current.value AS before_data,
      target.value AS target_data,
      GREATEST(
        COALESCE((current.value->>'history_revision')::integer, 0),
        COALESCE((target.value->>'history_revision')::integer, 0)
      ) AS retained_history_revision,
      ROW(
        current.value->>'started_at',
        current.value->>'finished_at',
        current.value->>'timezone',
        current.value->>'local_date',
        current.value->>'performed_time_precision',
        current.value->>'exclude_duration_from_analytics',
        current.value->>'active_duration_semantics_version',
        current.value->>'active_duration_seconds',
        current.value->>'active_duration_basis',
        current.value->'data_quality_flags'
      ) IS DISTINCT FROM ROW(
        target.value->>'started_at',
        target.value->>'finished_at',
        target.value->>'timezone',
        target.value->>'local_date',
        target.value->>'performed_time_precision',
        target.value->>'exclude_duration_from_analytics',
        target.value->>'active_duration_semantics_version',
        target.value->>'active_duration_seconds',
        target.value->>'active_duration_basis',
        target.value->'data_quality_flags'
      ) AS timing_fact_changed
    FROM current_workouts current
    JOIN target_workouts target ON target.value->>'id' = current.value->>'id'
    WHERE current.value->>'user_id' = p_user_id::text
      AND target.value->>'user_id' = p_user_id::text
  ), reconciled AS MATERIALIZED (
    UPDATE workout_sessions session
    SET history_revision = CASE
      WHEN context.timing_fact_changed
        THEN context.retained_history_revision + 1
      ELSE GREATEST(session.history_revision, context.retained_history_revision)
    END
    FROM restore_context context
    WHERE session.id = (context.target_data->>'id')::uuid
      AND session.user_id = p_user_id
      AND (
        context.timing_fact_changed
        OR session.history_revision < context.retained_history_revision
      )
    RETURNING session.id, session.user_id, session.history_revision,
      to_jsonb(session) AS after_data
  ), versioned AS MATERIALIZED (
    INSERT INTO record_versions (
      id, user_id, entity_type, entity_id, action,
      before_data, after_data, changed_fields, source_version_id, created_at
    )
    SELECT
      gen_random_uuid(),
      p_user_id,
      'workout_session',
      reconciled.id,
      'workout_session.snapshot_restore',
      context.before_data,
      reconciled.after_data,
      ARRAY(
        SELECT old_value.key
        FROM jsonb_each(context.before_data) old_value
        JOIN jsonb_each(reconciled.after_data) new_value USING (key)
        WHERE old_value.value IS DISTINCT FROM new_value.value
          AND old_value.key IN (
            'started_at',
            'finished_at',
            'timezone',
            'local_date',
            'performed_time_precision',
            'active_duration_basis',
            'active_duration_seconds',
            'active_duration_semantics_version',
            'data_quality_flags',
            'exclude_duration_from_analytics',
            'history_revision'
          )
        ORDER BY old_value.key
      ),
      source.source_version_id,
      statement_timestamp()
    FROM reconciled
    JOIN restore_context context
      ON context.target_data->>'id' = reconciled.id::text
    LEFT JOIN LATERAL (
      SELECT (candidate.value->>'id')::uuid AS source_version_id
      FROM jsonb_array_elements(v_source_timing_versions) candidate(value)
      WHERE candidate.value->>'entity_id' = reconciled.id::text
        AND ROW(
          candidate.value #>> '{after_data,started_at}',
          candidate.value #>> '{after_data,finished_at}',
          candidate.value #>> '{after_data,timezone}',
          candidate.value #>> '{after_data,local_date}',
          candidate.value #>> '{after_data,performed_time_precision}',
          candidate.value #>> '{after_data,exclude_duration_from_analytics}',
          candidate.value #>> '{after_data,active_duration_semantics_version}',
          candidate.value #>> '{after_data,active_duration_seconds}',
          candidate.value #>> '{after_data,active_duration_basis}',
          candidate.value #> '{after_data,data_quality_flags}'
        ) IS NOT DISTINCT FROM ROW(
          context.target_data->>'started_at',
          context.target_data->>'finished_at',
          context.target_data->>'timezone',
          context.target_data->>'local_date',
          context.target_data->>'performed_time_precision',
          context.target_data->>'exclude_duration_from_analytics',
          context.target_data->>'active_duration_semantics_version',
          context.target_data->>'active_duration_seconds',
          context.target_data->>'active_duration_basis',
          context.target_data->'data_quality_flags'
        )
      ORDER BY
        CASE WHEN candidate.value #>> '{after_data,history_revision}' =
          context.target_data->>'history_revision' THEN 0 ELSE 1 END,
        (candidate.value->>'created_at')::timestamptz DESC,
        candidate.value->>'id' DESC
      LIMIT 1
    ) source ON TRUE
    WHERE context.timing_fact_changed
    RETURNING id, entity_id, source_version_id, before_data, after_data, changed_fields
  ), affected_lineages AS MATERIALIZED (
    SELECT DISTINCT exercise.source_slot_lineage_id
    FROM reconciled
    JOIN session_exercises exercise ON exercise.session_id = reconciled.id
    WHERE exercise.source_slot_lineage_id IS NOT NULL
  ), reconciled_recommendations AS (
    UPDATE recommendations recommendation
    SET status = 'expired',
        reconciled_at = statement_timestamp(),
        reconciliation_reason =
          'The completed workout timing evidence was restored from a recovery snapshot, so this suggestion no longer reflects the current history revision.'
    FROM affected_lineages lineage
    WHERE recommendation.user_id = p_user_id
      AND recommendation.status = 'pending'
      AND recommendation.archived_at IS NULL
      AND recommendation.source_slot_lineage_id = lineage.source_slot_lineage_id
    RETURNING recommendation.id
  ), reconciled_stale_progression AS (
    UPDATE progression_jobs job
    SET status = 'completed',
        lease_token = NULL,
        leased_until = NULL,
        last_error =
          'Superseded progression input: workout history changed during snapshot restore.',
        completed_at = statement_timestamp(),
        updated_at = statement_timestamp()
    FROM reconciled
    WHERE job.user_id = p_user_id
      AND job.session_id = reconciled.id
      AND job.source_session_revision <> reconciled.history_revision
      AND job.status IN ('pending', 'processing')
    RETURNING job.id
  ), queued_progression AS (
    INSERT INTO progression_jobs (
      id, user_id, session_id, source_session_revision,
      coaching_prefs, next_attempt_at
    )
    SELECT
      gen_random_uuid(),
      p_user_id,
      reconciled.id,
      reconciled.history_revision,
      profile.coaching_prefs,
      statement_timestamp()
    FROM reconciled
    JOIN user_profiles profile ON profile.user_id = p_user_id
    ON CONFLICT (session_id, source_session_revision) DO NOTHING
    RETURNING id, session_id
  ), audited AS (
    INSERT INTO audit_logs (
      user_id, actor_type, action, entity_type, entity_id, summary,
      cause_ref, idempotency_key
    )
    SELECT
      p_user_id,
      'user',
      'workout_session.snapshot_restore',
      'workout_session',
      versioned.entity_id::text,
      'Restored completed workout timing evidence from a recovery snapshot and retained later correction evidence',
      jsonb_build_object(
        'versionId', versioned.id,
        'sourceVersionId', versioned.source_version_id,
        'sourceSnapshotId', p_source_snapshot_id,
        'safetySnapshotId', p_safety_snapshot_id,
        'sourceHistoryRevision', (versioned.before_data->>'history_revision')::integer,
        'resultHistoryRevision', (versioned.after_data->>'history_revision')::integer,
        'changedFields', versioned.changed_fields,
        'progressionJobId', queued.id
      ),
      concat(
        'workout_session.snapshot_restore:',
        p_source_snapshot_id::text,
        ':',
        p_safety_snapshot_id::text,
        ':',
        versioned.entity_id::text
      )
    FROM versioned
    LEFT JOIN queued_progression queued ON queued.session_id = versioned.entity_id
    ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
    RETURNING id
  )
  SELECT count(*)::integer INTO v_transitions FROM versioned;

  IF p_fail_after_table = 'workout_timing_evidence' THEN
    RAISE EXCEPTION 'Injected restore failure after workout timing evidence.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_timing_versions) source(value)
    LEFT JOIN record_versions restored ON restored.id = (source.value->>'id')::uuid
    WHERE restored.id IS NULL OR to_jsonb(restored) IS DISTINCT FROM source.value
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_audits) source(value)
    LEFT JOIN audit_logs restored ON restored.id = (source.value->>'id')::uuid
    WHERE restored.id IS NULL OR to_jsonb(restored) IS DISTINCT FROM source.value
  ) THEN
    RAISE EXCEPTION 'Merged snapshot workout-timing evidence failed final verification.'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{restoredRecords}',
    to_jsonb(
      COALESCE((v_result->>'restoredRecords')::integer, 0)
      + v_merged_versions
      + v_merged_audits
      + (v_transitions * 2)
    )
  );
END;
$$;
