-- Row hashes and xmin tokens bind individual evidence rows. This owner epoch
-- also closes collection-membership changes, including insertion of the first
-- safety constraint and reactivation of previously omitted evidence.
-- It is stored on the account root (which is intentionally outside owner-data
-- snapshots) and advanced by the closed source-binding inventory only.
ALTER TABLE "users"
ADD COLUMN "analysis_evidence_revision" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_analysis_evidence_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_row jsonb := CASE
    WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
    ELSE to_jsonb(NEW)
  END;
BEGIN
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '') = 'permanent' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_TABLE_NAME = ANY (ARRAY[
    'user_profiles',
    'constraints',
    'equipment_items',
    'plate_inventory',
    'barbell_configs',
    'plate_loaded_machine_profiles',
    'cable_machine_profiles',
    'cable_stack_steps',
    'cable_attachment_profiles',
    'programs',
    'exercises',
    'workout_sessions',
    'pain_logs',
    'fatigue_logs',
    'contextual_notes',
    'record_versions',
    'health_activities',
    'recommendations',
    'adaptation_events'
  ]) THEN
    v_user_id := NULLIF(v_row->>'user_id', '')::uuid;
  ELSIF TG_TABLE_NAME = 'program_versions' THEN
    SELECT program.user_id INTO v_user_id
    FROM programs program
    WHERE program.id = (v_row->>'program_id')::uuid;
  ELSIF TG_TABLE_NAME = 'workout_templates' THEN
    SELECT program.user_id INTO v_user_id
    FROM program_versions version
    JOIN programs program ON program.id = version.program_id
    WHERE version.id = (v_row->>'program_version_id')::uuid;
  ELSIF TG_TABLE_NAME = 'workout_template_exercises' THEN
    SELECT program.user_id INTO v_user_id
    FROM workout_templates day
    JOIN program_versions version ON version.id = day.program_version_id
    JOIN programs program ON program.id = version.program_id
    WHERE day.id = (v_row->>'workout_template_id')::uuid;
  ELSIF TG_TABLE_NAME = 'exercise_prescriptions' THEN
    SELECT program.user_id INTO v_user_id
    FROM workout_template_exercises slot
    JOIN workout_templates day ON day.id = slot.workout_template_id
    JOIN program_versions version ON version.id = day.program_version_id
    JOIN programs program ON program.id = version.program_id
    WHERE slot.id = (v_row->>'template_exercise_id')::uuid;
  ELSIF TG_TABLE_NAME = ANY (ARRAY[
    'session_exercise_groups',
    'session_exercises',
    'session_occurrences'
  ]) THEN
    SELECT session.user_id INTO v_user_id
    FROM workout_sessions session
    WHERE session.id = (v_row->>'session_id')::uuid;
  ELSIF TG_TABLE_NAME = 'completed_sets' THEN
    SELECT session.user_id INTO v_user_id
    FROM session_exercises exercise
    JOIN workout_sessions session ON session.id = exercise.session_id
    WHERE exercise.id = (v_row->>'session_exercise_id')::uuid;
  ELSIF TG_TABLE_NAME = 'user_decisions' THEN
    SELECT recommendation.user_id INTO v_user_id
    FROM recommendations recommendation
    WHERE recommendation.id = (v_row->>'recommendation_id')::uuid;
  ELSE
    RAISE EXCEPTION 'Unhandled analysis evidence insert source table %.', TG_TABLE_NAME;
  END IF;

  IF v_user_id IS NOT NULL THEN
    UPDATE users
    SET analysis_evidence_revision = analysis_evidence_revision + 1
    WHERE id = v_user_id;
    IF NOT FOUND AND TG_OP <> 'DELETE' THEN
      RAISE EXCEPTION 'Analysis evidence owner was not found.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'user_profiles',
    'constraints',
    'equipment_items',
    'plate_inventory',
    'barbell_configs',
    'plate_loaded_machine_profiles',
    'cable_machine_profiles',
    'cable_stack_steps',
    'cable_attachment_profiles',
    'programs',
    'program_versions',
    'workout_templates',
    'workout_template_exercises',
    'exercise_prescriptions',
    'exercises',
    'workout_sessions',
    'session_exercise_groups',
    'session_exercises',
    'session_occurrences',
    'completed_sets',
    'pain_logs',
    'fatigue_logs',
    'contextual_notes',
    'record_versions',
    'health_activities',
    'recommendations',
    'user_decisions',
    'adaptation_events'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER analysis_evidence_revision_guard '
      'AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW '
      'EXECUTE FUNCTION bump_analysis_evidence_revision()',
      v_table
    );
  END LOOP;
END;
$$;
