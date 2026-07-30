-- Universal user-observation notes are additive. Existing session_notes keep
-- their released workout-only meaning and no existing row is reclassified.

CREATE TABLE "contextual_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "client_key" uuid NOT NULL,
  "creation_payload_hash" text NOT NULL,
  "body" text NOT NULL,
  "coach_visible" boolean DEFAULT true NOT NULL,
  "input_mode" text NOT NULL,
  "attachment_kind" text NOT NULL,
  "session_id" uuid,
  "session_exercise_id" uuid,
  "occurrence_id" uuid,
  "completed_set_id" uuid,
  "program_id" uuid,
  "program_version_id" uuid,
  "workout_template_id" uuid,
  "workout_template_exercise_id" uuid,
  "captured_context" jsonb NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  "archive_operation_id" uuid,
  CONSTRAINT "contextual_notes_hash_valid" CHECK ("creation_payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "contextual_notes_body_valid" CHECK (length(btrim("body")) BETWEEN 1 AND 5000),
  CONSTRAINT "contextual_notes_input_mode_valid" CHECK ("input_mode" IN ('typed', 'reviewed_dictation')),
  CONSTRAINT "contextual_notes_attachment_kind_valid" CHECK ("attachment_kind" IN ('general', 'workout', 'exercise', 'occurrence', 'set', 'rest', 'program', 'program_day', 'program_item')),
  CONSTRAINT "contextual_notes_attachment_shape_valid" CHECK (
    ("attachment_kind" = 'general' AND num_nonnulls("session_id", "session_exercise_id", "occurrence_id", "completed_set_id", "program_id", "program_version_id", "workout_template_id", "workout_template_exercise_id") = 0)
    OR ("attachment_kind" = 'workout' AND "session_id" IS NOT NULL AND num_nonnulls("session_exercise_id", "occurrence_id", "completed_set_id", "program_id", "program_version_id", "workout_template_id", "workout_template_exercise_id") = 0)
    OR ("attachment_kind" = 'exercise' AND "session_id" IS NOT NULL AND "session_exercise_id" IS NOT NULL AND num_nonnulls("occurrence_id", "completed_set_id", "program_id", "program_version_id", "workout_template_id", "workout_template_exercise_id") = 0)
    OR ("attachment_kind" = 'occurrence' AND "session_id" IS NOT NULL AND "occurrence_id" IS NOT NULL AND num_nonnulls("completed_set_id", "program_id", "program_version_id", "workout_template_id", "workout_template_exercise_id") = 0)
    OR ("attachment_kind" = 'set' AND "session_id" IS NOT NULL AND "session_exercise_id" IS NOT NULL AND "occurrence_id" IS NOT NULL AND num_nonnulls("program_id", "program_version_id", "workout_template_id", "workout_template_exercise_id") = 0)
    OR ("attachment_kind" = 'rest' AND "session_id" IS NOT NULL AND "session_exercise_id" IS NOT NULL AND "occurrence_id" IS NOT NULL AND "completed_set_id" IS NOT NULL AND num_nonnulls("program_id", "program_version_id", "workout_template_id", "workout_template_exercise_id") = 0)
    OR ("attachment_kind" = 'program' AND "program_id" IS NOT NULL AND "program_version_id" IS NOT NULL AND num_nonnulls("session_id", "session_exercise_id", "occurrence_id", "completed_set_id", "workout_template_id", "workout_template_exercise_id") = 0)
    OR ("attachment_kind" = 'program_day' AND "program_id" IS NOT NULL AND "program_version_id" IS NOT NULL AND "workout_template_id" IS NOT NULL AND num_nonnulls("session_id", "session_exercise_id", "occurrence_id", "completed_set_id", "workout_template_exercise_id") = 0)
    OR ("attachment_kind" = 'program_item' AND "program_id" IS NOT NULL AND "program_version_id" IS NOT NULL AND "workout_template_id" IS NOT NULL AND "workout_template_exercise_id" IS NOT NULL AND num_nonnulls("session_id", "session_exercise_id", "occurrence_id", "completed_set_id") = 0)
  ),
  CONSTRAINT "contextual_notes_context_valid" CHECK (jsonb_typeof("captured_context") = 'object' AND "captured_context"->>'schemaVersion' = '1'),
  CONSTRAINT "contextual_notes_revision_valid" CHECK ("revision" >= 1),
  CONSTRAINT "contextual_notes_archive_pair_valid" CHECK (("archived_at" IS NULL AND "archive_operation_id" IS NULL) OR ("archived_at" IS NOT NULL AND "archive_operation_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "contextual_note_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "note_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "client_key" uuid NOT NULL,
  "canonical_payload_hash" text NOT NULL,
  "body" text NOT NULL,
  "coach_visible" boolean NOT NULL,
  "input_mode" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contextual_note_revisions_revision_valid" CHECK ("revision" >= 1),
  CONSTRAINT "contextual_note_revisions_hash_valid" CHECK ("canonical_payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "contextual_note_revisions_body_valid" CHECK (length(btrim("body")) BETWEEN 1 AND 5000),
  CONSTRAINT "contextual_note_revisions_input_mode_valid" CHECK ("input_mode" IN ('typed', 'reviewed_dictation'))
);
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_session_exercise_id_session_exercises_id_fk" FOREIGN KEY ("session_exercise_id") REFERENCES "public"."session_exercises"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_occurrence_id_session_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."session_occurrences"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_completed_set_id_completed_sets_id_fk" FOREIGN KEY ("completed_set_id") REFERENCES "public"."completed_sets"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_program_version_id_program_versions_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."program_versions"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_workout_template_id_workout_templates_id_fk" FOREIGN KEY ("workout_template_id") REFERENCES "public"."workout_templates"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_workout_template_exercise_id_workout_template_exercises_id_fk" FOREIGN KEY ("workout_template_exercise_id") REFERENCES "public"."workout_template_exercises"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "contextual_notes" ADD CONSTRAINT "contextual_notes_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "contextual_note_revisions" ADD CONSTRAINT "contextual_note_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "contextual_notes_user_client_uq" ON "contextual_notes" ("user_id", "client_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "contextual_notes_id_user_uq" ON "contextual_notes" ("id", "user_id");
--> statement-breakpoint
CREATE INDEX "contextual_notes_user_recorded_idx" ON "contextual_notes" ("user_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX "contextual_notes_session_recorded_idx" ON "contextual_notes" ("session_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX "contextual_notes_program_recorded_idx" ON "contextual_notes" ("program_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX "contextual_notes_archive_operation_idx" ON "contextual_notes" ("archive_operation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "contextual_note_revisions_note_revision_uq" ON "contextual_note_revisions" ("note_id", "revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "contextual_note_revisions_user_client_uq" ON "contextual_note_revisions" ("user_id", "client_key");
--> statement-breakpoint
CREATE INDEX "contextual_note_revisions_note_created_idx" ON "contextual_note_revisions" ("note_id", "created_at");
--> statement-breakpoint
ALTER TABLE "contextual_note_revisions" ADD CONSTRAINT "contextual_note_revisions_note_owner_fk" FOREIGN KEY ("note_id", "user_id") REFERENCES "public"."contextual_notes"("id", "user_id") ON DELETE cascade;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_contextual_note_attachment()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workout_sessions session WHERE session.id = NEW.session_id AND session.user_id = NEW.user_id
  ) THEN RAISE EXCEPTION 'Contextual note workout is unavailable.' USING ERRCODE = '23503'; END IF;
  IF NEW.session_exercise_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM session_exercises exercise WHERE exercise.id = NEW.session_exercise_id AND exercise.session_id = NEW.session_id
  ) THEN RAISE EXCEPTION 'Contextual note exercise does not belong to its workout.' USING ERRCODE = '23503'; END IF;
  IF NEW.occurrence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM session_occurrences occurrence
    WHERE occurrence.id = NEW.occurrence_id AND occurrence.session_id = NEW.session_id
      AND (NEW.session_exercise_id IS NULL OR occurrence.session_exercise_id = NEW.session_exercise_id)
  ) THEN RAISE EXCEPTION 'Contextual note occurrence does not belong to its workout context.' USING ERRCODE = '23503'; END IF;
  IF NEW.completed_set_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM completed_sets completed
    WHERE completed.id = NEW.completed_set_id AND completed.session_exercise_id = NEW.session_exercise_id
      AND EXISTS (
        SELECT 1 FROM session_occurrences occurrence
        WHERE occurrence.id = NEW.occurrence_id
          AND occurrence.completed_set_id = completed.id
      )
  ) THEN RAISE EXCEPTION 'Contextual note result does not belong to its exercise.' USING ERRCODE = '23503'; END IF;
  IF NEW.program_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM programs program WHERE program.id = NEW.program_id AND program.user_id = NEW.user_id
  ) THEN RAISE EXCEPTION 'Contextual note Program is unavailable.' USING ERRCODE = '23503'; END IF;
  IF NEW.program_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM program_versions version WHERE version.id = NEW.program_version_id AND version.program_id = NEW.program_id
  ) THEN RAISE EXCEPTION 'Contextual note Program version does not belong to its Program.' USING ERRCODE = '23503'; END IF;
  IF NEW.workout_template_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workout_templates template WHERE template.id = NEW.workout_template_id AND template.program_version_id = NEW.program_version_id
  ) THEN RAISE EXCEPTION 'Contextual note Program day does not belong to its version.' USING ERRCODE = '23503'; END IF;
  IF NEW.workout_template_exercise_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workout_template_exercises item WHERE item.id = NEW.workout_template_exercise_id AND item.workout_template_id = NEW.workout_template_id
  ) THEN RAISE EXCEPTION 'Contextual note Program item does not belong to its day.' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER contextual_notes_attachment_guard
BEFORE INSERT OR UPDATE ON contextual_notes
FOR EACH ROW EXECUTE FUNCTION validate_contextual_note_attachment();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_contextual_note_capture()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '') = 'snapshot_restore' THEN RETURN NEW; END IF;
  IF ROW(OLD.id, OLD.user_id, OLD.client_key, OLD.creation_payload_hash,
         OLD.attachment_kind, OLD.session_id, OLD.session_exercise_id, OLD.occurrence_id,
         OLD.completed_set_id, OLD.program_id, OLD.program_version_id, OLD.workout_template_id,
         OLD.workout_template_exercise_id, OLD.captured_context, OLD.recorded_at, OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.id, NEW.user_id, NEW.client_key, NEW.creation_payload_hash,
         NEW.attachment_kind, NEW.session_id, NEW.session_exercise_id, NEW.occurrence_id,
         NEW.completed_set_id, NEW.program_id, NEW.program_version_id, NEW.workout_template_id,
         NEW.workout_template_exercise_id, NEW.captured_context, NEW.recorded_at, NEW.created_at)
  THEN RAISE EXCEPTION 'Contextual note captured context is immutable.' USING ERRCODE = '55000'; END IF;
  IF ROW(OLD.body, OLD.coach_visible, OLD.input_mode) IS DISTINCT FROM ROW(NEW.body, NEW.coach_visible, NEW.input_mode) THEN
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'Contextual note edits must advance exactly one revision.' USING ERRCODE = '40001';
    END IF;
  ELSIF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'Contextual note revision cannot change without an edit.' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER contextual_notes_capture_guard
BEFORE UPDATE ON contextual_notes
FOR EACH ROW EXECUTE FUNCTION protect_contextual_note_capture();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION verify_contextual_note_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM contextual_note_revisions AS stored_revision
    WHERE stored_revision.note_id = NEW.id AND stored_revision.user_id = NEW.user_id
      AND stored_revision.revision = NEW.revision AND stored_revision.body = NEW.body
      AND stored_revision.coach_visible = NEW.coach_visible AND stored_revision.input_mode = NEW.input_mode
  ) THEN RAISE EXCEPTION 'Contextual note revision evidence is missing.' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER contextual_notes_revision_guard
AFTER INSERT OR UPDATE ON contextual_notes DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_contextual_note_revision();
--> statement-breakpoint

ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_without_contextual_notes;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid, p_scope text, p_expected_current jsonb, p_target_rows jsonb,
  p_dependency_rows jsonb, p_source_snapshot_id uuid, p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_notes jsonb := COALESCE(p_target_rows->'contextual_notes', '[]'::jsonb);
  v_revisions jsonb := COALESCE(p_target_rows->'contextual_note_revisions', '[]'::jsonb);
  v_current jsonb;
  v_expected jsonb;
  v_result jsonb;
  v_added integer := 0;
  v_count integer;
BEGIN
  PERFORM set_config('workout_tracker.authorized_delete', 'snapshot_restore', true);
  SELECT COALESCE(jsonb_agg(to_jsonb(note) ORDER BY note.id), '[]'::jsonb) INTO v_current
  FROM contextual_notes note WHERE note.user_id = p_user_id AND (p_scope = 'full' OR note.session_id IS NOT NULL);
  v_expected := COALESCE(p_expected_current->'contextual_notes', '[]'::jsonb);
  IF v_current IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Restore preview is stale for table contextual_notes.' USING ERRCODE = '40001'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(stored_revision) ORDER BY stored_revision.note_id, stored_revision.revision, stored_revision.id), '[]'::jsonb) INTO v_current
  FROM contextual_note_revisions AS stored_revision JOIN contextual_notes note ON note.id = stored_revision.note_id
  WHERE note.user_id = p_user_id AND (p_scope = 'full' OR note.session_id IS NOT NULL);
  v_expected := COALESCE(p_expected_current->'contextual_note_revisions', '[]'::jsonb);
  IF v_current IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Restore preview is stale for table contextual_note_revisions.' USING ERRCODE = '40001'; END IF;

  DELETE FROM contextual_note_revisions AS stored_revision USING contextual_notes note
  WHERE stored_revision.note_id = note.id AND note.user_id = p_user_id AND (p_scope = 'full' OR note.session_id IS NOT NULL);
  DELETE FROM contextual_notes note WHERE note.user_id = p_user_id AND (p_scope = 'full' OR note.session_id IS NOT NULL);

  v_result := restore_user_snapshot_without_contextual_notes(
    p_user_id, p_scope,
    p_expected_current - 'contextual_notes' - 'contextual_note_revisions',
    p_target_rows - 'contextual_notes' - 'contextual_note_revisions',
    p_dependency_rows - 'contextual_notes' - 'contextual_note_revisions',
    p_source_snapshot_id, p_safety_snapshot_id, p_fail_after_table
  );
  IF jsonb_array_length(v_notes) > 0 THEN INSERT INTO contextual_notes SELECT source.* FROM jsonb_populate_recordset(NULL::contextual_notes, v_notes) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;
  IF jsonb_array_length(v_revisions) > 0 THEN INSERT INTO contextual_note_revisions SELECT source.* FROM jsonb_populate_recordset(NULL::contextual_note_revisions, v_revisions) source; GET DIAGNOSTICS v_count = ROW_COUNT; v_added := v_added + v_count; END IF;
  IF p_fail_after_table IN ('contextual_notes', 'contextual_note_revisions') THEN RAISE EXCEPTION 'Injected restore failure after %.', p_fail_after_table; END IF;
  RETURN jsonb_set(v_result, '{restoredRecords}', to_jsonb(COALESCE((v_result->>'restoredRecords')::integer, 0) + v_added));
END;
$$;
--> statement-breakpoint

ALTER FUNCTION permanent_delete_archive_preview(uuid, uuid)
  RENAME TO permanent_delete_archive_preview_without_contextual_notes;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanent_delete_archive_preview(p_user_id uuid, p_operation_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
WITH base AS (
  SELECT permanent_delete_archive_preview_without_contextual_notes(p_user_id, p_operation_id) AS preview
), counts AS (
  SELECT
    (SELECT count(*)::integer FROM contextual_notes note WHERE note.user_id = p_user_id AND note.archive_operation_id = p_operation_id) AS notes,
    (SELECT count(*)::integer FROM contextual_note_revisions AS stored_revision JOIN contextual_notes note ON note.id = stored_revision.note_id WHERE note.user_id = p_user_id AND note.archive_operation_id = p_operation_id) AS revisions
)
SELECT CASE WHEN base.preview IS NULL THEN NULL ELSE
  jsonb_set(jsonb_set(base.preview, '{deleteCounts,contextualNotes}', to_jsonb(counts.notes), true), '{deleteCounts,contextualNoteRevisions}', to_jsonb(counts.revisions), true)
END FROM base CROSS JOIN counts;
$$;
--> statement-breakpoint

ALTER FUNCTION permanently_delete_archive_operation(uuid, uuid, text, text, uuid, text)
  RENAME TO permanently_delete_archive_operation_without_contextual_notes;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanently_delete_archive_operation(
  p_user_id uuid, p_operation_id uuid, p_token_hash text, p_confirmation text,
  p_safety_snapshot_id uuid, p_fail_after_step text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_result jsonb;
  v_note_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(note.id), ARRAY[]::uuid[]) INTO v_note_ids
  FROM contextual_notes note
  WHERE note.user_id = p_user_id AND note.archive_operation_id = p_operation_id;
  v_result := permanently_delete_archive_operation_without_contextual_notes(
    p_user_id, p_operation_id, p_token_hash, p_confirmation, p_safety_snapshot_id, p_fail_after_step
  );
  DELETE FROM contextual_note_revisions AS stored_revision
  WHERE stored_revision.user_id = p_user_id AND stored_revision.note_id = ANY(v_note_ids);
  DELETE FROM contextual_notes note WHERE note.user_id = p_user_id AND note.id = ANY(v_note_ids);
  IF EXISTS (SELECT 1 FROM contextual_notes note WHERE note.user_id = p_user_id AND note.id = ANY(v_note_ids))
  THEN RAISE EXCEPTION 'Contextual note deletion scope changed.'; END IF;
  IF p_fail_after_step = 'contextual_notes' THEN RAISE EXCEPTION 'Injected permanent-delete failure after contextual notes.'; END IF;
  RETURN v_result;
END;
$$;
