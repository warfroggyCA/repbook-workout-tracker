CREATE TABLE "session_compiler_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"program_version_id" uuid NOT NULL,
	"workout_template_id" uuid NOT NULL,
	"algorithm_version" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"output_snapshot" jsonb NOT NULL,
	"preflight_snapshot" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"client_mutation_id" text NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_hash" text,
	"accepted_session_id" uuid,
	"acceptance_key" text,
	"accepted_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_compiler_proposals_status_check" CHECK ("session_compiler_proposals"."status" IN ('ready', 'accepted', 'discarded', 'stale', 'unable')),
	CONSTRAINT "session_compiler_proposals_revision_check" CHECK ("session_compiler_proposals"."revision" = 1),
	CONSTRAINT "session_compiler_proposals_decision_check" CHECK (
      ("session_compiler_proposals"."status" = 'accepted' AND "session_compiler_proposals"."acceptance_key" IS NOT NULL AND "session_compiler_proposals"."accepted_at" IS NOT NULL AND "session_compiler_proposals"."reviewed_at" IS NOT NULL AND "session_compiler_proposals"."review_hash" IS NOT NULL)
      OR ("session_compiler_proposals"."status" <> 'accepted' AND "session_compiler_proposals"."accepted_session_id" IS NULL AND "session_compiler_proposals"."acceptance_key" IS NULL AND "session_compiler_proposals"."accepted_at" IS NULL)
    )
);
--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "compilation_acceptance_key" text;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "compilation_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "session_compiler_proposals" ADD CONSTRAINT "session_compiler_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_compiler_proposals" ADD CONSTRAINT "session_compiler_proposals_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_compiler_proposals" ADD CONSTRAINT "session_compiler_proposals_program_version_id_program_versions_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."program_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_compiler_proposals" ADD CONSTRAINT "session_compiler_proposals_workout_template_id_workout_templates_id_fk" FOREIGN KEY ("workout_template_id") REFERENCES "public"."workout_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_compiler_proposals" ADD CONSTRAINT "session_compiler_proposals_accepted_session_id_workout_sessions_id_fk" FOREIGN KEY ("accepted_session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_compiler_proposals_user_created_idx" ON "session_compiler_proposals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_compiler_proposals_user_mutation_uq" ON "session_compiler_proposals" USING btree ("user_id","client_mutation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_compiler_proposals_session_uq" ON "session_compiler_proposals" USING btree ("accepted_session_id") WHERE "session_compiler_proposals"."accepted_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_compiler_proposals_acceptance_uq" ON "session_compiler_proposals" USING btree ("user_id","acceptance_key") WHERE "session_compiler_proposals"."acceptance_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workout_sessions_compilation_acceptance_uq" ON "workout_sessions" USING btree ("user_id","compilation_acceptance_key") WHERE "workout_sessions"."compilation_acceptance_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD CONSTRAINT "workout_sessions_compilation_snapshot_check" CHECK (("workout_sessions"."compilation_acceptance_key" IS NULL AND "workout_sessions"."compilation_snapshot" IS NULL) OR ("workout_sessions"."compilation_acceptance_key" IS NOT NULL AND "workout_sessions"."compilation_snapshot" IS NOT NULL AND "workout_sessions"."source" = 'compiler'));--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_compiler_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.compilation_acceptance_key IS DISTINCT FROM NEW.compilation_acceptance_key
     OR OLD.compilation_snapshot IS DISTINCT FROM NEW.compilation_snapshot THEN
    RAISE EXCEPTION 'Accepted compiler provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER workout_sessions_compiler_provenance_immutable
BEFORE UPDATE OF compilation_acceptance_key, compilation_snapshot ON workout_sessions
FOR EACH ROW EXECUTE FUNCTION protect_compiler_provenance();--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_session_compiler_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.program_id IS DISTINCT FROM NEW.program_id
     OR OLD.program_version_id IS DISTINCT FROM NEW.program_version_id
     OR OLD.workout_template_id IS DISTINCT FROM NEW.workout_template_id
     OR OLD.algorithm_version IS DISTINCT FROM NEW.algorithm_version
     OR OLD.input_snapshot IS DISTINCT FROM NEW.input_snapshot
     OR OLD.output_snapshot IS DISTINCT FROM NEW.output_snapshot
     OR OLD.preflight_snapshot IS DISTINCT FROM NEW.preflight_snapshot
     OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
     OR OLD.client_mutation_id IS DISTINCT FROM NEW.client_mutation_id THEN
    RAISE EXCEPTION 'Session compiler proposal source and evidence are immutable';
  END IF;
  IF OLD.status IN ('accepted', 'discarded') AND OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'A decided session compiler proposal cannot be reopened';
  END IF;
  IF OLD.status = 'stale' AND NEW.status NOT IN ('stale', 'discarded') THEN
    RAISE EXCEPTION 'A stale session compiler proposal can only be discarded';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER session_compiler_proposals_immutable
BEFORE UPDATE ON session_compiler_proposals
FOR EACH ROW EXECUTE FUNCTION protect_session_compiler_proposal();--> statement-breakpoint

DROP TRIGGER IF EXISTS protected_delete_guard ON session_compiler_proposals;--> statement-breakpoint
CREATE TRIGGER protected_delete_guard
BEFORE DELETE ON session_compiler_proposals
FOR EACH ROW EXECUTE FUNCTION guard_protected_delete();--> statement-breakpoint

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
  v_expected_proposals jsonb := COALESCE(p_expected_current -> 'session_compiler_proposals', '[]'::jsonb);
  v_restore_proposals jsonb := CASE
    WHEN p_scope = 'full' THEN COALESCE(p_target_rows -> 'session_compiler_proposals', '[]'::jsonb)
    ELSE COALESCE(p_dependency_rows -> 'session_compiler_proposals', '[]'::jsonb)
  END;
  v_current_proposals jsonb;
  v_expected_jobs jsonb := COALESCE(p_expected_current -> 'progression_jobs', '[]'::jsonb);
  v_restore_jobs jsonb := COALESCE(p_target_rows -> 'progression_jobs', '[]'::jsonb);
  v_current_jobs jsonb;
  v_base_target jsonb;
  v_result jsonb;
  v_proposal_count integer := 0;
  v_job_count integer := 0;
BEGIN
  PERFORM set_config('workout_tracker.authorized_delete', 'snapshot_restore', true);

  IF p_scope = 'full' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(proposal) ORDER BY proposal.id), '[]'::jsonb)
      INTO v_current_proposals
      FROM session_compiler_proposals proposal
      WHERE proposal.user_id = p_user_id;
    IF v_current_proposals IS DISTINCT FROM v_expected_proposals THEN
      RAISE EXCEPTION 'Restore preview is stale for table session_compiler_proposals.'
        USING ERRCODE = '40001';
    END IF;
    DELETE FROM session_compiler_proposals WHERE user_id = p_user_id;
  ELSE
    DELETE FROM session_compiler_proposals proposal
    WHERE proposal.user_id = p_user_id
      AND proposal.accepted_session_id IN (
        SELECT id
        FROM jsonb_to_recordset(COALESCE(p_expected_current -> 'workout_sessions', '[]'::jsonb))
          AS expected_session(id uuid)
      );
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(job) ORDER BY job.id), '[]'::jsonb)
    INTO v_current_jobs
    FROM progression_jobs job
    WHERE job.user_id = p_user_id;
  IF v_current_jobs IS DISTINCT FROM v_expected_jobs THEN
    RAISE EXCEPTION 'Restore preview is stale for table progression_jobs.'
      USING ERRCODE = '40001';
  END IF;

  v_base_target := p_target_rows - 'session_compiler_proposals' - 'progression_jobs';
  IF v_base_target ? 'recommendations' THEN
    v_base_target := jsonb_set(
      v_base_target,
      '{recommendations}',
      COALESCE((
        SELECT jsonb_agg((recommendation - 'progression_job_id') || jsonb_build_object('progression_job_id', NULL))
        FROM jsonb_array_elements(v_base_target -> 'recommendations') recommendation
      ), '[]'::jsonb)
    );
  END IF;

  v_result := restore_user_snapshot_unguarded(
    p_user_id,
    p_scope,
    p_expected_current - 'session_compiler_proposals' - 'progression_jobs',
    v_base_target,
    p_dependency_rows - 'session_compiler_proposals' - 'progression_jobs',
    p_source_snapshot_id,
    p_safety_snapshot_id,
    p_fail_after_table
  );

  IF jsonb_array_length(v_restore_jobs) > 0 THEN
    INSERT INTO progression_jobs
    SELECT restored.*
    FROM jsonb_populate_recordset(NULL::progression_jobs, v_restore_jobs) restored;
    GET DIAGNOSTICS v_job_count = ROW_COUNT;
  END IF;

  IF p_fail_after_table = 'progression_jobs' THEN
    RAISE EXCEPTION 'Injected restore failure after progression_jobs.';
  END IF;

  IF p_target_rows ? 'recommendations' THEN
    UPDATE recommendations recommendation
    SET progression_job_id = source.progression_job_id
    FROM jsonb_to_recordset(p_target_rows -> 'recommendations')
      AS source(id uuid, progression_job_id uuid)
    WHERE recommendation.id = source.id
      AND recommendation.user_id = p_user_id;
  END IF;

  IF jsonb_array_length(v_restore_proposals) > 0 THEN
    INSERT INTO session_compiler_proposals
    SELECT restored.*
    FROM jsonb_populate_recordset(NULL::session_compiler_proposals, v_restore_proposals) restored;
    GET DIAGNOSTICS v_proposal_count = ROW_COUNT;
  END IF;

  IF p_fail_after_table = 'session_compiler_proposals' THEN
    RAISE EXCEPTION 'Injected restore failure after session_compiler_proposals.';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{restoredRecords}',
    to_jsonb(COALESCE((v_result ->> 'restoredRecords')::integer, 0) + v_proposal_count + v_job_count)
  );
END;
$$;
--> statement-breakpoint
ALTER FUNCTION permanent_delete_archive_preview(uuid, uuid)
  RENAME TO permanent_delete_archive_preview_without_session_compiler;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanent_delete_archive_preview(
  p_user_id uuid,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH base AS (
  SELECT permanent_delete_archive_preview_without_session_compiler(
    p_user_id,
    p_operation_id
  ) AS preview
), compiler_count AS (
  SELECT count(*)::integer AS count
  FROM session_compiler_proposals proposal
  JOIN archive_operation_records member
    ON member.operation_id = p_operation_id
   AND member.user_id = p_user_id
   AND member.entity_type = 'workout_session'
   AND member.entity_id = proposal.accepted_session_id::text
  WHERE proposal.user_id = p_user_id
)
SELECT CASE
  WHEN base.preview IS NULL THEN NULL
  ELSE jsonb_set(
    base.preview,
    '{deleteCounts,sessionCompilerProposals}',
    to_jsonb(compiler_count.count),
    true
  )
END
FROM base CROSS JOIN compiler_count;
$$;
