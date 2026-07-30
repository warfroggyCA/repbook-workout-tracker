-- Backfill only from evidence already stored with the record. Imported Hevy
-- history carries an explicitly reviewed timezone and pounds contract. Native
-- rows without equivalent evidence remain visible in the repair preview.
WITH stable_import_timezone AS (
  SELECT user_id, min(timezone) AS timezone
  FROM history_import_batches
  WHERE status = 'confirmed'
  GROUP BY user_id
  HAVING count(DISTINCT timezone) = 1
)
UPDATE user_profiles profile
SET timezone = evidence.timezone,
    updated_at = now()
FROM stable_import_timezone evidence
WHERE profile.user_id = evidence.user_id
  AND profile.timezone IS NULL;--> statement-breakpoint

UPDATE workout_sessions session
SET timezone = batch.timezone,
    local_date = timezone(batch.timezone, session.started_at)::date
FROM history_import_batches batch
WHERE session.import_batch_id = batch.id
  AND batch.status = 'confirmed'
  AND (session.timezone IS NULL OR session.local_date IS NULL);--> statement-breakpoint

UPDATE completed_sets completed_set
SET weight_unit = 'lb'
FROM session_exercises session_exercise
JOIN workout_sessions session ON session.id = session_exercise.session_id
JOIN history_import_batches batch ON batch.id = session.import_batch_id
WHERE completed_set.session_exercise_id = session_exercise.id
  AND completed_set.weight IS NOT NULL
  AND completed_set.weight_unit IS NULL
  AND batch.source = 'hevy'
  AND batch.status = 'confirmed';--> statement-breakpoint

CREATE VIEW production_data_repair_preview AS
SELECT
  'profile.timezone_missing'::text AS issue,
  'user_profile'::text AS entity_type,
  profile.id::text AS entity_id,
  profile.user_id,
  'timezone'::text AS field,
  to_jsonb(profile.timezone) AS current_value,
  jsonb_build_object(
    'profileUnit', profile.unit,
    'instruction', 'Review and set the user default IANA timezone.'
  ) AS evidence,
  NULL::jsonb AS suggested_value
FROM user_profiles profile
WHERE profile.timezone IS NULL

UNION ALL

SELECT
  'profile.timezone_invalid', 'user_profile', profile.id::text, profile.user_id,
  'timezone', to_jsonb(profile.timezone),
  jsonb_build_object('instruction', 'Replace the unrecognized IANA timezone.'),
  NULL::jsonb
FROM user_profiles profile
LEFT JOIN pg_timezone_names known ON known.name = profile.timezone
WHERE profile.timezone IS NOT NULL AND known.name IS NULL

UNION ALL

SELECT
  'workout.calendar_identity_missing', 'workout_session', session.id::text,
  session.user_id, 'timezone/local_date',
  jsonb_build_object('timezone', session.timezone, 'localDate', session.local_date),
  jsonb_build_object(
    'source', session.source,
    'importBatchId', session.import_batch_id,
    'startedAt', session.started_at,
    'profileTimezone', profile.timezone,
    'instruction', 'Choose a reviewed timezone; local date will be derived from the recorded instant.'
  ),
  CASE
    WHEN profile.timezone IS NULL THEN NULL::jsonb
    ELSE jsonb_build_object(
      'timezone', profile.timezone,
      'localDate', timezone(profile.timezone, session.started_at)::date
    )
  END
FROM workout_sessions session
JOIN user_profiles profile ON profile.user_id = session.user_id
WHERE session.timezone IS NULL OR session.local_date IS NULL

UNION ALL

SELECT
  'workout.timezone_invalid', 'workout_session', session.id::text,
  session.user_id, 'timezone', to_jsonb(session.timezone),
  jsonb_build_object('startedAt', session.started_at), NULL::jsonb
FROM workout_sessions session
LEFT JOIN pg_timezone_names known ON known.name = session.timezone
WHERE session.timezone IS NOT NULL AND known.name IS NULL

UNION ALL

SELECT
  'workout.local_date_mismatch', 'workout_session', session.id::text,
  session.user_id, 'local_date', to_jsonb(session.local_date),
  jsonb_build_object('timezone', session.timezone, 'startedAt', session.started_at),
  to_jsonb(timezone(session.timezone, session.started_at)::date)
FROM workout_sessions session
JOIN pg_timezone_names known ON known.name = session.timezone
WHERE session.local_date IS NOT NULL
  AND session.local_date <> timezone(session.timezone, session.started_at)::date

UNION ALL

SELECT
  'set.weight_unit_missing', 'completed_set', completed_set.id::text,
  session.user_id, 'weight_unit', to_jsonb(completed_set.weight_unit),
  jsonb_build_object(
    'weight', completed_set.weight,
    'source', session.source,
    'profileUnit', profile.unit,
    'instruction', 'Review the original unit; do not relabel the numeric value.'
  ),
  to_jsonb(profile.unit)
FROM completed_sets completed_set
JOIN session_exercises session_exercise
  ON session_exercise.id = completed_set.session_exercise_id
JOIN workout_sessions session ON session.id = session_exercise.session_id
JOIN user_profiles profile ON profile.user_id = session.user_id
WHERE completed_set.weight IS NOT NULL AND completed_set.weight_unit IS NULL

UNION ALL

SELECT
  'set.weight_unit_without_weight', 'completed_set', completed_set.id::text,
  session.user_id, 'weight_unit', to_jsonb(completed_set.weight_unit),
  jsonb_build_object('weight', completed_set.weight), 'null'::jsonb
FROM completed_sets completed_set
JOIN session_exercises session_exercise
  ON session_exercise.id = completed_set.session_exercise_id
JOIN workout_sessions session ON session.id = session_exercise.session_id
WHERE completed_set.weight IS NULL AND completed_set.weight_unit IS NOT NULL

UNION ALL

SELECT
  'prescription.target_load_unit_mismatch', 'exercise_prescription',
  prescription.id::text, program.user_id, 'target_load_unit',
  to_jsonb(prescription.target_load_unit),
  jsonb_build_object(
    'targetLoad', prescription.target_load,
    'profileUnit', profile.unit,
    'instruction', 'Review the unit used when this prescription was created.'
  ),
  CASE WHEN prescription.target_load IS NULL THEN 'null'::jsonb ELSE to_jsonb(profile.unit) END
FROM exercise_prescriptions prescription
JOIN workout_template_exercises template_exercise
  ON template_exercise.id = prescription.template_exercise_id
JOIN workout_templates template ON template.id = template_exercise.workout_template_id
JOIN program_versions version ON version.id = template.program_version_id
JOIN programs program ON program.id = version.program_id
JOIN user_profiles profile ON profile.user_id = program.user_id
WHERE (prescription.target_load IS NULL) <> (prescription.target_load_unit IS NULL)

UNION ALL

SELECT
  'session_target.target_load_unit_mismatch', 'session_exercise',
  session_exercise.id::text, session.user_id, 'target_load_unit',
  to_jsonb(session_exercise.target_load_unit),
  jsonb_build_object(
    'targetLoad', session_exercise.target_load,
    'profileUnit', profile.unit,
    'instruction', 'Review the snapshotted prescription unit.'
  ),
  CASE WHEN session_exercise.target_load IS NULL THEN 'null'::jsonb ELSE to_jsonb(profile.unit) END
FROM session_exercises session_exercise
JOIN workout_sessions session ON session.id = session_exercise.session_id
JOIN user_profiles profile ON profile.user_id = session.user_id
WHERE (session_exercise.target_load IS NULL) <> (session_exercise.target_load_unit IS NULL)

UNION ALL

SELECT
  'quick_log.weight_unit_missing', 'ai_parsing_event', event.id::text,
  event.user_id, 'parsed_json', event.parsed_json,
  jsonb_build_object(
    'profileUnit', profile.unit,
    'instruction', 'Review weighted quick-log entries and add an explicit unit before confirmation.'
  ),
  NULL::jsonb
FROM ai_parsing_events event
JOIN user_profiles profile ON profile.user_id = event.user_id
WHERE event.scope = 'log'
  AND event.parsed_json IS NOT NULL
  AND jsonb_path_exists(
    event.parsed_json,
    '$.data.entries[*] ? (@.kind == "sets").sets[*] ? (@.weight != null && (!exists(@.weightUnit) || @.weightUnit == null))'
  )

UNION ALL

SELECT
  'quick_log.weight_unit_without_weight', 'ai_parsing_event', event.id::text,
  event.user_id, 'parsed_json', event.parsed_json,
  jsonb_build_object(
    'instruction', 'Remove the unit from unweighted quick-log entries.'
  ),
  NULL::jsonb
FROM ai_parsing_events event
WHERE event.scope = 'log'
  AND event.parsed_json IS NOT NULL
  AND jsonb_path_exists(
    event.parsed_json,
    '$.data.entries[*] ? (@.kind == "sets").sets[*] ? (@.weight == null && exists(@.weightUnit) && @.weightUnit != null)'
  )

UNION ALL

SELECT
  'program.warmup_load_unit_mismatch', 'workout_template_exercise',
  template_exercise.id::text, program.user_id, 'warmup_sets',
  template_exercise.warmup_sets,
  jsonb_build_object(
    'profileUnit', profile.unit,
    'instruction', 'Review every numeric warm-up load and record its original unit.'
  ), NULL::jsonb
FROM workout_template_exercises template_exercise
JOIN workout_templates template ON template.id = template_exercise.workout_template_id
JOIN program_versions version ON version.id = template.program_version_id
JOIN programs program ON program.id = version.program_id
JOIN user_profiles profile ON profile.user_id = program.user_id
WHERE jsonb_path_exists(
  template_exercise.warmup_sets,
  '$[*] ? ((@.load != null && (!exists(@.loadUnit) || @.loadUnit == null)) || (@.load == null && exists(@.loadUnit) && @.loadUnit != null))'
)

UNION ALL

SELECT
  'session.warmup_load_unit_mismatch', 'session_exercise',
  session_exercise.id::text, session.user_id, 'warmup_sets',
  session_exercise.warmup_sets,
  jsonb_build_object(
    'profileUnit', profile.unit,
    'instruction', 'Review every snapshotted numeric warm-up load and record its original unit.'
  ), NULL::jsonb
FROM session_exercises session_exercise
JOIN workout_sessions session ON session.id = session_exercise.session_id
JOIN user_profiles profile ON profile.user_id = session.user_id
WHERE jsonb_path_exists(
  session_exercise.warmup_sets,
  '$[*] ? ((@.load != null && (!exists(@.loadUnit) || @.loadUnit == null)) || (@.load == null && exists(@.loadUnit) && @.loadUnit != null))'
)

UNION ALL

SELECT
  'setup.target_load_unit_mismatch', 'user_profile', profile.id::text,
  profile.user_id, 'setup_state', profile.setup_state,
  jsonb_build_object(
    'profileUnit', profile.unit,
    'instruction', 'Review numeric target loads in the saved setup draft.'
  ), NULL::jsonb
FROM user_profiles profile
WHERE jsonb_path_exists(
  profile.setup_state,
  '$.routineDraft.days[*].exercises[*] ? ((@.targetLoad != null && (!exists(@.targetLoadUnit) || @.targetLoadUnit == null)) || (@.targetLoad == null && exists(@.targetLoadUnit) && @.targetLoadUnit != null))'
)

UNION ALL

SELECT
  'setup.warmup_load_unit_mismatch', 'user_profile', profile.id::text,
  profile.user_id, 'setup_state', profile.setup_state,
  jsonb_build_object(
    'profileUnit', profile.unit,
    'instruction', 'Review numeric warm-up loads in the saved setup draft.'
  ), NULL::jsonb
FROM user_profiles profile
WHERE jsonb_path_exists(
  profile.setup_state,
  '$.routineDraft.days[*].exercises[*].warmup.sets[*] ? ((@.load != null && (!exists(@.loadUnit) || @.loadUnit == null)) || (@.load == null && exists(@.loadUnit) && @.loadUnit != null))'
)

UNION ALL

SELECT
  'recommendation.load_unit_missing', 'recommendation', recommendation.id::text,
  recommendation.user_id, 'payload', recommendation.payload,
  jsonb_build_object(
    'instruction', 'Match the recommendation to the explicit unit on its source prescription.'
  ), NULL::jsonb
FROM recommendations recommendation
WHERE recommendation.payload->>'kind' = 'load_change'
  AND COALESCE(recommendation.payload->>'loadUnit', '') NOT IN ('lb', 'kg')

UNION ALL

SELECT
  'version.set_weight_unit_mismatch', 'record_version', version.id::text,
  version.user_id, 'before_data', version.before_data,
  jsonb_build_object(
    'instruction', 'Recover the earlier set unit from its source record or audit evidence.'
  ), NULL::jsonb
FROM record_versions version
WHERE version.entity_type = 'completed_set'
  AND jsonb_path_exists(
    version.before_data,
    '$ ? ((@.weight != null && (!exists(@.weight_unit) || @.weight_unit == null)) || (@.weight == null && exists(@.weight_unit) && @.weight_unit != null))'
  )

UNION ALL

SELECT
  'version.session_target_unit_mismatch', 'record_version', version.id::text,
  version.user_id, 'before_data', version.before_data,
  jsonb_build_object(
    'instruction', 'Recover the earlier workout target unit from its prescription history.'
  ), NULL::jsonb
FROM record_versions version
WHERE version.entity_type = 'session_exercise'
  AND jsonb_path_exists(
    version.before_data,
    '$ ? ((@.target_load != null && (!exists(@.target_load_unit) || @.target_load_unit == null)) || (@.target_load == null && exists(@.target_load_unit) && @.target_load_unit != null))'
  )

UNION ALL

SELECT
  'version.after_load_unit_mismatch', 'record_version', version.id::text,
  version.user_id, 'after_data', version.after_data,
  jsonb_build_object(
    'instruction', 'Recover the saved unit from the source record or audit evidence.'
  ), NULL::jsonb
FROM record_versions version
WHERE (
    version.entity_type = 'completed_set'
    AND jsonb_path_exists(
      version.after_data,
      '$ ? ((@.weight != null && (!exists(@.weight_unit) || @.weight_unit == null)) || (@.weight == null && exists(@.weight_unit) && @.weight_unit != null))'
    )
  ) OR (
    version.entity_type = 'session_exercise'
    AND jsonb_path_exists(
      version.after_data,
      '$ ? ((@.target_load != null && (!exists(@.target_load_unit) || @.target_load_unit == null)) || (@.target_load == null && exists(@.target_load_unit) && @.target_load_unit != null))'
    )
  )

UNION ALL

SELECT
  'decision.load_unit_missing', 'user_decision', decision.id::text,
  recommendation.user_id, 'edited_payload', decision.edited_payload,
  jsonb_build_object(
    'instruction', 'Match the edited decision to the explicit unit on its recommendation.'
  ), NULL::jsonb
FROM user_decisions decision
JOIN recommendations recommendation ON recommendation.id = decision.recommendation_id
WHERE decision.edited_payload->>'kind' = 'load_change'
  AND COALESCE(decision.edited_payload->>'loadUnit', '') NOT IN ('lb', 'kg')

UNION ALL

SELECT
  'adaptation.prescription_load_unit_mismatch', 'adaptation_event', adaptation.id::text,
  adaptation.user_id, 'before_snapshot/after_snapshot',
  jsonb_build_object('before', adaptation.before_snapshot, 'after', adaptation.after_snapshot),
  jsonb_build_object(
    'instruction', 'Recover the historical prescription unit from prescription and audit evidence.'
  ), NULL::jsonb
FROM adaptation_events adaptation
WHERE jsonb_path_exists(
    adaptation.before_snapshot,
    '$.prescription ? ((@.targetLoad != null && (!exists(@.targetLoadUnit) || @.targetLoadUnit == null)) || (@.targetLoad == null && exists(@.targetLoadUnit) && @.targetLoadUnit != null))'
  ) OR jsonb_path_exists(
    adaptation.after_snapshot,
    '$.prescription ? ((@.targetLoad != null && (!exists(@.targetLoadUnit) || @.targetLoadUnit == null)) || (@.targetLoad == null && exists(@.targetLoadUnit) && @.targetLoadUnit != null))'
  );
