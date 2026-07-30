ALTER TABLE "program_versions" ADD COLUMN "document_schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "program_versions" ADD COLUMN "publication_preflight" jsonb;--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD COLUMN "intent" jsonb;--> statement-breakpoint
ALTER TABLE "workout_templates" ADD COLUMN "intent" jsonb;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_document_schema_valid" CHECK ("program_versions"."document_schema_version" IN (1, 2));