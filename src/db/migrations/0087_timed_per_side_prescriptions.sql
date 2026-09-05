-- Future-only typed loaded time. Existing rep prescriptions and sets are untouched.
ALTER TYPE metric_type ADD VALUE IF NOT EXISTS 'weight_duration_per_side';
--> statement-breakpoint
ALTER TABLE exercise_prescriptions
  ADD COLUMN IF NOT EXISTS timed_prescription jsonb,
  ALTER COLUMN rep_range_min DROP NOT NULL,
  ALTER COLUMN rep_range_max DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE session_exercises ADD COLUMN IF NOT EXISTS timed_prescription jsonb;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION repbook_valid_timed_prescription(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(
    jsonb_typeof(value) = 'object'
    AND value - ARRAY['version', 'metricType', 'minSeconds', 'maxSeconds'] = '{}'::jsonb
    AND value->'version' = '1'::jsonb
    AND value->>'metricType' = 'weight_duration_per_side'
    AND jsonb_typeof(value->'minSeconds') = 'number'
    AND jsonb_typeof(value->'maxSeconds') = 'number'
    AND (value->>'minSeconds')::numeric BETWEEN 1 AND 3600
    AND (value->>'maxSeconds')::numeric BETWEEN (value->>'minSeconds')::numeric AND 3600
    AND trunc((value->>'minSeconds')::numeric) = (value->>'minSeconds')::numeric
    AND trunc((value->>'maxSeconds')::numeric) = (value->>'maxSeconds')::numeric,
    false
  )
$$;
--> statement-breakpoint
ALTER TABLE exercise_prescriptions
  DROP CONSTRAINT IF EXISTS exercise_prescriptions_target_bounds_check,
  ADD CONSTRAINT exercise_prescriptions_target_bounds_check CHECK (
    sets BETWEEN 1 AND 20 AND (
      (timed_prescription IS NULL AND rep_range_min IS NOT NULL AND rep_range_max IS NOT NULL
       AND rep_range_min BETWEEN 1 AND 100 AND rep_range_max BETWEEN rep_range_min AND 100)
      OR (timed_prescription IS NOT NULL AND rep_range_min IS NULL AND rep_range_max IS NULL
          AND progression_rule_id = 'manual' AND repbook_valid_timed_prescription(timed_prescription))
    )
  );
--> statement-breakpoint
ALTER TABLE session_exercises
  DROP CONSTRAINT IF EXISTS session_exercises_timed_prescription_valid,
  ADD CONSTRAINT session_exercises_timed_prescription_valid CHECK (
    (timed_prescription IS NULL AND prescribed_metric_type::text IS DISTINCT FROM 'weight_duration_per_side') OR coalesce((
      repbook_valid_timed_prescription(timed_prescription)
      AND target_reps_min IS NULL AND target_reps_max IS NULL
      AND prescribed_metric_type::text = 'weight_duration_per_side'
      AND prescribed_load_semantics::text IN ('total', 'per_implement')
    ), false)
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_session_timed_prescription()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.timed_prescription IS DISTINCT FROM NEW.timed_prescription THEN
    RAISE EXCEPTION 'Workout timed prescription is immutable.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS session_timed_prescription_immutable ON session_exercises;
--> statement-breakpoint
CREATE TRIGGER session_timed_prescription_immutable BEFORE UPDATE ON session_exercises
FOR EACH ROW EXECUTE FUNCTION protect_session_timed_prescription();

--> statement-breakpoint
-- Add a distinct implement variant. Existing carry identities are untouched.
-- Empty databases receive this row from normal catalog seeding.
INSERT INTO exercises (
  family_id, name, movement_pattern, primary_muscles, secondary_muscles,
  is_unilateral, load_type, activity_class, metric_type, load_semantics,
  variant_key, variant_attributes, catalog_reviewed
)
SELECT family.id, 'Kettlebell Suitcase Carry', 'carry', '["core","grip"]'::jsonb,
       '[]'::jsonb, true, 'kettlebell', 'strength', 'distance_duration',
       'per_implement', 'kettlebell_suitcase_carry', '{}'::jsonb, true
FROM exercise_families family
WHERE family.key = 'loaded_carry'
  AND EXISTS (SELECT 1 FROM exercises source WHERE source.family_id = family.id
              AND source.user_id IS NULL AND source.catalog_reviewed AND source.name = 'Suitcase Carry')
  AND NOT EXISTS (SELECT 1 FROM exercises existing WHERE existing.name = 'Kettlebell Suitcase Carry')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type, min_weight)
SELECT exercise.id, 'kettlebell', NULL FROM exercises exercise
WHERE exercise.user_id IS NULL AND exercise.catalog_reviewed
  AND exercise.name = 'Kettlebell Suitcase Carry'
  AND NOT EXISTS (SELECT 1 FROM exercise_equipment_requirements requirement
                  WHERE requirement.exercise_id = exercise.id AND requirement.equipment_type = 'kettlebell');
--> statement-breakpoint
INSERT INTO exercise_aliases (exercise_id, alias)
SELECT exercise.id, 'kb suitcase carry' FROM exercises exercise
WHERE exercise.user_id IS NULL AND exercise.catalog_reviewed
  AND exercise.name = 'Kettlebell Suitcase Carry'
  AND NOT EXISTS (SELECT 1 FROM exercise_aliases alias WHERE alias.exercise_id = exercise.id AND lower(alias.alias) = 'kb suitcase carry');
--> statement-breakpoint
INSERT INTO exercise_sources (exercise_id, source_name, source_id, license, reviewed_at)
SELECT exercise.id, 'Workout Tracker curated catalog', 'kettlebell_suitcase_carry',
       'Project-authored metadata', '2026-09-05T00:00:00Z'::timestamptz
FROM exercises exercise WHERE exercise.user_id IS NULL AND exercise.catalog_reviewed
  AND exercise.name = 'Kettlebell Suitcase Carry'
  AND NOT EXISTS (SELECT 1 FROM exercise_sources source WHERE source.exercise_id = exercise.id
                  AND source.source_name = 'Workout Tracker curated catalog' AND source.source_id = 'kettlebell_suitcase_carry');
