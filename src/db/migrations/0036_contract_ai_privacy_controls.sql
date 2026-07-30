DO $$
DECLARE
  conflict_count integer;
BEGIN
  SELECT count(*) INTO conflict_count FROM ai_privacy_repair_preview;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'AI/privacy contract blocked: % repair preview item(s) require explicit review',
      conflict_count;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX "ai_parsing_events_retention_idx" ON "ai_parsing_events" USING btree ("retention_expires_at") WHERE "ai_parsing_events"."raw_redacted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "import_events_retention_idx" ON "import_events" USING btree ("retention_expires_at") WHERE "import_events"."raw_redacted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "import_events_current_hevy_stage_uq" ON "import_events" USING btree ("user_id") WHERE "import_events"."source" = 'csv' AND "import_events"."status" = 'parsed';--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_generation_lease_valid" CHECK (("coaching_insights"."response_status" = 'generating' AND "coaching_insights"."generation_lease_id" IS NOT NULL AND "coaching_insights"."generation_lease_expires_at" IS NOT NULL AND "coaching_insights"."generation_started_at" IS NOT NULL) OR ("coaching_insights"."response_status" IS DISTINCT FROM 'generating' AND "coaching_insights"."generation_lease_id" IS NULL AND "coaching_insights"."generation_lease_expires_at" IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION claim_ai_usage(
  p_user_id uuid,
  p_task text,
  p_logical_key text,
  p_lease_id uuid,
  p_lease_expires_at timestamptz,
  p_network_hash text,
  p_reserved_total_tokens integer,
  p_reserved_cost_microusd bigint,
  p_audio_seconds integer,
  p_now timestamptz
)
RETURNS TABLE(usage_id uuid, failure_code text)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_user_requests integer;
  v_network_requests integer;
  v_running_requests integer;
  v_logical_requests integer;
  v_daily_tokens bigint;
  v_daily_cost bigint;
  v_transcription_requests integer;
  v_transcription_seconds bigint;
  v_usage_id uuid;
  v_day_start timestamptz := date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  IF p_reserved_total_tokens < 0 OR p_reserved_cost_microusd < 0 OR p_audio_seconds < 0 THEN
    RAISE EXCEPTION 'AI usage reservations must be non-negative.' USING ERRCODE = '22023';
  END IF;
  IF p_lease_expires_at <= p_now THEN
    RAISE EXCEPTION 'AI usage lease must expire in the future.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ai-user:' || p_user_id::text, 0));
  IF p_network_hash IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ai-network:' || p_network_hash, 0));
  END IF;

  UPDATE ai_usage_events
  SET status = 'timed_out', completed_at = p_now, failure_code = 'lease_expired'
  WHERE user_id = p_user_id AND status = 'running' AND lease_expires_at <= p_now;

  SELECT
    count(*) FILTER (
      WHERE event.user_id = p_user_id
        AND event.started_at >= p_now - interval '10 minutes'
    )::integer,
    count(*) FILTER (
      WHERE p_network_hash IS NOT NULL
        AND event.network_hash = p_network_hash
        AND event.started_at >= p_now - interval '10 minutes'
    )::integer,
    count(*) FILTER (
      WHERE event.user_id = p_user_id
        AND event.status = 'running'
        AND event.lease_expires_at > p_now
    )::integer,
    count(*) FILTER (
      WHERE event.user_id = p_user_id
        AND event.logical_key = p_logical_key
        AND event.status = 'running'
        AND event.lease_expires_at > p_now
    )::integer,
    coalesce(sum(event.total_tokens) FILTER (
      WHERE event.user_id = p_user_id AND event.started_at >= v_day_start
    ), 0)::bigint,
    coalesce(sum(event.estimated_cost_microusd) FILTER (
      WHERE event.user_id = p_user_id AND event.started_at >= v_day_start
    ), 0)::bigint,
    count(*) FILTER (
      WHERE event.user_id = p_user_id
        AND event.task = 'live_coach_transcription'
        AND event.started_at >= p_now - interval '1 hour'
    )::integer,
    coalesce(sum(event.audio_seconds) FILTER (
      WHERE event.user_id = p_user_id
        AND event.task = 'live_coach_transcription'
        AND event.started_at >= v_day_start
    ), 0)::bigint
  INTO
    v_user_requests, v_network_requests, v_running_requests,
    v_logical_requests, v_daily_tokens, v_daily_cost,
    v_transcription_requests, v_transcription_seconds
  FROM ai_usage_events event;

  IF v_logical_requests > 0 THEN
    RETURN QUERY SELECT NULL::uuid, 'already_running'::text;
    RETURN;
  ELSIF v_running_requests >= 2 THEN
    RETURN QUERY SELECT NULL::uuid, 'concurrent_limit'::text;
    RETURN;
  ELSIF v_user_requests >= 20 THEN
    RETURN QUERY SELECT NULL::uuid, 'rate_limit'::text;
    RETURN;
  ELSIF p_network_hash IS NOT NULL AND v_network_requests >= 40 THEN
    RETURN QUERY SELECT NULL::uuid, 'network_rate_limit'::text;
    RETURN;
  ELSIF v_daily_tokens + p_reserved_total_tokens > 250000 THEN
    RETURN QUERY SELECT NULL::uuid, 'token_limit'::text;
    RETURN;
  ELSIF v_daily_cost + p_reserved_cost_microusd > 5000000 THEN
    RETURN QUERY SELECT NULL::uuid, 'cost_limit'::text;
    RETURN;
  ELSIF p_task = 'live_coach_transcription' AND v_transcription_requests >= 10 THEN
    RETURN QUERY SELECT NULL::uuid, 'transcription_rate_limit'::text;
    RETURN;
  ELSIF p_task = 'live_coach_transcription' AND v_transcription_seconds + p_audio_seconds > 1200 THEN
    RETURN QUERY SELECT NULL::uuid, 'transcription_duration_limit'::text;
    RETURN;
  END IF;

  INSERT INTO ai_usage_events (
    user_id, task, logical_key, status, lease_id, lease_expires_at,
    network_hash, total_tokens, estimated_cost_microusd, audio_seconds, started_at
  ) VALUES (
    p_user_id, p_task, p_logical_key, 'running', p_lease_id,
    p_lease_expires_at, p_network_hash, p_reserved_total_tokens,
    p_reserved_cost_microusd, p_audio_seconds, p_now
  ) RETURNING id INTO v_usage_id;

  RETURN QUERY SELECT v_usage_id, NULL::text;
EXCEPTION
  WHEN unique_violation THEN
    RETURN QUERY SELECT NULL::uuid, 'already_running'::text;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION claim_live_coach_generation(
  p_user_id uuid,
  p_response_id uuid,
  p_logical_key text,
  p_lease_id uuid,
  p_lease_expires_at timestamptz,
  p_network_hash text,
  p_reserved_total_tokens integer,
  p_reserved_cost_microusd bigint,
  p_now timestamptz
)
RETURNS TABLE(usage_id uuid, response_state text, failure_code text, claimed boolean)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_state text;
  v_current_lease_expires_at timestamptz;
  v_usage_id uuid;
  v_failure_code text;
  v_updated integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-user:' || p_user_id::text, 0));
  IF p_network_hash IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ai-network:' || p_network_hash, 0));
  END IF;

  SELECT response.response_status, response.generation_lease_expires_at
  INTO v_state, v_current_lease_expires_at
  FROM coaching_insights response
  WHERE response.id = p_response_id
    AND response.user_id = p_user_id
    AND response.kind = 'live_assistant'
    AND response.archived_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'missing'::text, 'already_running'::text, false;
    RETURN;
  END IF;
  IF v_state <> 'pending' AND NOT (
    v_state = 'generating' AND v_current_lease_expires_at <= p_now
  ) THEN
    RETURN QUERY SELECT NULL::uuid, v_state, 'already_running'::text, false;
    RETURN;
  END IF;

  SELECT claim.usage_id, claim.failure_code
  INTO v_usage_id, v_failure_code
  FROM claim_ai_usage(
    p_user_id, 'live_coaching', p_logical_key, p_lease_id,
    p_lease_expires_at, p_network_hash, p_reserved_total_tokens,
    p_reserved_cost_microusd, 0, p_now
  ) claim;
  IF v_usage_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, v_state, v_failure_code, false;
    RETURN;
  END IF;

  UPDATE coaching_insights response
  SET response_status = 'generating',
      generation_lease_id = p_lease_id,
      generation_lease_expires_at = p_lease_expires_at,
      generation_started_at = p_now,
      failure_reason = NULL,
      completed_at = NULL
  WHERE response.id = p_response_id
    AND response.user_id = p_user_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Live Coach generation claim lost its locked response.';
  END IF;

  RETURN QUERY SELECT v_usage_id, 'generating'::text, NULL::text, true;
END;
$$;
