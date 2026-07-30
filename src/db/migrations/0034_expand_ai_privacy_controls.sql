CREATE TABLE "ai_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task" text NOT NULL,
	"logical_key" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"lease_id" uuid NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"network_hash" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"estimated_cost_microusd" integer,
	"audio_seconds" integer,
	"failure_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ai_usage_events_status_valid" CHECK ("ai_usage_events"."status" IN ('running', 'completed', 'failed', 'cancelled', 'timed_out')),
	CONSTRAINT "ai_usage_events_usage_nonnegative" CHECK (COALESCE("ai_usage_events"."input_tokens", 0) >= 0 AND COALESCE("ai_usage_events"."output_tokens", 0) >= 0 AND COALESCE("ai_usage_events"."total_tokens", 0) >= 0 AND COALESCE("ai_usage_events"."estimated_cost_microusd", 0) >= 0 AND COALESCE("ai_usage_events"."audio_seconds", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "coaching_insights" DROP CONSTRAINT "coaching_insights_response_status_valid";--> statement-breakpoint
DROP INDEX "coaching_insights_live_pending_reply_uq";--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "generation_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "generation_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "generation_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_parsing_events" ADD COLUMN "input_sha256" text;--> statement-breakpoint
ALTER TABLE "ai_parsing_events" ADD COLUMN "raw_redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_parsing_events" ADD COLUMN "retention_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_events" ADD COLUMN "payload_sha256" text;--> statement-breakpoint
ALTER TABLE "import_events" ADD COLUMN "raw_redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_events" ADD COLUMN "retention_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_events_user_started_idx" ON "ai_usage_events" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "ai_usage_events_network_started_idx" ON "ai_usage_events" USING btree ("network_hash","started_at");--> statement-breakpoint
CREATE INDEX "ai_usage_events_running_lease_idx" ON "ai_usage_events" USING btree ("status","lease_expires_at") WHERE "ai_usage_events"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_events_running_logical_uq" ON "ai_usage_events" USING btree ("user_id","logical_key") WHERE "ai_usage_events"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "coaching_insights_live_pending_reply_uq" ON "coaching_insights" USING btree ("reply_to_id") WHERE "coaching_insights"."kind" = 'live_assistant' AND "coaching_insights"."response_status" IN ('pending', 'generating') AND "coaching_insights"."reply_to_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_response_status_valid" CHECK ("coaching_insights"."response_status" IS NULL OR "coaching_insights"."response_status" IN ('saved', 'pending', 'generating', 'completed', 'failed'));