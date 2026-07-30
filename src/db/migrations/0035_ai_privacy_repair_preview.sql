-- Phase 8 deliberately refuses to guess which simultaneously staged import
-- should survive, or whether an incomplete generation lease is still active.
-- Review and repair every row in this view before applying the contract.
CREATE VIEW ai_privacy_repair_preview AS
SELECT
  'hevy.multiple_current_stages'::text AS issue,
  'user'::text AS entity_type,
  staged.user_id::text AS entity_id,
  staged.user_id,
  jsonb_build_object(
    'importEventIds', jsonb_agg(staged.id ORDER BY staged.created_at, staged.id),
    'createdAt', jsonb_agg(staged.created_at ORDER BY staged.created_at, staged.id),
    'instruction', 'Choose the one Hevy review that remains current. Mark every other stage discarded and clear its raw and parsed payloads.'
  ) AS evidence
FROM import_events staged
WHERE staged.source = 'csv'
  AND staged.status = 'parsed'
GROUP BY staged.user_id
HAVING count(*) > 1

UNION ALL

SELECT
  'hevy.current_stage_missing_source',
  'import_event',
  staged.id::text,
  staged.user_id,
  jsonb_build_object(
    'createdAt', staged.created_at,
    'instruction', 'Discard this unusable stage. A current Hevy review must retain its bounded source until confirmation or expiry.'
  )
FROM import_events staged
WHERE staged.source = 'csv'
  AND staged.status = 'parsed'
  AND staged.raw_payload = ''

UNION ALL

SELECT
  'live_coach.incomplete_generation_lease',
  'coaching_insight',
  response.id::text,
  response.user_id,
  jsonb_build_object(
    'status', response.response_status,
    'leaseId', response.generation_lease_id,
    'leaseExpiresAt', response.generation_lease_expires_at,
    'generationStartedAt', response.generation_started_at,
    'instruction', 'Reconcile the provider job. Return expired or never-started work to pending; otherwise populate the complete active lease.'
  )
FROM coaching_insights response
WHERE response.response_status = 'generating'
  AND (
    response.generation_lease_id IS NULL
    OR response.generation_lease_expires_at IS NULL
    OR response.generation_started_at IS NULL
  );
