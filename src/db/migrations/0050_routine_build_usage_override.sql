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
  ELSIF p_task <> 'routine_build' AND v_daily_tokens + p_reserved_total_tokens > 250000 THEN
    RETURN QUERY SELECT NULL::uuid, 'token_limit'::text;
    RETURN;
  ELSIF p_task <> 'routine_build' AND v_daily_cost + p_reserved_cost_microusd > 5000000 THEN
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
