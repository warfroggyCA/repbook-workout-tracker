-- Retain exercise-equipment requirement meaning at the active-workout
-- boundary. Existing rows remain explicitly legacy/unknown; mutable current
-- catalog requirements must never be used as a historical backfill.

ALTER TABLE "session_exercises"
  ADD COLUMN "equipment_requirements_semantics_version" integer,
  ADD COLUMN "equipment_requirements_snapshot" jsonb;
--> statement-breakpoint

ALTER TABLE "session_exercises"
  ADD CONSTRAINT "session_exercises_equipment_requirements_snapshot_check"
  CHECK (
    (
      "equipment_requirements_semantics_version" IS NULL
      AND "equipment_requirements_snapshot" IS NULL
    ) OR (
      "equipment_requirements_semantics_version" = 1
      AND jsonb_typeof("equipment_requirements_snapshot") = 'object'
      AND "equipment_requirements_snapshot"->>'sourceExerciseId' = "exercise_id"::text
      AND jsonb_typeof("equipment_requirements_snapshot"->'broad') = 'array'
      AND "equipment_requirements_snapshot" ? 'exact'
      AND (
        "equipment_requirements_snapshot"->'exact' = 'null'::jsonb
        OR jsonb_typeof("equipment_requirements_snapshot"->'exact') = 'object'
      )
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_session_equipment_requirements_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.exercise_id = OLD.exercise_id
    AND (
      NEW.equipment_requirements_semantics_version IS DISTINCT FROM
        OLD.equipment_requirements_semantics_version
      OR NEW.equipment_requirements_snapshot IS DISTINCT FROM
        OLD.equipment_requirements_snapshot
    )
    AND current_setting('workout_tracker.authorized_delete', true)
      IS DISTINCT FROM 'snapshot_restore'
    AND current_setting('workout_tracker.authorized_delete', true)
      IS DISTINCT FROM 'record_version_restore'
  THEN
    RAISE EXCEPTION 'Retained session equipment requirements are immutable for an exercise identity.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER session_exercises_equipment_requirements_snapshot_guard
BEFORE UPDATE OF exercise_id, equipment_requirements_semantics_version,
  equipment_requirements_snapshot ON session_exercises
FOR EACH ROW EXECUTE FUNCTION guard_session_equipment_requirements_snapshot();
