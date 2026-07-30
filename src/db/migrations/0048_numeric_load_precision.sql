DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM barbell_configs
    WHERE abs(round(bar_weight::numeric, 2)) > 99999.99
       OR abs(round(collar_weight::numeric, 2)) > 99999.99
  ) OR EXISTS (
    SELECT 1 FROM plate_inventory
    WHERE abs(round(denomination::numeric, 2)) > 99999.99
  ) OR EXISTS (
    SELECT 1 FROM exercise_equipment_requirements
    WHERE abs(round(min_weight::numeric, 2)) > 99999.99
  ) OR EXISTS (
    SELECT 1 FROM exercise_prescriptions
    WHERE abs(round(target_load::numeric, 2)) > 99999.99
  ) OR EXISTS (
    SELECT 1 FROM session_exercises
    WHERE abs(round(target_load::numeric, 2)) > 99999.99
  ) OR EXISTS (
    SELECT 1 FROM program_drafts
    WHERE jsonb_path_exists(
      document,
      '$.days[*].exercises[*] ? (@.targetLoad > 99999.99 || @.targetLoad < 0)'
    )
  ) OR EXISTS (
    SELECT 1 FROM user_profiles
    WHERE jsonb_path_exists(
      setup_state,
      '$.routineDraft.days[*].exercises[*] ? (@.targetLoad > 99999.99 || @.targetLoad < 0)'
    )
  ) THEN
    RAISE EXCEPTION 'Load migration refused: a value exceeds numeric(7,2).';
  END IF;
END $$;--> statement-breakpoint
CREATE TEMP TABLE ws_0048_dependent_views ON COMMIT DROP AS
SELECT schemaname, viewname, pg_get_viewdef(format('%I.%I', schemaname, viewname)::regclass, true) AS definition
FROM pg_views
WHERE schemaname = current_schema()
  AND viewname IN ('production_data_repair_preview', 'program_editor_repair_preview');--> statement-breakpoint
DO $$
BEGIN
  IF (SELECT count(*) FROM ws_0048_dependent_views) <> 2 THEN
    RAISE EXCEPTION 'Load migration refused: expected repair views are missing.';
  END IF;
END $$;--> statement-breakpoint
DROP VIEW "program_editor_repair_preview";--> statement-breakpoint
DROP VIEW "production_data_repair_preview";--> statement-breakpoint
ALTER TABLE "barbell_configs" ALTER COLUMN "bar_weight" SET DATA TYPE numeric(7, 2) USING round("bar_weight"::numeric, 2);--> statement-breakpoint
ALTER TABLE "barbell_configs" ALTER COLUMN "collar_weight" SET DATA TYPE numeric(7, 2) USING round("collar_weight"::numeric, 2);--> statement-breakpoint
ALTER TABLE "plate_inventory" ALTER COLUMN "denomination" SET DATA TYPE numeric(7, 2) USING round("denomination"::numeric, 2);--> statement-breakpoint
ALTER TABLE "exercise_equipment_requirements" ALTER COLUMN "min_weight" SET DATA TYPE numeric(7, 2) USING round("min_weight"::numeric, 2);--> statement-breakpoint
ALTER TABLE "exercise_prescriptions" ALTER COLUMN "target_load" SET DATA TYPE numeric(7, 2) USING round("target_load"::numeric, 2);--> statement-breakpoint
ALTER TABLE "session_exercises" ALTER COLUMN "target_load" SET DATA TYPE numeric(7, 2) USING round("target_load"::numeric, 2);--> statement-breakpoint
DO $$
DECLARE
  saved_view record;
BEGIN
  FOR saved_view IN
    SELECT * FROM ws_0048_dependent_views ORDER BY viewname
  LOOP
    EXECUTE format(
      'CREATE VIEW %I.%I AS %s',
      saved_view.schemaname,
      saved_view.viewname,
      saved_view.definition
    );
  END LOOP;
END $$;
