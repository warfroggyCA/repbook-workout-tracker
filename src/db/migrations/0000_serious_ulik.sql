CREATE TYPE "public"."actor_type" AS ENUM('user', 'rule', 'ai', 'system');--> statement-breakpoint
CREATE TYPE "public"."ai_task_scope" AS ENUM('setup', 'import', 'log', 'review');--> statement-breakpoint
CREATE TYPE "public"."decision" AS ENUM('approve', 'reject', 'edit');--> statement-breakpoint
CREATE TYPE "public"."equipment_type" AS ENUM('barbell', 'ez_bar', 'rack', 'bench', 'dumbbell', 'kettlebell', 'plates', 'bands', 'jump_rope', 'elliptical', 'pullup_bar', 'cable', 'machine', 'bodyweight', 'other');--> statement-breakpoint
CREATE TYPE "public"."experience" AS ENUM('novice', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."export_kind" AS ENUM('csv', 'json', 'markdown');--> statement-breakpoint
CREATE TYPE "public"."import_source" AS ENUM('paste', 'csv', 'json', 'backup');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('raw', 'parsed', 'confirmed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."modification_type" AS ENUM('as_planned', 'substituted', 'added', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."movement_pattern" AS ENUM('squat', 'hinge', 'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull', 'lunge', 'carry', 'core', 'isolation_arms', 'isolation_shoulders', 'isolation_legs', 'conditioning');--> statement-breakpoint
CREATE TYPE "public"."pain_source" AS ENUM('set_flag', 'session_note', 'checkin');--> statement-breakpoint
CREATE TYPE "public"."recommendation_source" AS ENUM('rule', 'ai');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('pending', 'approved', 'rejected', 'edited', 'expired');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('in_progress', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."skip_reason" AS ENUM('time', 'pain', 'fatigue', 'equipment', 'other');--> statement-breakpoint
CREATE TYPE "public"."unit" AS ENUM('lb', 'kg');--> statement-breakpoint
CREATE TABLE "constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"body_part" text NOT NULL,
	"affected_patterns" jsonb NOT NULL,
	"avoid" boolean DEFAULT false NOT NULL,
	"cautious" boolean DEFAULT true NOT NULL,
	"pain_stop_threshold" integer DEFAULT 3 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"age_range" text,
	"experience" "experience" DEFAULT 'intermediate' NOT NULL,
	"goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"session_length_min" integer DEFAULT 45 NOT NULL,
	"weekly_frequency" integer DEFAULT 3 NOT NULL,
	"unit" "unit" DEFAULT 'lb' NOT NULL,
	"coaching_prefs" jsonb DEFAULT '{"aggressiveness":"conservative","deloadSuggestions":true,"substitutionSuggestions":true,"weeklyReview":true}'::jsonb NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"setup_state" jsonb DEFAULT '{"completedSteps":[],"routineDraft":null}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "barbell_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"bar_type" text NOT NULL,
	"bar_weight" real NOT NULL,
	"collar_weight" real DEFAULT 0 NOT NULL,
	"label" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "equipment_type" NOT NULL,
	"label" text NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plate_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"denomination" real NOT NULL,
	"count_per_side" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercise_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exercise_id" uuid NOT NULL,
	"alias" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercise_equipment_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exercise_id" uuid NOT NULL,
	"equipment_type" "equipment_type" NOT NULL,
	"min_weight" real
);
--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"movement_pattern" "movement_pattern" NOT NULL,
	"primary_muscles" jsonb NOT NULL,
	"is_unilateral" boolean DEFAULT false NOT NULL,
	"load_type" text DEFAULT 'external' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercise_prescriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_exercise_id" uuid NOT NULL,
	"sets" integer NOT NULL,
	"rep_range_min" integer NOT NULL,
	"rep_range_max" integer NOT NULL,
	"target_load" real,
	"progression_rule_id" text DEFAULT 'double_progression' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"version_no" integer DEFAULT 1 NOT NULL,
	"activated_at" timestamp with time zone,
	"source_import_event_id" uuid,
	"change_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "superset_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workout_template_id" uuid NOT NULL,
	"order_idx" integer DEFAULT 0 NOT NULL,
	"rest_after_round_sec" integer DEFAULT 90 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_template_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workout_template_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"order_idx" integer DEFAULT 0 NOT NULL,
	"superset_group_id" uuid,
	"rest_sec" integer DEFAULT 90 NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "workout_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"order_idx" integer DEFAULT 0 NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "completed_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_exercise_id" uuid NOT NULL,
	"set_no" integer NOT NULL,
	"weight" real,
	"reps" integer NOT NULL,
	"rpe" real,
	"is_warmup" boolean DEFAULT false NOT NULL,
	"target_met" boolean,
	"rest_taken_sec" integer,
	"note" text,
	"client_key" text,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fatigue_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"severity" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pain_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"exercise_id" uuid,
	"completed_set_id" uuid,
	"body_part" text NOT NULL,
	"severity" integer NOT NULL,
	"source" "pain_source" DEFAULT 'set_flag' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"planned_from_template_exercise_id" uuid,
	"modification_type" "modification_type" DEFAULT 'as_planned' NOT NULL,
	"skip_reason" "skip_reason",
	"substituted_for_exercise_id" uuid,
	"order_idx" integer DEFAULT 0 NOT NULL,
	"superset_key" text,
	"rest_sec" integer DEFAULT 90 NOT NULL,
	"target_sets" integer,
	"target_reps_min" integer,
	"target_reps_max" integer,
	"target_load" real,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "session_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid,
	"template_name" text,
	"status" "session_status" DEFAULT 'in_progress' NOT NULL,
	"time_budget_min" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "adaptation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "coaching_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_md" text NOT NULL,
	"data_digest" jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "recommendation_status" DEFAULT 'pending' NOT NULL,
	"source" "recommendation_source" NOT NULL,
	"rule_id" text,
	"insight_id" uuid,
	"exercise_id" uuid,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"decision" "decision" NOT NULL,
	"edited_payload" jsonb,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_parsing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" "ai_task_scope" NOT NULL,
	"task" text NOT NULL,
	"raw_input" text NOT NULL,
	"raw_output" text,
	"parsed_json" jsonb,
	"schema_version" text DEFAULT '1' NOT NULL,
	"confidence" real,
	"ambiguities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_payload" jsonb,
	"model" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"summary" text NOT NULL,
	"cause_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "export_kind" NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"raw_payload" text NOT NULL,
	"parsed_payload" jsonb,
	"status" "import_status" DEFAULT 'raw' NOT NULL,
	"result_program_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "constraints" ADD CONSTRAINT "constraints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD CONSTRAINT "barbell_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_items" ADD CONSTRAINT "equipment_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plate_inventory" ADD CONSTRAINT "plate_inventory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_aliases" ADD CONSTRAINT "exercise_aliases_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_equipment_requirements" ADD CONSTRAINT "exercise_equipment_requirements_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_prescriptions" ADD CONSTRAINT "exercise_prescriptions_template_exercise_id_workout_template_exercises_id_fk" FOREIGN KEY ("template_exercise_id") REFERENCES "public"."workout_template_exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "superset_groups" ADD CONSTRAINT "superset_groups_workout_template_id_workout_templates_id_fk" FOREIGN KEY ("workout_template_id") REFERENCES "public"."workout_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD CONSTRAINT "workout_template_exercises_workout_template_id_workout_templates_id_fk" FOREIGN KEY ("workout_template_id") REFERENCES "public"."workout_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD CONSTRAINT "workout_template_exercises_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD CONSTRAINT "workout_template_exercises_superset_group_id_superset_groups_id_fk" FOREIGN KEY ("superset_group_id") REFERENCES "public"."superset_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_templates" ADD CONSTRAINT "workout_templates_program_version_id_program_versions_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."program_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD CONSTRAINT "completed_sets_session_exercise_id_session_exercises_id_fk" FOREIGN KEY ("session_exercise_id") REFERENCES "public"."session_exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fatigue_logs" ADD CONSTRAINT "fatigue_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fatigue_logs" ADD CONSTRAINT "fatigue_logs_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_logs" ADD CONSTRAINT "pain_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_logs" ADD CONSTRAINT "pain_logs_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_logs" ADD CONSTRAINT "pain_logs_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_notes" ADD CONSTRAINT "session_notes_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD CONSTRAINT "workout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD CONSTRAINT "workout_sessions_template_id_workout_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workout_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptation_events" ADD CONSTRAINT "adaptation_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptation_events" ADD CONSTRAINT "adaptation_events_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_insights" ADD CONSTRAINT "coaching_insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_parsing_events" ADD CONSTRAINT "ai_parsing_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_events" ADD CONSTRAINT "export_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_events" ADD CONSTRAINT "import_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_user_idx" ON "user_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "exercise_aliases_alias_idx" ON "exercise_aliases" USING btree ("alias");--> statement-breakpoint
CREATE UNIQUE INDEX "exercises_name_idx" ON "exercises" USING btree ("name");--> statement-breakpoint
CREATE INDEX "prescriptions_slot_idx" ON "exercise_prescriptions" USING btree ("template_exercise_id");--> statement-breakpoint
CREATE INDEX "wte_template_idx" ON "workout_template_exercises" USING btree ("workout_template_id");--> statement-breakpoint
CREATE INDEX "completed_sets_se_idx" ON "completed_sets" USING btree ("session_exercise_id");--> statement-breakpoint
CREATE INDEX "pain_logs_user_idx" ON "pain_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "session_exercises_session_idx" ON "session_exercises" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_user_started_idx" ON "workout_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "recommendations_user_status_idx" ON "recommendations" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "ai_parsing_events_user_idx" ON "ai_parsing_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id","created_at");