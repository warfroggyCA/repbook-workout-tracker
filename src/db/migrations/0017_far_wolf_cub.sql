CREATE TYPE "public"."substitution_reason" AS ENUM('variety', 'equipment_busy', 'discomfort', 'other');--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "substitution_reason" "substitution_reason";--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "substituted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "session_exercises" AS se
SET "substitution_reason" = 'other',
    "substituted_at" = COALESCE(ws."finished_at", ws."started_at")
FROM "workout_sessions" AS ws
WHERE ws."id" = se."session_id"
  AND se."substituted_for_exercise_id" IS NOT NULL;
