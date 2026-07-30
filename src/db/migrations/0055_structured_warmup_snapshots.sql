ALTER TABLE "session_occurrences" DROP CONSTRAINT "session_occurrences_load_percent_valid";--> statement-breakpoint
ALTER TABLE "workout_templates" ADD COLUMN "warmup_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "day_warmup_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session_occurrences" ADD CONSTRAINT "session_occurrences_load_percent_valid" CHECK ("session_occurrences"."planned_load_percent" IS NULL OR "session_occurrences"."planned_load_percent" BETWEEN 0 AND 500);--> statement-breakpoint
UPDATE "workout_templates"
SET "warmup_items" = jsonb_build_array(jsonb_build_object(
  'key', "id"::text,
  'label', "warmup_notes",
  'reps', NULL,
  'load', NULL,
  'loadUnit', NULL,
  'loadPercent', NULL,
  'loadText', NULL,
  'notes', NULL
))
WHERE nullif(btrim("warmup_notes"), '') IS NOT NULL
  AND "warmup_items" = '[]'::jsonb;
