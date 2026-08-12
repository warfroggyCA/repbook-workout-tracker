import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { assertCanonicalSnapshotTableCoverage } from "@/services/recovery-manifest";
import { canonicalizeProgramDraftIdentity } from "@/services/program-document-integrity";
import { externalAnalysisImportDigestSchema } from "@/lib/external-analysis-import";

export const SNAPSHOT_SCHEMA_VERSION = "33";

export type CanonicalSnapshotPayload = {
  schemaVersion: string;
  capturedAt: string;
  appVersion: string;
  tables: Record<string, unknown[]>;
};

export type SnapshotRecordCounts = Record<string, number> & { total: number };

const OPAQUE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function opaqueUuidValues(
  value: unknown,
  result = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    if (OPAQUE_UUID_PATTERN.test(value)) result.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) opaqueUuidValues(item, result);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) opaqueUuidValues(item, result);
  }
  return result;
}

function parsePayload(value: unknown): CanonicalSnapshotPayload {
  const payload = (typeof value === "string" ? JSON.parse(value) : value) as
    | CanonicalSnapshotPayload
    | undefined;
  if (!payload?.tables || typeof payload.tables !== "object") {
    throw new Error("Database did not return a complete snapshot payload.");
  }
  return payload;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Raw model/import material never crosses into a durable backup generation. */
export function sanitizeSnapshotPrivacy(
  payload: CanonicalSnapshotPayload,
  options: { retainCoachEvidenceIds?: boolean } = {},
): CanonicalSnapshotPayload {
  for (const event of payload.tables.ai_parsing_events ?? []) {
    const row = event as Record<string, unknown>;
    const rawInput = typeof row.raw_input === "string" ? row.raw_input : "";
    row.input_sha256 = row.input_sha256 || sha256(rawInput);
    row.raw_input = "";
    row.raw_output = null;
    row.parsed_json = null;
    row.ambiguities = [];
    row.raw_redacted_at ||= row.created_at ?? payload.capturedAt;
    row.retention_expires_at = null;
  }
  for (const event of payload.tables.import_events ?? []) {
    const row = event as Record<string, unknown>;
    const rawPayload = typeof row.raw_payload === "string" ? row.raw_payload : "";
    row.payload_sha256 = row.payload_sha256 || sha256(rawPayload);
    row.raw_payload = "";
    row.parsed_payload = null;
    if (row.status === "raw" || row.status === "parsed") row.status = "discarded";
    row.raw_redacted_at ||= row.created_at ?? payload.capturedAt;
    row.retention_expires_at = null;
  }
  for (const insight of payload.tables.coaching_insights ?? []) {
    const row = insight as Record<string, unknown>;
    if (row.kind === "external_analysis_import") {
      const imported = externalAnalysisImportDigestSchema.safeParse(row.data_digest);
      if (!imported.success) {
        throw new Error("An external-analysis import receipt is malformed.");
      }
      row.data_digest = imported.data;
      row.content_md = "Selected external-analysis observations and proposal provenance.";
      row.model = null;
      row.provider_item_id = null;
      row.failure_reason = null;
      continue;
    }
    const digest =
      row.data_digest && typeof row.data_digest === "object"
        ? (row.data_digest as Record<string, unknown>)
        : {};
    const retainedEvidenceIds = options.retainCoachEvidenceIds
      ? [...opaqueUuidValues(digest)].sort()
      : [];
    row.data_digest = Object.fromEntries(
      Object.entries({
        schemaVersion: "2",
        question: row.kind === "qa" ? digest.question : undefined,
        generatedAt: digest.generatedAt ?? row.created_at,
        windowDays: digest.windowDays,
        sessionId: row.session_id,
        sessionExerciseId: row.session_exercise_id,
        completedSetId: row.completed_set_id,
        modelContextRetained: false,
        retentionArchiveInsightId: digest.retentionArchiveInsightId,
        retainedEvidenceIds:
          retainedEvidenceIds.length > 0 ? retainedEvidenceIds : undefined,
      }).filter(([, value]) => value != null)
    );
  }
  return payload;
}

export function normalizeSnapshotProgramDrafts(
  payload: CanonicalSnapshotPayload
): CanonicalSnapshotPayload {
  const drafts = payload.tables.program_drafts;
  if (drafts == null) return payload;
  if (!Array.isArray(drafts)) {
    throw new Error("Snapshot table program_drafts is invalid.");
  }
  for (const value of drafts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Snapshot table program_drafts contains an invalid row.");
    }
    const draft = value as Record<string, unknown>;
    const canonical = canonicalizeProgramDraftIdentity(
      draft.document,
      draft.content_hash
    );
    draft.document = canonical.document;
    draft.content_hash = canonical.contentHash;
    if (canonical.changed) {
      draft.reviewed_revision = null;
      draft.review_hash = null;
      draft.review_summary = null;
    }
  }
  return payload;
}

/**
 * One SQL statement means PostgreSQL supplies one MVCC view for every table in
 * the snapshot, including active and archived rows.
 */
export async function captureUserSnapshot(
  db: Db,
  userId: string,
  capturedAt: Date,
  appVersion: string,
  options: {
    normalizeProgramDrafts?: boolean;
    retainCoachEvidenceIds?: boolean;
  } = {}
): Promise<CanonicalSnapshotPayload> {
  const query = sql`
    WITH
    user_programs AS (
      SELECT * FROM programs WHERE user_id = ${userId}::uuid
    ),
    user_program_versions AS (
      SELECT pv.* FROM program_versions pv
      JOIN user_programs p ON p.id = pv.program_id
    ),
    user_program_drafts AS (
      SELECT draft.* FROM program_drafts draft
      JOIN user_programs program ON program.id = draft.program_id
      WHERE draft.user_id = ${userId}::uuid
    ),
    user_workout_templates AS (
      SELECT wt.* FROM workout_templates wt
      JOIN user_program_versions pv ON pv.id = wt.program_version_id
    ),
    user_superset_groups AS (
      SELECT sg.* FROM superset_groups sg
      JOIN user_workout_templates wt ON wt.id = sg.workout_template_id
    ),
    user_workout_template_exercises AS (
      SELECT wte.* FROM workout_template_exercises wte
      JOIN user_workout_templates wt ON wt.id = wte.workout_template_id
    ),
    user_exercise_prescriptions AS (
      SELECT ep.* FROM exercise_prescriptions ep
      JOIN user_workout_template_exercises wte ON wte.id = ep.template_exercise_id
    ),
    user_workout_sessions AS (
      SELECT * FROM workout_sessions WHERE user_id = ${userId}::uuid
    ),
    user_session_compiler_proposals AS (
      SELECT * FROM session_compiler_proposals WHERE user_id = ${userId}::uuid
    ),
    user_session_exercises AS (
      SELECT se.* FROM session_exercises se
      JOIN user_workout_sessions ws ON ws.id = se.session_id
    ),
    user_session_exercise_groups AS (
      SELECT seg.* FROM session_exercise_groups seg
      JOIN user_workout_sessions ws ON ws.id = seg.session_id
    ),
    user_completed_sets AS (
      SELECT cs.* FROM completed_sets cs
      JOIN user_session_exercises se ON se.id = cs.session_exercise_id
    ),
    user_session_occurrences AS (
      SELECT occurrence.* FROM session_occurrences occurrence
      JOIN user_workout_sessions ws ON ws.id = occurrence.session_id
    ),
    user_session_occurrence_mutations AS (
      SELECT mutation.* FROM session_occurrence_mutations mutation
      JOIN user_session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
    ),
    user_session_equipment_snapshots AS (
      SELECT snapshot.* FROM session_equipment_snapshots snapshot
      JOIN user_workout_sessions session ON session.id = snapshot.session_id
    ),
    user_session_equipment_selection_receipts AS (
      SELECT receipt.* FROM session_equipment_selection_receipts receipt
      JOIN user_workout_sessions session ON session.id = receipt.session_id
    ),
    user_session_notes AS (
      SELECT sn.* FROM session_notes sn
      JOIN user_workout_sessions ws ON ws.id = sn.session_id
    ),
    user_contextual_notes AS (
      SELECT * FROM contextual_notes WHERE user_id = ${userId}::uuid
    ),
    user_contextual_note_revisions AS (
      SELECT revision.* FROM contextual_note_revisions revision
      JOIN user_contextual_notes note ON note.id = revision.note_id
      WHERE revision.user_id = ${userId}::uuid
    ),
    user_progression_jobs AS (
      SELECT * FROM progression_jobs WHERE user_id = ${userId}::uuid
    ),
    user_progression_job_input_sessions AS (
      SELECT input.* FROM progression_job_input_sessions input
      JOIN user_progression_jobs job ON job.id = input.job_id
      WHERE input.user_id = ${userId}::uuid
    ),
    user_recommendations AS (
      SELECT * FROM recommendations WHERE user_id = ${userId}::uuid
    ),
    user_decisions_rows AS (
      SELECT ud.* FROM user_decisions ud
      JOIN user_recommendations r ON r.id = ud.recommendation_id
    ),
    user_archive_operations AS (
      SELECT * FROM archive_operations WHERE user_id = ${userId}::uuid
    ),
    user_archive_records AS (
      SELECT * FROM archive_operation_records WHERE user_id = ${userId}::uuid
    ),
    snapshot_exercises AS (
      SELECT * FROM exercises WHERE user_id IS NULL OR user_id = ${userId}::uuid
    ),
    snapshot_exercise_families AS (
      SELECT ef.* FROM exercise_families ef
      WHERE EXISTS (
        SELECT 1 FROM snapshot_exercises e WHERE e.family_id = ef.id
      )
    ),
    snapshot_exercise_aliases AS (
      SELECT ea.* FROM exercise_aliases ea
      JOIN snapshot_exercises e ON e.id = ea.exercise_id
    ),
    snapshot_exercise_sources AS (
      SELECT es.* FROM exercise_sources es
      JOIN snapshot_exercises e ON e.id = es.exercise_id
    ),
    snapshot_exercise_media_associations AS (
      SELECT ema.* FROM exercise_media_associations ema
      WHERE (
        ema.exercise_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM snapshot_exercises e WHERE e.id = ema.exercise_id
        )
      ) OR (
        ema.family_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM snapshot_exercise_families ef WHERE ef.id = ema.family_id
        )
      )
    ),
    snapshot_exercise_media_assets AS (
      SELECT ema.* FROM exercise_media_assets ema
      WHERE EXISTS (
        SELECT 1 FROM snapshot_exercise_media_associations link
        WHERE link.asset_id = ema.id
      )
    ),
    snapshot_exercise_requirements AS (
      SELECT er.* FROM exercise_equipment_requirements er
      JOIN snapshot_exercises e ON e.id = er.exercise_id
    ),
    snapshot_execution_requirements AS (
      SELECT requirement.* FROM exercise_execution_requirements requirement
      JOIN snapshot_exercises exercise ON exercise.id = requirement.exercise_id
    ),
    snapshot_equipment_definitions AS (
      SELECT ed.* FROM equipment_definitions ed
      WHERE EXISTS (
        SELECT 1 FROM equipment_items ei
        WHERE ei.user_id = ${userId}::uuid AND ei.definition_id = ed.id
      ) OR EXISTS (
        SELECT 1 FROM snapshot_exercise_requirements er
        WHERE er.equipment_definition_id = ed.id
      ) OR EXISTS (
        SELECT 1 FROM snapshot_execution_requirements requirement
        WHERE requirement.required_equipment_definition_id = ed.id
           OR requirement.required_attachment_definition_id = ed.id
      )
    )
    SELECT jsonb_build_object(
      'schemaVersion', ${SNAPSHOT_SCHEMA_VERSION}::text,
      'capturedAt', ${capturedAt.toISOString()}::text,
      'appVersion', ${appVersion}::text,
      'tables', jsonb_build_object(
        'users', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM users r WHERE r.id = ${userId}::uuid),
        'user_profiles', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_profiles r WHERE r.user_id = ${userId}::uuid),
        'constraints', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM constraints r WHERE r.user_id = ${userId}::uuid),
        'equipment_items', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM equipment_items r WHERE r.user_id = ${userId}::uuid),
        'exercise_equipment_fit_assertions', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM exercise_equipment_fit_assertions r WHERE r.user_id = ${userId}::uuid),
        'plate_inventory', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM plate_inventory r WHERE r.user_id = ${userId}::uuid),
        'barbell_configs', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM barbell_configs r WHERE r.user_id = ${userId}::uuid),
        'plate_loaded_machine_profiles', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM plate_loaded_machine_profiles r WHERE r.user_id = ${userId}::uuid),
        'plate_loaded_machine_compatible_plates', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.machine_profile_id, r.plate_inventory_id), '[]'::jsonb) FROM plate_loaded_machine_compatible_plates r WHERE r.user_id = ${userId}::uuid),
        'cable_machine_profiles', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM cable_machine_profiles r WHERE r.user_id = ${userId}::uuid),
        'cable_stack_steps', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM cable_stack_steps r WHERE r.user_id = ${userId}::uuid),
        'cable_attachment_profiles', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM cable_attachment_profiles r WHERE r.user_id = ${userId}::uuid),
        'cable_attachment_compatibilities', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.cable_profile_id, r.attachment_profile_id), '[]'::jsonb) FROM cable_attachment_compatibilities r WHERE r.user_id = ${userId}::uuid),
        'equipment_definitions', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM snapshot_equipment_definitions r),
        'exercise_families', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM snapshot_exercise_families r),
        'exercises', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM snapshot_exercises r),
        'exercise_aliases', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM snapshot_exercise_aliases r),
        'exercise_sources', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM snapshot_exercise_sources r),
        'exercise_media_assets', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM snapshot_exercise_media_assets r),
        'exercise_media_associations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM snapshot_exercise_media_associations r),
        'exercise_equipment_requirements', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM snapshot_exercise_requirements r),
        'exercise_execution_requirements', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM snapshot_execution_requirements r),
        'external_exercise_mappings', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM external_exercise_mappings r WHERE r.user_id = ${userId}::uuid)
      ) || jsonb_build_object(
        'programs', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_programs r),
        'program_versions', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_program_versions r),
        'program_drafts', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_program_drafts r),
        'workout_templates', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_workout_templates r),
        'superset_groups', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_superset_groups r),
        'workout_template_exercises', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_workout_template_exercises r),
        'exercise_prescriptions', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_exercise_prescriptions r),
        'session_compiler_proposals', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_session_compiler_proposals r),
        'workout_sessions', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_workout_sessions r),
        'session_exercise_groups', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_session_exercise_groups r),
        'session_exercises', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_session_exercises r),
        'session_equipment_snapshots', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_session_equipment_snapshots r),
        'completed_sets', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_completed_sets r),
        'session_occurrences', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_session_occurrences r),
        'session_occurrence_mutations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_session_occurrence_mutations r),
        'session_equipment_selection_receipts', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_session_equipment_selection_receipts r),
        'session_notes', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_session_notes r),
        'contextual_notes', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_contextual_notes r),
        'contextual_note_revisions', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.note_id, r.revision, r.id), '[]'::jsonb) FROM user_contextual_note_revisions r),
        'progression_jobs', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_progression_jobs r),
        'progression_job_input_sessions', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.job_id, r.source_slot_lineage_id, r.session_id), '[]'::jsonb) FROM user_progression_job_input_sessions r),
        'pain_logs', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM pain_logs r WHERE r.user_id = ${userId}::uuid),
        'fatigue_logs', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM fatigue_logs r WHERE r.user_id = ${userId}::uuid),
        'health_activities', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM health_activities r WHERE r.user_id = ${userId}::uuid),
        'recommendations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_recommendations r),
        'user_decisions', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_decisions_rows r),
        'adaptation_events', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM adaptation_events r WHERE r.user_id = ${userId}::uuid),
        'coaching_insights', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM coaching_insights r WHERE r.user_id = ${userId}::uuid),
        'ai_parsing_events', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM ai_parsing_events r WHERE r.user_id = ${userId}::uuid),
        'import_events', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM import_events r WHERE r.user_id = ${userId}::uuid),
        'history_import_batches', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM history_import_batches r WHERE r.user_id = ${userId}::uuid),
        'export_events', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM export_events r WHERE r.user_id = ${userId}::uuid),
        'audit_logs', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM audit_logs r WHERE r.user_id = ${userId}::uuid),
        'archive_operations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_archive_operations r),
        'archive_operation_records', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM user_archive_records r),
        'record_versions', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM record_versions r WHERE r.user_id = ${userId}::uuid),
        'data_snapshots', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM data_snapshots r WHERE r.user_id = ${userId}::uuid),
        'recovery_runs', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM recovery_runs r WHERE r.user_id = ${userId}::uuid),
        'integrity_findings', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM integrity_findings r WHERE r.user_id = ${userId}::uuid)
      )
    ) AS payload
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) throw new Error("Database did not return a snapshot.");
  const parsed = parsePayload(row.payload);
  const payload = sanitizeSnapshotPrivacy(
    options.normalizeProgramDrafts === false
      ? parsed
      : normalizeSnapshotProgramDrafts(parsed),
    { retainCoachEvidenceIds: options.retainCoachEvidenceIds },
  );
  assertCanonicalSnapshotTableCoverage(payload.tables);
  return payload;
}

export function snapshotRecordCounts(
  payload: CanonicalSnapshotPayload
): SnapshotRecordCounts {
  const counts = Object.fromEntries(
    Object.entries(payload.tables).map(([table, rows]) => [table, rows.length])
  );
  return {
    ...counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
  } as SnapshotRecordCounts;
}
