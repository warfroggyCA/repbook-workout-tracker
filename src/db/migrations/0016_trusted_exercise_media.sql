CREATE TYPE "public"."exercise_media_hosting" AS ENUM('app_managed', 'external');--> statement-breakpoint
CREATE TYPE "public"."exercise_media_match_scope" AS ENUM('exact_variant', 'equivalent_family');--> statement-breakpoint
CREATE TYPE "public"."exercise_media_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."exercise_media_type" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TABLE "exercise_media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_type" "exercise_media_type" NOT NULL,
	"display_url" text NOT NULL,
	"original_asset_url" text NOT NULL,
	"source_page_url" text NOT NULL,
	"creator" text NOT NULL,
	"license" text NOT NULL,
	"attribution_text" text,
	"hosting" "exercise_media_hosting" NOT NULL,
	"redistribution_allowed" boolean NOT NULL,
	"checksum_sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_seconds" double precision,
	"alt_text" text NOT NULL,
	"title" text,
	"rights_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"status" "exercise_media_status" DEFAULT 'pending' NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exercise_media_assets_dimensions_check" CHECK (("exercise_media_assets"."width" IS NULL AND "exercise_media_assets"."height" IS NULL) OR ("exercise_media_assets"."width" > 0 AND "exercise_media_assets"."height" > 0)),
	CONSTRAINT "exercise_media_assets_duration_check" CHECK ("exercise_media_assets"."duration_seconds" IS NULL OR "exercise_media_assets"."duration_seconds" > 0),
	CONSTRAINT "exercise_media_assets_withdrawn_check" CHECK ("exercise_media_assets"."status" <> 'withdrawn' OR "exercise_media_assets"."withdrawn_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "exercise_media_associations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"exercise_id" uuid,
	"family_id" uuid,
	"match_scope" "exercise_media_match_scope" NOT NULL,
	"equipment_signature" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variant_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"match_notes" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_thumbnail" boolean DEFAULT false NOT NULL,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exercise_media_associations_order_check" CHECK ("exercise_media_associations"."sort_order" >= 0),
	CONSTRAINT "exercise_media_associations_target_check" CHECK ((
        "exercise_media_associations"."match_scope" = 'exact_variant'
        AND "exercise_media_associations"."exercise_id" IS NOT NULL
        AND "exercise_media_associations"."family_id" IS NULL
      ) OR (
        "exercise_media_associations"."match_scope" = 'equivalent_family'
        AND "exercise_media_associations"."exercise_id" IS NULL
        AND "exercise_media_associations"."family_id" IS NOT NULL
        AND jsonb_array_length("exercise_media_associations"."equipment_signature") > 0
      ))
);
--> statement-breakpoint
ALTER TABLE "exercise_media_associations" ADD CONSTRAINT "exercise_media_associations_asset_id_exercise_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."exercise_media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_media_associations" ADD CONSTRAINT "exercise_media_associations_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_media_associations" ADD CONSTRAINT "exercise_media_associations_family_id_exercise_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."exercise_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_media_assets_checksum_idx" ON "exercise_media_assets" USING btree ("checksum_sha256");--> statement-breakpoint
CREATE INDEX "exercise_media_assets_status_idx" ON "exercise_media_assets" USING btree ("status","disabled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_media_associations_asset_idx" ON "exercise_media_associations" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "exercise_media_associations_exercise_idx" ON "exercise_media_associations" USING btree ("exercise_id","sort_order");--> statement-breakpoint
CREATE INDEX "exercise_media_associations_family_idx" ON "exercise_media_associations" USING btree ("family_id","sort_order");