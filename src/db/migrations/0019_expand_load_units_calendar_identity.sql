ALTER TABLE "user_profiles" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "exercise_prescriptions" ADD COLUMN "target_load_unit" "unit";--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "target_load_unit" "unit";--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "local_date" date;