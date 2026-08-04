-- U02 keeps ordinary set logging minimal while retaining explicit exception
-- evidence without inferring that missing context means no issue.

ALTER TYPE "pain_source" ADD VALUE IF NOT EXISTS 'set_exception';
--> statement-breakpoint

ALTER TABLE "completed_sets"
  ADD COLUMN "rir" real,
  ADD COLUMN "technique_issue" text,
  ADD COLUMN "limitation_cause" text;
--> statement-breakpoint

ALTER TABLE "completed_sets"
  ADD CONSTRAINT "completed_sets_effort_measure_valid"
  CHECK ("rir" IS NULL OR ("rir" BETWEEN 0 AND 10 AND "rpe" IS NULL)),
  ADD CONSTRAINT "completed_sets_technique_issue_valid"
  CHECK (
    "technique_issue" IS NULL OR "technique_issue" IN (
      'bracing', 'range_of_motion', 'control', 'balance', 'positioning',
      'tempo', 'other'
    )
  ),
  ADD CONSTRAINT "completed_sets_limitation_cause_valid"
  CHECK (
    "limitation_cause" IS NULL OR "limitation_cause" IN (
      'strength_fatigue', 'breathing_conditioning', 'grip', 'mobility',
      'pain', 'technique', 'equipment_setup', 'time', 'other'
    )
  );
--> statement-breakpoint

CREATE UNIQUE INDEX "pain_logs_active_completed_set_uq"
  ON "pain_logs" USING btree ("completed_set_id")
  WHERE "archived_at" IS NULL AND "completed_set_id" IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_pain_completed_set_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  expected_session_id uuid;
  expected_exercise_id uuid;
  expected_user_id uuid;
BEGIN
  IF NEW.completed_set_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.body_part NOT IN (
       'shoulder', 'knee', 'back', 'elbow', 'wrist', 'hip', 'other'
     ) OR
     NEW.severity NOT BETWEEN 1 AND 10 OR
     NEW.source::text NOT IN ('set_flag', 'set_exception') OR
     length(coalesce(NEW.note, '')) > 500
  THEN
    RAISE EXCEPTION 'Set-linked pain evidence has an invalid location, severity, source, or note.'
      USING ERRCODE = '23514';
  END IF;

  SELECT se.session_id, se.exercise_id, ws.user_id
  INTO expected_session_id, expected_exercise_id, expected_user_id
  FROM completed_sets completed
  JOIN session_exercises se ON se.id = completed.session_exercise_id
  JOIN workout_sessions ws ON ws.id = se.session_id
  WHERE completed.id = NEW.completed_set_id;

  IF expected_session_id IS NULL OR
     NEW.session_id IS DISTINCT FROM expected_session_id OR
     NEW.exercise_id IS DISTINCT FROM expected_exercise_id OR
     NEW.user_id IS DISTINCT FROM expected_user_id
  THEN
    RAISE EXCEPTION 'Set-linked pain evidence must match the completed set owner, workout, and exercise.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER pain_logs_completed_set_context_valid
  BEFORE INSERT OR UPDATE OF
    "user_id", "session_id", "exercise_id", "completed_set_id",
    "body_part", "severity", "source", "note"
  ON "pain_logs"
  FOR EACH ROW EXECUTE FUNCTION validate_pain_completed_set_context();
