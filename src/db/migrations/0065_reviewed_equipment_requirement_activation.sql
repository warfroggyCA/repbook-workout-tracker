-- Activate exact setup only for reviewed catalog variants. This migration
-- never classifies owner equipment from labels or notes and never applies an
-- exact profile requirement to generic machine exercises.

UPDATE exercises
SET variant_key = 'cable_lat_bar',
    variant_attributes = '{"machine":"cable","attachment":"lat_bar"}'::jsonb
WHERE user_id IS NULL
  AND catalog_reviewed
  AND name = 'Lat Pulldown';--> statement-breakpoint

INSERT INTO exercise_equipment_requirements (
  exercise_id, equipment_type, min_weight
)
SELECT exercise.id, 'cable', NULL
FROM exercises exercise
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND exercise.name = 'Lat Pulldown'
  AND NOT EXISTS (
    SELECT 1 FROM exercise_equipment_requirements requirement
    WHERE requirement.exercise_id = exercise.id
      AND requirement.equipment_type = 'cable'
  );--> statement-breakpoint

-- Trap/hex-bar variants already carry a reviewed broad trap_bar requirement.
-- Give those rows the established implement load lifecycle without adding an
-- exact requirement or inferring an item weight/geometry.
UPDATE exercises exercise
SET load_type = 'trap_bar', load_semantics = 'total'
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND EXISTS (
    SELECT 1 FROM exercise_equipment_requirements requirement
    WHERE requirement.exercise_id = exercise.id
      AND requirement.equipment_type = 'trap_bar'
  );--> statement-breakpoint

INSERT INTO exercises (
  id, family_id, name, movement_pattern, primary_muscles, secondary_muscles,
  is_unilateral, load_type, activity_class, metric_type, load_semantics,
  variant_key, variant_attributes, catalog_reviewed
)
SELECT
  gen_random_uuid(), family.id, 'Plate-Loaded Lat Pulldown', 'vertical_pull',
  '["back", "biceps"]'::jsonb, '[]'::jsonb, false, 'external', 'strength',
  'weight_reps', 'machine_stack', 'plate_loaded_machine',
  '{"machine":"plate_loaded"}'::jsonb, true
FROM exercise_families family
WHERE family.key = 'lat_pulldown'
  AND NOT EXISTS (
    SELECT 1 FROM exercises existing
    WHERE existing.name = 'Plate-Loaded Lat Pulldown'
  );--> statement-breakpoint

INSERT INTO exercise_aliases (exercise_id, alias)
SELECT exercise.id, 'plate loaded pulldown'
FROM exercises exercise
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND exercise.name = 'Plate-Loaded Lat Pulldown'
  AND NOT EXISTS (
    SELECT 1 FROM exercise_aliases alias
    WHERE alias.exercise_id = exercise.id
      AND alias.alias = 'plate loaded pulldown'
  );--> statement-breakpoint

INSERT INTO exercise_equipment_requirements (
  exercise_id, equipment_type, min_weight
)
SELECT exercise.id, 'machine', NULL
FROM exercises exercise
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND exercise.name = 'Plate-Loaded Lat Pulldown'
  AND NOT EXISTS (
    SELECT 1 FROM exercise_equipment_requirements requirement
    WHERE requirement.exercise_id = exercise.id
      AND requirement.equipment_type = 'machine'
  );--> statement-breakpoint

INSERT INTO exercise_sources (
  exercise_id, source_name, source_id, license, reviewed_at
)
SELECT exercise.id, 'Workout Tracker curated catalog',
       'plate_loaded_machine', 'Project-authored metadata',
       '2026-07-21T00:00:00Z'::timestamptz
FROM exercises exercise
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND exercise.name = 'Plate-Loaded Lat Pulldown'
  AND NOT EXISTS (
    SELECT 1 FROM exercise_sources source
    WHERE source.exercise_id = exercise.id
      AND source.source_name = 'Workout Tracker curated catalog'
      AND source.source_id = 'plate_loaded_machine'
  );--> statement-breakpoint

INSERT INTO exercise_execution_requirements (
  exercise_id, required_profile_kind, required_attachment_kind,
  requires_known_geometry, review_notes, reviewed_at
)
SELECT exercise.id, 'cable_machine', 'lat_bar', true,
       'Reviewed cable lat-pulldown variant: exact cable geometry and an explicitly compatible lat bar are required.',
       '2026-07-21T00:00:00Z'::timestamptz
FROM exercises exercise
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND exercise.name = 'Lat Pulldown'
ON CONFLICT (exercise_id) DO UPDATE SET
  required_profile_kind = EXCLUDED.required_profile_kind,
  required_equipment_definition_id = NULL,
  required_attachment_kind = EXCLUDED.required_attachment_kind,
  required_attachment_definition_id = NULL,
  requires_known_geometry = EXCLUDED.requires_known_geometry,
  review_notes = EXCLUDED.review_notes,
  reviewed_at = EXCLUDED.reviewed_at,
  updated_at = now();--> statement-breakpoint

INSERT INTO exercise_execution_requirements (
  exercise_id, required_profile_kind, required_attachment_kind,
  requires_known_geometry, review_notes, reviewed_at
)
SELECT exercise.id, 'plate_loaded_machine', NULL, true,
       'Reviewed plate-loaded lat-pulldown variant: exact machine geometry is required; selectorized machines do not satisfy it.',
       '2026-07-21T00:00:00Z'::timestamptz
FROM exercises exercise
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND exercise.name = 'Plate-Loaded Lat Pulldown'
ON CONFLICT (exercise_id) DO UPDATE SET
  required_profile_kind = EXCLUDED.required_profile_kind,
  required_equipment_definition_id = NULL,
  required_attachment_kind = NULL,
  required_attachment_definition_id = NULL,
  requires_known_geometry = EXCLUDED.requires_known_geometry,
  review_notes = EXCLUDED.review_notes,
  reviewed_at = EXCLUDED.reviewed_at,
  updated_at = now();
