CREATE TABLE "integrity_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"check_key" text NOT NULL,
	"severity" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrity_findings_severity_valid" CHECK ("integrity_findings"."severity" in ('warning', 'error'))
);
--> statement-breakpoint
CREATE TABLE "recovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"source_ref" text,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_runs_kind_valid" CHECK ("recovery_runs"."kind" in ('database_backup', 'restore_drill', 'snapshot_integrity', 'application_integrity')),
	CONSTRAINT "recovery_runs_status_valid" CHECK ("recovery_runs"."status" in ('passed', 'warning', 'failed')),
	CONSTRAINT "recovery_runs_time_order_valid" CHECK ("recovery_runs"."completed_at" >= "recovery_runs"."started_at")
);
--> statement-breakpoint
ALTER TABLE "integrity_findings" ADD CONSTRAINT "integrity_findings_run_id_recovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_findings" ADD CONSTRAINT "integrity_findings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_runs" ADD CONSTRAINT "recovery_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integrity_findings_user_unresolved_idx" ON "integrity_findings" USING btree ("user_id","resolved_at","created_at");--> statement-breakpoint
CREATE INDEX "integrity_findings_run_idx" ON "integrity_findings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "recovery_runs_user_kind_completed_idx" ON "recovery_runs" USING btree ("user_id","kind","completed_at");