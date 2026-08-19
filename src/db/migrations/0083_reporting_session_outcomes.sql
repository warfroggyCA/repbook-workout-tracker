ALTER TYPE "skip_reason" ADD VALUE IF NOT EXISTS 'time_limit_reached';
--> statement-breakpoint
ALTER TYPE "skip_reason" ADD VALUE IF NOT EXISTS 'pain_discomfort';
--> statement-breakpoint
ALTER TYPE "skip_reason" ADD VALUE IF NOT EXISTS 'equipment_unavailable_incompatible';
--> statement-breakpoint
ALTER TYPE "skip_reason" ADD VALUE IF NOT EXISTS 'user_choice';
--> statement-breakpoint
ALTER TYPE "skip_reason" ADD VALUE IF NOT EXISTS 'technical_app_issue';
--> statement-breakpoint
ALTER TYPE "skip_reason" ADD VALUE IF NOT EXISTS 'interruption';
--> statement-breakpoint
ALTER TYPE "skip_reason" ADD VALUE IF NOT EXISTS 'program_change';
--> statement-breakpoint
ALTER TABLE "workout_sessions"
ADD COLUMN "planned_duration_semantics_version" integer;
--> statement-breakpoint
ALTER TABLE "workout_sessions"
ADD COLUMN "planned_duration_min_minutes" integer;
--> statement-breakpoint
ALTER TABLE "workout_sessions"
ADD COLUMN "planned_duration_max_minutes" integer;
--> statement-breakpoint
ALTER TABLE "workout_sessions"
ADD COLUMN "planned_duration_source" text;
--> statement-breakpoint
ALTER TABLE "workout_sessions"
ADD COLUMN "completion_semantics_version" integer;
--> statement-breakpoint
ALTER TABLE "workout_sessions"
ADD COLUMN "completion_state" text;
--> statement-breakpoint
ALTER TABLE "workout_sessions"
ADD COLUMN "completion_reason" text;
--> statement-breakpoint
ALTER TABLE "session_occurrences"
ADD COLUMN "resolution_semantics_version" integer;
--> statement-breakpoint
ALTER TABLE "session_occurrences"
ADD COLUMN "resolution_reason_code" text;
--> statement-breakpoint
ALTER TABLE "session_exercises"
ADD COLUMN "prescribed_counting_semantics_version" integer;
--> statement-breakpoint
ALTER TABLE "session_exercises"
ADD COLUMN "prescribed_counting_basis" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_session_exercise_prescribed_semantics()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(
    current_setting('workout_tracker.authorized_delete', true),
    ''
  ) = 'snapshot_restore' THEN
    RETURN NEW;
  END IF;
  IF ROW(
    OLD.prescribed_semantics_version,
    OLD.prescribed_exercise_name,
    OLD.prescribed_metric_type,
    OLD.prescribed_load_type,
    OLD.prescribed_load_semantics,
    OLD.prescribed_counting_semantics_version,
    OLD.prescribed_counting_basis
  ) IS DISTINCT FROM ROW(
    NEW.prescribed_semantics_version,
    NEW.prescribed_exercise_name,
    NEW.prescribed_metric_type,
    NEW.prescribed_load_type,
    NEW.prescribed_load_semantics,
    NEW.prescribed_counting_semantics_version,
    NEW.prescribed_counting_basis
  ) THEN
    RAISE EXCEPTION 'Workout prescribed exercise meaning is immutable.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_workout_session_reporting_semantics()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(
    current_setting('workout_tracker.authorized_delete', true),
    ''
  ) = 'snapshot_restore' THEN
    RETURN NEW;
  END IF;

  IF ROW(
    OLD.planned_duration_semantics_version,
    OLD.planned_duration_min_minutes,
    OLD.planned_duration_max_minutes,
    OLD.planned_duration_source
  ) IS DISTINCT FROM ROW(
    NEW.planned_duration_semantics_version,
    NEW.planned_duration_min_minutes,
    NEW.planned_duration_max_minutes,
    NEW.planned_duration_source
  ) THEN
    RAISE EXCEPTION 'Workout planned duration meaning is immutable.'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    OLD.completion_semantics_version,
    OLD.completion_state,
    OLD.completion_reason
  ) IS DISTINCT FROM ROW(
    NEW.completion_semantics_version,
    NEW.completion_state,
    NEW.completion_reason
  ) THEN
    IF NOT (
      OLD.status = 'in_progress'
      AND OLD.completion_semantics_version IS NULL
      AND OLD.completion_state IS NULL
      AND OLD.completion_reason IS NULL
      AND NEW.status IN ('completed', 'abandoned')
      AND NEW.completion_semantics_version IS NOT NULL
      AND NEW.completion_state IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Workout completion meaning is immutable after its terminal transition.'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workout_sessions_reporting_semantics_immutable
  BEFORE UPDATE ON "workout_sessions"
  FOR EACH ROW EXECUTE FUNCTION protect_workout_session_reporting_semantics();
--> statement-breakpoint
ALTER TABLE "workout_sessions"
ADD CONSTRAINT "workout_sessions_planned_duration_tuple_check"
CHECK (
  (
    "planned_duration_semantics_version" IS NULL
    AND "planned_duration_min_minutes" IS NULL
    AND "planned_duration_max_minutes" IS NULL
    AND "planned_duration_source" IS NULL
  ) OR (
    "planned_duration_semantics_version" = 1
    AND "planned_duration_min_minutes" IS NOT NULL
    AND "planned_duration_max_minutes" IS NOT NULL
    AND "planned_duration_source" IS NOT NULL
    AND "planned_duration_min_minutes" BETWEEN 5 AND 600
    AND "planned_duration_max_minutes"
      BETWEEN "planned_duration_min_minutes" AND 600
    AND "planned_duration_source" IN (
      'program_day_target',
      'program_day_duration_override'
    )
  )
);
--> statement-breakpoint
ALTER TABLE "workout_sessions"
ADD CONSTRAINT "workout_sessions_completion_tuple_check"
CHECK (
  (
    "completion_semantics_version" IS NULL
    AND "completion_state" IS NULL
    AND "completion_reason" IS NULL
  ) OR (
    "completion_semantics_version" = 1
    AND "completion_state" IS NOT NULL
    AND (
      (
        "status" = 'completed'
        AND "completion_state" = 'completed_without_prescription'
        AND "completion_reason" IS NULL
        AND "template_id" IS NULL
        AND "source_program_id" IS NULL
        AND "source_program_version_id" IS NULL
        AND "source_day_lineage_id" IS NULL
      ) OR (
        "status" = 'completed'
        AND "completion_state" IN (
          'completed_as_prescribed',
          'completed_with_changes'
        )
        AND "completion_reason" IS NULL
      ) OR (
        "status" = 'completed'
        AND "completion_state" = 'completed_with_remaining_work'
        AND "completion_reason" IS NOT NULL
        AND "completion_reason" IN (
          'time_limit_reached',
          'fatigue',
          'pain_discomfort',
          'equipment_unavailable_incompatible',
          'user_choice',
          'technical_app_issue',
          'interruption',
          'program_change'
        )
      ) OR (
        "status" = 'abandoned'
        AND "completion_state" = 'abandoned'
        AND "completion_reason" = 'user_choice'
      )
    )
  )
);
--> statement-breakpoint
ALTER TABLE "session_occurrences"
ADD CONSTRAINT "session_occurrences_resolution_reason_tuple_check"
CHECK (
  (
    "resolution_semantics_version" IS NULL
    AND "resolution_reason_code" IS NULL
  ) OR (
    "resolution_semantics_version" = 1
    AND "resolution_reason_code" IS NOT NULL
    AND (
      (
        "outcome" = 'skipped'
        AND "resolution_reason_code" IN (
          'time_limit_reached',
          'fatigue',
          'pain_discomfort',
          'equipment_unavailable_incompatible',
          'user_choice',
          'technical_app_issue',
          'interruption',
          'program_change'
        )
      ) OR (
        "outcome" = 'abandoned'
        AND "resolution_reason_code" IN (
          'time_limit_reached',
          'fatigue',
          'pain_discomfort',
          'equipment_unavailable_incompatible',
          'user_choice',
          'technical_app_issue',
          'interruption',
          'program_change',
          'session_completed'
        )
      )
    )
  )
);
--> statement-breakpoint
ALTER TABLE "session_exercises"
ADD CONSTRAINT "session_exercises_prescribed_counting_tuple_check"
CHECK (
  (
    "prescribed_counting_semantics_version" IS NULL
    AND "prescribed_counting_basis" IS NULL
  ) OR (
    "prescribed_counting_semantics_version" IS NOT NULL
    AND "prescribed_counting_semantics_version" = 1
    AND "prescribed_counting_basis" IS NOT NULL
    AND "prescribed_counting_basis" = 'not_applicable'
    AND "prescribed_semantics_version" IS NOT NULL
    AND "prescribed_semantics_version" = 1
    AND "prescribed_metric_type" IS NOT NULL
    AND "prescribed_metric_type" IN ('weight_reps', 'assisted_reps')
  )
);
