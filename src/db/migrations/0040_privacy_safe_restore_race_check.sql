CREATE OR REPLACE FUNCTION restore_user_snapshot_unguarded(
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
  target_tables text[];
  delete_order text[] := ARRAY[
    'adaptation_events', 'user_decisions', 'pain_logs', 'fatigue_logs',
    'completed_sets', 'session_notes', 'session_exercises', 'workout_sessions',
    'exercise_prescriptions', 'workout_template_exercises', 'superset_groups',
    'workout_templates', 'program_versions', 'programs', 'recommendations',
    'history_import_batches', 'import_events', 'external_exercise_mappings',
    'exercise_equipment_requirements', 'exercise_aliases', 'exercise_sources',
    'exercises', 'equipment_items', 'plate_inventory', 'barbell_configs',
    'constraints', 'user_profiles', 'health_activities', 'coaching_insights',
    'ai_parsing_events', 'archive_operation_records', 'archive_operations'
  ];
  dependency_order text[] := ARRAY[
    'equipment_definitions', 'exercise_families', 'archive_operations',
    'exercises', 'exercise_aliases', 'exercise_sources',
    'exercise_equipment_requirements', 'import_events', 'programs',
    'program_versions', 'workout_templates', 'superset_groups',
    'workout_template_exercises', 'exercise_prescriptions'
  ];
  lock_order text[] := ARRAY[
    'equipment_definitions', 'exercise_families', 'archive_operations',
    'archive_operation_records', 'exercises', 'exercise_aliases',
    'exercise_sources', 'exercise_equipment_requirements',
    'external_exercise_mappings', 'user_profiles', 'constraints',
    'equipment_items', 'plate_inventory', 'barbell_configs', 'import_events',
    'history_import_batches', 'programs', 'program_versions', 'workout_templates',
    'superset_groups', 'workout_template_exercises', 'exercise_prescriptions',
    'workout_sessions', 'session_exercises', 'completed_sets', 'session_notes',
    'pain_logs', 'fatigue_logs', 'health_activities', 'coaching_insights',
    'recommendations', 'user_decisions', 'adaptation_events', 'ai_parsing_events'
  ];
  insert_order text[] := ARRAY[
    'archive_operations', 'user_profiles', 'constraints', 'equipment_items',
    'plate_inventory', 'barbell_configs', 'exercises', 'exercise_aliases',
    'exercise_sources', 'exercise_equipment_requirements', 'import_events',
    'history_import_batches', 'programs', 'program_versions', 'workout_templates',
    'superset_groups', 'workout_template_exercises', 'exercise_prescriptions',
    'workout_sessions', 'session_exercises', 'completed_sets', 'session_notes',
    'pain_logs', 'fatigue_logs', 'health_activities', 'coaching_insights',
    'recommendations', 'user_decisions', 'adaptation_events', 'ai_parsing_events',
    'external_exercise_mappings', 'archive_operation_records'
  ];
  table_name text;
  predicate text;
  current_rows jsonb;
  restored_rows integer := 0;
BEGIN
  IF p_scope = 'full' THEN
    target_tables := ARRAY[
      'user_profiles', 'constraints', 'equipment_items', 'plate_inventory',
      'barbell_configs', 'exercises', 'exercise_aliases', 'exercise_sources',
      'exercise_equipment_requirements', 'external_exercise_mappings', 'programs',
      'program_versions', 'workout_templates', 'superset_groups',
      'workout_template_exercises', 'exercise_prescriptions', 'workout_sessions',
      'session_exercises', 'completed_sets', 'session_notes', 'pain_logs',
      'fatigue_logs', 'health_activities', 'recommendations', 'user_decisions',
      'adaptation_events', 'coaching_insights', 'ai_parsing_events', 'import_events',
      'history_import_batches', 'archive_operations', 'archive_operation_records'
    ];
  ELSIF p_scope = 'history' THEN
    target_tables := ARRAY[
      'history_import_batches', 'workout_sessions', 'session_exercises',
      'completed_sets', 'session_notes', 'pain_logs', 'fatigue_logs',
      'health_activities', 'recommendations', 'user_decisions',
      'adaptation_events', 'coaching_insights'
    ];
  ELSE
    RAISE EXCEPTION 'Unsupported snapshot restore scope.' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Snapshot owner was not found.' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_expected_current) AS key
    WHERE NOT (key = ANY(target_tables))
  ) OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_target_rows) AS key
    WHERE NOT (key = ANY(target_tables))
  ) THEN
    RAISE EXCEPTION 'Snapshot restore contained an unexpected target table.'
      USING ERRCODE = '22023';
  END IF;

  FOREACH table_name IN ARRAY target_tables LOOP
    IF NOT (p_expected_current ? table_name) OR NOT (p_target_rows ? table_name) THEN
      RAISE EXCEPTION 'Snapshot restore is missing table %.', table_name
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_dependency_rows) AS key
    WHERE NOT (key = ANY(dependency_order))
  ) THEN
    RAISE EXCEPTION 'Snapshot restore contained an unexpected dependency table.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  PERFORM set_config('lock_timeout', '5s', true);
  FOREACH table_name IN ARRAY lock_order LOOP
    EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE', table_name);
  END LOOP;

  -- Re-read every affected row inside this transaction. A stale preview cannot
  -- delete newer work, even if another request changed a row after preview.
  FOREACH table_name IN ARRAY target_tables LOOP
    predicate := CASE table_name
      WHEN 'user_profiles' THEN 'r.user_id = $1'
      WHEN 'constraints' THEN 'r.user_id = $1'
      WHEN 'equipment_items' THEN 'r.user_id = $1'
      WHEN 'plate_inventory' THEN 'r.user_id = $1'
      WHEN 'barbell_configs' THEN 'r.user_id = $1'
      WHEN 'exercises' THEN 'r.user_id = $1'
      WHEN 'exercise_aliases' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'exercise_sources' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'exercise_equipment_requirements' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'external_exercise_mappings' THEN 'r.user_id = $1'
      WHEN 'programs' THEN 'r.user_id = $1'
      WHEN 'program_versions' THEN 'EXISTS (SELECT 1 FROM programs p WHERE p.id = r.program_id AND p.user_id = $1)'
      WHEN 'workout_templates' THEN 'EXISTS (SELECT 1 FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = r.program_version_id AND p.user_id = $1)'
      WHEN 'superset_groups' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
      WHEN 'workout_template_exercises' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
      WHEN 'exercise_prescriptions' THEN 'EXISTS (SELECT 1 FROM workout_template_exercises wte JOIN workout_templates wt ON wt.id = wte.workout_template_id JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wte.id = r.template_exercise_id AND p.user_id = $1)'
      WHEN 'workout_sessions' THEN 'r.user_id = $1'
      WHEN 'session_exercises' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
      WHEN 'completed_sets' THEN 'EXISTS (SELECT 1 FROM session_exercises se JOIN workout_sessions ws ON ws.id = se.session_id WHERE se.id = r.session_exercise_id AND ws.user_id = $1)'
      WHEN 'session_notes' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
      WHEN 'pain_logs' THEN 'r.user_id = $1'
      WHEN 'fatigue_logs' THEN 'r.user_id = $1'
      WHEN 'health_activities' THEN 'r.user_id = $1'
      WHEN 'recommendations' THEN 'r.user_id = $1'
      WHEN 'user_decisions' THEN 'EXISTS (SELECT 1 FROM recommendations rec WHERE rec.id = r.recommendation_id AND rec.user_id = $1)'
      WHEN 'adaptation_events' THEN 'r.user_id = $1'
      WHEN 'coaching_insights' THEN 'r.user_id = $1'
      WHEN 'ai_parsing_events' THEN 'r.user_id = $1'
      WHEN 'import_events' THEN 'r.user_id = $1'
      WHEN 'history_import_batches' THEN 'r.user_id = $1'
      WHEN 'archive_operations' THEN 'r.user_id = $1'
      WHEN 'archive_operation_records' THEN 'r.user_id = $1'
      ELSE NULL
    END;
    IF predicate IS NULL THEN
      RAISE EXCEPTION 'Snapshot restore table % has no ownership rule.', table_name;
    END IF;
    IF table_name = 'coaching_insights' THEN
      SELECT COALESCE(
        jsonb_agg(
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
          ORDER BY insight.id
        ),
        '[]'::jsonb
      )
      INTO current_rows
      FROM coaching_insights insight
      WHERE insight.user_id = p_user_id;
    ELSIF table_name = 'ai_parsing_events' THEN
      SELECT COALESCE(
        jsonb_agg(
          (
            to_jsonb(event)
            - 'input_sha256'
            - 'raw_input'
            - 'raw_output'
            - 'parsed_json'
            - 'ambiguities'
            - 'raw_redacted_at'
            - 'retention_expires_at'
          ) || jsonb_build_object(
            'input_sha256', COALESCE(
              NULLIF(event.input_sha256, ''),
              encode(sha256(convert_to(event.raw_input, 'UTF8')), 'hex')
            ),
            'raw_input', '',
            'raw_output', NULL::text,
            'parsed_json', NULL::jsonb,
            'ambiguities', '[]'::jsonb,
            'raw_redacted_at', COALESCE(event.raw_redacted_at, event.created_at),
            'retention_expires_at', NULL::timestamptz
          )
          ORDER BY event.id
        ),
        '[]'::jsonb
      )
      INTO current_rows
      FROM ai_parsing_events event
      WHERE event.user_id = p_user_id;
    ELSIF table_name = 'import_events' THEN
      SELECT COALESCE(
        jsonb_agg(
          (
            to_jsonb(event)
            - 'payload_sha256'
            - 'raw_payload'
            - 'parsed_payload'
            - 'status'
            - 'raw_redacted_at'
            - 'retention_expires_at'
          ) || jsonb_build_object(
            'payload_sha256', COALESCE(
              NULLIF(event.payload_sha256, ''),
              encode(sha256(convert_to(event.raw_payload, 'UTF8')), 'hex')
            ),
            'raw_payload', '',
            'parsed_payload', NULL::jsonb,
            'status', CASE
              WHEN event.status IN ('raw', 'parsed') THEN 'discarded'
              ELSE event.status
            END,
            'raw_redacted_at', COALESCE(event.raw_redacted_at, event.created_at),
            'retention_expires_at', NULL::timestamptz
          )
          ORDER BY event.id
        ),
        '[]'::jsonb
      )
      INTO current_rows
      FROM import_events event
      WHERE event.user_id = p_user_id;
    ELSE
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), ''[]''::jsonb) FROM %I r WHERE %s',
        table_name,
        predicate
      ) USING p_user_id INTO current_rows;
    END IF;
    IF current_rows IS DISTINCT FROM p_expected_current -> table_name THEN
      RAISE EXCEPTION 'Restore preview is stale for table %.', table_name
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY delete_order LOOP
    IF p_target_rows ? table_name THEN
      predicate := CASE table_name
        WHEN 'user_profiles' THEN 'r.user_id = $1'
        WHEN 'constraints' THEN 'r.user_id = $1'
        WHEN 'equipment_items' THEN 'r.user_id = $1'
        WHEN 'plate_inventory' THEN 'r.user_id = $1'
        WHEN 'barbell_configs' THEN 'r.user_id = $1'
        WHEN 'exercises' THEN 'r.user_id = $1'
        WHEN 'exercise_aliases' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
        WHEN 'exercise_sources' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
        WHEN 'exercise_equipment_requirements' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
        WHEN 'external_exercise_mappings' THEN 'r.user_id = $1'
        WHEN 'programs' THEN 'r.user_id = $1'
        WHEN 'program_versions' THEN 'EXISTS (SELECT 1 FROM programs p WHERE p.id = r.program_id AND p.user_id = $1)'
        WHEN 'workout_templates' THEN 'EXISTS (SELECT 1 FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = r.program_version_id AND p.user_id = $1)'
        WHEN 'superset_groups' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
        WHEN 'workout_template_exercises' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
        WHEN 'exercise_prescriptions' THEN 'EXISTS (SELECT 1 FROM workout_template_exercises wte JOIN workout_templates wt ON wt.id = wte.workout_template_id JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wte.id = r.template_exercise_id AND p.user_id = $1)'
        WHEN 'workout_sessions' THEN 'r.user_id = $1'
        WHEN 'session_exercises' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
        WHEN 'completed_sets' THEN 'EXISTS (SELECT 1 FROM session_exercises se JOIN workout_sessions ws ON ws.id = se.session_id WHERE se.id = r.session_exercise_id AND ws.user_id = $1)'
        WHEN 'session_notes' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
        WHEN 'pain_logs' THEN 'r.user_id = $1'
        WHEN 'fatigue_logs' THEN 'r.user_id = $1'
        WHEN 'health_activities' THEN 'r.user_id = $1'
        WHEN 'recommendations' THEN 'r.user_id = $1'
        WHEN 'user_decisions' THEN 'EXISTS (SELECT 1 FROM recommendations rec WHERE rec.id = r.recommendation_id AND rec.user_id = $1)'
        WHEN 'adaptation_events' THEN 'r.user_id = $1'
        WHEN 'coaching_insights' THEN 'r.user_id = $1'
        WHEN 'ai_parsing_events' THEN 'r.user_id = $1'
        WHEN 'import_events' THEN 'r.user_id = $1'
        WHEN 'history_import_batches' THEN 'r.user_id = $1'
        WHEN 'archive_operations' THEN 'r.user_id = $1'
        WHEN 'archive_operation_records' THEN 'r.user_id = $1'
      END;
      EXECUTE format('DELETE FROM %I r WHERE %s', table_name, predicate) USING p_user_id;
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY dependency_order LOOP
    IF p_dependency_rows ? table_name THEN
      EXECUTE format(
        'INSERT INTO %I SELECT * FROM jsonb_populate_recordset(NULL::%I, $1) ON CONFLICT (id) DO NOTHING',
        table_name,
        table_name
      ) USING p_dependency_rows -> table_name;
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY insert_order LOOP
    IF p_target_rows ? table_name THEN
      EXECUTE format(
        'INSERT INTO %I SELECT * FROM jsonb_populate_recordset(NULL::%I, $1)',
        table_name,
        table_name
      ) USING p_target_rows -> table_name;
      restored_rows := restored_rows + jsonb_array_length(p_target_rows -> table_name);
      IF p_fail_after_table = table_name THEN
        RAISE EXCEPTION 'Injected restore failure after table %.', table_name;
      END IF;
    END IF;
  END LOOP;

  -- Confirm the new state before recording success. Any mismatch raises and
  -- rolls back every preceding delete/insert in this function call.
  FOREACH table_name IN ARRAY target_tables LOOP
    predicate := CASE table_name
      WHEN 'user_profiles' THEN 'r.user_id = $1'
      WHEN 'constraints' THEN 'r.user_id = $1'
      WHEN 'equipment_items' THEN 'r.user_id = $1'
      WHEN 'plate_inventory' THEN 'r.user_id = $1'
      WHEN 'barbell_configs' THEN 'r.user_id = $1'
      WHEN 'exercises' THEN 'r.user_id = $1'
      WHEN 'exercise_aliases' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'exercise_sources' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'exercise_equipment_requirements' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'external_exercise_mappings' THEN 'r.user_id = $1'
      WHEN 'programs' THEN 'r.user_id = $1'
      WHEN 'program_versions' THEN 'EXISTS (SELECT 1 FROM programs p WHERE p.id = r.program_id AND p.user_id = $1)'
      WHEN 'workout_templates' THEN 'EXISTS (SELECT 1 FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = r.program_version_id AND p.user_id = $1)'
      WHEN 'superset_groups' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
      WHEN 'workout_template_exercises' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
      WHEN 'exercise_prescriptions' THEN 'EXISTS (SELECT 1 FROM workout_template_exercises wte JOIN workout_templates wt ON wt.id = wte.workout_template_id JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wte.id = r.template_exercise_id AND p.user_id = $1)'
      WHEN 'workout_sessions' THEN 'r.user_id = $1'
      WHEN 'session_exercises' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
      WHEN 'completed_sets' THEN 'EXISTS (SELECT 1 FROM session_exercises se JOIN workout_sessions ws ON ws.id = se.session_id WHERE se.id = r.session_exercise_id AND ws.user_id = $1)'
      WHEN 'session_notes' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
      WHEN 'pain_logs' THEN 'r.user_id = $1'
      WHEN 'fatigue_logs' THEN 'r.user_id = $1'
      WHEN 'health_activities' THEN 'r.user_id = $1'
      WHEN 'recommendations' THEN 'r.user_id = $1'
      WHEN 'user_decisions' THEN 'EXISTS (SELECT 1 FROM recommendations rec WHERE rec.id = r.recommendation_id AND rec.user_id = $1)'
      WHEN 'adaptation_events' THEN 'r.user_id = $1'
      WHEN 'coaching_insights' THEN 'r.user_id = $1'
      WHEN 'ai_parsing_events' THEN 'r.user_id = $1'
      WHEN 'import_events' THEN 'r.user_id = $1'
      WHEN 'history_import_batches' THEN 'r.user_id = $1'
      WHEN 'archive_operations' THEN 'r.user_id = $1'
      WHEN 'archive_operation_records' THEN 'r.user_id = $1'
    END;
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), ''[]''::jsonb) FROM %I r WHERE %s',
      table_name,
      predicate
    ) USING p_user_id INTO current_rows;
    IF current_rows IS DISTINCT FROM p_target_rows -> table_name THEN
      RAISE EXCEPTION 'Restored table % failed final verification.', table_name;
    END IF;
  END LOOP;

  INSERT INTO audit_logs (
    user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
  ) VALUES (
    p_user_id,
    'user',
    'snapshot.restore',
    'data_snapshot',
    p_source_snapshot_id::text,
    CASE p_scope
      WHEN 'full' THEN 'Restored all restorable data from a verified snapshot'
      ELSE 'Restored workout and activity history from a verified snapshot'
    END,
    jsonb_build_object(
      'scope', p_scope,
      'sourceSnapshotId', p_source_snapshot_id,
      'safetySnapshotId', p_safety_snapshot_id,
      'restoredRecords', restored_rows
    )
  );

  RETURN jsonb_build_object(
    'scope', p_scope,
    'restoredRecords', restored_rows,
    'sourceSnapshotId', p_source_snapshot_id,
    'safetySnapshotId', p_safety_snapshot_id
  );
END;
$$;
