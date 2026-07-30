DO $$
DECLARE
  conflict_count integer;
BEGIN
  SELECT count(*) INTO conflict_count FROM program_editor_repair_preview;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'Program editor contract blocked: % repair preview item(s) require explicit review',
      conflict_count;
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bridge_program_version_fields ON program_versions;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bridge_program_current_version ON program_versions;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bridge_recommendation_slot_lineage ON recommendations;
--> statement-breakpoint
DROP FUNCTION IF EXISTS bridge_program_version_fields();
--> statement-breakpoint
DROP FUNCTION IF EXISTS bridge_program_current_version();
--> statement-breakpoint
DROP FUNCTION IF EXISTS bridge_recommendation_slot_lineage();
--> statement-breakpoint
ALTER TABLE "program_versions" ALTER COLUMN "name" SET DEFAULT 'Program';
--> statement-breakpoint
ALTER TABLE "program_versions" ALTER COLUMN "name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "program_versions" ALTER COLUMN "publication_source" SET DEFAULT 'setup';
--> statement-breakpoint
ALTER TABLE "program_versions" ALTER COLUMN "publication_source" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "program_versions" ALTER COLUMN "activated_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workout_templates" ALTER COLUMN "lineage_id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "workout_templates" ALTER COLUMN "lineage_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "superset_groups" ALTER COLUMN "lineage_id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "superset_groups" ALTER COLUMN "lineage_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "superset_groups" ALTER COLUMN "name" SET DEFAULT 'Superset';
--> statement-breakpoint
ALTER TABLE "superset_groups" ALTER COLUMN "name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ALTER COLUMN "lineage_id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ALTER COLUMN "lineage_id" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "programs_one_active_user_uq" ON "programs" USING btree ("user_id")
WHERE "status" = 'active' AND "archived_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "programs_id_user_uq" ON "programs" USING btree ("id", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "program_versions_program_number_uq" ON "program_versions" USING btree ("program_id", "version_no");
--> statement-breakpoint
CREATE UNIQUE INDEX "program_versions_id_program_uq" ON "program_versions" USING btree ("id", "program_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workout_templates_version_order_uq" ON "workout_templates" USING btree ("program_version_id", "order_idx");
--> statement-breakpoint
CREATE UNIQUE INDEX "workout_templates_version_lineage_uq" ON "workout_templates" USING btree ("program_version_id", "lineage_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workout_templates_id_version_uq" ON "workout_templates" USING btree ("id", "program_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "superset_groups_template_order_uq" ON "superset_groups" USING btree ("workout_template_id", "order_idx");
--> statement-breakpoint
CREATE UNIQUE INDEX "superset_groups_template_lineage_uq" ON "superset_groups" USING btree ("workout_template_id", "lineage_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "superset_groups_id_template_uq" ON "superset_groups" USING btree ("id", "workout_template_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "wte_template_lineage_uq" ON "workout_template_exercises" USING btree ("workout_template_id", "lineage_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "wte_template_order_uq" ON "workout_template_exercises" USING btree ("workout_template_id", "order_idx");
--> statement-breakpoint
DROP INDEX "recommendations_progression_job_slot_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_progression_job_lineage_uq" ON "recommendations" USING btree ("progression_job_id", "source_slot_lineage_id")
WHERE "progression_job_id" IS NOT NULL AND "source_slot_lineage_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_status_valid" CHECK ("status" IN ('active', 'archived'));
--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_current_version_state_check" CHECK (
  ("status" = 'active' AND "archived_at" IS NULL AND "current_version_id" IS NOT NULL)
  OR ("status" = 'archived' AND "archived_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_number_positive" CHECK ("version_no" >= 1);
--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_source_valid" CHECK (
  "publication_source" IN ('setup', 'import', 'editor', 'recommendation', 'restore')
);
--> statement-breakpoint
ALTER TABLE "workout_templates" ADD CONSTRAINT "workout_templates_order_nonnegative" CHECK ("order_idx" >= 0);
--> statement-breakpoint
ALTER TABLE "superset_groups" ADD CONSTRAINT "superset_groups_order_nonnegative" CHECK ("order_idx" >= 0);
--> statement-breakpoint
ALTER TABLE "superset_groups" ADD CONSTRAINT "superset_groups_rest_valid" CHECK ("rest_after_round_sec" BETWEEN 0 AND 1800);
--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD CONSTRAINT "wte_order_nonnegative" CHECK ("order_idx" >= 0);
--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD CONSTRAINT "wte_rest_valid" CHECK ("rest_sec" BETWEEN 0 AND 1800);
--> statement-breakpoint
ALTER TABLE "exercise_prescriptions" ADD CONSTRAINT "exercise_prescriptions_target_bounds_check" CHECK (
  "sets" BETWEEN 1 AND 20
  AND "rep_range_min" BETWEEN 1 AND 100
  AND "rep_range_max" BETWEEN 1 AND 100
  AND "rep_range_min" <= "rep_range_max"
);
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_reconciliation_reason_check" CHECK (
  "status" <> 'expired' OR (nullif(btrim("reconciliation_reason"), '') IS NOT NULL AND "reconciled_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "workout_template_exercises" ADD CONSTRAINT "wte_superset_template_fk"
FOREIGN KEY ("superset_group_id", "workout_template_id")
REFERENCES "superset_groups"("id", "workout_template_id")
ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_parent_program_fk"
FOREIGN KEY ("parent_version_id", "program_id") REFERENCES "program_versions"("id", "program_id")
ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_restore_program_fk"
FOREIGN KEY ("restored_from_version_id", "program_id") REFERENCES "program_versions"("id", "program_id")
ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "program_drafts" ADD CONSTRAINT "program_drafts_program_owner_fk"
FOREIGN KEY ("program_id", "user_id") REFERENCES "programs"("id", "user_id")
ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "program_drafts" ADD CONSTRAINT "program_drafts_base_program_fk"
FOREIGN KEY ("base_version_id", "program_id") REFERENCES "program_versions"("id", "program_id")
ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "program_drafts" ADD CONSTRAINT "program_drafts_restore_program_fk"
FOREIGN KEY ("restored_from_version_id", "program_id") REFERENCES "program_versions"("id", "program_id")
ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "program_drafts" ADD CONSTRAINT "program_drafts_published_program_fk"
FOREIGN KEY ("published_version_id", "program_id") REFERENCES "program_versions"("id", "program_id")
ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_program_editor_relationships()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target_program_id uuid;
  duplicate_slot_count integer;
BEGIN
  IF TG_TABLE_NAME = 'programs' THEN
    IF NEW.current_version_id IS NOT NULL THEN
      SELECT pv.program_id INTO target_program_id
      FROM program_versions pv
      WHERE pv.id = NEW.current_version_id;
      IF target_program_id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Program current version must belong to the same Program';
      END IF;
      IF EXISTS (
        SELECT 1 FROM program_versions newer
        WHERE newer.program_id = NEW.id
          AND newer.version_no > (
            SELECT selected.version_no FROM program_versions selected
            WHERE selected.id = NEW.current_version_id
          )
      ) THEN
        RAISE EXCEPTION 'Program current version must be its newest version';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO duplicate_slot_count
  FROM workout_template_exercises candidate
  JOIN workout_templates candidate_day ON candidate_day.id = candidate.workout_template_id
  WHERE EXISTS (
    SELECT 1
    FROM workout_template_exercises peer
    JOIN workout_templates peer_day ON peer_day.id = peer.workout_template_id
    WHERE peer.id <> candidate.id
      AND peer_day.program_version_id = candidate_day.program_version_id
      AND peer.lineage_id = candidate.lineage_id
  );
  IF duplicate_slot_count > 0 THEN
    RAISE EXCEPTION 'Exercise slot lineage must be unique within a Program version';
  END IF;

  IF EXISTS (
    SELECT 1 FROM superset_groups sg
    WHERE (SELECT count(*) FROM workout_template_exercises wte WHERE wte.superset_group_id = sg.id) < 2
  ) THEN
    RAISE EXCEPTION 'Every superset must contain at least two exercises';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER program_current_version_owner_guard
AFTER INSERT OR UPDATE OF current_version_id ON programs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_program_editor_relationships();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER program_slot_lineage_guard
AFTER INSERT OR UPDATE OR DELETE ON workout_template_exercises
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_program_editor_relationships();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER program_superset_members_guard
AFTER INSERT OR UPDATE OR DELETE ON superset_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_program_editor_relationships();
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
  should_increment boolean := false;
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
      OR NEW.payload IS DISTINCT FROM OLD.payload
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
  ELSE
    affected_user_id := NEW.user_id;
    source_slot_id := NEW.source_template_exercise_id;
    source_lineage_id := NEW.source_slot_lineage_id;
    affected_payload := NEW.payload;
  END IF;

  IF affected_payload->>'kind' = 'deload' THEN
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
CREATE TRIGGER pending_recommendation_revision_guard
AFTER INSERT OR UPDATE OF status, payload, source_template_exercise_id, source_slot_lineage_id OR DELETE ON recommendations
FOR EACH ROW EXECUTE FUNCTION maintain_pending_recommendation_revision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_program_draft_exercise_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM program_drafts draft
    WHERE draft.user_id = OLD.user_id
      AND draft.status = 'open'
      AND draft.document::text LIKE '%' || OLD.id::text || '%'
  ) THEN
    RAISE EXCEPTION 'The custom exercise is still used in an open Program draft.'
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER program_draft_exercise_delete_guard
BEFORE DELETE ON exercises
FOR EACH ROW EXECUTE FUNCTION guard_program_draft_exercise_delete();
--> statement-breakpoint
CREATE TRIGGER protected_delete_guard
BEFORE DELETE ON program_drafts
FOR EACH ROW EXECUTE FUNCTION guard_protected_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_published_program_tree()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  old_version_id uuid;
  new_version_id uuid;
  old_version_xid bigint;
  new_version_xid bigint;
  authorized_restore text;
BEGIN
  authorized_restore := COALESCE(current_setting('workout_tracker.authorized_delete', true), '');
  IF authorized_restore IN ('snapshot_restore', 'permanent') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF COALESCE(current_setting('workout_tracker.program_publish', true), '') = 'authorized' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'program_versions' THEN
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    old_version_id := OLD.id;
    IF TG_OP = 'UPDATE' THEN new_version_id := NEW.id; END IF;
  ELSIF TG_TABLE_NAME = 'workout_templates' THEN
    IF TG_OP <> 'INSERT' THEN old_version_id := OLD.program_version_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_version_id := NEW.program_version_id; END IF;
  ELSIF TG_TABLE_NAME = 'superset_groups' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT wt.program_version_id INTO old_version_id
      FROM workout_templates wt WHERE wt.id = OLD.workout_template_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT wt.program_version_id INTO new_version_id
      FROM workout_templates wt WHERE wt.id = NEW.workout_template_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'workout_template_exercises' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT wt.program_version_id INTO old_version_id
      FROM workout_templates wt WHERE wt.id = OLD.workout_template_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT wt.program_version_id INTO new_version_id
      FROM workout_templates wt WHERE wt.id = NEW.workout_template_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'exercise_prescriptions' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT wt.program_version_id INTO old_version_id
      FROM workout_template_exercises wte
      JOIN workout_templates wt ON wt.id = wte.workout_template_id
      WHERE wte.id = OLD.template_exercise_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT wt.program_version_id INTO new_version_id
      FROM workout_template_exercises wte
      JOIN workout_templates wt ON wt.id = wte.workout_template_id
      WHERE wte.id = NEW.template_exercise_id;
    END IF;
  END IF;

  IF old_version_id IS NOT NULL THEN
    SELECT (pv.xmin::text)::bigint INTO old_version_xid
    FROM program_versions pv WHERE pv.id = old_version_id;
    IF old_version_xid IS DISTINCT FROM txid_current() THEN
      RAISE EXCEPTION 'Published Program versions are immutable';
    END IF;
  END IF;
  IF new_version_id IS NOT NULL THEN
    SELECT (pv.xmin::text)::bigint INTO new_version_xid
    FROM program_versions pv WHERE pv.id = new_version_id;
    IF new_version_xid IS DISTINCT FROM txid_current() THEN
      RAISE EXCEPTION 'Published Program versions are immutable';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER published_program_versions_immutable
BEFORE UPDATE OR DELETE ON program_versions
FOR EACH ROW EXECUTE FUNCTION guard_published_program_tree();
--> statement-breakpoint
CREATE TRIGGER published_workout_templates_immutable
BEFORE INSERT OR UPDATE OR DELETE ON workout_templates
FOR EACH ROW EXECUTE FUNCTION guard_published_program_tree();
--> statement-breakpoint
CREATE TRIGGER published_superset_groups_immutable
BEFORE INSERT OR UPDATE OR DELETE ON superset_groups
FOR EACH ROW EXECUTE FUNCTION guard_published_program_tree();
--> statement-breakpoint
CREATE TRIGGER published_template_exercises_immutable
BEFORE INSERT OR UPDATE OR DELETE ON workout_template_exercises
FOR EACH ROW EXECUTE FUNCTION guard_published_program_tree();
--> statement-breakpoint
CREATE TRIGGER published_exercise_prescriptions_immutable
BEFORE INSERT OR UPDATE OR DELETE ON exercise_prescriptions
FOR EACH ROW EXECUTE FUNCTION guard_published_program_tree();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_user_snapshot_unguarded(
  p_user_id uuid,
  p_scope text,
  p_expected_current jsonb,
  p_target_rows jsonb,
  p_dependency_rows jsonb,
  p_source_snapshot_id uuid,
  p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target_tables text[];
  delete_order text[] := ARRAY[
    'adaptation_events', 'user_decisions', 'pain_logs', 'fatigue_logs',
    'completed_sets', 'session_notes', 'session_exercises', 'workout_sessions',
    'exercise_prescriptions', 'workout_template_exercises', 'superset_groups',
    'workout_templates', 'program_drafts', 'program_versions', 'programs', 'recommendations',
    'history_import_batches', 'import_events', 'external_exercise_mappings',
    'exercise_equipment_requirements', 'exercise_aliases', 'exercise_sources',
    'exercises', 'equipment_items', 'plate_inventory', 'barbell_configs',
    'constraints', 'user_profiles', 'health_activities', 'coaching_insights',
    'ai_parsing_events', 'archive_operation_records', 'archive_operations'
  ];
  dependency_order text[] := ARRAY[
    'equipment_definitions', 'exercise_families', 'archive_operations',
    'exercises', 'exercise_aliases', 'exercise_sources',
    'exercise_equipment_requirements', 'import_events', 'programs',
    'program_versions', 'workout_templates', 'superset_groups',
    'workout_template_exercises', 'exercise_prescriptions'
  ];
  lock_order text[] := ARRAY[
    'equipment_definitions', 'exercise_families', 'archive_operations',
    'archive_operation_records', 'exercises', 'exercise_aliases',
    'exercise_sources', 'exercise_equipment_requirements',
    'external_exercise_mappings', 'user_profiles', 'constraints',
    'equipment_items', 'plate_inventory', 'barbell_configs', 'import_events',
    'history_import_batches', 'programs', 'program_versions', 'program_drafts', 'workout_templates',
    'superset_groups', 'workout_template_exercises', 'exercise_prescriptions',
    'workout_sessions', 'session_exercises', 'completed_sets', 'session_notes',
    'pain_logs', 'fatigue_logs', 'health_activities', 'coaching_insights',
    'recommendations', 'user_decisions', 'adaptation_events', 'ai_parsing_events'
  ];
  insert_order text[] := ARRAY[
    'archive_operations', 'user_profiles', 'constraints', 'equipment_items',
    'plate_inventory', 'barbell_configs', 'exercises', 'exercise_aliases',
    'exercise_sources', 'exercise_equipment_requirements', 'import_events',
    'history_import_batches', 'programs', 'program_versions', 'program_drafts', 'workout_templates',
    'superset_groups', 'workout_template_exercises', 'exercise_prescriptions',
    'workout_sessions', 'session_exercises', 'completed_sets', 'session_notes',
    'pain_logs', 'fatigue_logs', 'health_activities', 'coaching_insights',
    'recommendations', 'user_decisions', 'adaptation_events', 'ai_parsing_events',
    'external_exercise_mappings', 'archive_operation_records'
  ];
  table_name text;
  predicate text;
  current_rows jsonb;
  restored_rows integer := 0;
BEGIN
  IF p_scope = 'full' THEN
    target_tables := ARRAY[
      'user_profiles', 'constraints', 'equipment_items', 'plate_inventory',
      'barbell_configs', 'exercises', 'exercise_aliases', 'exercise_sources',
      'exercise_equipment_requirements', 'external_exercise_mappings', 'programs',
      'program_versions', 'program_drafts', 'workout_templates', 'superset_groups',
      'workout_template_exercises', 'exercise_prescriptions', 'workout_sessions',
      'session_exercises', 'completed_sets', 'session_notes', 'pain_logs',
      'fatigue_logs', 'health_activities', 'recommendations', 'user_decisions',
      'adaptation_events', 'coaching_insights', 'ai_parsing_events', 'import_events',
      'history_import_batches', 'archive_operations', 'archive_operation_records'
    ];
  ELSIF p_scope = 'history' THEN
    target_tables := ARRAY[
      'history_import_batches', 'workout_sessions', 'session_exercises',
      'completed_sets', 'session_notes', 'pain_logs', 'fatigue_logs',
      'health_activities', 'recommendations', 'user_decisions',
      'adaptation_events', 'coaching_insights'
    ];
  ELSE
    RAISE EXCEPTION 'Unsupported snapshot restore scope.' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Snapshot owner was not found.' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_expected_current) AS key
    WHERE NOT (key = ANY(target_tables))
  ) OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_target_rows) AS key
    WHERE NOT (key = ANY(target_tables))
  ) THEN
    RAISE EXCEPTION 'Snapshot restore contained an unexpected target table.'
      USING ERRCODE = '22023';
  END IF;

  FOREACH table_name IN ARRAY target_tables LOOP
    IF NOT (p_expected_current ? table_name) OR NOT (p_target_rows ? table_name) THEN
      RAISE EXCEPTION 'Snapshot restore is missing table %.', table_name
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_dependency_rows) AS key
    WHERE NOT (key = ANY(dependency_order))
  ) THEN
    RAISE EXCEPTION 'Snapshot restore contained an unexpected dependency table.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  PERFORM set_config('lock_timeout', '5s', true);
  FOREACH table_name IN ARRAY lock_order LOOP
    EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE', table_name);
  END LOOP;

  -- Re-read every affected row inside this transaction. A stale preview cannot
  -- delete newer work, even if another request changed a row after preview.
  FOREACH table_name IN ARRAY target_tables LOOP
    predicate := CASE table_name
      WHEN 'user_profiles' THEN 'r.user_id = $1'
      WHEN 'constraints' THEN 'r.user_id = $1'
      WHEN 'equipment_items' THEN 'r.user_id = $1'
      WHEN 'plate_inventory' THEN 'r.user_id = $1'
      WHEN 'barbell_configs' THEN 'r.user_id = $1'
      WHEN 'exercises' THEN 'r.user_id = $1'
      WHEN 'exercise_aliases' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'exercise_sources' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'exercise_equipment_requirements' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'external_exercise_mappings' THEN 'r.user_id = $1'
      WHEN 'programs' THEN 'r.user_id = $1'
      WHEN 'program_drafts' THEN 'r.user_id = $1'
      WHEN 'program_versions' THEN 'EXISTS (SELECT 1 FROM programs p WHERE p.id = r.program_id AND p.user_id = $1)'
      WHEN 'workout_templates' THEN 'EXISTS (SELECT 1 FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = r.program_version_id AND p.user_id = $1)'
      WHEN 'superset_groups' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
      WHEN 'workout_template_exercises' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
      WHEN 'exercise_prescriptions' THEN 'EXISTS (SELECT 1 FROM workout_template_exercises wte JOIN workout_templates wt ON wt.id = wte.workout_template_id JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wte.id = r.template_exercise_id AND p.user_id = $1)'
      WHEN 'workout_sessions' THEN 'r.user_id = $1'
      WHEN 'session_exercises' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
      WHEN 'completed_sets' THEN 'EXISTS (SELECT 1 FROM session_exercises se JOIN workout_sessions ws ON ws.id = se.session_id WHERE se.id = r.session_exercise_id AND ws.user_id = $1)'
      WHEN 'session_notes' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
      WHEN 'pain_logs' THEN 'r.user_id = $1'
      WHEN 'fatigue_logs' THEN 'r.user_id = $1'
      WHEN 'health_activities' THEN 'r.user_id = $1'
      WHEN 'recommendations' THEN 'r.user_id = $1'
      WHEN 'user_decisions' THEN 'EXISTS (SELECT 1 FROM recommendations rec WHERE rec.id = r.recommendation_id AND rec.user_id = $1)'
      WHEN 'adaptation_events' THEN 'r.user_id = $1'
      WHEN 'coaching_insights' THEN 'r.user_id = $1'
      WHEN 'ai_parsing_events' THEN 'r.user_id = $1'
      WHEN 'import_events' THEN 'r.user_id = $1'
      WHEN 'history_import_batches' THEN 'r.user_id = $1'
      WHEN 'archive_operations' THEN 'r.user_id = $1'
      WHEN 'archive_operation_records' THEN 'r.user_id = $1'
      ELSE NULL
    END;
    IF predicate IS NULL THEN
      RAISE EXCEPTION 'Snapshot restore table % has no ownership rule.', table_name;
    END IF;
    IF table_name = 'coaching_insights' THEN
      SELECT COALESCE(
        jsonb_agg(
          (to_jsonb(insight) - 'data_digest') || jsonb_build_object(
            'data_digest', jsonb_strip_nulls(jsonb_build_object(
              'schemaVersion', '2',
              'question', CASE
                WHEN insight.kind = 'qa' THEN insight.data_digest -> 'question'
                ELSE NULL
              END,
              'generatedAt', COALESCE(
                insight.data_digest -> 'generatedAt',
                to_jsonb(insight.created_at)
              ),
              'windowDays', insight.data_digest -> 'windowDays',
              'sessionId', insight.session_id,
              'sessionExerciseId', insight.session_exercise_id,
              'completedSetId', insight.completed_set_id,
              'modelContextRetained', false,
              'retentionArchiveInsightId',
                insight.data_digest -> 'retentionArchiveInsightId'
            ))
          )
          ORDER BY insight.id
        ),
        '[]'::jsonb
      )
      INTO current_rows
      FROM coaching_insights insight
      WHERE insight.user_id = p_user_id;
    ELSIF table_name = 'ai_parsing_events' THEN
      SELECT COALESCE(
        jsonb_agg(
          (
            to_jsonb(event)
            - 'input_sha256'
            - 'raw_input'
            - 'raw_output'
            - 'parsed_json'
            - 'ambiguities'
            - 'raw_redacted_at'
            - 'retention_expires_at'
          ) || jsonb_build_object(
            'input_sha256', COALESCE(
              NULLIF(event.input_sha256, ''),
              encode(sha256(convert_to(event.raw_input, 'UTF8')), 'hex')
            ),
            'raw_input', '',
            'raw_output', NULL::text,
            'parsed_json', NULL::jsonb,
            'ambiguities', '[]'::jsonb,
            'raw_redacted_at', COALESCE(event.raw_redacted_at, event.created_at),
            'retention_expires_at', NULL::timestamptz
          )
          ORDER BY event.id
        ),
        '[]'::jsonb
      )
      INTO current_rows
      FROM ai_parsing_events event
      WHERE event.user_id = p_user_id;
    ELSIF table_name = 'import_events' THEN
      SELECT COALESCE(
        jsonb_agg(
          (
            to_jsonb(event)
            - 'payload_sha256'
            - 'raw_payload'
            - 'parsed_payload'
            - 'status'
            - 'raw_redacted_at'
            - 'retention_expires_at'
          ) || jsonb_build_object(
            'payload_sha256', COALESCE(
              NULLIF(event.payload_sha256, ''),
              encode(sha256(convert_to(event.raw_payload, 'UTF8')), 'hex')
            ),
            'raw_payload', '',
            'parsed_payload', NULL::jsonb,
            'status', CASE
              WHEN event.status IN ('raw', 'parsed') THEN 'discarded'
              ELSE event.status
            END,
            'raw_redacted_at', COALESCE(event.raw_redacted_at, event.created_at),
            'retention_expires_at', NULL::timestamptz
          )
          ORDER BY event.id
        ),
        '[]'::jsonb
      )
      INTO current_rows
      FROM import_events event
      WHERE event.user_id = p_user_id;
    ELSE
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), ''[]''::jsonb) FROM %I r WHERE %s',
        table_name,
        predicate
      ) USING p_user_id INTO current_rows;
    END IF;
    IF current_rows IS DISTINCT FROM p_expected_current -> table_name THEN
      RAISE EXCEPTION 'Restore preview is stale for table %.', table_name
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY delete_order LOOP
    IF p_target_rows ? table_name THEN
      predicate := CASE table_name
        WHEN 'user_profiles' THEN 'r.user_id = $1'
        WHEN 'constraints' THEN 'r.user_id = $1'
        WHEN 'equipment_items' THEN 'r.user_id = $1'
        WHEN 'plate_inventory' THEN 'r.user_id = $1'
        WHEN 'barbell_configs' THEN 'r.user_id = $1'
        WHEN 'exercises' THEN 'r.user_id = $1'
        WHEN 'exercise_aliases' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
        WHEN 'exercise_sources' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
        WHEN 'exercise_equipment_requirements' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
        WHEN 'external_exercise_mappings' THEN 'r.user_id = $1'
        WHEN 'programs' THEN 'r.user_id = $1'
      WHEN 'program_drafts' THEN 'r.user_id = $1'
        WHEN 'program_versions' THEN 'EXISTS (SELECT 1 FROM programs p WHERE p.id = r.program_id AND p.user_id = $1)'
        WHEN 'workout_templates' THEN 'EXISTS (SELECT 1 FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = r.program_version_id AND p.user_id = $1)'
        WHEN 'superset_groups' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
        WHEN 'workout_template_exercises' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
        WHEN 'exercise_prescriptions' THEN 'EXISTS (SELECT 1 FROM workout_template_exercises wte JOIN workout_templates wt ON wt.id = wte.workout_template_id JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wte.id = r.template_exercise_id AND p.user_id = $1)'
        WHEN 'workout_sessions' THEN 'r.user_id = $1'
        WHEN 'session_exercises' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
        WHEN 'completed_sets' THEN 'EXISTS (SELECT 1 FROM session_exercises se JOIN workout_sessions ws ON ws.id = se.session_id WHERE se.id = r.session_exercise_id AND ws.user_id = $1)'
        WHEN 'session_notes' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
        WHEN 'pain_logs' THEN 'r.user_id = $1'
        WHEN 'fatigue_logs' THEN 'r.user_id = $1'
        WHEN 'health_activities' THEN 'r.user_id = $1'
        WHEN 'recommendations' THEN 'r.user_id = $1'
        WHEN 'user_decisions' THEN 'EXISTS (SELECT 1 FROM recommendations rec WHERE rec.id = r.recommendation_id AND rec.user_id = $1)'
        WHEN 'adaptation_events' THEN 'r.user_id = $1'
        WHEN 'coaching_insights' THEN 'r.user_id = $1'
        WHEN 'ai_parsing_events' THEN 'r.user_id = $1'
        WHEN 'import_events' THEN 'r.user_id = $1'
        WHEN 'history_import_batches' THEN 'r.user_id = $1'
        WHEN 'archive_operations' THEN 'r.user_id = $1'
        WHEN 'archive_operation_records' THEN 'r.user_id = $1'
      END;
      EXECUTE format('DELETE FROM %I r WHERE %s', table_name, predicate) USING p_user_id;
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY dependency_order LOOP
    IF p_dependency_rows ? table_name THEN
      EXECUTE format(
        'INSERT INTO %I SELECT * FROM jsonb_populate_recordset(NULL::%I, $1) ON CONFLICT (id) DO NOTHING',
        table_name,
        table_name
      ) USING p_dependency_rows -> table_name;
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY insert_order LOOP
    IF p_target_rows ? table_name THEN
      EXECUTE format(
        'INSERT INTO %I SELECT * FROM jsonb_populate_recordset(NULL::%I, $1)',
        table_name,
        table_name
      ) USING p_target_rows -> table_name;
      restored_rows := restored_rows + jsonb_array_length(p_target_rows -> table_name);
      IF p_fail_after_table = table_name THEN
        RAISE EXCEPTION 'Injected restore failure after table %.', table_name;
      END IF;
    END IF;
  END LOOP;

  -- Confirm the new state before recording success. Any mismatch raises and
  -- rolls back every preceding delete/insert in this function call.
  FOREACH table_name IN ARRAY target_tables LOOP
    predicate := CASE table_name
      WHEN 'user_profiles' THEN 'r.user_id = $1'
      WHEN 'constraints' THEN 'r.user_id = $1'
      WHEN 'equipment_items' THEN 'r.user_id = $1'
      WHEN 'plate_inventory' THEN 'r.user_id = $1'
      WHEN 'barbell_configs' THEN 'r.user_id = $1'
      WHEN 'exercises' THEN 'r.user_id = $1'
      WHEN 'exercise_aliases' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'exercise_sources' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'exercise_equipment_requirements' THEN 'EXISTS (SELECT 1 FROM exercises e WHERE e.id = r.exercise_id AND e.user_id = $1)'
      WHEN 'external_exercise_mappings' THEN 'r.user_id = $1'
      WHEN 'programs' THEN 'r.user_id = $1'
      WHEN 'program_drafts' THEN 'r.user_id = $1'
      WHEN 'program_versions' THEN 'EXISTS (SELECT 1 FROM programs p WHERE p.id = r.program_id AND p.user_id = $1)'
      WHEN 'workout_templates' THEN 'EXISTS (SELECT 1 FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = r.program_version_id AND p.user_id = $1)'
      WHEN 'superset_groups' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
      WHEN 'workout_template_exercises' THEN 'EXISTS (SELECT 1 FROM workout_templates wt JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wt.id = r.workout_template_id AND p.user_id = $1)'
      WHEN 'exercise_prescriptions' THEN 'EXISTS (SELECT 1 FROM workout_template_exercises wte JOIN workout_templates wt ON wt.id = wte.workout_template_id JOIN program_versions pv ON pv.id = wt.program_version_id JOIN programs p ON p.id = pv.program_id WHERE wte.id = r.template_exercise_id AND p.user_id = $1)'
      WHEN 'workout_sessions' THEN 'r.user_id = $1'
      WHEN 'session_exercises' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
      WHEN 'completed_sets' THEN 'EXISTS (SELECT 1 FROM session_exercises se JOIN workout_sessions ws ON ws.id = se.session_id WHERE se.id = r.session_exercise_id AND ws.user_id = $1)'
      WHEN 'session_notes' THEN 'EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.id = r.session_id AND ws.user_id = $1)'
      WHEN 'pain_logs' THEN 'r.user_id = $1'
      WHEN 'fatigue_logs' THEN 'r.user_id = $1'
      WHEN 'health_activities' THEN 'r.user_id = $1'
      WHEN 'recommendations' THEN 'r.user_id = $1'
      WHEN 'user_decisions' THEN 'EXISTS (SELECT 1 FROM recommendations rec WHERE rec.id = r.recommendation_id AND rec.user_id = $1)'
      WHEN 'adaptation_events' THEN 'r.user_id = $1'
      WHEN 'coaching_insights' THEN 'r.user_id = $1'
      WHEN 'ai_parsing_events' THEN 'r.user_id = $1'
      WHEN 'import_events' THEN 'r.user_id = $1'
      WHEN 'history_import_batches' THEN 'r.user_id = $1'
      WHEN 'archive_operations' THEN 'r.user_id = $1'
      WHEN 'archive_operation_records' THEN 'r.user_id = $1'
    END;
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), ''[]''::jsonb) FROM %I r WHERE %s',
      table_name,
      predicate
    ) USING p_user_id INTO current_rows;
    IF current_rows IS DISTINCT FROM p_target_rows -> table_name THEN
      RAISE EXCEPTION 'Restored table % failed final verification.', table_name;
    END IF;
  END LOOP;

  INSERT INTO audit_logs (
    user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
  ) VALUES (
    p_user_id,
    'user',
    'snapshot.restore',
    'data_snapshot',
    p_source_snapshot_id::text,
    CASE p_scope
      WHEN 'full' THEN 'Restored all restorable data from a verified snapshot'
      ELSE 'Restored workout and activity history from a verified snapshot'
    END,
    jsonb_build_object(
      'scope', p_scope,
      'sourceSnapshotId', p_source_snapshot_id,
      'safetySnapshotId', p_safety_snapshot_id,
      'restoredRecords', restored_rows
    )
  );

  RETURN jsonb_build_object(
    'scope', p_scope,
    'restoredRecords', restored_rows,
    'sourceSnapshotId', p_source_snapshot_id,
    'safetySnapshotId', p_safety_snapshot_id
  );
END;
$$;
