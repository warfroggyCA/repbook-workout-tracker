CREATE TABLE "health_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_type" text NOT NULL,
	"title" text,
	"started_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"distance_km" double precision,
	"average_pace_seconds_per_km" double precision,
	"intensity" text,
	"elevation_gain_m" double precision,
	"average_heart_rate_bpm" integer,
	"energy_kcal" double precision,
	"notes" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_record_id" text,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"original_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"exclude_from_analytics" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_activities_duration_positive" CHECK ("health_activities"."duration_seconds" > 0),
	CONSTRAINT "health_activities_distance_nonnegative" CHECK ("health_activities"."distance_km" is null or "health_activities"."distance_km" >= 0),
	CONSTRAINT "health_activities_pace_positive" CHECK ("health_activities"."average_pace_seconds_per_km" is null or "health_activities"."average_pace_seconds_per_km" > 0),
	CONSTRAINT "health_activities_elevation_nonnegative" CHECK ("health_activities"."elevation_gain_m" is null or "health_activities"."elevation_gain_m" >= 0),
	CONSTRAINT "health_activities_heart_rate_range" CHECK ("health_activities"."average_heart_rate_bpm" is null or "health_activities"."average_heart_rate_bpm" between 20 and 260),
	CONSTRAINT "health_activities_energy_nonnegative" CHECK ("health_activities"."energy_kcal" is null or "health_activities"."energy_kcal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "health_activities" ADD CONSTRAINT "health_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_activities_user_started_idx" ON "health_activities" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "health_activities_user_fingerprint_idx" ON "health_activities" USING btree ("user_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "health_activities_manual_fingerprint_uq" ON "health_activities" USING btree ("user_id","fingerprint") WHERE "health_activities"."source" = 'manual';--> statement-breakpoint
CREATE UNIQUE INDEX "health_activities_source_record_uq" ON "health_activities" USING btree ("user_id","source","source_record_id") WHERE "health_activities"."source_record_id" is not null;