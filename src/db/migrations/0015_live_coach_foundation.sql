ALTER TABLE "coaching_insights" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "session_exercise_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "completed_set_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "reply_to_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "author" text;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "message_kind" text;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "input_mode" text;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "response_status" text;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "client_key" text;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "provider_item_id" text;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_session_exercise_id_session_exercises_id_fk" FOREIGN KEY ("session_exercise_id") REFERENCES "public"."session_exercises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_completed_set_id_completed_sets_id_fk" FOREIGN KEY ("completed_set_id") REFERENCES "public"."completed_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coaching_insights_session_created_idx" ON "coaching_insights" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coaching_insights_live_client_key_uq" ON "coaching_insights" USING btree ("user_id","client_key") WHERE "coaching_insights"."kind" = 'live_user' AND "coaching_insights"."client_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "coaching_insights_live_pending_reply_uq" ON "coaching_insights" USING btree ("reply_to_id") WHERE "coaching_insights"."kind" = 'live_assistant' AND "coaching_insights"."response_status" = 'pending' AND "coaching_insights"."reply_to_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_author_valid" CHECK ("coaching_insights"."author" IS NULL OR "coaching_insights"."author" IN ('user', 'assistant'));--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_message_kind_valid" CHECK ("coaching_insights"."message_kind" IS NULL OR "coaching_insights"."message_kind" IN ('question', 'observation', 'answer'));--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_input_mode_valid" CHECK ("coaching_insights"."input_mode" IS NULL OR "coaching_insights"."input_mode" IN ('text', 'dictation', 'realtime_voice'));--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_response_status_valid" CHECK ("coaching_insights"."response_status" IS NULL OR "coaching_insights"."response_status" IN ('saved', 'pending', 'completed', 'failed'));