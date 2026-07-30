ALTER TABLE "workout_template_exercises" ADD COLUMN "warmup_notes" text;--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD COLUMN "warmup_sets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD COLUMN "set_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "warmup_notes" text;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "warmup_sets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "set_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;