-- Stage 4 recovery owns every new live profile and immutable workout setup.
-- Older restore wrappers remain intact underneath this additive boundary.

CREATE OR REPLACE FUNCTION validate_session_equipment_snapshot_live_ids()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_attachment_item_id uuid;
  v_restoring boolean := COALESCE(current_setting('workout_tracker.authorized_delete', true), '') = 'snapshot_restore';
BEGIN
  -- Restore may preserve historical truth after its live inventory IDs have
  -- disappeared, but it never bypasses immutable geometry validation below.
  IF NOT v_restoring AND NEW.equipment_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM equipment_items item
    WHERE item.id = NEW.equipment_item_id AND item.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Workout equipment snapshot item belongs to another account or does not exist.'
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_restoring AND NEW.load_profile_id IS NOT NULL THEN
    IF NEW.profile_kind = 'plate_loaded_implement' AND NOT EXISTS (
      SELECT 1 FROM barbell_configs profile
      WHERE profile.id = NEW.load_profile_id AND profile.user_id = NEW.user_id
        AND profile.equipment_item_id = NEW.equipment_item_id
    ) THEN
      RAISE EXCEPTION 'Workout equipment snapshot bar profile belongs to another account or does not exist.'
        USING ERRCODE = '23503';
    ELSIF NEW.profile_kind = 'plate_loaded_machine' AND NOT EXISTS (
      SELECT 1 FROM plate_loaded_machine_profiles profile
      WHERE profile.id = NEW.load_profile_id AND profile.user_id = NEW.user_id
        AND profile.equipment_item_id = NEW.equipment_item_id
    ) THEN
      RAISE EXCEPTION 'Workout equipment snapshot machine profile belongs to another account or does not exist.'
        USING ERRCODE = '23503';
    ELSIF NEW.profile_kind = 'cable_machine' AND NOT EXISTS (
      SELECT 1 FROM cable_machine_profiles profile
      WHERE profile.id = NEW.load_profile_id AND profile.user_id = NEW.user_id
        AND profile.equipment_item_id = NEW.equipment_item_id
    ) THEN
      RAISE EXCEPTION 'Workout equipment snapshot cable profile belongs to another account or does not exist.'
        USING ERRCODE = '23503';
    ELSIF NEW.profile_kind NOT IN ('plate_loaded_implement', 'plate_loaded_machine', 'cable_machine') THEN
      RAISE EXCEPTION 'That snapshot kind cannot reference this load profile.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.geometry_certainty = 'known' THEN
    IF NEW.profile_kind = 'plate_loaded_implement' AND NOT coalesce((
      jsonb_typeof(NEW.geometry_snapshot->'emptyWeight') = 'number'
      AND jsonb_typeof(NEW.geometry_snapshot->'collarWeight') = 'number'
      AND NEW.geometry_snapshot->>'unit' IN ('lb', 'kg')
      AND jsonb_typeof(NEW.geometry_snapshot->'sharedPlatePoolCompatible') = 'boolean'
    ), false) THEN
      RAISE EXCEPTION 'Known implement geometry is incomplete.' USING ERRCODE = '23514';
    ELSIF NEW.profile_kind = 'plate_loaded_machine' AND NOT coalesce((
      jsonb_typeof(NEW.geometry_snapshot->'startingResistance') = 'number'
      AND jsonb_typeof(NEW.geometry_snapshot->'loadingPointCount') = 'number'
      AND NEW.geometry_snapshot->>'balancingRule' IN ('single_point', 'identical_each_point')
      AND NEW.geometry_snapshot->>'targetEntryMeaning' IN ('total_system', 'per_loading_point')
      AND jsonb_typeof(NEW.geometry_snapshot->'compatiblePlates') = 'array'
    ), false) THEN
      RAISE EXCEPTION 'Known machine geometry is incomplete.' USING ERRCODE = '23514';
    ELSIF NEW.profile_kind = 'cable_machine' AND NOT coalesce((
      jsonb_typeof(NEW.geometry_snapshot->'stackCount') = 'number'
      AND NEW.geometry_snapshot->>'topology' IN ('shared_selection', 'independent_per_stack')
      AND NEW.geometry_snapshot->>'displayedUnit' IN ('lb', 'kg')
      AND jsonb_typeof(NEW.geometry_snapshot->'stackSteps') = 'array'
      AND jsonb_array_length(NEW.geometry_snapshot->'stackSteps') > 0
      AND NEW.geometry_snapshot->>'ratioStatus' IN ('known', 'unknown')
    ), false) THEN
      RAISE EXCEPTION 'Known cable geometry is incomplete.' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NOT v_restoring AND NEW.attachment_profile_id IS NOT NULL THEN
    SELECT profile.equipment_item_id INTO v_attachment_item_id
    FROM cable_attachment_profiles profile
    WHERE profile.id = NEW.attachment_profile_id AND profile.user_id = NEW.user_id;
    IF v_attachment_item_id IS NULL OR v_attachment_item_id <> NEW.attachment_item_id THEN
      RAISE EXCEPTION 'Workout equipment snapshot attachment belongs to another account, does not exist, or does not match the item.'
        USING ERRCODE = '23503';
    END IF;
    IF NEW.profile_kind <> 'cable_machine' THEN
      RAISE EXCEPTION 'Only a cable-machine snapshot can retain an attachment.'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM cable_attachment_compatibilities compatibility
      WHERE compatibility.cable_profile_id = NEW.load_profile_id
        AND compatibility.attachment_profile_id = NEW.attachment_profile_id
        AND compatibility.user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'The selected attachment is not compatible with this cable profile.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_completed_set_equipment_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '') = 'snapshot_restore' THEN RETURN NEW; END IF;
  IF ROW(OLD.equipment_snapshot_id, OLD.load_entry_meaning) IS NOT DISTINCT FROM ROW(NEW.equipment_snapshot_id, NEW.load_entry_meaning) THEN RETURN NEW; END IF;
  IF OLD.equipment_snapshot_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM session_occurrences occurrence WHERE occurrence.completed_set_id = OLD.id AND occurrence.outcome = 'completed'
  ) THEN RAISE EXCEPTION 'Completed set equipment evidence is immutable.' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_completed_occurrence_equipment_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_set_snapshot_id uuid;
BEGIN
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '') = 'snapshot_restore' THEN
    RETURN NEW;
  END IF;
  IF NEW.completed_set_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT completed.equipment_snapshot_id INTO v_set_snapshot_id
  FROM completed_sets completed
  WHERE completed.id = NEW.completed_set_id
    AND completed.session_exercise_id = NEW.session_exercise_id;

  IF v_set_snapshot_id IS DISTINCT FROM NEW.equipment_snapshot_id THEN
    RAISE EXCEPTION 'A completed occurrence and completed set must retain the same equipment snapshot.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_session_occurrence_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '') = 'snapshot_restore' THEN
    RETURN NEW;
  END IF;

  IF ROW(
    OLD.id, OLD.session_id, OLD.session_exercise_id, OLD.kind, OLD.origin,
    OLD.sequence_idx, OLD.kind_ordinal, OLD.label, OLD.planned_exercise_id,
    OLD.planned_reps_min, OLD.planned_reps_max, OLD.planned_load,
    OLD.planned_load_unit, OLD.planned_load_percent, OLD.planned_load_text,
    OLD.planned_rest_sec, OLD.planned_note, OLD.group_snapshot_id,
    OLD.group_round, OLD.group_member_order_idx, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.session_id, NEW.session_exercise_id, NEW.kind, NEW.origin,
    NEW.sequence_idx, NEW.kind_ordinal, NEW.label, NEW.planned_exercise_id,
    NEW.planned_reps_min, NEW.planned_reps_max, NEW.planned_load,
    NEW.planned_load_unit, NEW.planned_load_percent, NEW.planned_load_text,
    NEW.planned_rest_sec, NEW.planned_note, NEW.group_snapshot_id,
    NEW.group_round, NEW.group_member_order_idx, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Workout occurrence plan and identity evidence is immutable.'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    OLD.outcome, OLD.outcome_reason, OLD.outcome_note, OLD.revision,
    OLD.resolved_at, OLD.completed_set_id, OLD.equipment_snapshot_id
  ) IS NOT DISTINCT FROM ROW(
    NEW.outcome, NEW.outcome_reason, NEW.outcome_note, NEW.revision,
    NEW.resolved_at, NEW.completed_set_id, NEW.equipment_snapshot_id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Workout occurrence transitions must advance exactly one revision.'
      USING ERRCODE = '40001';
  END IF;

  IF NOT (
    (OLD.outcome = 'pending' AND NEW.outcome IN ('completed', 'skipped', 'abandoned'))
    OR (
      OLD.outcome IN ('pending', 'completed', 'skipped')
      AND NEW.outcome = OLD.outcome
      AND NEW.outcome_reason IS NOT DISTINCT FROM OLD.outcome_reason
      AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
      AND NEW.completed_set_id IS NOT DISTINCT FROM OLD.completed_set_id
      AND (
        OLD.outcome = 'pending'
        OR NEW.equipment_snapshot_id IS NOT DISTINCT FROM OLD.equipment_snapshot_id
      )
    )
    OR (OLD.outcome IN ('skipped', 'abandoned') AND NEW.outcome = 'pending')
  ) THEN
    RAISE EXCEPTION 'Workout occurrence outcome transition is not allowed.'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_without_equipment_truth;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid, p_scope text, p_expected_current jsonb, p_target_rows jsonb,
  p_dependency_rows jsonb, p_source_snapshot_id uuid, p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_live_tables text[] := ARRAY[
    'plate_loaded_machine_compatible_plates', 'cable_stack_steps',
    'cable_attachment_compatibilities', 'plate_loaded_machine_profiles',
    'cable_machine_profiles', 'cable_attachment_profiles'
  ];
  v_table text;
  v_current jsonb;
  v_expected jsonb;
  v_snapshots jsonb := COALESCE(p_target_rows->'session_equipment_snapshots', '[]'::jsonb);
  v_receipts jsonb := COALESCE(p_target_rows->'session_equipment_selection_receipts', '[]'::jsonb);
  v_machine_profiles jsonb := COALESCE(p_target_rows->'plate_loaded_machine_profiles', '[]'::jsonb);
  v_machine_plates jsonb := COALESCE(p_target_rows->'plate_loaded_machine_compatible_plates', '[]'::jsonb);
  v_cable_profiles jsonb := COALESCE(p_target_rows->'cable_machine_profiles', '[]'::jsonb);
  v_cable_steps jsonb := COALESCE(p_target_rows->'cable_stack_steps', '[]'::jsonb);
  v_attachment_profiles jsonb := COALESCE(p_target_rows->'cable_attachment_profiles', '[]'::jsonb);
  v_attachment_compat jsonb := COALESCE(p_target_rows->'cable_attachment_compatibilities', '[]'::jsonb);
  v_execution_requirements jsonb := CASE WHEN p_scope = 'full'
    THEN COALESCE(p_target_rows->'exercise_execution_requirements', '[]'::jsonb) || COALESCE(p_dependency_rows->'exercise_execution_requirements', '[]'::jsonb)
    ELSE COALESCE(p_dependency_rows->'exercise_execution_requirements', '[]'::jsonb) END;
  v_base_expected jsonb;
  v_base_target jsonb;
  v_base_dependencies jsonb;
  v_result jsonb;
  v_added integer := 0;
  v_count integer;
BEGIN
  PERFORM set_config('workout_tracker.authorized_delete', 'snapshot_restore', true);

  FOREACH v_table IN ARRAY ARRAY['session_equipment_snapshots', 'session_equipment_selection_receipts'] LOOP
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), ''[]''::jsonb) FROM %I row_value WHERE row_value.user_id = $1 AND ($2 = ''full'' OR row_value.session_id IN (SELECT id FROM jsonb_to_recordset(COALESCE($3->''workout_sessions'', ''[]''::jsonb)) AS selected(id uuid)))',
      v_table
    ) INTO v_current USING p_user_id, p_scope, p_expected_current;
    v_expected := COALESCE(p_expected_current->v_table, '[]'::jsonb);
    IF v_current IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Restore preview is stale for table %.', v_table USING ERRCODE = '40001';
    END IF;
  END LOOP;

  IF p_scope = 'full' THEN
    FOREACH v_table IN ARRAY v_live_tables LOOP
      EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY to_jsonb(row_value)::text), ''[]''::jsonb) FROM %I row_value WHERE row_value.user_id = $1', v_table)
        INTO v_current USING p_user_id;
      SELECT COALESCE(jsonb_agg(value ORDER BY value::text), '[]'::jsonb) INTO v_expected
      FROM jsonb_array_elements(COALESCE(p_expected_current->v_table, '[]'::jsonb)) value;
      IF v_current IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'Restore preview is stale for table %.', v_table USING ERRCODE = '40001';
      END IF;
    END LOOP;
  END IF;

  DELETE FROM session_equipment_selection_receipts receipt
  USING workout_sessions session
  WHERE receipt.session_id = session.id AND session.user_id = p_user_id
    AND (p_scope = 'full' OR receipt.session_id IN (SELECT id FROM jsonb_to_recordset(COALESCE(p_expected_current->'workout_sessions','[]'::jsonb)) AS selected(id uuid)));
  UPDATE session_exercises exercise SET current_equipment_snapshot_id = NULL
  FROM workout_sessions session WHERE exercise.session_id = session.id AND session.user_id = p_user_id
    AND (p_scope = 'full' OR exercise.session_id IN (SELECT id FROM jsonb_to_recordset(COALESCE(p_expected_current->'workout_sessions','[]'::jsonb)) AS selected(id uuid)));
  UPDATE session_occurrences occurrence SET equipment_snapshot_id = NULL
  FROM workout_sessions session WHERE occurrence.session_id = session.id AND session.user_id = p_user_id
    AND (p_scope = 'full' OR occurrence.session_id IN (SELECT id FROM jsonb_to_recordset(COALESCE(p_expected_current->'workout_sessions','[]'::jsonb)) AS selected(id uuid)));
  UPDATE completed_sets completed
  SET equipment_snapshot_id = NULL, load_entry_meaning = 'legacy_unknown'
  FROM session_exercises exercise, workout_sessions session
  WHERE completed.session_exercise_id = exercise.id AND exercise.session_id = session.id AND session.user_id = p_user_id
    AND (p_scope = 'full' OR exercise.session_id IN (SELECT id FROM jsonb_to_recordset(COALESCE(p_expected_current->'workout_sessions','[]'::jsonb)) AS selected(id uuid)));
  DELETE FROM session_equipment_snapshots snapshot USING workout_sessions session
  WHERE snapshot.session_id = session.id AND session.user_id = p_user_id
    AND (p_scope = 'full' OR snapshot.session_id IN (SELECT id FROM jsonb_to_recordset(COALESCE(p_expected_current->'workout_sessions','[]'::jsonb)) AS selected(id uuid)));

  IF p_scope = 'full' THEN
    DELETE FROM plate_loaded_machine_compatible_plates WHERE user_id = p_user_id;
    DELETE FROM cable_stack_steps WHERE user_id = p_user_id;
    DELETE FROM cable_attachment_compatibilities WHERE user_id = p_user_id;
    DELETE FROM plate_loaded_machine_profiles WHERE user_id = p_user_id;
    DELETE FROM cable_machine_profiles WHERE user_id = p_user_id;
    DELETE FROM cable_attachment_profiles WHERE user_id = p_user_id;
  END IF;

  v_base_expected := p_expected_current
    - 'plate_loaded_machine_profiles' - 'plate_loaded_machine_compatible_plates'
    - 'cable_machine_profiles' - 'cable_stack_steps' - 'cable_attachment_profiles'
    - 'cable_attachment_compatibilities' - 'exercise_execution_requirements'
    - 'session_equipment_snapshots' - 'session_equipment_selection_receipts';
  v_base_target := p_target_rows
    - 'plate_loaded_machine_profiles' - 'plate_loaded_machine_compatible_plates'
    - 'cable_machine_profiles' - 'cable_stack_steps' - 'cable_attachment_profiles'
    - 'cable_attachment_compatibilities' - 'exercise_execution_requirements'
    - 'session_equipment_snapshots' - 'session_equipment_selection_receipts';
  v_base_dependencies := p_dependency_rows - 'exercise_execution_requirements';

  IF v_base_expected ? 'session_exercises' THEN
    v_base_expected := jsonb_set(v_base_expected, '{session_exercises}', COALESCE((SELECT jsonb_agg((row_value-'current_equipment_snapshot_id') || jsonb_build_object('current_equipment_snapshot_id', NULL)) FROM jsonb_array_elements(v_base_expected->'session_exercises') row_value), '[]'::jsonb));
  END IF;
  IF v_base_target ? 'session_exercises' THEN
    v_base_target := jsonb_set(v_base_target, '{session_exercises}', COALESCE((SELECT jsonb_agg((row_value-'current_equipment_snapshot_id') || jsonb_build_object('current_equipment_snapshot_id', NULL)) FROM jsonb_array_elements(v_base_target->'session_exercises') row_value), '[]'::jsonb));
  END IF;
  IF v_base_expected ? 'completed_sets' THEN
    v_base_expected := jsonb_set(v_base_expected, '{completed_sets}', COALESCE((SELECT jsonb_agg((row_value-'equipment_snapshot_id'-'load_entry_meaning') || jsonb_build_object('equipment_snapshot_id', NULL, 'load_entry_meaning', 'legacy_unknown')) FROM jsonb_array_elements(v_base_expected->'completed_sets') row_value), '[]'::jsonb));
  END IF;
  IF v_base_target ? 'completed_sets' THEN
    v_base_target := jsonb_set(v_base_target, '{completed_sets}', COALESCE((SELECT jsonb_agg((row_value-'equipment_snapshot_id'-'load_entry_meaning') || jsonb_build_object('equipment_snapshot_id', NULL, 'load_entry_meaning', 'legacy_unknown')) FROM jsonb_array_elements(v_base_target->'completed_sets') row_value), '[]'::jsonb));
  END IF;
  IF v_base_expected ? 'session_occurrences' THEN
    v_base_expected := jsonb_set(v_base_expected, '{session_occurrences}', COALESCE((SELECT jsonb_agg((row_value-'equipment_snapshot_id') || jsonb_build_object('equipment_snapshot_id', NULL)) FROM jsonb_array_elements(v_base_expected->'session_occurrences') row_value), '[]'::jsonb));
  END IF;
  IF v_base_target ? 'session_occurrences' THEN
    v_base_target := jsonb_set(v_base_target, '{session_occurrences}', COALESCE((SELECT jsonb_agg((row_value-'equipment_snapshot_id') || jsonb_build_object('equipment_snapshot_id', NULL)) FROM jsonb_array_elements(v_base_target->'session_occurrences') row_value), '[]'::jsonb));
  END IF;

  v_result := restore_user_snapshot_without_equipment_truth(p_user_id, p_scope, v_base_expected, v_base_target, v_base_dependencies, p_source_snapshot_id, p_safety_snapshot_id, p_fail_after_table);

  IF jsonb_array_length(v_machine_profiles) > 0 THEN INSERT INTO plate_loaded_machine_profiles SELECT source.* FROM jsonb_populate_recordset(NULL::plate_loaded_machine_profiles, v_machine_profiles) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;
  IF jsonb_array_length(v_cable_profiles) > 0 THEN INSERT INTO cable_machine_profiles SELECT source.* FROM jsonb_populate_recordset(NULL::cable_machine_profiles, v_cable_profiles) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;
  IF jsonb_array_length(v_attachment_profiles) > 0 THEN INSERT INTO cable_attachment_profiles SELECT source.* FROM jsonb_populate_recordset(NULL::cable_attachment_profiles, v_attachment_profiles) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;
  IF jsonb_array_length(v_cable_steps) > 0 THEN INSERT INTO cable_stack_steps SELECT source.* FROM jsonb_populate_recordset(NULL::cable_stack_steps, v_cable_steps) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;
  IF jsonb_array_length(v_machine_plates) > 0 THEN INSERT INTO plate_loaded_machine_compatible_plates SELECT source.* FROM jsonb_populate_recordset(NULL::plate_loaded_machine_compatible_plates, v_machine_plates) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;
  IF jsonb_array_length(v_attachment_compat) > 0 THEN INSERT INTO cable_attachment_compatibilities SELECT source.* FROM jsonb_populate_recordset(NULL::cable_attachment_compatibilities, v_attachment_compat) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;

  IF jsonb_array_length(v_execution_requirements) > 0 THEN
    INSERT INTO exercise_execution_requirements
    SELECT source.*
    FROM jsonb_populate_recordset(NULL::exercise_execution_requirements, v_execution_requirements) source
    JOIN exercises exercise ON exercise.id = source.exercise_id
    WHERE exercise.user_id = p_user_id
    ON CONFLICT (exercise_id) DO UPDATE SET required_profile_kind = EXCLUDED.required_profile_kind, required_equipment_definition_id = EXCLUDED.required_equipment_definition_id, required_attachment_kind = EXCLUDED.required_attachment_kind, required_attachment_definition_id = EXCLUDED.required_attachment_definition_id, requires_known_geometry = EXCLUDED.requires_known_geometry, review_notes = EXCLUDED.review_notes, reviewed_at = EXCLUDED.reviewed_at, updated_at = EXCLUDED.updated_at;
    GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count;
  END IF;

  IF jsonb_array_length(v_snapshots) > 0 THEN INSERT INTO session_equipment_snapshots SELECT source.* FROM jsonb_populate_recordset(NULL::session_equipment_snapshots, v_snapshots) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;
  IF p_target_rows ? 'completed_sets' THEN UPDATE completed_sets completed SET equipment_snapshot_id = source.equipment_snapshot_id, load_entry_meaning = source.load_entry_meaning FROM jsonb_to_recordset(p_target_rows->'completed_sets') source(id uuid, equipment_snapshot_id uuid, load_entry_meaning text) WHERE completed.id = source.id; END IF;
  IF p_target_rows ? 'session_occurrences' THEN UPDATE session_occurrences occurrence SET equipment_snapshot_id = source.equipment_snapshot_id FROM jsonb_to_recordset(p_target_rows->'session_occurrences') source(id uuid, equipment_snapshot_id uuid) WHERE occurrence.id = source.id; END IF;
  IF p_target_rows ? 'session_exercises' THEN UPDATE session_exercises exercise SET current_equipment_snapshot_id = source.current_equipment_snapshot_id FROM jsonb_to_recordset(p_target_rows->'session_exercises') source(id uuid, current_equipment_snapshot_id uuid) WHERE exercise.id = source.id; END IF;
  IF jsonb_array_length(v_receipts) > 0 THEN INSERT INTO session_equipment_selection_receipts SELECT source.* FROM jsonb_populate_recordset(NULL::session_equipment_selection_receipts, v_receipts) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;

  IF p_fail_after_table IN ('session_equipment_snapshots', 'session_equipment_selection_receipts', 'equipment_load_profiles') THEN RAISE EXCEPTION 'Injected restore failure after %.', p_fail_after_table; END IF;
  RETURN jsonb_set(v_result, '{restoredRecords}', to_jsonb(COALESCE((v_result->>'restoredRecords')::integer, 0) + v_added));
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION record_archived_equipment_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.entity_type = 'workout_session' THEN
    INSERT INTO archive_operation_records(operation_id, user_id, entity_type, entity_id, relationship_role, parent_entity_type, parent_entity_id)
    SELECT NEW.operation_id, NEW.user_id, 'session_equipment_snapshot', snapshot.id::text, 'linked', 'workout_session', NEW.entity_id
    FROM session_equipment_snapshots snapshot WHERE snapshot.session_id::text = NEW.entity_id
    ON CONFLICT DO NOTHING;
    INSERT INTO archive_operation_records(operation_id, user_id, entity_type, entity_id, relationship_role, parent_entity_type, parent_entity_id)
    SELECT NEW.operation_id, NEW.user_id, 'session_equipment_selection_receipt', receipt.id::text, 'linked', 'workout_session', NEW.entity_id
    FROM session_equipment_selection_receipts receipt WHERE receipt.session_id::text = NEW.entity_id
    ON CONFLICT DO NOTHING;
  ELSIF NEW.entity_type = 'completed_set' THEN
    INSERT INTO archive_operation_records(operation_id, user_id, entity_type, entity_id, relationship_role, parent_entity_type, parent_entity_id)
    SELECT NEW.operation_id, NEW.user_id, 'session_equipment_snapshot', completed.equipment_snapshot_id::text, 'preserved', 'completed_set', NEW.entity_id
    FROM completed_sets completed WHERE completed.id::text = NEW.entity_id AND completed.equipment_snapshot_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  ELSE
    RETURN NEW;
  END IF;
  UPDATE archive_operations operation SET record_counts = operation.record_counts || jsonb_build_object(
    'sessionEquipmentSnapshots', (SELECT count(*) FROM archive_operation_records member WHERE member.operation_id = NEW.operation_id AND member.entity_type = 'session_equipment_snapshot'),
    'sessionEquipmentSelectionReceipts', (SELECT count(*) FROM archive_operation_records member WHERE member.operation_id = NEW.operation_id AND member.entity_type = 'session_equipment_selection_receipt')
  ) WHERE operation.id = NEW.operation_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER archive_operation_records_equipment_evidence
AFTER INSERT ON archive_operation_records
FOR EACH ROW EXECUTE FUNCTION record_archived_equipment_evidence();
--> statement-breakpoint

ALTER FUNCTION permanent_delete_archive_preview(uuid, uuid)
  RENAME TO permanent_delete_archive_preview_without_equipment_truth;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanent_delete_archive_preview(p_user_id uuid, p_operation_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
WITH base AS (SELECT permanent_delete_archive_preview_without_equipment_truth(p_user_id, p_operation_id) AS preview), counts AS (
  SELECT
    (SELECT count(DISTINCT snapshot.id)::integer FROM session_equipment_snapshots snapshot JOIN archive_operation_records member ON member.operation_id = p_operation_id AND member.user_id = p_user_id AND member.entity_type = 'workout_session' AND member.entity_id = snapshot.session_id::text) AS snapshots,
    (SELECT count(DISTINCT receipt.id)::integer FROM session_equipment_selection_receipts receipt JOIN archive_operation_records member ON member.operation_id = p_operation_id AND member.user_id = p_user_id AND member.entity_type = 'workout_session' AND member.entity_id = receipt.session_id::text) AS receipts
)
SELECT CASE WHEN base.preview IS NULL THEN NULL ELSE jsonb_set(jsonb_set(base.preview, '{deleteCounts,sessionEquipmentSnapshots}', to_jsonb(counts.snapshots), true), '{deleteCounts,sessionEquipmentSelectionReceipts}', to_jsonb(counts.receipts), true) END FROM base CROSS JOIN counts;
$$;
--> statement-breakpoint
ALTER FUNCTION permanently_delete_archive_operation(uuid, uuid, text, text, uuid, text)
  RENAME TO permanently_delete_archive_operation_without_equipment_truth;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanently_delete_archive_operation(
  p_user_id uuid, p_operation_id uuid, p_token_hash text, p_confirmation text,
  p_safety_snapshot_id uuid, p_fail_after_step text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  v_result := permanently_delete_archive_operation_without_equipment_truth(p_user_id, p_operation_id, p_token_hash, p_confirmation, p_safety_snapshot_id, p_fail_after_step);
  IF EXISTS (
    SELECT 1 FROM session_equipment_snapshots snapshot JOIN archive_operation_records member ON member.operation_id = p_operation_id AND member.entity_type = 'workout_session' AND member.entity_id = snapshot.session_id::text
  ) OR EXISTS (
    SELECT 1 FROM session_equipment_selection_receipts receipt JOIN archive_operation_records member ON member.operation_id = p_operation_id AND member.entity_type = 'workout_session' AND member.entity_id = receipt.session_id::text
  ) THEN RAISE EXCEPTION 'Equipment evidence deletion scope changed.'; END IF;
  IF p_fail_after_step = 'session_equipment_snapshots' THEN RAISE EXCEPTION 'Injected permanent-delete failure after equipment evidence.'; END IF;
  RETURN v_result;
END;
$$;
