import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  contextualNoteCreateInputSchema,
  contextualNoteEditInputSchema,
  type ContextualNoteAttachmentKind,
  type ContextualNoteCreateInput,
  type ContextualNoteEditInput,
  type ContextualNoteInputMode,
  type ContextualNoteCapturedContext,
  type ParsedContextualNoteCreateInput,
} from "@/lib/contextual-note-contract";
import { canonicalJson } from "@/services/snapshot-crypto";

export type ContextualNoteRecord = {
  id: string;
  userId: string;
  body: string;
  coachVisible: boolean;
  inputMode: ContextualNoteInputMode;
  attachmentKind: ContextualNoteAttachmentKind;
  sessionId: string | null;
  sessionExerciseId: string | null;
  occurrenceId: string | null;
  completedSetId: string | null;
  programId: string | null;
  programVersionId: string | null;
  workoutTemplateId: string | null;
  workoutTemplateExerciseId: string | null;
  capturedContext: ContextualNoteCapturedContext;
  revision: number;
  recordedAt: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type ContextualNoteMutationResult =
  | { outcome: "saved" | "replayed"; note: ContextualNoteRecord }
  | { outcome: "conflict" }
  | { outcome: "stale" }
  | { outcome: "not_found" };

type Anchors = {
  sessionId: string | null;
  sessionExerciseId: string | null;
  occurrenceId: string | null;
  completedSetId: string | null;
  programId: string | null;
  programVersionId: string | null;
  workoutTemplateId: string | null;
  workoutTemplateExerciseId: string | null;
};

function createHashFor(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function anchors(input: ParsedContextualNoteCreateInput): Anchors {
  return {
    sessionId: "sessionId" in input ? input.sessionId : null,
    sessionExerciseId:
      "sessionExerciseId" in input ? input.sessionExerciseId : null,
    occurrenceId: "occurrenceId" in input ? input.occurrenceId : null,
    completedSetId:
      "completedSetId" in input ? input.completedSetId ?? null : null,
    programId: "programId" in input ? input.programId : null,
    programVersionId:
      "programVersionId" in input ? input.programVersionId : null,
    workoutTemplateId:
      "workoutTemplateId" in input ? input.workoutTemplateId : null,
    workoutTemplateExerciseId:
      "workoutTemplateExerciseId" in input
        ? input.workoutTemplateExerciseId
        : null,
  };
}

function noteRecord(row: Record<string, unknown>): ContextualNoteRecord {
  const iso = (value: unknown) => new Date(value as Date | string).toISOString();
  const optional = (value: unknown) => (value == null ? null : String(value));
  return {
    id: String(row.id),
    userId: String(row.user_id),
    body: String(row.body),
    coachVisible: Boolean(row.coach_visible),
    inputMode: String(row.input_mode) as ContextualNoteInputMode,
    attachmentKind: String(row.attachment_kind) as ContextualNoteAttachmentKind,
    sessionId: optional(row.session_id),
    sessionExerciseId: optional(row.session_exercise_id),
    occurrenceId: optional(row.occurrence_id),
    completedSetId: optional(row.completed_set_id),
    programId: optional(row.program_id),
    programVersionId: optional(row.program_version_id),
    workoutTemplateId: optional(row.workout_template_id),
    workoutTemplateExerciseId: optional(row.workout_template_exercise_id),
    capturedContext: row.captured_context as ContextualNoteCapturedContext,
    revision: Number(row.revision),
    recordedAt: iso(row.recorded_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: row.archived_at == null ? null : iso(row.archived_at),
  };
}

async function replayCreate(
  db: Db,
  userId: string,
  clientKey: string,
  hash: string,
): Promise<ContextualNoteMutationResult | null> {
  const row = resultRows(await db.execute(sql`
    SELECT note.*, CASE WHEN note.creation_payload_hash = ${hash} THEN 'replayed' ELSE 'conflict' END AS mutation_outcome
    FROM contextual_notes note
    WHERE note.user_id = ${userId}::uuid AND note.client_key = ${clientKey}::uuid
    LIMIT 1
  `))[0];
  if (!row) return null;
  return row.mutation_outcome === "replayed"
    ? { outcome: "replayed", note: noteRecord(row) }
    : { outcome: "conflict" };
}

export async function createContextualNote(
  db: Db,
  userId: string,
  rawInput: ContextualNoteCreateInput,
): Promise<ContextualNoteMutationResult> {
  const input = contextualNoteCreateInputSchema.parse(rawInput);
  const anchor = anchors(input);
  const hash = createHashFor(input);
  const noteId = randomUUID();
  const revisionId = randomUUID();
  const contextJson = JSON.stringify(input.capturedContext);

  const row = resultRows(await db.execute(sql`
    WITH existing AS MATERIALIZED (
      SELECT * FROM contextual_notes
      WHERE user_id = ${userId}::uuid AND client_key = ${input.clientKey}::uuid
    ), valid_attachment AS MATERIALIZED (
      SELECT 1 AS valid WHERE
        (${input.attachmentKind} = 'general')
        OR (${input.attachmentKind} = 'workout' AND EXISTS (
          SELECT 1 FROM workout_sessions session WHERE session.id = ${anchor.sessionId}::uuid AND session.user_id = ${userId}::uuid
        ))
        OR (${input.attachmentKind} IN ('exercise', 'set', 'rest') AND EXISTS (
          SELECT 1 FROM session_exercises exercise JOIN workout_sessions session ON session.id = exercise.session_id
          WHERE exercise.id = ${anchor.sessionExerciseId}::uuid AND exercise.session_id = ${anchor.sessionId}::uuid AND session.user_id = ${userId}::uuid
        ) AND (${input.attachmentKind} = 'exercise' OR EXISTS (
          SELECT 1 FROM session_occurrences occurrence
          WHERE occurrence.id = ${anchor.occurrenceId}::uuid AND occurrence.session_id = ${anchor.sessionId}::uuid
            AND occurrence.session_exercise_id = ${anchor.sessionExerciseId}::uuid
            AND (
              (${input.attachmentKind} = 'set' AND ${anchor.completedSetId}::uuid IS NULL)
              OR (${input.attachmentKind} IN ('set', 'rest') AND ${anchor.completedSetId}::uuid IS NOT NULL AND EXISTS (
                SELECT 1 FROM completed_sets completed WHERE completed.id = ${anchor.completedSetId}::uuid
                  AND completed.session_exercise_id = ${anchor.sessionExerciseId}::uuid
                  AND occurrence.completed_set_id = completed.id
              ))
            )
        )))
        OR (${input.attachmentKind} = 'occurrence' AND EXISTS (
          SELECT 1 FROM session_occurrences occurrence JOIN workout_sessions session ON session.id = occurrence.session_id
          WHERE occurrence.id = ${anchor.occurrenceId}::uuid AND occurrence.session_id = ${anchor.sessionId}::uuid AND session.user_id = ${userId}::uuid
        ))
        OR (${input.attachmentKind} IN ('program', 'program_day', 'program_item') AND EXISTS (
          SELECT 1 FROM program_versions version JOIN programs program ON program.id = version.program_id
          WHERE program.id = ${anchor.programId}::uuid AND program.user_id = ${userId}::uuid AND version.id = ${anchor.programVersionId}::uuid
            AND (${input.attachmentKind} = 'program' OR EXISTS (
              SELECT 1 FROM workout_templates template WHERE template.id = ${anchor.workoutTemplateId}::uuid
                AND template.program_version_id = version.id
                AND (${input.attachmentKind} = 'program_day' OR EXISTS (
                  SELECT 1 FROM workout_template_exercises item WHERE item.id = ${anchor.workoutTemplateExerciseId}::uuid
                    AND item.workout_template_id = template.id
                ))
            ))
        ))
    ), inserted AS (
      INSERT INTO contextual_notes (
        id, user_id, client_key, creation_payload_hash, body, coach_visible,
        input_mode, attachment_kind, session_id, session_exercise_id,
        occurrence_id, completed_set_id, program_id, program_version_id,
        workout_template_id, workout_template_exercise_id, captured_context,
        revision, recorded_at
      )
      SELECT ${noteId}::uuid, ${userId}::uuid, ${input.clientKey}::uuid, ${hash},
        ${input.body}, ${input.coachVisible}, ${input.inputMode}, ${input.attachmentKind},
        ${anchor.sessionId}::uuid, ${anchor.sessionExerciseId}::uuid,
        ${anchor.occurrenceId}::uuid, ${anchor.completedSetId}::uuid,
        ${anchor.programId}::uuid, ${anchor.programVersionId}::uuid,
        ${anchor.workoutTemplateId}::uuid, ${anchor.workoutTemplateExerciseId}::uuid,
        ${contextJson}::jsonb, 1, ${input.recordedAt}::timestamptz
      FROM valid_attachment WHERE NOT EXISTS (SELECT 1 FROM existing)
      ON CONFLICT (user_id, client_key) DO NOTHING
      RETURNING *
    ), saved_revision AS (
      INSERT INTO contextual_note_revisions (
        id, note_id, user_id, revision, client_key, canonical_payload_hash,
        body, coach_visible, input_mode
      )
      SELECT ${revisionId}::uuid, inserted.id, inserted.user_id, 1,
        inserted.client_key, inserted.creation_payload_hash, inserted.body,
        inserted.coach_visible, inserted.input_mode
      FROM inserted RETURNING note_id
    ), selected AS (
      SELECT inserted.*, 'saved'::text AS mutation_outcome FROM inserted
      UNION ALL
      SELECT existing.*, CASE WHEN existing.creation_payload_hash = ${hash} THEN 'replayed' ELSE 'conflict' END
      FROM existing
      LIMIT 1
    )
    SELECT * FROM selected
  `))[0];

  if (!row) {
    return (await replayCreate(db, userId, input.clientKey, hash)) ?? {
      outcome: "not_found",
    };
  }
  if (row.mutation_outcome === "conflict") return { outcome: "conflict" };
  return {
    outcome: row.mutation_outcome === "saved" ? "saved" : "replayed",
    note: noteRecord(row),
  };
}

async function replayEdit(
  db: Db,
  userId: string,
  clientKey: string,
  hash: string,
): Promise<ContextualNoteMutationResult | null> {
  const row = resultRows(await db.execute(sql`
    SELECT note.*, CASE WHEN revision.canonical_payload_hash = ${hash} THEN 'replayed' ELSE 'conflict' END AS mutation_outcome
    FROM contextual_note_revisions revision
    JOIN contextual_notes note ON note.id = revision.note_id AND note.user_id = revision.user_id
    WHERE revision.user_id = ${userId}::uuid AND revision.client_key = ${clientKey}::uuid
    LIMIT 1
  `))[0];
  if (!row) return null;
  return row.mutation_outcome === "replayed"
    ? { outcome: "replayed", note: noteRecord(row) }
    : { outcome: "conflict" };
}

export async function editContextualNote(
  db: Db,
  userId: string,
  rawInput: ContextualNoteEditInput,
): Promise<ContextualNoteMutationResult> {
  const input = contextualNoteEditInputSchema.parse(rawInput);
  const hash = createHashFor(input);
  const revisionId = randomUUID();
  const row = resultRows(await db.execute(sql`
    WITH visible AS MATERIALIZED (
      SELECT * FROM contextual_notes WHERE id = ${input.noteId}::uuid AND user_id = ${userId}::uuid
    ), existing AS MATERIALIZED (
      SELECT * FROM contextual_note_revisions
      WHERE user_id = ${userId}::uuid AND client_key = ${input.clientKey}::uuid
    ), updated AS (
      UPDATE contextual_notes note SET
        body = ${input.body}, coach_visible = ${input.coachVisible},
        input_mode = ${input.inputMode}, revision = note.revision + 1, updated_at = now()
      FROM visible
      WHERE note.id = visible.id AND note.revision = ${input.expectedRevision}
        AND note.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM existing)
      RETURNING note.*
    ), saved_revision AS (
      INSERT INTO contextual_note_revisions (
        id, note_id, user_id, revision, client_key, canonical_payload_hash,
        body, coach_visible, input_mode
      )
      SELECT ${revisionId}::uuid, updated.id, updated.user_id, updated.revision,
        ${input.clientKey}::uuid, ${hash}, updated.body, updated.coach_visible,
        updated.input_mode FROM updated RETURNING note_id
    ), selected AS (
      SELECT updated.*, 'saved'::text AS mutation_outcome FROM updated
      UNION ALL
      SELECT note.*, CASE WHEN existing.canonical_payload_hash = ${hash} AND existing.note_id = note.id THEN 'replayed' ELSE 'conflict' END
      FROM existing JOIN contextual_notes note ON note.id = existing.note_id AND note.user_id = existing.user_id
      LIMIT 1
    )
    SELECT CASE
      WHEN selected.mutation_outcome IS NOT NULL THEN selected.mutation_outcome
      WHEN NOT EXISTS (SELECT 1 FROM visible) THEN 'not_found'
      WHEN EXISTS (SELECT 1 FROM visible WHERE archived_at IS NOT NULL) THEN 'not_found'
      ELSE 'stale'
    END AS outcome, selected.*
    FROM (SELECT 1) anchor LEFT JOIN selected ON true
  `))[0];

  if (!row) throw new Error("The contextual note edit returned no outcome.");
  if (row.outcome === "saved" || row.outcome === "replayed") {
    return { outcome: row.outcome, note: noteRecord(row) };
  }
  if (row.outcome === "stale") {
    return (await replayEdit(db, userId, input.clientKey, hash)) ?? {
      outcome: "stale",
    };
  }
  return { outcome: row.outcome === "conflict" ? "conflict" : "not_found" };
}

export type ContextualNoteQuery = {
  sessionId?: string;
  sessionExerciseId?: string;
  occurrenceId?: string;
  programId?: string;
  attachmentKind?: ContextualNoteAttachmentKind;
  coachVisibleOnly?: boolean;
  includeArchived?: boolean;
  limit?: number;
  before?: { recordedAt: string; id: string };
};

export async function listContextualNotes(
  db: Db,
  userId: string,
  query: ContextualNoteQuery = {},
): Promise<ContextualNoteRecord[]> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 250);
  const beforeRecordedAt = query.before?.recordedAt ?? null;
  const beforeId = query.before?.id ?? null;
  const rows = resultRows(await db.execute(sql`
    SELECT note.* FROM contextual_notes note
    WHERE note.user_id = ${userId}::uuid
      AND (${query.includeArchived ?? false} OR note.archived_at IS NULL)
      AND (NOT ${query.coachVisibleOnly ?? false} OR note.coach_visible)
      AND (${query.sessionId ?? null}::uuid IS NULL OR note.session_id = ${query.sessionId ?? null}::uuid)
      AND (${query.sessionExerciseId ?? null}::uuid IS NULL OR note.session_exercise_id = ${query.sessionExerciseId ?? null}::uuid)
      AND (${query.occurrenceId ?? null}::uuid IS NULL OR note.occurrence_id = ${query.occurrenceId ?? null}::uuid)
      AND (${query.programId ?? null}::uuid IS NULL OR note.program_id = ${query.programId ?? null}::uuid)
      AND (${query.attachmentKind ?? null}::text IS NULL OR note.attachment_kind = ${query.attachmentKind ?? null})
      AND (
        ${beforeRecordedAt}::timestamptz IS NULL OR
        (note.recorded_at, note.id) < (${beforeRecordedAt}::timestamptz, ${beforeId}::uuid)
      )
    ORDER BY note.recorded_at DESC, note.id DESC
    LIMIT ${limit}
  `));
  return rows.map(noteRecord);
}

export type ArchiveContextualNoteResult =
  | { outcome: "archived"; operationId: string }
  | { outcome: "stale" }
  | { outcome: "not_found" };

/**
 * Archives one owned note without deleting its body, captured context, or
 * revision history. The operation/member pair is the durable Undo identity.
 */
export async function archiveContextualNote(
  db: Db,
  userId: string,
  input: { noteId: string; expectedRevision: number },
): Promise<ArchiveContextualNoteResult> {
  const noteId = contextualNoteEditInputSchema.shape.noteId.parse(input.noteId);
  const expectedRevision = contextualNoteEditInputSchema.shape.expectedRevision.parse(
    input.expectedRevision,
  );
  const operationId = randomUUID();
  const memberId = randomUUID();
  const row = resultRows(await db.execute(sql`
    WITH visible AS MATERIALIZED (
      SELECT note.id, note.revision, note.archived_at,
        (SELECT count(*)::int FROM contextual_note_revisions note_revision WHERE note_revision.note_id = note.id) AS revision_count
      FROM contextual_notes note
      WHERE note.id = ${noteId}::uuid AND note.user_id = ${userId}::uuid
      FOR UPDATE
    ), eligible AS MATERIALIZED (
      SELECT * FROM visible WHERE revision = ${expectedRevision} AND archived_at IS NULL
    ), new_operation AS (
      INSERT INTO archive_operations (
        id, user_id, action, status, summary, record_counts
      )
      SELECT ${operationId}::uuid, ${userId}::uuid, 'contextual_note', 'active',
        'Archived one training observation.',
        jsonb_build_object('contextualNotes', 1, 'contextualNoteRevisions', eligible.revision_count)
      FROM eligible RETURNING id
    ), archived AS (
      UPDATE contextual_notes note SET
        archived_at = now(), archive_operation_id = new_operation.id,
        updated_at = now()
      FROM new_operation
      WHERE note.id = ${noteId}::uuid AND note.user_id = ${userId}::uuid
        AND note.revision = ${expectedRevision} AND note.archived_at IS NULL
      RETURNING note.id, new_operation.id AS operation_id
    ), member AS (
      INSERT INTO archive_operation_records (
        id, operation_id, user_id, entity_type, entity_id, relationship_role
      )
      SELECT ${memberId}::uuid, archived.operation_id, ${userId}::uuid,
        'contextual_note', archived.id::text, 'root'
      FROM archived RETURNING operation_id
    )
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM member) THEN 'archived'
      WHEN NOT EXISTS (SELECT 1 FROM visible) OR EXISTS (SELECT 1 FROM visible WHERE archived_at IS NOT NULL) THEN 'not_found'
      ELSE 'stale'
    END AS outcome,
    (SELECT operation_id FROM member LIMIT 1) AS operation_id
  `))[0];
  if (!row) throw new Error("The contextual note archive returned no outcome.");
  if (row.outcome === "archived") {
    return { outcome: "archived", operationId: String(row.operation_id) };
  }
  return { outcome: row.outcome === "stale" ? "stale" : "not_found" };
}
