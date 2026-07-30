ALTER TABLE "ai_parsing_events" ADD COLUMN "result_session_id" uuid;--> statement-breakpoint

WITH candidate_sessions AS (
  SELECT event.id AS event_id, session.id AS session_id
  FROM ai_parsing_events event
  JOIN workout_sessions session
    ON event.confirmed_payload->>'sessionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND session.id = (event.confirmed_payload->>'sessionId')::uuid
   AND session.user_id = event.user_id
  WHERE event.scope = 'log' AND event.confirmed = true

  UNION

  SELECT event.id, session.id
  FROM ai_parsing_events event
  JOIN audit_logs audit
    ON audit.user_id = event.user_id
   AND audit.action = 'quicklog.apply'
   AND audit.cause_ref->>'parsingEventId' = event.id::text
   AND audit.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  JOIN workout_sessions session
    ON session.id = audit.entity_id::uuid
   AND session.user_id = event.user_id
  WHERE event.scope = 'log' AND event.confirmed = true
), unambiguous AS (
  SELECT event_id, min(session_id::text)::uuid AS session_id
  FROM candidate_sessions
  GROUP BY event_id
  HAVING count(DISTINCT session_id) = 1
)
UPDATE ai_parsing_events event
SET result_session_id = unambiguous.session_id
FROM unambiguous
WHERE event.id = unambiguous.event_id
  AND event.result_session_id IS NULL;--> statement-breakpoint

CREATE VIEW "quick_log_result_repair_preview" AS
WITH candidate_sessions AS (
  SELECT event.id AS event_id, session.id AS session_id
  FROM ai_parsing_events event
  JOIN workout_sessions session
    ON event.confirmed_payload->>'sessionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND session.id = (event.confirmed_payload->>'sessionId')::uuid
   AND session.user_id = event.user_id
  WHERE event.scope = 'log' AND event.confirmed = true

  UNION

  SELECT event.id, session.id
  FROM ai_parsing_events event
  JOIN audit_logs audit
    ON audit.user_id = event.user_id
   AND audit.action = 'quicklog.apply'
   AND audit.cause_ref->>'parsingEventId' = event.id::text
   AND audit.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  JOIN workout_sessions session
    ON session.id = audit.entity_id::uuid
   AND session.user_id = event.user_id
  WHERE event.scope = 'log' AND event.confirmed = true
), candidate_counts AS (
  SELECT
    event_id,
    count(DISTINCT session_id)::integer AS candidate_count,
    array_agg(DISTINCT session_id ORDER BY session_id) AS candidate_session_ids
  FROM candidate_sessions
  GROUP BY event_id
)
SELECT
  event.id AS parsing_event_id,
  event.user_id,
  CASE
    WHEN event.confirmed = false AND event.result_session_id IS NOT NULL
      THEN 'unconfirmed_event_has_result'
    WHEN coalesce(candidate.candidate_count, 0) > 1
      THEN 'multiple_result_candidates'
    ELSE 'confirmed_result_not_recoverable'
  END AS issue,
  coalesce(candidate.candidate_count, 0) AS candidate_count,
  coalesce(candidate.candidate_session_ids, ARRAY[]::uuid[]) AS candidate_session_ids,
  event.result_session_id,
  event.created_at
FROM ai_parsing_events event
LEFT JOIN candidate_counts candidate ON candidate.event_id = event.id
WHERE event.scope = 'log'
  AND (
    (event.confirmed = true AND event.result_session_id IS NULL)
    OR (event.confirmed = false AND event.result_session_id IS NOT NULL)
    OR coalesce(candidate.candidate_count, 0) > 1
  );--> statement-breakpoint

ALTER TABLE "ai_parsing_events" ADD CONSTRAINT "ai_parsing_events_result_session_id_workout_sessions_id_fk" FOREIGN KEY ("result_session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE set null ON UPDATE no action;
