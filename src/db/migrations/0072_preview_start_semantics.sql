-- T06 makes preview read-only, gives each explicit Today Start intent one
-- owner-scoped replay identity, and freezes the prescribed exercise meaning
-- used to render the resulting workout.

ALTER TABLE "workout_sessions"
  ADD COLUMN "start_request_key" text,
  ADD COLUMN "start_request_hash" text;
--> statement-breakpoint

CREATE UNIQUE INDEX "workout_sessions_start_request_uq"
  ON "workout_sessions" USING btree ("user_id", "start_request_key")
  WHERE "start_request_key" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "workout_sessions"
  ADD CONSTRAINT "workout_sessions_start_request_identity_check"
  CHECK (
    ("start_request_key" IS NULL AND "start_request_hash" IS NULL)
    OR (
      "start_request_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "start_request_hash" ~ '^[0-9a-f]{64}$'
    )
  );
--> statement-breakpoint

ALTER TABLE "session_exercises"
  ADD COLUMN "prescribed_semantics_version" integer,
  ADD COLUMN "prescribed_exercise_name" text,
  ADD COLUMN "prescribed_metric_type" "metric_type",
  ADD COLUMN "prescribed_load_type" text,
  ADD COLUMN "prescribed_load_semantics" "load_semantics";
--> statement-breakpoint

ALTER TABLE "session_exercises"
  ADD CONSTRAINT "session_exercises_prescribed_semantics_check"
  CHECK (
    num_nonnulls(
      "prescribed_semantics_version",
      "prescribed_exercise_name",
      "prescribed_metric_type",
      "prescribed_load_type",
      "prescribed_load_semantics"
    ) IN (0, 5)
    AND (
      "prescribed_semantics_version" IS NULL
      OR (
        "prescribed_semantics_version" = 1
        AND length(btrim("prescribed_exercise_name")) BETWEEN 1 AND 300
        AND length(btrim("prescribed_load_type")) BETWEEN 1 AND 50
      )
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_workout_start_request_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '') = 'snapshot_restore' THEN
    RETURN NEW;
  END IF;
  IF ROW(OLD.start_request_key, OLD.start_request_hash)
    IS DISTINCT FROM ROW(NEW.start_request_key, NEW.start_request_hash)
  THEN
    RAISE EXCEPTION 'Workout Start request identity is immutable.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER workout_sessions_start_request_identity_immutable
  BEFORE UPDATE ON "workout_sessions"
  FOR EACH ROW EXECUTE FUNCTION protect_workout_start_request_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_session_exercise_prescribed_semantics()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '') = 'snapshot_restore' THEN
    RETURN NEW;
  END IF;
  IF ROW(
    OLD.prescribed_semantics_version,
    OLD.prescribed_exercise_name,
    OLD.prescribed_metric_type,
    OLD.prescribed_load_type,
    OLD.prescribed_load_semantics
  ) IS DISTINCT FROM ROW(
    NEW.prescribed_semantics_version,
    NEW.prescribed_exercise_name,
    NEW.prescribed_metric_type,
    NEW.prescribed_load_type,
    NEW.prescribed_load_semantics
  ) THEN
    RAISE EXCEPTION 'Workout prescribed exercise meaning is immutable.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER session_exercises_prescribed_semantics_immutable
  BEFORE UPDATE ON "session_exercises"
  FOR EACH ROW EXECUTE FUNCTION protect_session_exercise_prescribed_semantics();
