import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";

export type AIHistoryArchivePreview = {
  coachingInsights: number;
  parsingInputs: number;
};

export async function getAIHistoryArchivePreview(
  db: Db,
  userId: string
): Promise<AIHistoryArchivePreview> {
  const row = resultRows(
    await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM coaching_insights
          WHERE user_id = ${userId}::uuid AND archived_at IS NULL) AS coaching_insights,
        (SELECT count(*)::int FROM ai_parsing_events
          WHERE user_id = ${userId}::uuid
            AND raw_redacted_at IS NULL
            AND (raw_input <> '' OR raw_output IS NOT NULL OR parsed_json IS NOT NULL)
        ) AS parsing_inputs
    `)
  )[0];
  return {
    coachingInsights: Number(row?.coaching_insights ?? 0),
    parsingInputs: Number(row?.parsing_inputs ?? 0),
  };
}

export async function archiveAIHistory(
  db: Db,
  userId: string,
  expected: AIHistoryArchivePreview
) {
  const operationId = randomUUID();
  const expectedJson = JSON.stringify(expected);
  const query = sql`
    WITH target_insights AS MATERIALIZED (
      SELECT id
      FROM coaching_insights
      WHERE user_id = ${userId}::uuid
        AND archived_at IS NULL
      FOR UPDATE
    ), target_parses AS MATERIALIZED (
      SELECT id
      FROM ai_parsing_events
      WHERE user_id = ${userId}::uuid
        AND raw_redacted_at IS NULL
        AND (raw_input <> '' OR raw_output IS NOT NULL OR parsed_json IS NOT NULL)
      FOR UPDATE
    ), scope AS MATERIALIZED (
      SELECT jsonb_build_object(
        'coachingInsights', (SELECT count(*)::int FROM target_insights),
        'parsingInputs', (SELECT count(*)::int FROM target_parses)
      ) AS counts
    ), new_operation AS (
      INSERT INTO archive_operations (
        id, user_id, action, status, summary, record_counts
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid, 'ai_history.archive', 'active',
        'Archived AI and Coach history', scope.counts
      FROM scope
      WHERE scope.counts = ${expectedJson}::jsonb
        AND (
          (scope.counts->>'coachingInsights')::int > 0
          OR (scope.counts->>'parsingInputs')::int > 0
        )
      RETURNING id, summary, record_counts
    ), archived_insights AS (
      UPDATE coaching_insights insight
      SET archived_at = now(),
          archive_operation_id = ${operationId}::uuid,
          data_digest = jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion', '2',
            'question', insight.data_digest->>'question',
            'generatedAt', coalesce(insight.data_digest->>'generatedAt', insight.created_at::text),
            'windowDays', insight.data_digest->'windowDays',
            'sessionId', insight.session_id,
            'sessionExerciseId', insight.session_exercise_id,
            'completedSetId', insight.completed_set_id,
            'modelContextRetained', false,
            'retentionArchiveInsightId', insight.id
          ))
      WHERE insight.id IN (SELECT id FROM target_insights)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING insight.id
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
          raw_redacted_at = now(),
          retention_expires_at = NULL
      WHERE event.id IN (SELECT id FROM target_parses)
        AND EXISTS (SELECT 1 FROM new_operation)
      RETURNING event.id
    ), member_input AS (
      SELECT 'ai_history'::text AS entity_type, ${operationId}::text AS entity_id,
        'root'::text AS relationship_role, NULL::text AS parent_entity_type,
        NULL::text AS parent_entity_id
      WHERE EXISTS (SELECT 1 FROM new_operation)
      UNION ALL
      SELECT 'coaching_insight', id::text, 'linked', 'ai_history', ${operationId}::text
      FROM archived_insights
    ), recorded_members AS (
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role,
        parent_entity_type, parent_entity_id
      )
      SELECT
        ${operationId}::uuid, ${userId}::uuid, entity_type, entity_id,
        relationship_role, parent_entity_type, parent_entity_id
      FROM member_input
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'ai_history.archive', 'archive_operation',
        operation.id::text, operation.summary,
        jsonb_build_object(
          'archiveOperationId', operation.id,
          'recordCounts', operation.record_counts,
          'rawInputsRedacted', (SELECT count(*) FROM redacted_parses)
        )
      FROM new_operation operation
      RETURNING id
    )
    SELECT id::text AS operation_id, summary, record_counts
    FROM new_operation
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) {
    return {
      ok: false as const,
      reason: "AI history changed since the preview. Review it again before archiving.",
    };
  }
  return {
    ok: true as const,
    operationId: String(row.operation_id),
    summary: String(row.summary),
    recordCounts: row.record_counts as Record<string, number>,
  };
}
