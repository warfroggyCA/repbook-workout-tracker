CREATE TABLE "permanent_delete_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text DEFAULT 'archive.permanent_delete' NOT NULL,
	"provider" text NOT NULL,
	"preview" jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authenticated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "permanent_delete_grants_purpose_valid" CHECK ("permanent_delete_grants"."purpose" = 'archive.permanent_delete'),
	CONSTRAINT "permanent_delete_grants_provider_valid" CHECK ("permanent_delete_grants"."provider" in ('github', 'dev-login')),
	CONSTRAINT "permanent_delete_grants_expiry_valid" CHECK ("permanent_delete_grants"."expires_at" > "permanent_delete_grants"."requested_at")
);
--> statement-breakpoint
ALTER TABLE "archive_operations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "permanent_delete_grants" ADD CONSTRAINT "permanent_delete_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permanent_delete_grants" ADD CONSTRAINT "permanent_delete_grants_operation_id_archive_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "permanent_delete_grants_token_hash_uq" ON "permanent_delete_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "permanent_delete_grants_user_operation_idx" ON "permanent_delete_grants" USING btree ("user_id","operation_id","expires_at");
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
WITH target_operation AS (
  SELECT id, summary
  FROM archive_operations
  WHERE id = p_operation_id
    AND user_id = p_user_id
    AND status = 'active'
), members AS (
  SELECT r.*
  FROM archive_operation_records r
  JOIN target_operation op ON op.id = r.operation_id
  WHERE r.user_id = p_user_id
), target_sessions AS (
  SELECT ws.* FROM workout_sessions ws
  JOIN members m ON m.entity_type = 'workout_session' AND m.entity_id = ws.id::text
  WHERE ws.user_id = p_user_id
), target_session_exercises AS (
  SELECT se.* FROM session_exercises se
  JOIN members m ON m.entity_type = 'session_exercise' AND m.entity_id = se.id::text
), target_sets AS (
  SELECT cs.* FROM completed_sets cs
  JOIN members m ON m.entity_type = 'completed_set' AND m.entity_id = cs.id::text
), root_sets AS (
  SELECT cs.* FROM target_sets cs
  JOIN members m ON m.entity_type = 'completed_set'
    AND m.entity_id = cs.id::text AND m.relationship_role = 'root'
), target_notes AS (
  SELECT sn.* FROM session_notes sn
  JOIN members m ON m.entity_type = 'session_note' AND m.entity_id = sn.id::text
), target_pain AS (
  SELECT DISTINCT pl.*
  FROM pain_logs pl
  WHERE pl.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'pain_log' AND m.entity_id = pl.id::text)
    OR EXISTS (SELECT 1 FROM target_sessions ws WHERE ws.id = pl.session_id)
    OR EXISTS (SELECT 1 FROM target_sets cs WHERE cs.id::text = pl.completed_set_id::text)
  )
), target_fatigue AS (
  SELECT DISTINCT fl.*
  FROM fatigue_logs fl
  WHERE fl.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'fatigue_log' AND m.entity_id = fl.id::text)
    OR EXISTS (SELECT 1 FROM target_sessions ws WHERE ws.id = fl.session_id)
  )
), target_activities AS (
  SELECT ha.* FROM health_activities ha
  JOIN members m ON m.entity_type = 'health_activity' AND m.entity_id = ha.id::text
  WHERE ha.user_id = p_user_id
), target_batches AS (
  SELECT hib.* FROM history_import_batches hib
  JOIN members m ON m.entity_type = 'history_import_batch' AND m.entity_id = hib.id::text
  WHERE hib.user_id = p_user_id
), target_import_events AS (
  SELECT DISTINCT ie.* FROM import_events ie
  WHERE ie.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'import_event' AND m.entity_id = ie.id::text)
    OR EXISTS (SELECT 1 FROM target_batches hib WHERE hib.import_event_id = ie.id)
  )
), target_exercises AS (
  SELECT e.* FROM exercises e
  JOIN members m ON m.entity_type = 'exercise' AND m.entity_id = e.id::text
  WHERE e.user_id = p_user_id
), target_mappings AS (
  SELECT DISTINCT eem.* FROM external_exercise_mappings eem
  WHERE eem.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'external_exercise_mapping' AND m.entity_id = eem.id::text)
    OR EXISTS (SELECT 1 FROM target_exercises e WHERE e.id = eem.exercise_id)
  )
), target_recommendations AS (
  SELECT DISTINCT r.* FROM recommendations r
  WHERE r.user_id = p_user_id AND (
    EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'recommendation' AND m.entity_id = r.id::text)
    OR EXISTS (SELECT 1 FROM members m WHERE r.evidence::text LIKE '%' || m.entity_id || '%')
  )
), target_decisions AS (
  SELECT d.* FROM user_decisions d
  WHERE EXISTS (SELECT 1 FROM target_recommendations r WHERE r.id = d.recommendation_id)
), target_adaptations AS (
  SELECT a.* FROM adaptation_events a
  WHERE a.user_id = p_user_id
    AND EXISTS (SELECT 1 FROM target_recommendations r WHERE r.id = a.recommendation_id)
), target_insights AS (
  SELECT DISTINCT ci.* FROM coaching_insights ci
  WHERE ci.user_id = p_user_id
    AND EXISTS (SELECT 1 FROM members m WHERE ci.data_digest::text LIKE '%' || m.entity_id || '%')
), target_versions AS (
  SELECT DISTINCT rv.* FROM record_versions rv
  WHERE rv.user_id = p_user_id
    AND EXISTS (
      SELECT 1 FROM members m
      WHERE m.entity_type = rv.entity_type AND m.entity_id = rv.entity_id::text
    )
), missing_members AS (
  SELECT count(*)::int AS count FROM members m WHERE
    (m.entity_type = 'workout_session' AND NOT EXISTS (SELECT 1 FROM workout_sessions x WHERE x.id::text = m.entity_id AND x.user_id = p_user_id)) OR
    (m.entity_type = 'session_exercise' AND NOT EXISTS (SELECT 1 FROM session_exercises x WHERE x.id::text = m.entity_id)) OR
    (m.entity_type = 'completed_set' AND NOT EXISTS (SELECT 1 FROM completed_sets x WHERE x.id::text = m.entity_id)) OR
    (m.entity_type = 'session_note' AND NOT EXISTS (SELECT 1 FROM session_notes x WHERE x.id::text = m.entity_id)) OR
    (m.entity_type = 'pain_log' AND NOT EXISTS (SELECT 1 FROM pain_logs x WHERE x.id::text = m.entity_id AND x.user_id = p_user_id)) OR
    (m.entity_type = 'fatigue_log' AND NOT EXISTS (SELECT 1 FROM fatigue_logs x WHERE x.id::text = m.entity_id AND x.user_id = p_user_id)) OR
    (m.entity_type = 'health_activity' AND NOT EXISTS (SELECT 1 FROM health_activities x WHERE x.id::text = m.entity_id AND x.user_id = p_user_id)) OR
    (m.entity_type = 'recommendation' AND NOT EXISTS (SELECT 1 FROM recommendations x WHERE x.id::text = m.entity_id AND x.user_id = p_user_id)) OR
    (m.entity_type = 'history_import_batch' AND NOT EXISTS (SELECT 1 FROM history_import_batches x WHERE x.id::text = m.entity_id AND x.user_id = p_user_id)) OR
    (m.entity_type = 'import_event' AND NOT EXISTS (SELECT 1 FROM import_events x WHERE x.id::text = m.entity_id AND x.user_id = p_user_id)) OR
    (m.entity_type = 'exercise' AND NOT EXISTS (SELECT 1 FROM exercises x WHERE x.id::text = m.entity_id AND x.user_id = p_user_id)) OR
    (m.entity_type = 'external_exercise_mapping' AND NOT EXISTS (SELECT 1 FROM external_exercise_mappings x WHERE x.id::text = m.entity_id AND x.user_id = p_user_id))
), state_conflicts AS (
  SELECT (
    (SELECT count(*) FROM target_sessions x WHERE x.archived_at IS NULL OR x.archive_operation_id IS DISTINCT FROM p_operation_id) +
    (SELECT count(*) FROM root_sets x WHERE x.archived_at IS NULL OR x.archive_operation_id IS DISTINCT FROM p_operation_id) +
    (SELECT count(*) FROM target_activities x WHERE x.archived_at IS NULL OR x.archive_operation_id IS DISTINCT FROM p_operation_id) +
    (SELECT count(*) FROM target_batches x WHERE x.archived_at IS NULL OR x.archive_operation_id IS DISTINCT FROM p_operation_id)
  )::int AS count
), nested_children AS (
  SELECT (
    (SELECT count(*) FROM session_exercises x WHERE EXISTS (SELECT 1 FROM target_sessions s WHERE s.id = x.session_id) AND NOT EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'session_exercise' AND m.entity_id = x.id::text)) +
    (SELECT count(*) FROM completed_sets x JOIN session_exercises se ON se.id = x.session_exercise_id WHERE EXISTS (SELECT 1 FROM target_sessions s WHERE s.id = se.session_id) AND NOT EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'completed_set' AND m.entity_id = x.id::text)) +
    (SELECT count(*) FROM session_notes x WHERE EXISTS (SELECT 1 FROM target_sessions s WHERE s.id = x.session_id) AND NOT EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'session_note' AND m.entity_id = x.id::text)) +
    (SELECT count(*) FROM pain_logs x WHERE EXISTS (SELECT 1 FROM target_sessions s WHERE s.id = x.session_id) AND NOT EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'pain_log' AND m.entity_id = x.id::text)) +
    (SELECT count(*) FROM fatigue_logs x WHERE EXISTS (SELECT 1 FROM target_sessions s WHERE s.id = x.session_id) AND NOT EXISTS (SELECT 1 FROM members m WHERE m.entity_type = 'fatigue_log' AND m.entity_id = x.id::text))
  )::int AS count
), nested_batch_sessions AS (
  SELECT count(*)::int AS count
  FROM workout_sessions ws
  WHERE EXISTS (SELECT 1 FROM target_batches b WHERE b.id = ws.import_batch_id)
    AND NOT EXISTS (SELECT 1 FROM target_sessions s WHERE s.id = ws.id)
), exercise_references AS (
  SELECT (
    (SELECT count(*) FROM session_exercises se WHERE EXISTS (SELECT 1 FROM target_exercises e WHERE e.id = se.exercise_id) AND NOT EXISTS (SELECT 1 FROM target_sessions s WHERE s.id = se.session_id)) +
    (SELECT count(*) FROM workout_template_exercises wte WHERE EXISTS (SELECT 1 FROM target_exercises e WHERE e.id = wte.exercise_id)) +
    (SELECT count(*) FROM pain_logs pl WHERE EXISTS (SELECT 1 FROM target_exercises e WHERE e.id = pl.exercise_id) AND NOT EXISTS (SELECT 1 FROM target_pain p WHERE p.id = pl.id)) +
    (SELECT count(*) FROM recommendations r WHERE EXISTS (SELECT 1 FROM target_exercises e WHERE e.id = r.exercise_id) AND NOT EXISTS (SELECT 1 FROM target_recommendations tr WHERE tr.id = r.id))
  )::int AS count
), mapping_references AS (
  SELECT count(*)::int AS count
  FROM target_mappings m
  JOIN session_exercises se ON se.source_exercise_name = m.source_name
  JOIN workout_sessions ws ON ws.id = se.session_id
  WHERE NOT EXISTS (SELECT 1 FROM target_sessions s WHERE s.id = ws.id)
), import_references AS (
  SELECT (
    (SELECT count(*) FROM program_versions pv WHERE EXISTS (SELECT 1 FROM target_import_events ie WHERE ie.id = pv.source_import_event_id)) +
    (SELECT count(*) FROM history_import_batches hib WHERE EXISTS (SELECT 1 FROM target_import_events ie WHERE ie.id = hib.import_event_id) AND NOT EXISTS (SELECT 1 FROM target_batches b WHERE b.id = hib.id)) +
    (SELECT count(*) FROM exercises e WHERE EXISTS (SELECT 1 FROM target_import_events ie WHERE ie.id = e.created_from_import_event_id) AND NOT EXISTS (SELECT 1 FROM target_exercises te WHERE te.id = e.id))
  )::int AS count
), blocker_rows AS (
  SELECT 'missing_member'::text AS key, 'The archive membership no longer matches the stored records.'::text AS message, count FROM missing_members WHERE count > 0
  UNION ALL SELECT 'archive_state_changed', 'One or more roots are no longer controlled by this Archive action.', count FROM state_conflicts WHERE count > 0
  UNION ALL SELECT 'nested_archive', 'A linked workout record is controlled by a different Archive action.', count FROM nested_children WHERE count > 0
  UNION ALL SELECT 'nested_workout_archive', 'An imported workout is controlled by a different Archive action.', count FROM nested_batch_sessions WHERE count > 0
  UNION ALL SELECT 'exercise_in_use', 'A custom exercise is still used outside this archived scope.', count FROM exercise_references WHERE count > 0
  UNION ALL SELECT 'mapping_in_use', 'A reviewed mapping is still used outside this archived scope.', count FROM mapping_references WHERE count > 0
  UNION ALL SELECT 'import_in_use', 'Import provenance is still linked to records outside this archived scope.', count FROM import_references WHERE count > 0
)
SELECT jsonb_build_object(
  'operationId', op.id,
  'rootType', COALESCE((SELECT min(entity_type) FROM members WHERE relationship_role = 'root'), 'archive_operation'),
  'summary', op.summary,
  'deleteCounts', jsonb_build_object(
    'workoutSessions', (SELECT count(*) FROM target_sessions),
    'sessionExercises', (SELECT count(*) FROM target_session_exercises),
    'completedSets', (SELECT count(*) FROM target_sets),
    'sessionNotes', (SELECT count(*) FROM target_notes),
    'painLogs', (SELECT count(*) FROM target_pain),
    'fatigueLogs', (SELECT count(*) FROM target_fatigue),
    'healthActivities', (SELECT count(*) FROM target_activities),
    'recommendations', (SELECT count(*) FROM target_recommendations),
    'userDecisions', (SELECT count(*) FROM target_decisions),
    'adaptationEvents', (SELECT count(*) FROM target_adaptations),
    'coachingInsights', (SELECT count(*) FROM target_insights),
    'historyImportBatches', (SELECT count(*) FROM target_batches),
    'importEvents', (SELECT count(*) FROM target_import_events),
    'externalExerciseMappings', (SELECT count(*) FROM target_mappings),
    'customExercises', (SELECT count(*) FROM target_exercises),
    'exerciseAliases', (SELECT count(*) FROM exercise_aliases a WHERE EXISTS (SELECT 1 FROM target_exercises e WHERE e.id = a.exercise_id)),
    'exerciseSources', (SELECT count(*) FROM exercise_sources s WHERE EXISTS (SELECT 1 FROM target_exercises e WHERE e.id = s.exercise_id)),
    'exerciseRequirements', (SELECT count(*) FROM exercise_equipment_requirements r WHERE EXISTS (SELECT 1 FROM target_exercises e WHERE e.id = r.exercise_id)),
    'recordVersions', (SELECT count(*) FROM target_versions)
  ),
  'preservedCounts', jsonb_build_object(
    'archiveMembership', (SELECT count(*) FROM members),
    'auditRecords', (SELECT count(*) FROM audit_logs a WHERE a.user_id = p_user_id AND (a.entity_id = p_operation_id::text OR coalesce(a.cause_ref::text, '') LIKE '%' || p_operation_id::text || '%')),
    'protectedSnapshots', (SELECT count(*) FROM data_snapshots s WHERE s.user_id = p_user_id AND s.source_operation_id = p_operation_id)
  ),
  'blockers', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'message', message, 'count', count) ORDER BY key) FROM blocker_rows), '[]'::jsonb)
)
FROM target_operation op;
$$;
--> statement-breakpoint
ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_unguarded;
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
BEGIN
  PERFORM set_config('workout_tracker.authorized_delete', 'snapshot_restore', true);
  RETURN restore_user_snapshot_unguarded(
    p_user_id, p_scope, p_expected_current, p_target_rows, p_dependency_rows,
    p_source_snapshot_id, p_safety_snapshot_id, p_fail_after_table
  );
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_protected_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'exercises' THEN
    IF (to_jsonb(OLD)->>'user_id') IS NULL THEN
      RETURN OLD;
    END IF;
  END IF;
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '')
      NOT IN ('permanent', 'snapshot_restore') THEN
    RAISE EXCEPTION 'Direct deletion from protected table % is not allowed.', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  protected_table text;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[
    'archive_operations', 'archive_operation_records', 'record_versions',
    'workout_sessions', 'completed_sets', 'session_notes', 'pain_logs',
    'fatigue_logs', 'health_activities', 'recommendations', 'coaching_insights',
    'history_import_batches', 'import_events', 'external_exercise_mappings',
    'exercises'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS protected_delete_guard ON %I', protected_table);
    EXECUTE format(
      'CREATE TRIGGER protected_delete_guard BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_protected_delete()',
      protected_table
    );
  END LOOP;
END;
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
    workout_sessions, session_exercises, completed_sets, session_notes,
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
