-- Existing lifecycle conflicts are never guessed away. Review this view before
-- applying the following contract migration.
CREATE VIEW workout_lifecycle_repair_preview AS
SELECT
  'workout.multiple_active_sessions'::text AS issue,
  'user'::text AS entity_type,
  session.user_id::text AS entity_id,
  session.user_id,
  jsonb_build_object(
    'sessionIds', jsonb_agg(session.id ORDER BY session.started_at),
    'startedAt', jsonb_agg(session.started_at ORDER BY session.started_at),
    'instruction', 'Review which workout remains active; preserve the others before changing status.'
  ) AS evidence
FROM workout_sessions session
WHERE session.status = 'in_progress'
  AND session.archived_at IS NULL
GROUP BY session.user_id
HAVING count(*) > 1

UNION ALL

SELECT
  'set.duplicate_client_identity',
  'session_exercise',
  completed_set.session_exercise_id::text,
  session.user_id,
  jsonb_build_object(
    'clientKey', completed_set.client_key,
    'setIds', jsonb_agg(completed_set.id ORDER BY completed_set.logged_at),
    'instruction', 'Review repeated delivery rows without deleting or merging their recorded values.'
  )
FROM completed_sets completed_set
JOIN session_exercises session_exercise
  ON session_exercise.id = completed_set.session_exercise_id
JOIN workout_sessions session ON session.id = session_exercise.session_id
WHERE completed_set.client_key IS NOT NULL
GROUP BY completed_set.session_exercise_id, session.user_id, completed_set.client_key
HAVING count(*) > 1

UNION ALL

SELECT
  'set.duplicate_active_number',
  'session_exercise',
  completed_set.session_exercise_id::text,
  session.user_id,
  jsonb_build_object(
    'setNo', completed_set.set_no,
    'setIds', jsonb_agg(completed_set.id ORDER BY completed_set.logged_at),
    'instruction', 'Review duplicate visible set numbers; archived rows do not conflict.'
  )
FROM completed_sets completed_set
JOIN session_exercises session_exercise
  ON session_exercise.id = completed_set.session_exercise_id
JOIN workout_sessions session ON session.id = session_exercise.session_id
WHERE completed_set.archived_at IS NULL
GROUP BY completed_set.session_exercise_id, session.user_id, completed_set.set_no
HAVING count(*) > 1;
