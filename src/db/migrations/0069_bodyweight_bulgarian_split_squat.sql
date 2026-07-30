-- Add one reviewed performed variant for an explicit workout substitution.
-- This migration inserts catalog metadata only. It never relabels a planned
-- exercise or updates an existing session, completed set, or record version.
-- Empty databases receive the same row from normal catalog seeding. Keeping
-- migration-only databases empty avoids inventing a second shared-family
-- identity that a portable backup would later have to reinterpret.

INSERT INTO exercises (
  id, family_id, name, movement_pattern, primary_muscles, secondary_muscles,
  is_unilateral, load_type, activity_class, metric_type, load_semantics,
  variant_key, variant_attributes, catalog_reviewed
)
SELECT
  gen_random_uuid(), family.id, 'Bodyweight Bulgarian Split Squat', 'lunge',
  '["quads", "glutes"]'::jsonb, '[]'::jsonb, true, 'bodyweight', 'strength',
  'reps', 'bodyweight', 'bodyweight',
  '{"laterality":"unilateral","assistance":"none"}'::jsonb, true
FROM exercise_families family
WHERE (family.key = 'bulgarian_split_squat'
    OR family.name = 'Bulgarian Split Squat')
  AND EXISTS (
    SELECT 1
    FROM exercises loaded
    WHERE loaded.user_id IS NULL
      AND loaded.catalog_reviewed
      AND loaded.family_id = family.id
      AND loaded.name = 'Bulgarian Split Squat'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM exercises existing
    WHERE existing.name = 'Bodyweight Bulgarian Split Squat'
  )
ORDER BY (family.key = 'bulgarian_split_squat') DESC, family.id
LIMIT 1
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO exercise_aliases (exercise_id, alias)
SELECT exercise.id, candidate.alias
FROM exercises exercise
CROSS JOIN (
  VALUES
    ('bodyweight bss'),
    ('bodyweight rear foot elevated split squat'),
    ('bulgarian split squat bodyweight')
) AS candidate(alias)
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND exercise.name = 'Bodyweight Bulgarian Split Squat'
  AND NOT EXISTS (
    SELECT 1
    FROM exercise_aliases existing
    WHERE existing.exercise_id = exercise.id
      AND lower(existing.alias) = candidate.alias
  );--> statement-breakpoint

INSERT INTO exercise_equipment_requirements (
  exercise_id, equipment_type, min_weight
)
SELECT exercise.id, candidate.equipment_type::equipment_type, NULL
FROM exercises exercise
CROSS JOIN (
  VALUES ('bodyweight'), ('bench')
) AS candidate(equipment_type)
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND exercise.name = 'Bodyweight Bulgarian Split Squat'
  AND NOT EXISTS (
    SELECT 1
    FROM exercise_equipment_requirements existing
    WHERE existing.exercise_id = exercise.id
      AND existing.equipment_type = candidate.equipment_type::equipment_type
  );--> statement-breakpoint

INSERT INTO exercise_sources (
  exercise_id, source_name, source_id, license, reviewed_at
)
SELECT
  exercise.id,
  'Workout Tracker curated catalog',
  'bodyweight_bulgarian_split_squat',
  'Project-authored metadata',
  '2026-07-30T00:00:00Z'::timestamptz
FROM exercises exercise
WHERE exercise.user_id IS NULL
  AND exercise.catalog_reviewed
  AND exercise.name = 'Bodyweight Bulgarian Split Squat'
  AND NOT EXISTS (
    SELECT 1
    FROM exercise_sources existing
    WHERE existing.exercise_id = exercise.id
      AND existing.source_name = 'Workout Tracker curated catalog'
      AND existing.source_id = 'bodyweight_bulgarian_split_squat'
  );
