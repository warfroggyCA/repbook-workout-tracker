CREATE TABLE "archive_operation_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"relationship_role" text DEFAULT 'root' NOT NULL,
	"parent_entity_type" text,
	"parent_entity_id" text,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archive_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"summary" text NOT NULL,
	"record_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "fatigue_logs" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fatigue_logs" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "pain_logs" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pain_logs" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "session_notes" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_notes" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "health_activities" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "health_activities" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "history_import_batches" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "history_import_batches" ADD COLUMN "archive_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "archive_operation_records" ADD CONSTRAINT "archive_operation_records_operation_id_archive_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_operation_records" ADD CONSTRAINT "archive_operation_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_operations" ADD CONSTRAINT "archive_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_operation_records_member_uq" ON "archive_operation_records" USING btree ("operation_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "archive_operation_records_entity_idx" ON "archive_operation_records" USING btree ("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "archive_operations_user_created_idx" ON "archive_operations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "archive_operations_user_status_idx" ON "archive_operations" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD CONSTRAINT "completed_sets_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fatigue_logs" ADD CONSTRAINT "fatigue_logs_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_logs" ADD CONSTRAINT "pain_logs_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_notes" ADD CONSTRAINT "session_notes_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD CONSTRAINT "workout_sessions_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_activities" ADD CONSTRAINT "health_activities_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_import_batches" ADD CONSTRAINT "history_import_batches_archive_operation_id_archive_operations_id_fk" FOREIGN KEY ("archive_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;