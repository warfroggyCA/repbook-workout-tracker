ALTER TABLE "recommendations" ADD COLUMN "review_revision" integer;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "defer_revision" integer;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "deferred_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "revisit_on" date;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "defer_reason" text;
--> statement-breakpoint
ALTER TABLE "user_decisions" ADD COLUMN "review_snapshot" jsonb;
--> statement-breakpoint
UPDATE "recommendations"
SET "review_revision" = 0, "defer_revision" = 0
WHERE "review_revision" IS NULL OR "defer_revision" IS NULL;
--> statement-breakpoint
UPDATE "user_decisions"
SET "review_snapshot" = '{"schemaVersion":"legacy-unknown"}'::jsonb
WHERE "review_snapshot" IS NULL;
--> statement-breakpoint
ALTER TABLE "recommendations" ALTER COLUMN "review_revision" SET DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "recommendations" ALTER COLUMN "review_revision" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "recommendations" ALTER COLUMN "defer_revision" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "recommendations" ALTER COLUMN "defer_revision" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_decisions" ALTER COLUMN "review_snapshot" SET DEFAULT '{"schemaVersion":"legacy-unknown"}'::jsonb;
--> statement-breakpoint
ALTER TABLE "user_decisions" ALTER COLUMN "review_snapshot" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_review_revision_check"
CHECK ("review_revision" >= 0 AND "defer_revision" >= 0);
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_defer_state_check"
CHECK (
  ("deferred_at" IS NULL AND "revisit_on" IS NULL AND "defer_reason" IS NULL)
  OR
  ("deferred_at" IS NOT NULL AND "status" = 'pending' AND "archived_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_defer_reason_check"
CHECK (
  "defer_reason" IS NULL
  OR (nullif(btrim("defer_reason"), '') IS NOT NULL AND char_length("defer_reason") <= 500)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maintain_recommendation_review_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  material_changed boolean;
BEGIN
  IF COALESCE(current_setting('workout_tracker.authorized_delete', true), '') IN ('snapshot_restore', 'permanent') THEN
    RETURN NEW;
  END IF;

  NEW.review_revision := OLD.review_revision;
  NEW.defer_revision := OLD.defer_revision;
  material_changed :=
    NEW.source IS DISTINCT FROM OLD.source
    OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
    OR NEW.exercise_id IS DISTINCT FROM OLD.exercise_id
    OR NEW.progression_job_id IS DISTINCT FROM OLD.progression_job_id
    OR NEW.source_template_exercise_id IS DISTINCT FROM OLD.source_template_exercise_id
    OR NEW.source_slot_lineage_id IS DISTINCT FROM OLD.source_slot_lineage_id
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.evidence IS DISTINCT FROM OLD.evidence;

  IF material_changed THEN
    NEW.review_revision := OLD.review_revision + 1;
    NEW.deferred_at := NULL;
    NEW.revisit_on := NULL;
    NEW.defer_reason := NULL;
  END IF;

  IF NEW.status <> 'pending' OR NEW.archived_at IS NOT NULL THEN
    NEW.deferred_at := NULL;
    NEW.revisit_on := NULL;
    NEW.defer_reason := NULL;
  END IF;

  IF NEW.deferred_at IS DISTINCT FROM OLD.deferred_at
     OR NEW.revisit_on IS DISTINCT FROM OLD.revisit_on
     OR NEW.defer_reason IS DISTINCT FROM OLD.defer_reason THEN
    NEW.defer_revision := OLD.defer_revision + 1;
  END IF;

  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER recommendation_review_state_guard
BEFORE UPDATE ON "recommendations"
FOR EACH ROW EXECUTE FUNCTION maintain_recommendation_review_state();
