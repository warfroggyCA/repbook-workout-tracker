CREATE TABLE "progression_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"coaching_prefs" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"leased_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "progression_jobs_status_check" CHECK ("progression_jobs"."status" IN ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "progression_jobs_lease_check" CHECK (("progression_jobs"."lease_token" IS NULL) = ("progression_jobs"."leased_until" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "progression_job_id" uuid;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "source_template_exercise_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "progression_jobs" ADD CONSTRAINT "progression_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progression_jobs" ADD CONSTRAINT "progression_jobs_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "progression_jobs_session_uq" ON "progression_jobs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "progression_jobs_claim_idx" ON "progression_jobs" USING btree ("status","next_attempt_at","leased_until");--> statement-breakpoint
CREATE INDEX "progression_jobs_user_idx" ON "progression_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_progression_job_id_progression_jobs_id_fk" FOREIGN KEY ("progression_job_id") REFERENCES "public"."progression_jobs"("id") ON DELETE set null ON UPDATE no action;