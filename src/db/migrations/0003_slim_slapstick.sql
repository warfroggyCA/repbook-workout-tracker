CREATE TYPE "public"."activity_class" AS ENUM('strength', 'conditioning', 'mobility', 'stretch', 'activation', 'warmup');--> statement-breakpoint
CREATE TYPE "public"."load_semantics" AS ENUM('total', 'per_implement', 'bodyweight', 'added_weight', 'assistance', 'machine_stack', 'resistance_band', 'none');--> statement-breakpoint
CREATE TYPE "public"."metric_type" AS ENUM('weight_reps', 'reps', 'assisted_reps', 'duration', 'distance_duration', 'activity');--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'trap_bar';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'smith_machine';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'suspension';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'medicine_ball';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'stability_ball';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'foam_roller';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'sled';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'rowing_machine';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'stationary_bike';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'treadmill';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'stair_machine';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'dip_station';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'box';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'landmine';--> statement-breakpoint
ALTER TYPE "public"."equipment_type" ADD VALUE 'battle_rope';--> statement-breakpoint
ALTER TYPE "public"."import_status" ADD VALUE 'removed';--> statement-breakpoint
ALTER TYPE "public"."movement_pattern" ADD VALUE 'rotation';--> statement-breakpoint
ALTER TYPE "public"."movement_pattern" ADD VALUE 'locomotion';--> statement-breakpoint
ALTER TYPE "public"."movement_pattern" ADD VALUE 'olympic_lift';--> statement-breakpoint
ALTER TYPE "public"."movement_pattern" ADD VALUE 'plyometric';--> statement-breakpoint
ALTER TYPE "public"."movement_pattern" ADD VALUE 'mobility';--> statement-breakpoint
ALTER TYPE "public"."movement_pattern" ADD VALUE 'stretch';--> statement-breakpoint
CREATE TABLE "equipment_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"category" "equipment_type" NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercise_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"movement_pattern" "movement_pattern" NOT NULL,
	"primary_muscles" jsonb NOT NULL,
	"secondary_muscles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercise_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exercise_id" uuid NOT NULL,
	"source_name" text NOT NULL,
	"source_id" text,
	"source_url" text,
	"license" text,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "external_exercise_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_exercise_id" text,
	"source_name" text NOT NULL,
	"source_equipment" text,
	"normalized_key" text NOT NULL,
	"exercise_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "history_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"import_event_id" uuid NOT NULL,
	"source" text NOT NULL,
	"original_filename" text NOT NULL,
	"file_hash" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"summary" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "completed_sets" ALTER COLUMN "reps" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "equipment_items" ADD COLUMN "definition_id" uuid;--> statement-breakpoint
ALTER TABLE "exercise_equipment_requirements" ADD COLUMN "equipment_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "secondary_muscles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "activity_class" "activity_class" DEFAULT 'strength' NOT NULL;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "metric_type" "metric_type" DEFAULT 'weight_reps' NOT NULL;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "load_semantics" "load_semantics" DEFAULT 'total' NOT NULL;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "variant_key" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "variant_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "catalog_reviewed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "created_from_import_event_id" uuid;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD COLUMN "weight_unit" "unit";--> statement-breakpoint
ALTER TABLE "completed_sets" ADD COLUMN "metric_type" "metric_type" DEFAULT 'weight_reps' NOT NULL;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD COLUMN "distance_km" real;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD COLUMN "source_set_index" integer;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD COLUMN "source_row" integer;--> statement-breakpoint
ALTER TABLE "completed_sets" ADD COLUMN "exclude_from_analytics" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "source_exercise_key" text;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD COLUMN "source_exercise_name" text;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "source" text DEFAULT 'tracker' NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "source_workout_key" text;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "data_quality_flags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD COLUMN "exclude_duration_from_analytics" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "exercise_sources" ADD CONSTRAINT "exercise_sources_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_exercise_mappings" ADD CONSTRAINT "external_exercise_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_exercise_mappings" ADD CONSTRAINT "external_exercise_mappings_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_import_batches" ADD CONSTRAINT "history_import_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_import_batches" ADD CONSTRAINT "history_import_batches_import_event_id_import_events_id_fk" FOREIGN KEY ("import_event_id") REFERENCES "public"."import_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_definitions_key_idx" ON "equipment_definitions" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_families_key_idx" ON "exercise_families" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_families_name_idx" ON "exercise_families" USING btree ("name");--> statement-breakpoint
CREATE INDEX "exercise_sources_exercise_idx" ON "exercise_sources" USING btree ("exercise_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_exercise_mappings_user_source_key_idx" ON "external_exercise_mappings" USING btree ("user_id","source","normalized_key");--> statement-breakpoint
CREATE INDEX "external_exercise_mappings_exercise_idx" ON "external_exercise_mappings" USING btree ("exercise_id");--> statement-breakpoint
CREATE INDEX "history_import_batches_user_idx" ON "history_import_batches" USING btree ("user_id","confirmed_at");--> statement-breakpoint
CREATE INDEX "history_import_batches_hash_idx" ON "history_import_batches" USING btree ("user_id","file_hash","status");--> statement-breakpoint
ALTER TABLE "equipment_items" ADD CONSTRAINT "equipment_items_definition_id_equipment_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."equipment_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_equipment_requirements" ADD CONSTRAINT "exercise_equipment_requirements_equipment_definition_id_equipment_definitions_id_fk" FOREIGN KEY ("equipment_definition_id") REFERENCES "public"."equipment_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_family_id_exercise_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."exercise_families"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD CONSTRAINT "workout_sessions_import_batch_id_history_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."history_import_batches"("id") ON DELETE cascade ON UPDATE no action;