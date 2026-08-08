CREATE UNIQUE INDEX "coaching_insights_external_response_uq"
ON "coaching_insights" ("user_id", "client_key")
WHERE "kind" = 'external_analysis_import' AND "client_key" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "coaching_insights"
ADD CONSTRAINT "coaching_insights_external_import_valid"
CHECK (
  "kind" <> 'external_analysis_import'
  OR (
    "client_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "response_status" = 'completed'
    AND "completed_at" IS NOT NULL
    AND "data_digest"->>'schemaVersion' = 'external-analysis-import/1'
    AND "data_digest"->'rawResponseRetained' = 'false'::jsonb
  )
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maintain_pending_recommendation_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  affected_program_id uuid;
  affected_user_id uuid;
  source_slot_id uuid;
  source_lineage_id uuid;
  affected_payload jsonb;
  affected_source text;
  affected_rule_id text;
  affected_insight_id uuid;
  affected_evidence jsonb;
  should_increment boolean := false;
  is_external_review boolean := false;
BEGIN
  IF COALESCE(current_setting('workout_tracker.program_publish', true), '') = 'authorized'
     OR COALESCE(current_setting('workout_tracker.authorized_delete', true), '') IN ('snapshot_restore', 'permanent') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    should_increment := NEW.status = 'pending';
  ELSIF TG_OP = 'DELETE' THEN
    should_increment := OLD.status = 'pending';
  ELSE
    should_increment := (NEW.status = 'pending' OR OLD.status = 'pending') AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.source IS DISTINCT FROM OLD.source
      OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
      OR NEW.insight_id IS DISTINCT FROM OLD.insight_id
      OR NEW.payload IS DISTINCT FROM OLD.payload
      OR NEW.evidence IS DISTINCT FROM OLD.evidence
      OR NEW.source_template_exercise_id IS DISTINCT FROM OLD.source_template_exercise_id
      OR NEW.source_slot_lineage_id IS DISTINCT FROM OLD.source_slot_lineage_id
    );
  END IF;
  IF NOT should_increment THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    affected_user_id := OLD.user_id;
    source_slot_id := OLD.source_template_exercise_id;
    source_lineage_id := OLD.source_slot_lineage_id;
    affected_payload := OLD.payload;
    affected_source := OLD.source;
    affected_rule_id := OLD.rule_id;
    affected_insight_id := OLD.insight_id;
    affected_evidence := OLD.evidence;
  ELSE
    affected_user_id := NEW.user_id;
    source_slot_id := NEW.source_template_exercise_id;
    source_lineage_id := NEW.source_slot_lineage_id;
    affected_payload := NEW.payload;
    affected_source := NEW.source;
    affected_rule_id := NEW.rule_id;
    affected_insight_id := NEW.insight_id;
    affected_evidence := NEW.evidence;
  END IF;

  is_external_review :=
    affected_payload->>'kind' = 'external_review'
    AND affected_source = 'ai'
    AND affected_rule_id = 'external_analysis'
    AND affected_insight_id IS NOT NULL
    AND affected_evidence->'externalAnalysis'->>'schemaVersion' = 'external-analysis-evidence-v1';

  IF is_external_review THEN
    IF source_slot_id IS NOT NULL OR source_lineage_id IS NOT NULL THEN
      RAISE EXCEPTION 'An external Review proposal cannot claim a Program exercise slot';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM coaching_insights insight
      WHERE insight.id = affected_insight_id
        AND insight.user_id = affected_user_id
        AND insight.kind = 'external_analysis_import'
        AND insight.archived_at IS NULL
        AND insight.id::text = affected_evidence->'externalAnalysis'->>'importId'
    ) THEN
      RAISE EXCEPTION 'An external Review proposal must reference its owner import receipt';
    END IF;
    SELECT program.id INTO affected_program_id
    FROM programs program
    WHERE program.user_id = affected_user_id
      AND program.status = 'active'
      AND program.archived_at IS NULL
      AND program.current_version_id IS NOT NULL
    FOR UPDATE OF program;
  ELSIF affected_payload->>'kind' = 'deload' THEN
    IF source_slot_id IS NOT NULL OR source_lineage_id IS NOT NULL THEN
      RAISE EXCEPTION 'A Program-wide recommendation cannot reference an exercise slot';
    END IF;
    SELECT program.id INTO affected_program_id
    FROM programs program
    WHERE program.user_id = affected_user_id
      AND program.status = 'active'
      AND program.archived_at IS NULL
      AND program.current_version_id IS NOT NULL
    FOR UPDATE OF program;
  ELSE
    SELECT program.id INTO affected_program_id
    FROM programs program
    JOIN workout_templates day ON day.program_version_id = program.current_version_id
    JOIN workout_template_exercises slot ON slot.workout_template_id = day.id
    WHERE program.user_id = affected_user_id
      AND program.status = 'active'
      AND program.archived_at IS NULL
      AND slot.id = source_slot_id
      AND slot.lineage_id = source_lineage_id
    FOR UPDATE OF program;
  END IF;
  IF affected_program_id IS NULL THEN
    RAISE EXCEPTION 'A pending recommendation must reference its owner current Program slot';
  END IF;
  UPDATE programs
  SET recommendation_revision = recommendation_revision + 1
  WHERE id = affected_program_id;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER "pending_recommendation_revision_guard" ON "recommendations";
--> statement-breakpoint
CREATE TRIGGER pending_recommendation_revision_guard
AFTER INSERT OR UPDATE OF status, source, rule_id, insight_id, payload, evidence, source_template_exercise_id, source_slot_lineage_id OR DELETE ON recommendations
FOR EACH ROW EXECUTE FUNCTION maintain_pending_recommendation_revision();
