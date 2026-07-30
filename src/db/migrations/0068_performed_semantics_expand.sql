ALTER TABLE "completed_sets"
  ADD COLUMN "performed_semantics_version" integer,
  ADD COLUMN "performed_load_type" text,
  ADD COLUMN "performed_load_semantics" "load_semantics";
--> statement-breakpoint

ALTER TABLE "completed_sets"
  ADD CONSTRAINT "completed_sets_performed_semantics_tuple_valid"
  CHECK (
    (
      "performed_semantics_version" IS NULL
      AND "performed_load_type" IS NULL
      AND "performed_load_semantics" IS NULL
    )
    OR
    (
      "performed_semantics_version" = 1
      AND "performed_load_type" IS NOT NULL
      AND length(btrim("performed_load_type")) > 0
      AND "performed_load_semantics" IS NOT NULL
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_completed_set_semantics_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.metric_type IS DISTINCT FROM NEW.metric_type
    OR OLD.performed_semantics_version IS DISTINCT FROM NEW.performed_semantics_version
    OR OLD.performed_load_type IS DISTINCT FROM NEW.performed_load_type
    OR OLD.performed_load_semantics IS DISTINCT FROM NEW.performed_load_semantics
  THEN
    RAISE EXCEPTION 'completed set performed semantics are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER completed_sets_performed_semantics_immutable
BEFORE UPDATE OF
  "metric_type",
  "performed_semantics_version",
  "performed_load_type",
  "performed_load_semantics"
ON "completed_sets"
FOR EACH ROW
EXECUTE FUNCTION prevent_completed_set_semantics_rewrite();
