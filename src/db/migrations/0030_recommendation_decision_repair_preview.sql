-- Existing decision, prescription, or workout-order conflicts are never
-- guessed away. Apply this preview before the contract migration and review
-- every returned row.
CREATE VIEW recommendation_decision_repair_preview AS
SELECT
  'recommendation.multiple_decisions'::text AS issue,
  'recommendation'::text AS entity_type,
  recommendation.id::text AS entity_id,
  recommendation.user_id,
  jsonb_build_object(
    'decisionIds', jsonb_agg(decision.id ORDER BY decision.decided_at, decision.id),
    'decisions', jsonb_agg(decision.decision ORDER BY decision.decided_at, decision.id),
    'instruction', 'Review the recommendation history and preserve one truthful decision before applying the contract.'
  ) AS evidence
FROM recommendations recommendation
JOIN user_decisions decision ON decision.recommendation_id = recommendation.id
GROUP BY recommendation.id, recommendation.user_id
HAVING count(*) > 1

UNION ALL

SELECT
  'recommendation.multiple_adaptations'::text,
  'recommendation'::text,
  recommendation.id::text,
  recommendation.user_id,
  jsonb_build_object(
    'adaptationIds', jsonb_agg(adaptation.id ORDER BY adaptation.applied_at, adaptation.id),
    'instruction', 'Review before/after evidence and preserve one truthful applied adaptation before applying the contract.'
  )
FROM recommendations recommendation
JOIN adaptation_events adaptation ON adaptation.recommendation_id = recommendation.id
GROUP BY recommendation.id, recommendation.user_id
HAVING count(*) > 1

UNION ALL

SELECT
  'program.multiple_active_prescriptions'::text,
  'template_exercise'::text,
  slot.id::text,
  program.user_id,
  jsonb_build_object(
    'prescriptionIds', jsonb_agg(prescription.id ORDER BY prescription.created_at, prescription.id),
    'instruction', 'Review prescription history and explicitly select the one current prescription before applying the contract.'
  )
FROM workout_template_exercises slot
JOIN workout_templates template ON template.id = slot.workout_template_id
JOIN program_versions version ON version.id = template.program_version_id
JOIN programs program ON program.id = version.program_id
JOIN exercise_prescriptions prescription
  ON prescription.template_exercise_id = slot.id
 AND prescription.superseded_by_id IS NULL
GROUP BY slot.id, program.user_id
HAVING count(*) > 1

UNION ALL

SELECT
  'quick_log.duplicate_session_order'::text,
  'workout_session'::text,
  session.id::text,
  session.user_id,
  jsonb_build_object(
    'orderIndex', exercise.order_idx,
    'sessionExerciseIds', jsonb_agg(exercise.id ORDER BY exercise.id),
    'instruction', 'Review the performed order and assign distinct positions without discarding workout data before applying the contract.'
  )
FROM workout_sessions session
JOIN session_exercises exercise ON exercise.session_id = session.id
GROUP BY session.id, session.user_id, exercise.order_idx
HAVING count(*) > 1

UNION ALL

SELECT
  'recommendation.status_decision_mismatch'::text,
  'recommendation'::text,
  recommendation.id::text,
  recommendation.user_id,
  jsonb_build_object(
    'status', recommendation.status,
    'decisionCount', decision_summary.decision_count,
    'decisions', decision_summary.decisions,
    'instruction', 'Review the recommendation and decision evidence, then align the durable status with exactly one truthful decision.'
  )
FROM recommendations recommendation
CROSS JOIN LATERAL (
  SELECT
    count(*)::integer AS decision_count,
    coalesce(jsonb_agg(decision.decision ORDER BY decision.decided_at, decision.id), '[]'::jsonb) AS decisions,
    count(*) FILTER (WHERE decision.decision = 'approve')::integer AS approvals,
    count(*) FILTER (WHERE decision.decision = 'edit')::integer AS edits,
    count(*) FILTER (WHERE decision.decision = 'reject')::integer AS rejections
  FROM user_decisions decision
  WHERE decision.recommendation_id = recommendation.id
) decision_summary
WHERE
  (recommendation.status = 'pending' AND decision_summary.decision_count <> 0)
  OR (recommendation.status = 'approved'
      AND (decision_summary.decision_count <> 1 OR decision_summary.approvals <> 1))
  OR (recommendation.status = 'edited'
      AND (decision_summary.decision_count <> 1 OR decision_summary.edits <> 1))
  OR (recommendation.status = 'rejected'
      AND (decision_summary.decision_count <> 1 OR decision_summary.rejections <> 1))
  OR (recommendation.status = 'expired' AND decision_summary.decision_count <> 0)

UNION ALL

SELECT
  'recommendation.adaptation_state_mismatch'::text,
  'recommendation'::text,
  recommendation.id::text,
  recommendation.user_id,
  jsonb_build_object(
    'status', recommendation.status,
    'adaptationCount', adaptation_summary.adaptation_count,
    'adaptationIds', adaptation_summary.adaptation_ids,
    'instruction', 'Approved or edited recommendations require one truthful adaptation; all other statuses require none.'
  )
FROM recommendations recommendation
CROSS JOIN LATERAL (
  SELECT
    count(*)::integer AS adaptation_count,
    coalesce(jsonb_agg(adaptation.id ORDER BY adaptation.applied_at, adaptation.id), '[]'::jsonb) AS adaptation_ids
  FROM adaptation_events adaptation
  WHERE adaptation.recommendation_id = recommendation.id
) adaptation_summary
WHERE
  (recommendation.status IN ('approved', 'edited')
    AND adaptation_summary.adaptation_count <> 1)
  OR (recommendation.status NOT IN ('approved', 'edited')
    AND adaptation_summary.adaptation_count <> 0);
