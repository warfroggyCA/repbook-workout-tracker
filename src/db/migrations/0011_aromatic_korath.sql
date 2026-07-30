CREATE TABLE "record_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before_data" jsonb NOT NULL,
	"after_data" jsonb NOT NULL,
	"changed_fields" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"source_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_versions" ADD CONSTRAINT "record_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_versions_user_created_idx" ON "record_versions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "record_versions_entity_idx" ON "record_versions" USING btree ("user_id","entity_type","entity_id","created_at");