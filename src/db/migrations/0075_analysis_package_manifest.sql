CREATE TABLE "analysis_package_manifests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"package_namespace" text NOT NULL,
	"schema_version" text NOT NULL,
	"semantic_version" text NOT NULL,
	"digest_algorithm" text NOT NULL,
	"digest" text NOT NULL,
	"scope" jsonb NOT NULL,
	"inventory" jsonb NOT NULL,
	"source_bindings" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"evidence_cutoff" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analysis_package_manifests_schema_check" CHECK ("analysis_package_manifests"."schema_version" = 'analysis-package/1' AND "analysis_package_manifests"."semantic_version" = 'repbook-v2/1'),
	CONSTRAINT "analysis_package_manifests_digest_check" CHECK ("analysis_package_manifests"."package_namespace" ~ '^repbook-owner/[0-9a-f]{24}$' AND "analysis_package_manifests"."digest_algorithm" = 'sha256' AND "analysis_package_manifests"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "analysis_package_manifests_shape_check" CHECK (jsonb_typeof("analysis_package_manifests"."scope") = 'object' AND jsonb_typeof("analysis_package_manifests"."inventory") = 'object' AND jsonb_typeof("analysis_package_manifests"."inventory"->'included') = 'object' AND jsonb_typeof("analysis_package_manifests"."inventory"->'omitted') = 'array' AND jsonb_typeof("analysis_package_manifests"."source_bindings") = 'array'),
	CONSTRAINT "analysis_package_manifests_retention_check" CHECK ("analysis_package_manifests"."evidence_cutoff" <= "analysis_package_manifests"."created_at" AND "analysis_package_manifests"."created_at" < "analysis_package_manifests"."expires_at" AND "analysis_package_manifests"."expires_at" <= "analysis_package_manifests"."created_at" + interval '30 days')
);
--> statement-breakpoint
ALTER TABLE "analysis_package_manifests" ADD CONSTRAINT "analysis_package_manifests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_package_manifests_owner_digest_uq" ON "analysis_package_manifests" USING btree ("user_id","digest");
--> statement-breakpoint
CREATE INDEX "analysis_package_manifests_owner_expiry_idx" ON "analysis_package_manifests" USING btree ("user_id","expires_at");
