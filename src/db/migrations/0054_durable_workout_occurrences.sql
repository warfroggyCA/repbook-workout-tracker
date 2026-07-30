CREATE TABLE "session_exercise_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"source_group_id" uuid,
	"lineage_id" uuid,
	"provenance" text NOT NULL,
	"name" text NOT NULL,
	"order_idx" integer NOT NULL,
	"planned_rounds" integer,
	"member_count" integer,
	"rest_between_members_sec" integer,
	"rest_between_rounds_sec" integer,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "session_exercise_groups_provenance_valid" CHECK ("session_exercise_groups"."provenance" IN ('program', 'compiler', 'import', 'legacy')),
	CONSTRAINT "session_exercise_groups_order_valid" CHECK ("session_exercise_groups"."order_idx" >= 0),
	CONSTRAINT "session_exercise_groups_rounds_valid" CHECK ("session_exercise_groups"."planned_rounds" IS NULL OR "session_exercise_groups"."planned_rounds" >= 1),
	CONSTRAINT "session_exercise_groups_member_count_valid" CHECK ("session_exercise_groups"."member_count" IS NULL OR "session_exercise_groups"."member_count" >= 2),
	CONSTRAINT "session_exercise_groups_member_rest_valid" CHECK ("session_exercise_groups"."rest_between_members_sec" IS NULL OR "session_exercise_groups"."rest_between_members_sec" BETWEEN 0 AND 1800),
	CONSTRAINT "session_exercise_groups_round_rest_valid" CHECK ("session_exercise_groups"."rest_between_rounds_sec" IS NULL OR "session_exercise_groups"."rest_between_rounds_sec" BETWEEN 0 AND 1800),
	CONSTRAINT "session_exercise_groups_snapshot_version_valid" CHECK ("session_exercise_groups"."snapshot_version" >= 1),
	CONSTRAINT "session_exercise_groups_canonical_plan_valid" CHECK ("session_exercise_groups"."provenance" IN ('import', 'legacy') OR ("session_exercise_groups"."planned_rounds" IS NOT NULL AND "session_exercise_groups"."member_count" IS NOT NULL AND "session_exercise_groups"."rest_between_members_sec" IS NOT NULL AND "session_exercise_groups"."rest_between_rounds_sec" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "session_occurrence_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"client_key" text NOT NULL,
	"operation" text NOT NULL,
	"canonical_payload_hash" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"resulting_revision" integer NOT NULL,
	"result_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_occurrence_mutations_operation_valid" CHECK ("session_occurrence_mutations"."operation" IN ('complete', 'skip', 'restore', 'abandon', 'note')),
	CONSTRAINT "session_occurrence_mutations_revision_valid" CHECK ("session_occurrence_mutations"."expected_revision" >= 0 AND "session_occurrence_mutations"."resulting_revision" >= "session_occurrence_mutations"."expected_revision"),
	CONSTRAINT "session_occurrence_mutations_result_valid" CHECK ("session_occurrence_mutations"."result_code" IN ('applied', 'no_change'))
);
--> statement-breakpoint
CREATE TABLE "session_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"session_exercise_id" uuid,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"sequence_idx" integer NOT NULL,
	"kind_ordinal" integer NOT NULL,
	"label" text,
	"planned_exercise_id" uuid,
	"planned_reps_min" integer,
	"planned_reps_max" integer,
	"planned_load" numeric(7, 2),
	"planned_load_unit" "unit",
	"planned_load_percent" numeric(5, 2),
	"planned_load_text" text,
	"planned_rest_sec" integer,
	"planned_note" text,
	"group_snapshot_id" uuid,
	"group_round" integer,
	"group_member_order_idx" integer,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"outcome_reason" text,
	"outcome_note" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"completed_set_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_occurrences_kind_valid" CHECK ("session_occurrences"."kind" IN ('day_warmup', 'exercise_warmup', 'working_set')),
	CONSTRAINT "session_occurrences_origin_valid" CHECK ("session_occurrences"."origin" IN ('planned', 'ad_hoc', 'imported', 'legacy')),
	CONSTRAINT "session_occurrences_outcome_valid" CHECK ("session_occurrences"."outcome" IN ('pending', 'completed', 'skipped', 'abandoned', 'legacy_unrecorded')),
	CONSTRAINT "session_occurrences_order_valid" CHECK ("session_occurrences"."sequence_idx" >= 0 AND "session_occurrences"."kind_ordinal" >= 0),
	CONSTRAINT "session_occurrences_reps_valid" CHECK (("session_occurrences"."planned_reps_min" IS NULL AND "session_occurrences"."planned_reps_max" IS NULL) OR ("session_occurrences"."planned_reps_min" >= 0 AND "session_occurrences"."planned_reps_max" >= "session_occurrences"."planned_reps_min")),
	CONSTRAINT "session_occurrences_load_unit_valid" CHECK (("session_occurrences"."planned_load" IS NULL AND "session_occurrences"."planned_load_unit" IS NULL) OR ("session_occurrences"."planned_load" IS NOT NULL AND "session_occurrences"."planned_load_unit" IS NOT NULL)),
	CONSTRAINT "session_occurrences_load_representation_valid" CHECK (num_nonnulls("session_occurrences"."planned_load", "session_occurrences"."planned_load_percent", "session_occurrences"."planned_load_text") <= 1),
	CONSTRAINT "session_occurrences_load_percent_valid" CHECK ("session_occurrences"."planned_load_percent" IS NULL OR "session_occurrences"."planned_load_percent" BETWEEN 0 AND 100),
	CONSTRAINT "session_occurrences_rest_valid" CHECK ("session_occurrences"."planned_rest_sec" IS NULL OR "session_occurrences"."planned_rest_sec" BETWEEN 0 AND 1800),
	CONSTRAINT "session_occurrences_group_coordinates_valid" CHECK (("session_occurrences"."group_snapshot_id" IS NULL AND "session_occurrences"."group_round" IS NULL AND "session_occurrences"."group_member_order_idx" IS NULL) OR ("session_occurrences"."group_snapshot_id" IS NOT NULL AND "session_occurrences"."group_round" >= 1 AND "session_occurrences"."group_member_order_idx" >= 0 AND "session_occurrences"."kind" = 'working_set')),
	CONSTRAINT "session_occurrences_exercise_identity_valid" CHECK (("session_occurrences"."kind" = 'day_warmup' AND "session_occurrences"."session_exercise_id" IS NULL AND "session_occurrences"."planned_exercise_id" IS NULL) OR ("session_occurrences"."kind" IN ('exercise_warmup', 'working_set') AND "session_occurrences"."session_exercise_id" IS NOT NULL AND "session_occurrences"."planned_exercise_id" IS NOT NULL)),
	CONSTRAINT "session_occurrences_revision_valid" CHECK ("session_occurrences"."revision" >= 0),
	CONSTRAINT "session_occurrences_resolution_valid" CHECK (("session_occurrences"."outcome" IN ('pending', 'legacy_unrecorded') AND "session_occurrences"."resolved_at" IS NULL) OR ("session_occurrences"."outcome" IN ('completed', 'skipped', 'abandoned') AND "session_occurrences"."resolved_at" IS NOT NULL)),
	CONSTRAINT "session_occurrences_completed_link_valid" CHECK ("session_occurrences"."completed_set_id" IS NULL OR ("session_occurrences"."kind" = 'working_set' AND "session_occurrences"."outcome" = 'completed'))
);
--> statement-breakpoint
ALTER TABLE "program_versions" DROP CONSTRAINT "program_versions_document_schema_valid";--> statement-breakpoint
ALTER TABLE "superset_groups" ADD COLUMN "planned_rounds" integer;--> statement-breakpoint
ALTER TABLE "superset_groups" ADD COLUMN "rest_between_members_sec" integer;--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD COLUMN "group_member_order_idx" integer;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "group_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "group_member_order_idx" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "session_exercise_groups_id_session_uq" ON "session_exercise_groups" USING btree ("id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_exercises_id_session_uq" ON "session_exercises" USING btree ("id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "completed_sets_id_session_exercise_uq" ON "completed_sets" USING btree ("id","session_exercise_id");--> statement-breakpoint
ALTER TABLE "session_exercise_groups" ADD CONSTRAINT "session_exercise_groups_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exercise_groups" ADD CONSTRAINT "session_exercise_groups_source_group_id_superset_groups_id_fk" FOREIGN KEY ("source_group_id") REFERENCES "public"."superset_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_occurrence_mutations" ADD CONSTRAINT "session_occurrence_mutations_occurrence_id_session_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."session_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_occurrences" ADD CONSTRAINT "session_occurrences_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_occurrences" ADD CONSTRAINT "session_occurrences_planned_exercise_id_exercises_id_fk" FOREIGN KEY ("planned_exercise_id") REFERENCES "public"."exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_occurrences" ADD CONSTRAINT "session_occurrences_exercise_session_fk" FOREIGN KEY ("session_exercise_id","session_id") REFERENCES "public"."session_exercises"("id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_occurrences" ADD CONSTRAINT "session_occurrences_group_session_fk" FOREIGN KEY ("group_snapshot_id","session_id") REFERENCES "public"."session_exercise_groups"("id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_occurrences" ADD CONSTRAINT "session_occurrences_completed_set_exercise_fk" FOREIGN KEY ("completed_set_id","session_exercise_id") REFERENCES "public"."completed_sets"("id","session_exercise_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_exercise_groups_session_order_uq" ON "session_exercise_groups" USING btree ("session_id","order_idx");--> statement-breakpoint
CREATE INDEX "session_exercise_groups_source_idx" ON "session_exercise_groups" USING btree ("source_group_id","session_id") WHERE "session_exercise_groups"."source_group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_occurrence_mutations_client_key_uq" ON "session_occurrence_mutations" USING btree ("occurrence_id","client_key");--> statement-breakpoint
CREATE INDEX "session_occurrence_mutations_created_idx" ON "session_occurrence_mutations" USING btree ("occurrence_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_occurrences_session_sequence_uq" ON "session_occurrences" USING btree ("session_id","sequence_idx");--> statement-breakpoint
CREATE UNIQUE INDEX "session_occurrences_completed_set_uq" ON "session_occurrences" USING btree ("completed_set_id") WHERE "session_occurrences"."completed_set_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_occurrences_group_member_round_uq" ON "session_occurrences" USING btree ("group_snapshot_id","group_round","group_member_order_idx") WHERE "session_occurrences"."group_snapshot_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_occurrences_day_kind_ordinal_uq" ON "session_occurrences" USING btree ("session_id","kind","kind_ordinal") WHERE "session_occurrences"."session_exercise_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_occurrences_exercise_kind_ordinal_uq" ON "session_occurrences" USING btree ("session_exercise_id","kind","kind_ordinal") WHERE "session_occurrences"."session_exercise_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "session_occurrences_session_outcome_sequence_idx" ON "session_occurrences" USING btree ("session_id","outcome","sequence_idx");--> statement-breakpoint
CREATE INDEX "session_occurrences_session_exercise_idx" ON "session_occurrences" USING btree ("session_exercise_id");--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_group_session_fk" FOREIGN KEY ("group_snapshot_id","session_id") REFERENCES "public"."session_exercise_groups"("id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_exercises_group_member_uq" ON "session_exercises" USING btree ("group_snapshot_id","group_member_order_idx") WHERE "session_exercises"."group_snapshot_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_document_schema_valid" CHECK ("program_versions"."document_schema_version" IN (1, 2, 3));--> statement-breakpoint
ALTER TABLE "superset_groups" ADD CONSTRAINT "superset_groups_rounds_valid" CHECK ("superset_groups"."planned_rounds" IS NULL OR "superset_groups"."planned_rounds" >= 1);--> statement-breakpoint
ALTER TABLE "superset_groups" ADD CONSTRAINT "superset_groups_member_rest_valid" CHECK ("superset_groups"."rest_between_members_sec" IS NULL OR "superset_groups"."rest_between_members_sec" BETWEEN 0 AND 1800);--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD CONSTRAINT "wte_group_member_order_valid" CHECK ("workout_template_exercises"."group_member_order_idx" IS NULL OR ("workout_template_exercises"."superset_group_id" IS NOT NULL AND "workout_template_exercises"."group_member_order_idx" >= 0));--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_group_coordinates_valid" CHECK (("session_exercises"."group_snapshot_id" IS NULL AND "session_exercises"."group_member_order_idx" IS NULL) OR ("session_exercises"."group_snapshot_id" IS NOT NULL AND "session_exercises"."group_member_order_idx" >= 0));--> statement-breakpoint

DO $$
DECLARE
  protected_table text;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[
    'session_exercise_groups',
    'session_occurrences',
    'session_occurrence_mutations'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS protected_delete_guard ON %I', protected_table);
    EXECUTE format(
      'CREATE TRIGGER protected_delete_guard BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_protected_delete()',
      protected_table
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION restore_user_snapshot(
  uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text
) RENAME TO restore_user_snapshot_without_occurrences;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid,
  p_scope text,
  p_expected_current jsonb,
  p_target_rows jsonb,
  p_dependency_rows jsonb,
  p_source_snapshot_id uuid,
  p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_expected_groups jsonb := COALESCE(p_expected_current -> 'session_exercise_groups', '[]'::jsonb);
  v_expected_occurrences jsonb := COALESCE(p_expected_current -> 'session_occurrences', '[]'::jsonb);
  v_expected_mutations jsonb := COALESCE(p_expected_current -> 'session_occurrence_mutations', '[]'::jsonb);
  v_restore_groups jsonb := COALESCE(p_target_rows -> 'session_exercise_groups', '[]'::jsonb);
  v_restore_occurrences jsonb := COALESCE(p_target_rows -> 'session_occurrences', '[]'::jsonb);
  v_restore_mutations jsonb := COALESCE(p_target_rows -> 'session_occurrence_mutations', '[]'::jsonb);
  v_current_groups jsonb;
  v_current_occurrences jsonb;
  v_current_mutations jsonb;
  v_base_expected jsonb;
  v_base_target jsonb;
  v_result jsonb;
  v_group_count integer := 0;
  v_occurrence_count integer := 0;
  v_mutation_count integer := 0;
BEGIN
  PERFORM set_config('workout_tracker.authorized_delete', 'snapshot_restore', true);

  SELECT COALESCE(jsonb_agg(to_jsonb(seg) ORDER BY seg.id), '[]'::jsonb)
    INTO v_current_groups
    FROM session_exercise_groups seg
    JOIN workout_sessions session ON session.id = seg.session_id
    WHERE session.user_id = p_user_id
      AND (
        p_scope = 'full'
        OR seg.session_id IN (
          SELECT id FROM jsonb_to_recordset(
            COALESCE(p_expected_current -> 'workout_sessions', '[]'::jsonb)
          ) AS expected_session(id uuid)
        )
      );
  IF v_current_groups IS DISTINCT FROM v_expected_groups THEN
    RAISE EXCEPTION 'Restore preview is stale for table session_exercise_groups.'
      USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(occurrence) ORDER BY occurrence.id), '[]'::jsonb)
    INTO v_current_occurrences
    FROM session_occurrences occurrence
    JOIN workout_sessions session ON session.id = occurrence.session_id
    WHERE session.user_id = p_user_id
      AND (
        p_scope = 'full'
        OR occurrence.session_id IN (
          SELECT id FROM jsonb_to_recordset(
            COALESCE(p_expected_current -> 'workout_sessions', '[]'::jsonb)
          ) AS expected_session(id uuid)
        )
      );
  IF v_current_occurrences IS DISTINCT FROM v_expected_occurrences THEN
    RAISE EXCEPTION 'Restore preview is stale for table session_occurrences.'
      USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(mutation) ORDER BY mutation.id), '[]'::jsonb)
    INTO v_current_mutations
    FROM session_occurrence_mutations mutation
    JOIN session_occurrences occurrence ON occurrence.id = mutation.occurrence_id
    JOIN workout_sessions session ON session.id = occurrence.session_id
    WHERE session.user_id = p_user_id
      AND (
        p_scope = 'full'
        OR occurrence.session_id IN (
          SELECT id FROM jsonb_to_recordset(
            COALESCE(p_expected_current -> 'workout_sessions', '[]'::jsonb)
          ) AS expected_session(id uuid)
        )
      );
  IF v_current_mutations IS DISTINCT FROM v_expected_mutations THEN
    RAISE EXCEPTION 'Restore preview is stale for table session_occurrence_mutations.'
      USING ERRCODE = '40001';
  END IF;

  DELETE FROM session_occurrence_mutations mutation
  USING session_occurrences occurrence, workout_sessions session
  WHERE mutation.occurrence_id = occurrence.id
    AND occurrence.session_id = session.id
    AND session.user_id = p_user_id
    AND (
      p_scope = 'full'
      OR occurrence.session_id IN (
        SELECT id FROM jsonb_to_recordset(
          COALESCE(p_expected_current -> 'workout_sessions', '[]'::jsonb)
        ) AS expected_session(id uuid)
      )
    );

  DELETE FROM session_occurrences occurrence
  USING workout_sessions session
  WHERE occurrence.session_id = session.id
    AND session.user_id = p_user_id
    AND (
      p_scope = 'full'
      OR occurrence.session_id IN (
        SELECT id FROM jsonb_to_recordset(
          COALESCE(p_expected_current -> 'workout_sessions', '[]'::jsonb)
        ) AS expected_session(id uuid)
      )
    );

  UPDATE session_exercises exercise
  SET group_snapshot_id = NULL,
      group_member_order_idx = NULL
  FROM workout_sessions session
  WHERE exercise.session_id = session.id
    AND session.user_id = p_user_id
    AND exercise.group_snapshot_id IS NOT NULL
    AND (
      p_scope = 'full'
      OR exercise.session_id IN (
        SELECT id FROM jsonb_to_recordset(
          COALESCE(p_expected_current -> 'workout_sessions', '[]'::jsonb)
        ) AS expected_session(id uuid)
      )
    );

  DELETE FROM session_exercise_groups seg
  USING workout_sessions session
  WHERE seg.session_id = session.id
    AND session.user_id = p_user_id
    AND (
      p_scope = 'full'
      OR seg.session_id IN (
        SELECT id FROM jsonb_to_recordset(
          COALESCE(p_expected_current -> 'workout_sessions', '[]'::jsonb)
        ) AS expected_session(id uuid)
      )
    );

  v_base_expected := p_expected_current
    - 'session_exercise_groups'
    - 'session_occurrences'
    - 'session_occurrence_mutations';
  IF v_base_expected ? 'session_exercises' THEN
    v_base_expected := jsonb_set(
      v_base_expected,
      '{session_exercises}',
      COALESCE((
        SELECT jsonb_agg(
          (exercise - 'group_snapshot_id' - 'group_member_order_idx')
          || jsonb_build_object(
            'group_snapshot_id', NULL,
            'group_member_order_idx', NULL
          )
        )
        FROM jsonb_array_elements(v_base_expected -> 'session_exercises') exercise
      ), '[]'::jsonb)
    );
  END IF;

  v_base_target := p_target_rows
    - 'session_exercise_groups'
    - 'session_occurrences'
    - 'session_occurrence_mutations';
  IF v_base_target ? 'session_exercises' THEN
    v_base_target := jsonb_set(
      v_base_target,
      '{session_exercises}',
      COALESCE((
        SELECT jsonb_agg(
          (exercise - 'group_snapshot_id' - 'group_member_order_idx')
          || jsonb_build_object(
            'group_snapshot_id', NULL,
            'group_member_order_idx', NULL
          )
        )
        FROM jsonb_array_elements(v_base_target -> 'session_exercises') exercise
      ), '[]'::jsonb)
    );
  END IF;

  v_result := restore_user_snapshot_without_occurrences(
    p_user_id,
    p_scope,
    v_base_expected,
    v_base_target,
    p_dependency_rows
      - 'session_exercise_groups'
      - 'session_occurrences'
      - 'session_occurrence_mutations',
    p_source_snapshot_id,
    p_safety_snapshot_id,
    p_fail_after_table
  );

  IF jsonb_array_length(v_restore_groups) > 0 THEN
    INSERT INTO session_exercise_groups
    SELECT restored.*
    FROM jsonb_populate_recordset(NULL::session_exercise_groups, v_restore_groups) restored;
    GET DIAGNOSTICS v_group_count = ROW_COUNT;
  END IF;
  IF p_fail_after_table = 'session_exercise_groups' THEN
    RAISE EXCEPTION 'Injected restore failure after session_exercise_groups.';
  END IF;

  IF p_target_rows ? 'session_exercises' THEN
    UPDATE session_exercises exercise
    SET group_snapshot_id = source.group_snapshot_id,
        group_member_order_idx = source.group_member_order_idx
    FROM jsonb_to_recordset(p_target_rows -> 'session_exercises')
      AS source(id uuid, group_snapshot_id uuid, group_member_order_idx integer)
    WHERE exercise.id = source.id;
  END IF;

  IF jsonb_array_length(v_restore_occurrences) > 0 THEN
    INSERT INTO session_occurrences
    SELECT restored.*
    FROM jsonb_populate_recordset(NULL::session_occurrences, v_restore_occurrences) restored;
    GET DIAGNOSTICS v_occurrence_count = ROW_COUNT;
  END IF;
  IF p_fail_after_table = 'session_occurrences' THEN
    RAISE EXCEPTION 'Injected restore failure after session_occurrences.';
  END IF;

  IF jsonb_array_length(v_restore_mutations) > 0 THEN
    INSERT INTO session_occurrence_mutations
    SELECT restored.*
    FROM jsonb_populate_recordset(NULL::session_occurrence_mutations, v_restore_mutations) restored;
    GET DIAGNOSTICS v_mutation_count = ROW_COUNT;
  END IF;
  IF p_fail_after_table = 'session_occurrence_mutations' THEN
    RAISE EXCEPTION 'Injected restore failure after session_occurrence_mutations.';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{restoredRecords}',
    to_jsonb(
      COALESCE((v_result ->> 'restoredRecords')::integer, 0)
      + v_group_count
      + v_occurrence_count
      + v_mutation_count
    )
  );
END;
$$;
