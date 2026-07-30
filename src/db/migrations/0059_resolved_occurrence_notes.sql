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
    (OLD.outcome = 'pending' AND NEW.outcome IN ('completed', 'skipped', 'abandoned'))
    OR (
      OLD.outcome IN ('pending', 'completed', 'skipped')
      AND NEW.outcome = OLD.outcome
      AND NEW.outcome_reason IS NOT DISTINCT FROM OLD.outcome_reason
      AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
      AND NEW.completed_set_id IS NOT DISTINCT FROM OLD.completed_set_id
    )
    OR (OLD.outcome IN ('skipped', 'abandoned') AND NEW.outcome = 'pending')
  ) THEN
    RAISE EXCEPTION 'Workout occurrence outcome transition is not allowed.'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
