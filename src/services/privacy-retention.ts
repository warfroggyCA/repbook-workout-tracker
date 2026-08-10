import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { AI_USAGE_RETENTION_DAYS } from "@/services/ai-control";
import { RAW_DATA_RETENTION_HOURS } from "@/lib/privacy-retention";
import { ANALYSIS_PACKAGE_RETENTION_DAYS } from "@/lib/analysis-package";

export type PrivacyRetentionResult = {
  expiredImports: number;
  redactedImports: number;
  redactedAiParses: number;
  minimizedCoachContexts: number;
  expiredUsageEvents: number;
  expiredAnalysisPackageManifests: number;
};

/** One bounded maintenance statement; validated workout/program records are untouched. */
export async function runPrivacyRetention(
  db: Db,
  now = new Date()
): Promise<PrivacyRetentionResult> {
  const query = sql`
    WITH target_imports AS MATERIALIZED (
      SELECT
        event.id,
        event.user_id,
        event.status IN ('raw', 'parsed') AS should_expire
      FROM import_events event
      WHERE event.raw_redacted_at IS NULL
        AND (
          event.status IN ('confirmed', 'discarded', 'removed')
          OR (
            event.status IN ('raw', 'parsed')
            AND (
              event.retention_expires_at <= ${now.toISOString()}::timestamptz
              OR (
                event.retention_expires_at IS NULL
                AND event.created_at <= ${now.toISOString()}::timestamptz - interval '24 hours'
              )
            )
          )
        )
      FOR UPDATE
    ), redacted_imports AS (
      UPDATE import_events event
      SET status = CASE
            WHEN target.should_expire THEN 'discarded'::import_status
            ELSE event.status
          END,
          payload_sha256 = coalesce(
            event.payload_sha256,
            encode(sha256(convert_to(event.raw_payload, 'UTF8')), 'hex')
          ),
          raw_payload = '',
          parsed_payload = NULL,
          raw_redacted_at = ${now.toISOString()}::timestamptz,
          retention_expires_at = NULL
      FROM target_imports target
      WHERE event.id = target.id
      RETURNING event.id, event.user_id, target.should_expire
    ), redacted_parses AS (
      UPDATE ai_parsing_events event
      SET input_sha256 = coalesce(
            event.input_sha256,
            encode(sha256(convert_to(event.raw_input, 'UTF8')), 'hex')
          ),
          raw_input = '',
          raw_output = NULL,
          parsed_json = NULL,
          ambiguities = '[]'::jsonb,
          raw_redacted_at = ${now.toISOString()}::timestamptz,
          retention_expires_at = NULL
      WHERE event.raw_redacted_at IS NULL
        AND (
          event.confirmed
          OR event.retention_expires_at <= ${now.toISOString()}::timestamptz
          OR (
            event.retention_expires_at IS NULL
            AND event.created_at <= ${now.toISOString()}::timestamptz - interval '24 hours'
          )
        )
      RETURNING event.id, event.user_id
    ), minimized_context AS (
      UPDATE coaching_insights insight
      SET data_digest = jsonb_strip_nulls(jsonb_build_object(
        'schemaVersion', '2',
        'question', CASE WHEN insight.kind = 'qa' THEN insight.data_digest->>'question' ELSE NULL END,
        'generatedAt', coalesce(
          insight.data_digest->>'generatedAt',
          insight.created_at::text
        ),
        'windowDays', insight.data_digest->'windowDays',
        'sessionId', insight.session_id,
        'sessionExerciseId', insight.session_exercise_id,
        'completedSetId', insight.completed_set_id,
        'modelContextRetained', false
      ))
      WHERE insight.kind IN ('manual_review', 'qa', 'live_user', 'live_assistant')
        AND coalesce(insight.data_digest->>'modelContextRetained', 'true') <> 'false'
      RETURNING insight.id, insight.user_id
    ), expired_usage AS (
      DELETE FROM ai_usage_events usage
      WHERE usage.status <> 'running'
        AND usage.started_at <= ${now.toISOString()}::timestamptz - interval '90 days'
      RETURNING usage.id, usage.user_id
    ), expired_analysis_manifests AS (
      DELETE FROM analysis_package_manifests manifest
      WHERE manifest.expires_at <= ${now.toISOString()}::timestamptz
      RETURNING manifest.id, manifest.user_id
    ), affected_users AS (
      SELECT user_id FROM redacted_imports
      UNION SELECT user_id FROM redacted_parses
      UNION SELECT user_id FROM minimized_context
      UNION SELECT user_id FROM expired_usage
      UNION SELECT user_id FROM expired_analysis_manifests
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, summary, cause_ref
      )
      SELECT
        affected.user_id, 'system', 'privacy.retention.run',
        'privacy_retention', 'Applied the configured raw-data retention policy',
        jsonb_build_object(
          'runAt', ${now.toISOString()}::text,
          'rawRetentionHours', ${RAW_DATA_RETENTION_HOURS}::integer,
          'usageRetentionDays', ${AI_USAGE_RETENTION_DAYS}::integer,
          'analysisPackageRetentionDays', ${ANALYSIS_PACKAGE_RETENTION_DAYS}::integer
        )
      FROM affected_users affected
      RETURNING id
    )
    SELECT
      (SELECT count(*) FILTER (WHERE should_expire)::int FROM redacted_imports) AS expired_imports,
      (SELECT count(*)::int FROM redacted_imports) AS redacted_imports,
      (SELECT count(*)::int FROM redacted_parses) AS redacted_ai_parses,
      (SELECT count(*)::int FROM minimized_context) AS minimized_coach_contexts,
      (SELECT count(*)::int FROM expired_usage) AS expired_usage_events,
      (SELECT count(*)::int FROM expired_analysis_manifests) AS expired_analysis_package_manifests,
      (SELECT count(*)::int FROM recorded_audit) AS audits
  `;
  const row = resultRows(await db.execute(query))[0] ?? {};
  return {
    expiredImports: Number(row.expired_imports ?? 0),
    redactedImports: Number(row.redacted_imports ?? 0),
    redactedAiParses: Number(row.redacted_ai_parses ?? 0),
    minimizedCoachContexts: Number(row.minimized_coach_contexts ?? 0),
    expiredUsageEvents: Number(row.expired_usage_events ?? 0),
    expiredAnalysisPackageManifests: Number(
      row.expired_analysis_package_manifests ?? 0,
    ),
  };
}
