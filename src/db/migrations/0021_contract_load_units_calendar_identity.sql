DO $$
DECLARE
  unresolved integer;
BEGIN
  SELECT count(*) INTO unresolved FROM production_data_repair_preview;
  IF unresolved > 0 THEN
    RAISE EXCEPTION
      'Unit/calendar contract blocked: % unresolved row(s) remain in production_data_repair_preview.',
      unresolved
      USING ERRCODE = '23514';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "timezone" SET DEFAULT 'America/Toronto';--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "timezone" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_sessions" ALTER COLUMN "timezone" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_sessions" ALTER COLUMN "local_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "exercise_prescriptions" ADD CONSTRAINT "exercise_prescriptions_target_load_unit_check" CHECK (("exercise_prescriptions"."target_load" IS NULL AND "exercise_prescriptions"."target_load_unit" IS NULL) OR ("exercise_prescriptions"."target_load" IS NOT NULL AND "exercise_prescriptions"."target_load_unit" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "completed_sets" ADD CONSTRAINT "completed_sets_weight_unit_check" CHECK (("completed_sets"."weight" IS NULL AND "completed_sets"."weight_unit" IS NULL) OR ("completed_sets"."weight" IS NOT NULL AND "completed_sets"."weight_unit" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_target_load_unit_check" CHECK (("session_exercises"."target_load" IS NULL AND "session_exercises"."target_load_unit" IS NULL) OR ("session_exercises"."target_load" IS NOT NULL AND "session_exercises"."target_load_unit" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD CONSTRAINT "workout_sessions_local_calendar_check" CHECK ("workout_sessions"."local_date" = timezone("workout_sessions"."timezone", "workout_sessions"."started_at")::date);
