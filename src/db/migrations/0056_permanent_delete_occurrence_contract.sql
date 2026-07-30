ALTER FUNCTION permanent_delete_archive_preview(uuid, uuid)
  RENAME TO permanent_delete_archive_preview_without_occurrence_contract;
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
  SELECT permanent_delete_archive_preview_without_occurrence_contract(
    p_user_id,
    p_operation_id
  ) AS preview
), target_occurrences AS (
  SELECT occurrence.id
  FROM session_occurrences occurrence
  WHERE EXISTS (
    SELECT 1
    FROM archive_operation_records member
    WHERE member.operation_id = p_operation_id
      AND member.user_id = p_user_id
      AND (
        (member.entity_type = 'workout_session'
          AND member.entity_id = occurrence.session_id::text)
        OR (member.entity_type = 'completed_set'
          AND member.entity_id = occurrence.completed_set_id::text)
      )
  )
), occurrence_counts AS (
  SELECT
    (SELECT count(*)::integer FROM target_occurrences) AS occurrences,
    (
      SELECT count(*)::integer
      FROM session_occurrence_mutations mutation
      WHERE EXISTS (
        SELECT 1 FROM target_occurrences target
        WHERE target.id = mutation.occurrence_id
      )
    ) AS mutations,
    (
      SELECT count(*)::integer
      FROM session_exercise_groups exercise_group
      WHERE EXISTS (
        SELECT 1
        FROM archive_operation_records member
        WHERE member.operation_id = p_operation_id
          AND member.user_id = p_user_id
          AND member.entity_type = 'workout_session'
          AND member.entity_id = exercise_group.session_id::text
      )
    ) AS exercise_groups
)
SELECT CASE
  WHEN base.preview IS NULL THEN NULL
  ELSE jsonb_set(
    jsonb_set(
      jsonb_set(
        base.preview,
        '{deleteCounts,sessionOccurrenceMutations}',
        to_jsonb(occurrence_counts.mutations),
        true
      ),
      '{deleteCounts,sessionOccurrences}',
      to_jsonb(occurrence_counts.occurrences),
      true
    ),
    '{deleteCounts,sessionExerciseGroups}',
    to_jsonb(occurrence_counts.exercise_groups),
    true
  )
END
FROM base CROSS JOIN occurrence_counts;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanently_delete_archive_operation(
  p_user_id uuid,
  p_operation_id uuid,
  p_token_hash text,
  p_confirmation text,
  p_safety_snapshot_id uuid,
  p_fail_after_step text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_preview jsonb;
  v_grant_id uuid;
  v_count integer;
BEGIN
  IF p_confirmation <> 'DELETE PERMANENTLY' THEN
    RAISE EXCEPTION 'The permanent-delete confirmation phrase did not match.'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM data_snapshots
    WHERE id = p_safety_snapshot_id AND user_id = p_user_id
      AND status = 'verified' AND verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A verified safety snapshot is required.' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE archive_operations, archive_operation_records, permanent_delete_grants,
    workout_sessions, session_exercise_groups, session_exercises,
    session_occurrences, session_occurrence_mutations, completed_sets, session_notes,
    pain_logs, fatigue_logs, health_activities, recommendations, user_decisions,
    adaptation_events, coaching_insights, history_import_batches, import_events,
    external_exercise_mappings, exercises, exercise_aliases, exercise_sources,
    exercise_equipment_requirements, workout_template_exercises, program_versions,
    record_versions IN SHARE ROW EXCLUSIVE MODE;

  v_preview := permanent_delete_archive_preview(p_user_id, p_operation_id);
  IF v_preview IS NULL THEN
    RAISE EXCEPTION 'Active Archive action not found.' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_array_length(v_preview->'blockers') > 0 THEN
    RAISE EXCEPTION 'The archived scope has dependencies that must be resolved first.'
      USING ERRCODE = '23503';
  END IF;

  UPDATE permanent_delete_grants
  SET consumed_at = now()
  WHERE user_id = p_user_id
    AND operation_id = p_operation_id
    AND token_hash = p_token_hash
    AND purpose = 'archive.permanent_delete'
    AND provider IN ('github', 'dev-login')
    AND authenticated_at IS NOT NULL
    AND authenticated_at >= now() - interval '5 minutes'
    AND expires_at > now()
    AND consumed_at IS NULL
    AND (preview - 'preservedCounts') = (v_preview - 'preservedCounts')
  RETURNING id INTO v_grant_id;
  IF v_grant_id IS NULL THEN
    RAISE EXCEPTION 'The identity grant is missing, expired, stale, or already used.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('workout_tracker.authorized_delete', 'permanent', true);

  DELETE FROM record_versions rv
  WHERE rv.user_id = p_user_id AND EXISTS (
    SELECT 1 FROM archive_operation_records m
    WHERE m.operation_id = p_operation_id AND m.user_id = p_user_id
      AND m.entity_type = rv.entity_type AND m.entity_id = rv.entity_id::text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,recordVersions}')::int, 0) THEN RAISE EXCEPTION 'Record-version scope changed.'; END IF;

  DELETE FROM coaching_insights ci
  WHERE ci.user_id = p_user_id AND EXISTS (
    SELECT 1 FROM archive_operation_records m
    WHERE m.operation_id = p_operation_id AND m.user_id = p_user_id
      AND ci.data_digest::text LIKE '%' || m.entity_id || '%'
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,coachingInsights}')::int, 0) THEN RAISE EXCEPTION 'Coaching-insight scope changed.'; END IF;

  DELETE FROM user_decisions d WHERE EXISTS (
    SELECT 1 FROM recommendations r
    WHERE r.id = d.recommendation_id AND r.user_id = p_user_id AND (
      EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'recommendation' AND m.entity_id = r.id::text)
      OR EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND r.evidence::text LIKE '%' || m.entity_id || '%')
    )
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,userDecisions}')::int, 0) THEN RAISE EXCEPTION 'Decision scope changed.'; END IF;

  DELETE FROM adaptation_events a WHERE a.user_id = p_user_id AND EXISTS (
    SELECT 1 FROM recommendations r
    WHERE r.id = a.recommendation_id AND (
      EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'recommendation' AND m.entity_id = r.id::text)
      OR EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND r.evidence::text LIKE '%' || m.entity_id || '%')
    )
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,adaptationEvents}')::int, 0) THEN RAISE EXCEPTION 'Adaptation scope changed.'; END IF;

  DELETE FROM recommendations r WHERE r.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'recommendation' AND m.entity_id = r.id::text)
    OR EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND r.evidence::text LIKE '%' || m.entity_id || '%')
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,recommendations}')::int, 0) THEN RAISE EXCEPTION 'Recommendation scope changed.'; END IF;

  DELETE FROM pain_logs pl WHERE pl.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'pain_log' AND m.entity_id = pl.id::text)
    OR EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'workout_session' AND m.entity_id = pl.session_id::text)
    OR EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'completed_set' AND m.entity_id = pl.completed_set_id::text)
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,painLogs}')::int, 0) THEN RAISE EXCEPTION 'Pain-log scope changed.'; END IF;

  DELETE FROM fatigue_logs fl WHERE fl.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'fatigue_log' AND m.entity_id = fl.id::text)
    OR EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'workout_session' AND m.entity_id = fl.session_id::text)
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,fatigueLogs}')::int, 0) THEN RAISE EXCEPTION 'Fatigue-log scope changed.'; END IF;

  DELETE FROM session_notes sn WHERE EXISTS (
    SELECT 1 FROM archive_operation_records m
    WHERE m.operation_id = p_operation_id AND m.entity_type = 'session_note' AND m.entity_id = sn.id::text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,sessionNotes}')::int, 0) THEN RAISE EXCEPTION 'Session-note scope changed.'; END IF;

  DELETE FROM session_occurrence_mutations mutation
  WHERE EXISTS (
    SELECT 1
    FROM session_occurrences occurrence
    JOIN archive_operation_records member
      ON member.operation_id = p_operation_id
     AND member.user_id = p_user_id
     AND (
       (member.entity_type = 'workout_session' AND member.entity_id = occurrence.session_id::text)
       OR (member.entity_type = 'completed_set' AND member.entity_id = occurrence.completed_set_id::text)
     )
    WHERE occurrence.id = mutation.occurrence_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,sessionOccurrenceMutations}')::int, 0) THEN RAISE EXCEPTION 'Occurrence-mutation scope changed.'; END IF;

  DELETE FROM session_occurrences occurrence
  WHERE EXISTS (
    SELECT 1 FROM archive_operation_records member
    WHERE member.operation_id = p_operation_id
      AND member.user_id = p_user_id
      AND (
        (member.entity_type = 'workout_session' AND member.entity_id = occurrence.session_id::text)
        OR (member.entity_type = 'completed_set' AND member.entity_id = occurrence.completed_set_id::text)
      )
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,sessionOccurrences}')::int, 0) THEN RAISE EXCEPTION 'Occurrence scope changed.'; END IF;

  IF p_fail_after_step = 'session_occurrences' THEN
    RAISE EXCEPTION 'Injected permanent-delete failure after workout occurrences.';
  END IF;

  DELETE FROM completed_sets cs WHERE EXISTS (
    SELECT 1 FROM archive_operation_records m
    WHERE m.operation_id = p_operation_id AND m.entity_type = 'completed_set' AND m.entity_id = cs.id::text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,completedSets}')::int, 0) THEN RAISE EXCEPTION 'Set scope changed.'; END IF;

  DELETE FROM session_exercises se WHERE EXISTS (
    SELECT 1 FROM archive_operation_records m
    WHERE m.operation_id = p_operation_id AND m.entity_type = 'session_exercise' AND m.entity_id = se.id::text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,sessionExercises}')::int, 0) THEN RAISE EXCEPTION 'Exercise-occurrence scope changed.'; END IF;

  DELETE FROM session_exercise_groups exercise_group
  WHERE EXISTS (
    SELECT 1 FROM archive_operation_records member
    WHERE member.operation_id = p_operation_id
      AND member.user_id = p_user_id
      AND member.entity_type = 'workout_session'
      AND member.entity_id = exercise_group.session_id::text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,sessionExerciseGroups}')::int, 0) THEN RAISE EXCEPTION 'Exercise-group scope changed.'; END IF;

  DELETE FROM workout_sessions ws WHERE ws.user_id = p_user_id AND EXISTS (
    SELECT 1 FROM archive_operation_records m
    WHERE m.operation_id = p_operation_id AND m.entity_type = 'workout_session' AND m.entity_id = ws.id::text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,workoutSessions}')::int, 0) THEN RAISE EXCEPTION 'Workout scope changed.'; END IF;

  IF p_fail_after_step = 'workout_sessions' THEN
    RAISE EXCEPTION 'Injected permanent-delete failure after workouts.';
  END IF;

  DELETE FROM health_activities ha WHERE ha.user_id = p_user_id AND EXISTS (
    SELECT 1 FROM archive_operation_records m
    WHERE m.operation_id = p_operation_id AND m.entity_type = 'health_activity' AND m.entity_id = ha.id::text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,healthActivities}')::int, 0) THEN RAISE EXCEPTION 'Activity scope changed.'; END IF;

  DELETE FROM external_exercise_mappings eem WHERE eem.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'external_exercise_mapping' AND m.entity_id = eem.id::text)
    OR EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'exercise' AND m.entity_id = eem.exercise_id::text)
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,externalExerciseMappings}')::int, 0) THEN RAISE EXCEPTION 'Mapping scope changed.'; END IF;

  DELETE FROM history_import_batches hib WHERE hib.user_id = p_user_id AND EXISTS (
    SELECT 1 FROM archive_operation_records m
    WHERE m.operation_id = p_operation_id AND m.entity_type = 'history_import_batch' AND m.entity_id = hib.id::text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,historyImportBatches}')::int, 0) THEN RAISE EXCEPTION 'Import-batch scope changed.'; END IF;

  DELETE FROM exercise_aliases a WHERE EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'exercise' AND m.entity_id = a.exercise_id::text);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,exerciseAliases}')::int, 0) THEN RAISE EXCEPTION 'Exercise-alias scope changed.'; END IF;
  DELETE FROM exercise_sources s WHERE EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'exercise' AND m.entity_id = s.exercise_id::text);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,exerciseSources}')::int, 0) THEN RAISE EXCEPTION 'Exercise-source scope changed.'; END IF;
  DELETE FROM exercise_equipment_requirements r WHERE EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'exercise' AND m.entity_id = r.exercise_id::text);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,exerciseRequirements}')::int, 0) THEN RAISE EXCEPTION 'Exercise-requirement scope changed.'; END IF;

  DELETE FROM exercises e WHERE e.user_id = p_user_id AND EXISTS (
    SELECT 1 FROM archive_operation_records m
    WHERE m.operation_id = p_operation_id AND m.entity_type = 'exercise' AND m.entity_id = e.id::text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,customExercises}')::int, 0) THEN RAISE EXCEPTION 'Custom-exercise scope changed.'; END IF;

  DELETE FROM import_events ie WHERE ie.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM archive_operation_records m WHERE m.operation_id = p_operation_id AND m.entity_type = 'import_event' AND m.entity_id = ie.id::text)
    OR EXISTS (SELECT 1 FROM archive_operation_records m JOIN history_import_batches hib ON hib.id::text = m.entity_id WHERE m.operation_id = p_operation_id AND m.entity_type = 'history_import_batch' AND hib.import_event_id = ie.id)
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> COALESCE((v_preview#>>'{deleteCounts,importEvents}')::int, 0) THEN RAISE EXCEPTION 'Import-event scope changed.'; END IF;

  IF p_fail_after_step = 'all_records' THEN
    RAISE EXCEPTION 'Injected permanent-delete failure after all records.';
  END IF;

  UPDATE archive_operations
  SET status = 'deleted', deleted_at = now()
  WHERE id = p_operation_id AND user_id = p_user_id AND status = 'active';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'Archive action state changed.'; END IF;

  INSERT INTO audit_logs (
    user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
  ) VALUES (
    p_user_id, 'user', 'archive.permanent_delete', 'archive_operation',
    p_operation_id::text, 'Permanently deleted reviewed archived records',
    jsonb_build_object(
      'archiveOperationId', p_operation_id,
      'grantId', v_grant_id,
      'safetySnapshotId', p_safety_snapshot_id,
      'preview', v_preview
    )
  );

  RETURN v_preview;
END;
$$;
