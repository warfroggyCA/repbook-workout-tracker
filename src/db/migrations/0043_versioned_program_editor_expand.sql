CREATE TABLE "program_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"restored_from_version_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"document" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"last_mutation_id" uuid NOT NULL,
	"reviewed_revision" integer,
	"review_hash" text,
	"review_summary" jsonb,
	"published_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"discarded_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	CONSTRAINT "program_drafts_status_valid" CHECK ("program_drafts"."status" IN ('open', 'published', 'discarded')),
	CONSTRAINT "program_drafts_revision_positive" CHECK ("program_drafts"."revision" >= 1),
	CONSTRAINT "program_drafts_review_pair_check" CHECK (("program_drafts"."reviewed_revision" IS NULL AND "program_drafts"."review_hash" IS NULL) OR ("program_drafts"."reviewed_revision" IS NOT NULL AND "program_drafts"."review_hash" IS NOT NULL))
	,CONSTRAINT "program_drafts_restore_source_check" CHECK ("program_drafts"."restored_from_version_id" IS NULL OR "program_drafts"."restored_from_version_id" <> "program_drafts"."base_version_id")
);
--> statement-breakpoint
ALTER TABLE "program_versions" ALTER COLUMN "activated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "programs" ALTER COLUMN "name" SET DEFAULT 'Program';
--> statement-breakpoint
ALTER TABLE "program_versions" ADD COLUMN "name" text;
--> statement-breakpoint
ALTER TABLE "program_versions" ADD COLUMN "parent_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "program_versions" ADD COLUMN "restored_from_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "program_versions" ADD COLUMN "publication_source" text;
--> statement-breakpoint
ALTER TABLE "program_versions" ADD COLUMN "review_hash" text;
--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "current_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "recommendation_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "superset_groups" ADD COLUMN "lineage_id" uuid;
--> statement-breakpoint
ALTER TABLE "superset_groups" ADD COLUMN "name" text;
--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD COLUMN "lineage_id" uuid;
--> statement-breakpoint
ALTER TABLE "workout_templates" ADD COLUMN "lineage_id" uuid;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "source_slot_lineage_id" uuid;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "reconciled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "reconciliation_reason" text;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "reconciled_by_program_version_id" uuid;
--> statement-breakpoint
UPDATE program_versions version
SET name = program.name,
    publication_source = CASE
      WHEN version.source_import_event_id IS NOT NULL THEN 'import'
      ELSE 'setup'
    END
FROM programs program
WHERE program.id = version.program_id;
--> statement-breakpoint
WITH candidates AS (
  SELECT DISTINCT ON (version.program_id)
    version.program_id,
    version.id,
    version.version_no
  FROM program_versions version
  ORDER BY version.program_id, version.version_no DESC,
           version.created_at DESC, version.id DESC
), unambiguous AS (
  SELECT candidate.*
  FROM candidates candidate
  WHERE (
    SELECT count(*)
    FROM program_versions peer
    WHERE peer.program_id = candidate.program_id
      AND peer.version_no = candidate.version_no
  ) = 1
)
UPDATE programs program
SET current_version_id = current_version.id
FROM unambiguous current_version
WHERE current_version.program_id = program.id;
--> statement-breakpoint
UPDATE workout_templates SET lineage_id = id WHERE lineage_id IS NULL;
--> statement-breakpoint
UPDATE superset_groups
SET lineage_id = id,
    name = 'Superset ' || (order_idx + 1)::text
WHERE lineage_id IS NULL OR name IS NULL;
--> statement-breakpoint
UPDATE workout_template_exercises SET lineage_id = id WHERE lineage_id IS NULL;
--> statement-breakpoint
ALTER TABLE "workout_templates" ALTER COLUMN "lineage_id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "superset_groups" ALTER COLUMN "lineage_id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "superset_groups" ALTER COLUMN "name" SET DEFAULT 'Superset';
--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ALTER COLUMN "lineage_id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
UPDATE recommendations recommendation
SET source_slot_lineage_id = slot.lineage_id
FROM workout_template_exercises slot
WHERE slot.id = recommendation.source_template_exercise_id
  AND recommendation.source_slot_lineage_id IS NULL;
--> statement-breakpoint
ALTER TABLE "program_drafts" ADD CONSTRAINT "program_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "program_drafts" ADD CONSTRAINT "program_drafts_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "program_drafts" ADD CONSTRAINT "program_drafts_base_version_id_program_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."program_versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "program_drafts" ADD CONSTRAINT "program_drafts_restored_from_version_id_program_versions_id_fk" FOREIGN KEY ("restored_from_version_id") REFERENCES "public"."program_versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "program_drafts" ADD CONSTRAINT "program_drafts_published_version_id_program_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."program_versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_parent_version_id_program_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_restored_from_version_id_program_versions_id_fk" FOREIGN KEY ("restored_from_version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_current_version_id_program_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."program_versions"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_reconciled_by_program_version_id_program_versions_id_fk" FOREIGN KEY ("reconciled_by_program_version_id") REFERENCES "public"."program_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "program_drafts_one_open_program_uq" ON "program_drafts" USING btree ("program_id") WHERE "program_drafts"."status" = 'open';
--> statement-breakpoint
CREATE UNIQUE INDEX "program_drafts_user_mutation_uq" ON "program_drafts" USING btree ("user_id","last_mutation_id");
--> statement-breakpoint
CREATE INDEX "program_drafts_user_updated_idx" ON "program_drafts" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE INDEX "recommendations_lineage_state_idx" ON "recommendations" USING btree ("user_id","source_slot_lineage_id","status") WHERE "recommendations"."archived_at" IS NULL AND "recommendations"."source_slot_lineage_id" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bridge_program_version_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.name IS NULL THEN
    SELECT program.name INTO NEW.name
    FROM programs program
    WHERE program.id = NEW.program_id;
  END IF;
  NEW.publication_source := COALESCE(
    NEW.publication_source,
    CASE WHEN NEW.source_import_event_id IS NULL THEN 'setup' ELSE 'import' END
  );
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bridge_program_version_fields
BEFORE INSERT ON program_versions
FOR EACH ROW EXECUTE FUNCTION bridge_program_version_fields();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bridge_program_current_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE programs program
  SET current_version_id = NEW.id
  WHERE program.id = NEW.program_id
    AND (
      program.current_version_id IS NULL
      OR EXISTS (
        SELECT 1 FROM program_versions current_version
        WHERE current_version.id = program.current_version_id
          AND current_version.version_no < NEW.version_no
      )
    );
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bridge_program_current_version
AFTER INSERT ON program_versions
FOR EACH ROW EXECUTE FUNCTION bridge_program_current_version();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bridge_recommendation_slot_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.source_template_exercise_id IS NULL THEN
    NEW.source_slot_lineage_id := NULL;
  ELSIF NEW.source_slot_lineage_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.source_template_exercise_id IS DISTINCT FROM OLD.source_template_exercise_id) THEN
    SELECT slot.lineage_id INTO NEW.source_slot_lineage_id
    FROM workout_template_exercises slot
    WHERE slot.id = NEW.source_template_exercise_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bridge_recommendation_slot_lineage
BEFORE INSERT OR UPDATE OF source_template_exercise_id, source_slot_lineage_id ON recommendations
FOR EACH ROW EXECUTE FUNCTION bridge_recommendation_slot_lineage();
