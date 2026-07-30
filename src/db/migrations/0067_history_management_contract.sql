-- H2 adds stable historical identity, revision fencing, and truthful timing
-- evidence without exposing a retrospective writer.

ALTER TABLE "workout_sessions"
  ADD COLUMN "history_revision" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "performed_time_precision" text DEFAULT 'instant' NOT NULL,
  ADD COLUMN "source_program_id" uuid,
  ADD COLUMN "source_program_version_id" uuid,
  ADD COLUMN "source_day_lineage_id" uuid;
--> statement-breakpoint
ALTER TABLE "session_exercises"
  ADD COLUMN "source_slot_lineage_id" uuid;
--> statement-breakpoint
ALTER TABLE "completed_sets"
  ADD COLUMN "observed_completed_at" timestamp with time zone,
  ADD COLUMN "observed_completion_provenance" text DEFAULT 'unknown' NOT NULL,
  ADD COLUMN "observed_completion_quality" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "progression_jobs"
  ADD COLUMN "source_session_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Backfill only exact surviving physical Program references. Already-unlinked,
-- deleted, or contradictory references remain explicitly unknown.
UPDATE workout_sessions session
SET
  source_program_id = version.program_id,
  source_program_version_id = template.program_version_id,
  source_day_lineage_id = template.lineage_id
FROM workout_templates template
JOIN program_versions version ON version.id = template.program_version_id
JOIN programs program ON program.id = version.program_id
WHERE session.template_id = template.id
  AND program.user_id = session.user_id;
--> statement-breakpoint
UPDATE session_exercises exercise
SET source_slot_lineage_id = item.lineage_id
FROM workout_template_exercises item, workout_sessions session
WHERE exercise.planned_from_template_exercise_id = item.id
  AND session.id = exercise.session_id
  AND session.template_id = item.workout_template_id
  AND session.source_program_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "session_exercises_source_lineage_session_idx"
  ON "session_exercises" ("source_slot_lineage_id", "session_id")
  WHERE "source_slot_lineage_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "workout_sessions"
  ADD CONSTRAINT "workout_sessions_history_revision_check"
    CHECK ("history_revision" >= 0),
  ADD CONSTRAINT "workout_sessions_performed_time_precision_check"
    CHECK ("performed_time_precision" IN ('instant', 'date_only')),
  ADD CONSTRAINT "workout_sessions_source_program_tuple_check"
    CHECK (num_nonnulls("source_program_id", "source_program_version_id", "source_day_lineage_id") IN (0, 3));
--> statement-breakpoint
CREATE UNIQUE INDEX "workout_sessions_history_manual_source_uq"
  ON "workout_sessions" ("user_id", "source_workout_key")
  WHERE "source" = 'history_manual' AND "source_workout_key" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "completed_sets"
  ADD CONSTRAINT "completed_sets_observed_completion_provenance_valid"
    CHECK ("observed_completion_provenance" IN ('live_client', 'manual_explicit', 'import_source', 'unknown')),
  ADD CONSTRAINT "completed_sets_observed_completion_quality_valid"
    CHECK ("observed_completion_quality" IN ('trustworthy', 'owner_reported', 'unknown')),
  ADD CONSTRAINT "completed_sets_observed_completion_tuple_valid"
    CHECK (
      ("observed_completed_at" IS NULL
        AND "observed_completion_provenance" = 'unknown'
        AND "observed_completion_quality" = 'unknown')
      OR
      ("observed_completed_at" IS NOT NULL AND (
        ("observed_completion_provenance" = 'live_client'
          AND "observed_completion_quality" = 'trustworthy')
        OR
        ("observed_completion_provenance" = 'import_source'
          AND "observed_completion_quality" = 'trustworthy')
        OR
        ("observed_completion_provenance" = 'manual_explicit'
          AND "observed_completion_quality" = 'owner_reported')
      ))
    );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_completed_set_recorded_time()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.logged_at IS DISTINCT FROM NEW.logged_at THEN
    RAISE EXCEPTION 'Completed set recording time is immutable.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER completed_sets_recorded_time_immutable
BEFORE UPDATE OF "logged_at" ON completed_sets
FOR EACH ROW EXECUTE FUNCTION protect_completed_set_recorded_time();
--> statement-breakpoint

DROP INDEX "progression_jobs_session_uq";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM progression_jobs job
    JOIN workout_sessions session ON session.id = job.session_id
    WHERE job.user_id <> session.user_id
  ) THEN
    RAISE EXCEPTION 'Cannot add History job ownership: an existing progression job belongs to another account.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "progression_jobs"
  DROP CONSTRAINT "progression_jobs_session_id_workout_sessions_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "progression_jobs_session_revision_uq"
  ON "progression_jobs" ("session_id", "source_session_revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "progression_jobs_id_user_uq"
  ON "progression_jobs" ("id", "user_id");
--> statement-breakpoint
ALTER TABLE "progression_jobs"
  ADD CONSTRAINT "progression_jobs_source_revision_check"
    CHECK ("source_session_revision" >= 0),
  ADD CONSTRAINT "progression_jobs_session_owner_fk"
    FOREIGN KEY ("session_id", "user_id")
    REFERENCES "public"."workout_sessions"("id", "user_id")
    ON DELETE cascade;
--> statement-breakpoint

CREATE TABLE "progression_job_input_sessions" (
  "job_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "source_slot_lineage_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "history_revision" integer NOT NULL,
  CONSTRAINT "progression_job_input_sessions_pk"
    PRIMARY KEY ("job_id", "source_slot_lineage_id", "session_id"),
  CONSTRAINT "progression_job_input_sessions_revision_check"
    CHECK ("history_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "progression_job_input_sessions"
  ADD CONSTRAINT "progression_job_input_sessions_job_owner_fk"
    FOREIGN KEY ("job_id", "user_id")
    REFERENCES "public"."progression_jobs"("id", "user_id")
    ON DELETE cascade,
  ADD CONSTRAINT "progression_job_input_sessions_session_owner_fk"
    FOREIGN KEY ("session_id", "user_id")
    REFERENCES "public"."workout_sessions"("id", "user_id")
    ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "progression_job_input_sessions_session_idx"
  ON "progression_job_input_sessions" ("session_id", "history_revision");
--> statement-breakpoint

-- Preserve exact job-input evidence through both full and History restores.
-- The existing outer restore owns progression_jobs; this wrapper removes input
-- rows first, delegates the parent graph, then restores inputs after their jobs.
ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_without_progression_job_inputs;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid, p_scope text, p_expected_current jsonb, p_target_rows jsonb,
  p_dependency_rows jsonb, p_source_snapshot_id uuid, p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_inputs jsonb := COALESCE(p_target_rows->'progression_job_input_sessions', '[]'::jsonb);
  v_current jsonb;
  v_expected jsonb := COALESCE(p_expected_current->'progression_job_input_sessions', '[]'::jsonb);
  v_result jsonb;
  v_added integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 847221));
  PERFORM set_config('workout_tracker.authorized_delete', 'snapshot_restore', true);
  LOCK TABLE progression_jobs, progression_job_input_sessions IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_inputs) input
    WHERE input->>'user_id' IS DISTINCT FROM p_user_id::text
  ) THEN
    RAISE EXCEPTION 'Snapshot progression input belongs to another account.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(
      COALESCE(p_target_rows->'workout_sessions', '[]'::jsonb)
    ) source(
      user_id uuid,
      template_id uuid,
      source_program_id uuid,
      source_program_version_id uuid,
      source_day_lineage_id uuid
    )
    LEFT JOIN programs program ON program.id = source.source_program_id
    LEFT JOIN program_versions version
      ON version.id = source.source_program_version_id
    LEFT JOIN workout_templates template ON template.id = source.template_id
    WHERE source.user_id IS DISTINCT FROM p_user_id
      OR (
        source.source_program_id IS NOT NULL
        AND (
          (program.id IS NOT NULL AND program.user_id <> p_user_id)
          OR (
            version.id IS NOT NULL
            AND version.program_id <> source.source_program_id
          )
          OR (
            template.id IS NOT NULL
            AND (
              template.program_version_id <>
                source.source_program_version_id
              OR template.lineage_id <> source.source_day_lineage_id
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Snapshot workout source Program lineage is cross-owner or contradictory.'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(input) ORDER BY input.job_id, input.source_slot_lineage_id, input.session_id),
    '[]'::jsonb
  ) INTO v_current
  FROM progression_job_input_sessions input
  JOIN progression_jobs job ON job.id = input.job_id
  WHERE job.user_id = p_user_id;

  IF v_current IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Restore preview is stale for table progression_job_input_sessions.'
      USING ERRCODE = '40001';
  END IF;

  DELETE FROM progression_job_input_sessions input
  USING progression_jobs job
  WHERE input.job_id = job.id
    AND job.user_id = p_user_id;

  v_result := restore_user_snapshot_without_progression_job_inputs(
    p_user_id, p_scope,
    p_expected_current - 'progression_job_input_sessions',
    p_target_rows - 'progression_job_input_sessions',
    p_dependency_rows - 'progression_job_input_sessions',
    p_source_snapshot_id, p_safety_snapshot_id, p_fail_after_table
  );

  IF jsonb_array_length(v_inputs) > 0 THEN
    INSERT INTO progression_job_input_sessions
    SELECT source.*
    FROM jsonb_populate_recordset(
      NULL::progression_job_input_sessions,
      v_inputs
    ) source;
    GET DIAGNOSTICS v_added = ROW_COUNT;
  END IF;
  IF v_added <> jsonb_array_length(v_inputs) THEN
    RAISE EXCEPTION 'Restored progression input count did not match the reviewed snapshot.'
      USING ERRCODE = '23514';
  END IF;

  IF p_fail_after_table = 'progression_job_input_sessions' THEN
    RAISE EXCEPTION 'Injected restore failure after progression_job_input_sessions.';
  END IF;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(input) ORDER BY input.job_id, input.source_slot_lineage_id, input.session_id),
    '[]'::jsonb
  ) INTO v_current
  FROM progression_job_input_sessions input
  JOIN progression_jobs job ON job.id = input.job_id
  WHERE job.user_id = p_user_id;
  IF v_current IS DISTINCT FROM v_inputs THEN
    RAISE EXCEPTION 'Restored table progression_job_input_sessions failed final verification.'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{restoredRecords}',
    to_jsonb(COALESCE((v_result->>'restoredRecords')::integer, 0) + v_added)
  );
END;
$$;
--> statement-breakpoint

-- Extend Archive membership when a workout or completed set enters an
-- operation. These are preserved relationship/evidence records, not new roots.
CREATE OR REPLACE FUNCTION record_archived_history_revision_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.entity_type = 'workout_session' THEN
    INSERT INTO archive_operation_records(
      operation_id, user_id, entity_type, entity_id, relationship_role,
      parent_entity_type, parent_entity_id
    )
    SELECT DISTINCT NEW.operation_id, NEW.user_id, 'recommendation',
      recommendation.id::text, 'derived', 'workout_session', NEW.entity_id
    FROM recommendations recommendation
    JOIN progression_jobs job ON job.id = recommendation.progression_job_id
    WHERE recommendation.user_id = NEW.user_id
      AND (
        job.session_id::text = NEW.entity_id
        OR EXISTS (
          SELECT 1
          FROM progression_job_input_sessions matched_input
          WHERE matched_input.job_id = job.id
            AND matched_input.session_id::text = NEW.entity_id
        )
      )
    ON CONFLICT DO NOTHING;

    INSERT INTO archive_operation_records(
      operation_id, user_id, entity_type, entity_id, relationship_role,
      parent_entity_type, parent_entity_id
    )
    SELECT NEW.operation_id, NEW.user_id, 'record_version', version.id::text,
      'evidence', 'workout_session', NEW.entity_id
    FROM record_versions version
    WHERE version.user_id = NEW.user_id
      AND (
        (version.entity_type = 'workout_session' AND version.entity_id::text = NEW.entity_id)
        OR
        (
          version.entity_type = 'session_exercise'
          AND EXISTS (
            SELECT 1
            FROM session_exercises exercise
            WHERE exercise.id = version.entity_id
              AND exercise.session_id::text = NEW.entity_id
          )
        )
        OR
        (
          version.entity_type = 'completed_set'
          AND EXISTS (
            SELECT 1
            FROM completed_sets completed
            JOIN session_exercises exercise ON exercise.id = completed.session_exercise_id
            WHERE completed.id = version.entity_id
              AND exercise.session_id::text = NEW.entity_id
          )
        )
      )
    ON CONFLICT DO NOTHING;
  ELSIF NEW.entity_type = 'completed_set' THEN
    INSERT INTO archive_operation_records(
      operation_id, user_id, entity_type, entity_id, relationship_role,
      parent_entity_type, parent_entity_id
    )
    SELECT NEW.operation_id, NEW.user_id, 'record_version', version.id::text,
      'evidence', 'completed_set', NEW.entity_id
    FROM record_versions version
    WHERE version.user_id = NEW.user_id
      AND version.entity_type = 'completed_set'
      AND version.entity_id::text = NEW.entity_id
    ON CONFLICT DO NOTHING;
  ELSE
    RETURN NEW;
  END IF;

  UPDATE archive_operations operation
  SET record_counts = operation.record_counts || jsonb_build_object(
    'recordVersions', (
      SELECT count(*) FROM archive_operation_records member
      WHERE member.operation_id = NEW.operation_id
        AND member.entity_type = 'record_version'
    )
  )
  WHERE operation.id = NEW.operation_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER archive_operation_records_history_revision_evidence
AFTER INSERT ON archive_operation_records
FOR EACH ROW EXECUTE FUNCTION record_archived_history_revision_evidence();
--> statement-breakpoint

ALTER FUNCTION permanent_delete_archive_preview(uuid, uuid)
  RENAME TO permanent_delete_archive_preview_without_progression_job_inputs;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanent_delete_archive_preview(
  p_user_id uuid, p_operation_id uuid
) RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
WITH base AS (
  SELECT permanent_delete_archive_preview_without_progression_job_inputs(
    p_user_id, p_operation_id
  ) AS preview
), archived_sessions AS (
  SELECT member.entity_id::uuid AS session_id
  FROM archive_operation_records member
  WHERE member.operation_id = p_operation_id
    AND member.user_id = p_user_id
    AND member.entity_type = 'workout_session'
), affected_job_rows AS (
  SELECT DISTINCT job.id
  FROM progression_jobs job
  WHERE job.user_id = p_user_id
    AND (
      job.session_id IN (SELECT session_id FROM archived_sessions)
      OR EXISTS (
        SELECT 1
        FROM progression_job_input_sessions input
        WHERE input.job_id = job.id
          AND input.session_id IN (SELECT session_id FROM archived_sessions)
      )
    )
), affected_jobs AS (
  SELECT count(*)::integer AS count FROM affected_job_rows
), input_count AS (
  SELECT count(DISTINCT (
    input.job_id, input.source_slot_lineage_id, input.session_id
  ))::integer AS count
  FROM progression_job_input_sessions input
  WHERE input.user_id = p_user_id
    AND EXISTS (
      SELECT 1 FROM affected_job_rows affected
      WHERE affected.id = input.job_id
    )
), shared_recommendations AS (
  SELECT count(DISTINCT member.entity_id)::integer AS count
  FROM archive_operation_records member
  JOIN archive_operation_records other_member
    ON other_member.entity_type = 'recommendation'
   AND other_member.entity_id = member.entity_id
   AND other_member.operation_id <> member.operation_id
  JOIN archive_operations other_operation
    ON other_operation.id = other_member.operation_id
   AND other_operation.user_id = p_user_id
   AND other_operation.status = 'active'
  WHERE member.operation_id = p_operation_id
    AND member.user_id = p_user_id
    AND member.entity_type = 'recommendation'
)
SELECT CASE WHEN base.preview IS NULL THEN NULL ELSE
  jsonb_set(
    jsonb_set(
      jsonb_set(
        base.preview,
        '{deleteCounts,progressionJobs}',
        to_jsonb(affected_jobs.count),
        true
      ),
      '{deleteCounts,progressionJobInputSessions}',
      to_jsonb(input_count.count),
      true
    ),
    '{blockers}',
    COALESCE(base.preview->'blockers', '[]'::jsonb) ||
      CASE WHEN shared_recommendations.count > 0
        THEN jsonb_build_array(jsonb_build_object(
          'key', 'shared_recommendation_archive',
          'message', 'A derived recommendation is still linked to another active Archive action.',
          'count', shared_recommendations.count
        ))
        ELSE '[]'::jsonb
      END,
    true
  )
END
FROM base
CROSS JOIN affected_jobs
CROSS JOIN input_count
CROSS JOIN shared_recommendations;
$$;
--> statement-breakpoint

ALTER FUNCTION permanently_delete_archive_operation(uuid, uuid, text, text, uuid, text)
  RENAME TO permanently_delete_archive_operation_without_progression_job_inputs;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanently_delete_archive_operation(
  p_user_id uuid, p_operation_id uuid, p_token_hash text, p_confirmation text,
  p_safety_snapshot_id uuid, p_fail_after_step text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_result jsonb;
  v_inputs jsonb;
  v_job_ids uuid[];
  v_deleted_jobs integer := 0;
  v_remaining_jobs integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 847221));
  SELECT COALESCE(array_agg(affected.id), ARRAY[]::uuid[])
  INTO v_job_ids
  FROM (
    SELECT DISTINCT job.id
    FROM progression_jobs job
    WHERE job.user_id = p_user_id
      AND (
        job.session_id IN (
          SELECT member.entity_id::uuid
          FROM archive_operation_records member
          WHERE member.operation_id = p_operation_id
            AND member.user_id = p_user_id
            AND member.entity_type = 'workout_session'
        )
        OR EXISTS (
          SELECT 1
          FROM progression_job_input_sessions input
          JOIN archive_operation_records member
            ON member.operation_id = p_operation_id
           AND member.user_id = p_user_id
           AND member.entity_type = 'workout_session'
           AND member.entity_id = input.session_id::text
          WHERE input.job_id = job.id
        )
      )
  ) affected;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(input) ORDER BY input.job_id, input.source_slot_lineage_id, input.session_id),
    '[]'::jsonb
  ) INTO v_inputs
  FROM progression_job_input_sessions input
  WHERE input.user_id = p_user_id
    AND input.job_id = ANY(v_job_ids);

  v_result := permanently_delete_archive_operation_without_progression_job_inputs(
    p_user_id, p_operation_id, p_token_hash, p_confirmation,
    p_safety_snapshot_id, p_fail_after_step
  );

  SELECT count(*)::integer INTO v_remaining_jobs
  FROM progression_jobs job
  WHERE job.user_id = p_user_id
    AND job.id = ANY(v_job_ids);
  DELETE FROM progression_jobs job
  WHERE job.user_id = p_user_id
    AND job.id = ANY(v_job_ids);
  GET DIAGNOSTICS v_deleted_jobs = ROW_COUNT;
  IF v_deleted_jobs <> v_remaining_jobs THEN
    RAISE EXCEPTION 'Progression job deletion scope changed.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM progression_jobs job
    WHERE job.user_id = p_user_id AND job.id = ANY(v_job_ids)
  ) THEN
    RAISE EXCEPTION 'Progression job deletion scope changed.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM progression_job_input_sessions input
    JOIN jsonb_to_recordset(v_inputs)
      AS deleted(job_id uuid, source_slot_lineage_id uuid, session_id uuid)
      ON deleted.job_id = input.job_id
     AND deleted.source_slot_lineage_id = input.source_slot_lineage_id
     AND deleted.session_id = input.session_id
  ) THEN
    RAISE EXCEPTION 'Progression job input deletion scope changed.';
  END IF;
  IF p_fail_after_step = 'progression_job_input_sessions' THEN
    RAISE EXCEPTION 'Injected permanent-delete failure after progression job inputs.';
  END IF;
  RETURN jsonb_set(
    jsonb_set(
      v_result,
      '{deleteCounts,progressionJobs}',
      to_jsonb(cardinality(v_job_ids)),
      true
    ),
    '{deleteCounts,progressionJobInputSessions}',
    to_jsonb(jsonb_array_length(v_inputs)),
    true
  );
END;
$$;
--> statement-breakpoint
