ALTER TABLE "session_occurrences"
  DROP CONSTRAINT "session_occurrences_completed_link_valid";
--> statement-breakpoint
ALTER TABLE "session_occurrences"
  ADD CONSTRAINT "session_occurrences_completed_link_valid" CHECK (
    (
      "session_occurrences"."kind" = 'working_set'
      AND "session_occurrences"."outcome" = 'completed'
      AND "session_occurrences"."completed_set_id" IS NOT NULL
    ) OR (
      (
        "session_occurrences"."kind" <> 'working_set'
        OR "session_occurrences"."outcome" <> 'completed'
      )
      AND "session_occurrences"."completed_set_id" IS NULL
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_session_exercise_group_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '')
      IN ('snapshot_restore', 'permanent') THEN
    RETURN NEW;
  END IF;

  IF ROW(
    OLD.id, OLD.session_id, OLD.source_group_id, OLD.lineage_id,
    OLD.provenance, OLD.name, OLD.order_idx, OLD.planned_rounds,
    OLD.member_count, OLD.rest_between_members_sec,
    OLD.rest_between_rounds_sec, OLD.snapshot_version
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.session_id, NEW.source_group_id, NEW.lineage_id,
    NEW.provenance, NEW.name, NEW.order_idx, NEW.planned_rounds,
    NEW.member_count, NEW.rest_between_members_sec,
    NEW.rest_between_rounds_sec, NEW.snapshot_version
  ) THEN
    RAISE EXCEPTION 'Workout exercise-group snapshot evidence is immutable.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_exercise_groups_snapshot_immutable
BEFORE UPDATE ON session_exercise_groups
FOR EACH ROW EXECUTE FUNCTION protect_session_exercise_group_snapshot();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_session_occurrence_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF ROW(
    OLD.id, OLD.session_id, OLD.session_exercise_id, OLD.kind, OLD.origin,
    OLD.sequence_idx, OLD.kind_ordinal, OLD.label, OLD.planned_exercise_id,
    OLD.planned_reps_min, OLD.planned_reps_max, OLD.planned_load,
    OLD.planned_load_unit, OLD.planned_load_percent, OLD.planned_load_text,
    OLD.planned_rest_sec, OLD.planned_note, OLD.group_snapshot_id,
    OLD.group_round, OLD.group_member_order_idx, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.session_id, NEW.session_exercise_id, NEW.kind, NEW.origin,
    NEW.sequence_idx, NEW.kind_ordinal, NEW.label, NEW.planned_exercise_id,
    NEW.planned_reps_min, NEW.planned_reps_max, NEW.planned_load,
    NEW.planned_load_unit, NEW.planned_load_percent, NEW.planned_load_text,
    NEW.planned_rest_sec, NEW.planned_note, NEW.group_snapshot_id,
    NEW.group_round, NEW.group_member_order_idx, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Workout occurrence plan and identity evidence is immutable.'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    OLD.outcome, OLD.outcome_reason, OLD.outcome_note, OLD.revision,
    OLD.resolved_at, OLD.completed_set_id
  ) IS NOT DISTINCT FROM ROW(
    NEW.outcome, NEW.outcome_reason, NEW.outcome_note, NEW.revision,
    NEW.resolved_at, NEW.completed_set_id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Workout occurrence transitions must advance exactly one revision.'
      USING ERRCODE = '40001';
  END IF;

  IF NOT (
    (OLD.outcome = 'pending' AND NEW.outcome IN ('pending', 'completed', 'skipped', 'abandoned'))
    OR (OLD.outcome IN ('skipped', 'abandoned') AND NEW.outcome = 'pending')
  ) THEN
    RAISE EXCEPTION 'Workout occurrence outcome transition is not allowed.'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_occurrences_evidence_immutable
BEFORE UPDATE ON session_occurrences
FOR EACH ROW EXECUTE FUNCTION protect_session_occurrence_evidence();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_session_occurrence_mutation_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Workout occurrence mutation receipts are immutable.'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_occurrence_mutations_receipt_immutable
BEFORE UPDATE ON session_occurrence_mutations
FOR EACH ROW EXECUTE FUNCTION protect_session_occurrence_mutation_receipt();
