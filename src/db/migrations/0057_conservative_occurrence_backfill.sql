UPDATE workout_sessions session
SET day_warmup_items = jsonb_build_array(jsonb_build_object(
  'key', session.id::text,
  'label', session.day_warmup_notes,
  'reps', NULL,
  'load', NULL,
  'loadUnit', NULL,
  'loadPercent', NULL,
  'loadText', NULL,
  'notes', NULL
))
WHERE nullif(btrim(session.day_warmup_notes), '') IS NOT NULL
  AND session.day_warmup_items = '[]'::jsonb;
--> statement-breakpoint
WITH grouped AS MATERIALIZED (
  SELECT
    exercise.session_id,
    exercise.superset_key,
    min(exercise.order_idx)::integer AS first_order,
    count(*)::integer AS member_count,
    CASE
      WHEN count(DISTINCT exercise.target_sets) = 1
        AND min(exercise.target_sets) >= 1
      THEN min(exercise.target_sets)::integer
      ELSE NULL
    END AS planned_rounds
  FROM session_exercises exercise
  WHERE exercise.superset_key IS NOT NULL
    AND exercise.group_snapshot_id IS NULL
  GROUP BY exercise.session_id, exercise.superset_key
  HAVING count(*) >= 2
), ordered AS (
  SELECT grouped.*,
    row_number() OVER (
      PARTITION BY grouped.session_id
      ORDER BY grouped.first_order, grouped.superset_key
    )::integer - 1 AS group_order
  FROM grouped
)
INSERT INTO session_exercise_groups (
  session_id, provenance, name, order_idx, planned_rounds, member_count,
  rest_between_members_sec, rest_between_rounds_sec
)
SELECT
  ordered.session_id,
  'legacy',
  'Legacy group ' || ordered.superset_key,
  ordered.group_order,
  ordered.planned_rounds,
  ordered.member_count,
  NULL,
  NULL
FROM ordered;
--> statement-breakpoint
WITH ranked_members AS MATERIALIZED (
  SELECT
    exercise.id,
    group_snapshot.id AS group_snapshot_id,
    row_number() OVER (
      PARTITION BY exercise.session_id, exercise.superset_key
      ORDER BY exercise.order_idx, exercise.id
    )::integer - 1 AS member_order
  FROM session_exercises exercise
  JOIN session_exercise_groups group_snapshot
    ON group_snapshot.session_id = exercise.session_id
   AND group_snapshot.provenance = 'legacy'
   AND group_snapshot.name = 'Legacy group ' || exercise.superset_key
  WHERE exercise.group_snapshot_id IS NULL
)
UPDATE session_exercises exercise
SET group_snapshot_id = ranked.group_snapshot_id,
    group_member_order_idx = ranked.member_order
FROM ranked_members ranked
WHERE exercise.id = ranked.id;
--> statement-breakpoint
WITH eligible_sessions AS MATERIALIZED (
  SELECT session.*
  FROM workout_sessions session
  WHERE NOT EXISTS (
    SELECT 1 FROM session_occurrences existing
    WHERE existing.session_id = session.id
  )
), day_warmups AS MATERIALIZED (
  SELECT
    session.id AS session_id,
    NULL::uuid AS session_exercise_id,
    'day_warmup'::text AS kind,
    item.ordinality::integer - 1 AS kind_ordinal,
    item.value->>'label' AS label,
    NULL::uuid AS planned_exercise_id,
    (item.value->>'reps')::integer AS planned_reps_min,
    (item.value->>'reps')::integer AS planned_reps_max,
    (item.value->>'load')::numeric AS planned_load,
    CASE
      WHEN item.value->>'load' IS NOT NULL
      THEN (item.value->>'loadUnit')::unit
      ELSE NULL::unit
    END AS planned_load_unit,
    CASE
      WHEN item.value->>'load' IS NULL
      THEN (item.value->>'loadPercent')::numeric
      ELSE NULL::numeric
    END AS planned_load_percent,
    CASE
      WHEN item.value->>'load' IS NULL
        AND item.value->>'loadPercent' IS NULL
      THEN item.value->>'loadText'
      ELSE NULL::text
    END AS planned_load_text,
    NULL::integer AS planned_rest_sec,
    item.value->>'notes' AS planned_note,
    NULL::uuid AS group_snapshot_id,
    NULL::integer AS group_round,
    NULL::integer AS group_member_order_idx,
    CASE WHEN session.status = 'in_progress' THEN 'pending' ELSE 'legacy_unrecorded' END AS outcome,
    NULL::uuid AS completed_set_id,
    NULL::timestamptz AS resolved_at,
    item.ordinality::integer - 1 AS source_order,
    0::integer AS exercise_order,
    0::integer AS kind_order
  FROM eligible_sessions session
  CROSS JOIN LATERAL jsonb_array_elements(session.day_warmup_items)
    WITH ORDINALITY AS item(value, ordinality)
), exercise_warmups AS MATERIALIZED (
  SELECT
    session.id AS session_id,
    exercise.id AS session_exercise_id,
    'exercise_warmup'::text AS kind,
    source.local_order AS kind_ordinal,
    source.value->>'label' AS label,
    exercise.exercise_id AS planned_exercise_id,
    (source.value->>'reps')::integer AS planned_reps_min,
    (source.value->>'reps')::integer AS planned_reps_max,
    (source.value->>'load')::numeric AS planned_load,
    CASE
      WHEN source.value->>'load' IS NOT NULL
      THEN (source.value->>'loadUnit')::unit
      ELSE NULL::unit
    END AS planned_load_unit,
    CASE
      WHEN source.value->>'load' IS NULL
      THEN (source.value->>'loadPercent')::numeric
      ELSE NULL::numeric
    END AS planned_load_percent,
    CASE
      WHEN source.value->>'load' IS NULL
        AND source.value->>'loadPercent' IS NULL
      THEN source.value->>'loadText'
      ELSE NULL::text
    END AS planned_load_text,
    NULL::integer AS planned_rest_sec,
    source.value->>'notes' AS planned_note,
    NULL::uuid AS group_snapshot_id,
    NULL::integer AS group_round,
    NULL::integer AS group_member_order_idx,
    CASE WHEN session.status = 'in_progress' THEN 'pending' ELSE 'legacy_unrecorded' END AS outcome,
    NULL::uuid AS completed_set_id,
    NULL::timestamptz AS resolved_at,
    source.local_order AS source_order,
    exercise.order_idx AS exercise_order,
    1::integer AS kind_order
  FROM eligible_sessions session
  JOIN session_exercises exercise ON exercise.session_id = session.id
  CROSS JOIN LATERAL (
    SELECT 0::integer AS local_order, jsonb_build_object(
      'label', exercise.warmup_notes,
      'reps', NULL,
      'load', NULL,
      'loadUnit', NULL,
      'loadPercent', NULL,
      'loadText', NULL,
      'notes', NULL
    ) AS value
    WHERE nullif(btrim(exercise.warmup_notes), '') IS NOT NULL
    UNION ALL
    SELECT item.ordinality::integer
      - CASE WHEN nullif(btrim(exercise.warmup_notes), '') IS NULL THEN 1 ELSE 0 END,
      item.value
    FROM jsonb_array_elements(exercise.warmup_sets)
      WITH ORDINALITY AS item(value, ordinality)
  ) source
), planned_work AS MATERIALIZED (
  SELECT
    session.id AS session_id,
    exercise.id AS session_exercise_id,
    'working_set'::text AS kind,
    series.set_no - 1 AS kind_ordinal,
    NULL::text AS label,
    exercise.exercise_id AS planned_exercise_id,
    exercise.target_reps_min AS planned_reps_min,
    exercise.target_reps_max AS planned_reps_max,
    exercise.target_load AS planned_load,
    exercise.target_load_unit AS planned_load_unit,
    NULL::numeric AS planned_load_percent,
    NULL::text AS planned_load_text,
    exercise.rest_sec AS planned_rest_sec,
    coalesce(exercise.set_notes->>(series.set_no - 1), exercise.notes) AS planned_note,
    exercise.group_snapshot_id,
    CASE WHEN exercise.group_snapshot_id IS NULL THEN NULL ELSE series.set_no END AS group_round,
    exercise.group_member_order_idx,
    CASE
      WHEN result.id IS NOT NULL THEN 'completed'
      WHEN session.status = 'in_progress' THEN 'pending'
      ELSE 'legacy_unrecorded'
    END AS outcome,
    result.id AS completed_set_id,
    CASE WHEN result.id IS NOT NULL THEN coalesce(session.finished_at, session.started_at) ELSE NULL END AS resolved_at,
    series.set_no - 1 AS source_order,
    exercise.order_idx AS exercise_order,
    2::integer AS kind_order
  FROM eligible_sessions session
  JOIN session_exercises exercise ON exercise.session_id = session.id
  CROSS JOIN LATERAL generate_series(1, coalesce(exercise.target_sets, 0)) series(set_no)
  LEFT JOIN completed_sets result
    ON result.session_exercise_id = exercise.id
   AND result.set_no = series.set_no
   AND result.is_warmup = false
   AND result.archived_at IS NULL
), extra_results AS MATERIALIZED (
  SELECT
    session.id AS session_id,
    exercise.id AS session_exercise_id,
    'working_set'::text AS kind,
    coalesce(exercise.target_sets, 0)
      + row_number() OVER (
          PARTITION BY exercise.id
          ORDER BY result.set_no, result.id
        )::integer - 1 AS kind_ordinal,
    NULL::text AS label,
    exercise.exercise_id AS planned_exercise_id,
    NULL::integer AS planned_reps_min,
    NULL::integer AS planned_reps_max,
    NULL::numeric AS planned_load,
    NULL::unit AS planned_load_unit,
    NULL::numeric AS planned_load_percent,
    NULL::text AS planned_load_text,
    exercise.rest_sec AS planned_rest_sec,
    NULL::text AS planned_note,
    NULL::uuid AS group_snapshot_id,
    NULL::integer AS group_round,
    NULL::integer AS group_member_order_idx,
    'completed'::text AS outcome,
    result.id AS completed_set_id,
    coalesce(session.finished_at, session.started_at) AS resolved_at,
    coalesce(exercise.target_sets, 0)
      + row_number() OVER (
          PARTITION BY exercise.id
          ORDER BY result.set_no, result.id
        )::integer - 1 AS source_order,
    exercise.order_idx AS exercise_order,
    2::integer AS kind_order
  FROM eligible_sessions session
  JOIN session_exercises exercise ON exercise.session_id = session.id
  JOIN completed_sets result
    ON result.session_exercise_id = exercise.id
   AND result.is_warmup = false
   AND result.archived_at IS NULL
  WHERE result.set_no > coalesce(exercise.target_sets, 0)
), combined AS MATERIALIZED (
  SELECT * FROM day_warmups
  UNION ALL SELECT * FROM exercise_warmups
  UNION ALL SELECT * FROM planned_work
  UNION ALL SELECT * FROM extra_results
), ordered AS (
  SELECT combined.*,
    row_number() OVER (
      PARTITION BY combined.session_id
      ORDER BY
        combined.kind_order,
        CASE
          WHEN combined.group_snapshot_id IS NOT NULL THEN (
            SELECT min(member.order_idx)
            FROM session_exercises member
            WHERE member.group_snapshot_id = combined.group_snapshot_id
          )
          ELSE combined.exercise_order
        END,
        CASE WHEN combined.group_snapshot_id IS NOT NULL
          THEN combined.source_order ELSE 0 END,
        CASE WHEN combined.group_snapshot_id IS NOT NULL
          THEN combined.group_member_order_idx ELSE combined.source_order END,
        combined.session_exercise_id NULLS FIRST
    )::integer - 1 AS sequence_idx
  FROM combined
)
INSERT INTO session_occurrences (
  session_id, session_exercise_id, kind, origin, sequence_idx, kind_ordinal,
  label, planned_exercise_id, planned_reps_min, planned_reps_max,
  planned_load, planned_load_unit, planned_load_percent, planned_load_text,
  planned_rest_sec, planned_note, group_snapshot_id, group_round,
  group_member_order_idx, outcome, completed_set_id, resolved_at
)
SELECT
  ordered.session_id,
  ordered.session_exercise_id,
  ordered.kind,
  CASE
    WHEN session.import_batch_id IS NOT NULL THEN 'imported'
    WHEN session.template_id IS NULL THEN 'ad_hoc'
    ELSE 'legacy'
  END,
  ordered.sequence_idx,
  ordered.kind_ordinal,
  ordered.label,
  ordered.planned_exercise_id,
  ordered.planned_reps_min,
  ordered.planned_reps_max,
  ordered.planned_load,
  ordered.planned_load_unit,
  ordered.planned_load_percent,
  ordered.planned_load_text,
  ordered.planned_rest_sec,
  ordered.planned_note,
  ordered.group_snapshot_id,
  ordered.group_round,
  ordered.group_member_order_idx,
  ordered.outcome,
  ordered.completed_set_id,
  ordered.resolved_at
FROM ordered
JOIN eligible_sessions session ON session.id = ordered.session_id;
