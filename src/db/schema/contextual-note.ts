import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ContextualNoteCapturedContext } from "@/lib/contextual-note-contract";
import { archiveOperations } from "./archive";
import { programs, programVersions, workoutTemplateExercises, workoutTemplates } from "./program";
import { completedSets, sessionExercises, sessionOccurrences, workoutSessions } from "./session";
import { users } from "./user";

export const contextualNotes = pgTable(
  "contextual_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientKey: uuid("client_key").notNull(),
    creationPayloadHash: text("creation_payload_hash").notNull(),
    body: text("body").notNull(),
    coachVisible: boolean("coach_visible").notNull().default(true),
    inputMode: text("input_mode").notNull(),
    attachmentKind: text("attachment_kind").notNull(),
    sessionId: uuid("session_id").references(() => workoutSessions.id, {
      onDelete: "cascade",
    }),
    sessionExerciseId: uuid("session_exercise_id").references(
      () => sessionExercises.id,
      { onDelete: "cascade" },
    ),
    occurrenceId: uuid("occurrence_id").references(() => sessionOccurrences.id, {
      onDelete: "cascade",
    }),
    completedSetId: uuid("completed_set_id").references(() => completedSets.id, {
      onDelete: "cascade",
    }),
    programId: uuid("program_id").references(() => programs.id, {
      onDelete: "cascade",
    }),
    programVersionId: uuid("program_version_id").references(
      () => programVersions.id,
      { onDelete: "cascade" },
    ),
    workoutTemplateId: uuid("workout_template_id").references(
      () => workoutTemplates.id,
      { onDelete: "cascade" },
    ),
    workoutTemplateExerciseId: uuid("workout_template_exercise_id").references(
      () => workoutTemplateExercises.id,
      { onDelete: "cascade" },
    ),
    capturedContext: jsonb("captured_context")
      .$type<ContextualNoteCapturedContext>()
      .notNull(),
    revision: integer("revision").notNull().default(1),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveOperationId: uuid("archive_operation_id").references(
      () => archiveOperations.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    uniqueIndex("contextual_notes_user_client_uq").on(t.userId, t.clientKey),
    uniqueIndex("contextual_notes_id_user_uq").on(t.id, t.userId),
    index("contextual_notes_user_recorded_idx").on(t.userId, t.recordedAt),
    index("contextual_notes_session_recorded_idx").on(t.sessionId, t.recordedAt),
    index("contextual_notes_program_recorded_idx").on(t.programId, t.recordedAt),
    index("contextual_notes_archive_operation_idx").on(t.archiveOperationId),
    check(
      "contextual_notes_hash_valid",
      sql`${t.creationPayloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("contextual_notes_body_valid", sql`length(btrim(${t.body})) BETWEEN 1 AND 5000`),
    check(
      "contextual_notes_input_mode_valid",
      sql`${t.inputMode} IN ('typed', 'reviewed_dictation')`,
    ),
    check(
      "contextual_notes_attachment_kind_valid",
      sql`${t.attachmentKind} IN ('general', 'workout', 'exercise', 'occurrence', 'set', 'rest', 'program', 'program_day', 'program_item')`,
    ),
    check(
      "contextual_notes_attachment_shape_valid",
      sql`
        (${t.attachmentKind} = 'general' AND num_nonnulls(${t.sessionId}, ${t.sessionExerciseId}, ${t.occurrenceId}, ${t.completedSetId}, ${t.programId}, ${t.programVersionId}, ${t.workoutTemplateId}, ${t.workoutTemplateExerciseId}) = 0)
        OR (${t.attachmentKind} = 'workout' AND ${t.sessionId} IS NOT NULL AND num_nonnulls(${t.sessionExerciseId}, ${t.occurrenceId}, ${t.completedSetId}, ${t.programId}, ${t.programVersionId}, ${t.workoutTemplateId}, ${t.workoutTemplateExerciseId}) = 0)
        OR (${t.attachmentKind} = 'exercise' AND ${t.sessionId} IS NOT NULL AND ${t.sessionExerciseId} IS NOT NULL AND num_nonnulls(${t.occurrenceId}, ${t.completedSetId}, ${t.programId}, ${t.programVersionId}, ${t.workoutTemplateId}, ${t.workoutTemplateExerciseId}) = 0)
        OR (${t.attachmentKind} = 'occurrence' AND ${t.sessionId} IS NOT NULL AND ${t.occurrenceId} IS NOT NULL AND num_nonnulls(${t.completedSetId}, ${t.programId}, ${t.programVersionId}, ${t.workoutTemplateId}, ${t.workoutTemplateExerciseId}) = 0)
        OR (${t.attachmentKind} = 'set' AND ${t.sessionId} IS NOT NULL AND ${t.sessionExerciseId} IS NOT NULL AND ${t.occurrenceId} IS NOT NULL AND num_nonnulls(${t.programId}, ${t.programVersionId}, ${t.workoutTemplateId}, ${t.workoutTemplateExerciseId}) = 0)
        OR (${t.attachmentKind} = 'rest' AND ${t.sessionId} IS NOT NULL AND ${t.sessionExerciseId} IS NOT NULL AND ${t.occurrenceId} IS NOT NULL AND ${t.completedSetId} IS NOT NULL AND num_nonnulls(${t.programId}, ${t.programVersionId}, ${t.workoutTemplateId}, ${t.workoutTemplateExerciseId}) = 0)
        OR (${t.attachmentKind} = 'program' AND ${t.programId} IS NOT NULL AND ${t.programVersionId} IS NOT NULL AND num_nonnulls(${t.sessionId}, ${t.sessionExerciseId}, ${t.occurrenceId}, ${t.completedSetId}, ${t.workoutTemplateId}, ${t.workoutTemplateExerciseId}) = 0)
        OR (${t.attachmentKind} = 'program_day' AND ${t.programId} IS NOT NULL AND ${t.programVersionId} IS NOT NULL AND ${t.workoutTemplateId} IS NOT NULL AND num_nonnulls(${t.sessionId}, ${t.sessionExerciseId}, ${t.occurrenceId}, ${t.completedSetId}, ${t.workoutTemplateExerciseId}) = 0)
        OR (${t.attachmentKind} = 'program_item' AND ${t.programId} IS NOT NULL AND ${t.programVersionId} IS NOT NULL AND ${t.workoutTemplateId} IS NOT NULL AND ${t.workoutTemplateExerciseId} IS NOT NULL AND num_nonnulls(${t.sessionId}, ${t.sessionExerciseId}, ${t.occurrenceId}, ${t.completedSetId}) = 0)
      `,
    ),
    check(
      "contextual_notes_context_valid",
      sql`jsonb_typeof(${t.capturedContext}) = 'object' AND (${t.capturedContext}->>'schemaVersion') = '1'`,
    ),
    check("contextual_notes_revision_valid", sql`${t.revision} >= 1`),
    check(
      "contextual_notes_archive_pair_valid",
      sql`(${t.archivedAt} IS NULL AND ${t.archiveOperationId} IS NULL) OR (${t.archivedAt} IS NOT NULL AND ${t.archiveOperationId} IS NOT NULL)`,
    ),
  ],
);

export const contextualNoteRevisions = pgTable(
  "contextual_note_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    clientKey: uuid("client_key").notNull(),
    canonicalPayloadHash: text("canonical_payload_hash").notNull(),
    body: text("body").notNull(),
    coachVisible: boolean("coach_visible").notNull(),
    inputMode: text("input_mode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("contextual_note_revisions_note_revision_uq").on(t.noteId, t.revision),
    uniqueIndex("contextual_note_revisions_user_client_uq").on(t.userId, t.clientKey),
    index("contextual_note_revisions_note_created_idx").on(t.noteId, t.createdAt),
    foreignKey({
      name: "contextual_note_revisions_note_owner_fk",
      columns: [t.noteId, t.userId],
      foreignColumns: [contextualNotes.id, contextualNotes.userId],
    }).onDelete("cascade"),
    check("contextual_note_revisions_revision_valid", sql`${t.revision} >= 1`),
    check(
      "contextual_note_revisions_hash_valid",
      sql`${t.canonicalPayloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("contextual_note_revisions_body_valid", sql`length(btrim(${t.body})) BETWEEN 1 AND 5000`),
    check(
      "contextual_note_revisions_input_mode_valid",
      sql`${t.inputMode} IN ('typed', 'reviewed_dictation')`,
    ),
  ],
);
