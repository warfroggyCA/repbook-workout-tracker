CREATE UNIQUE INDEX "workout_sessions_id_user_uq"
  ON "workout_sessions" USING btree ("id", "user_id");
--> statement-breakpoint
CREATE TABLE "session_equipment_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "session_exercise_id" uuid NOT NULL,
  "equipment_item_id" uuid,
  "load_profile_id" uuid,
  "attachment_item_id" uuid,
  "attachment_profile_id" uuid,
  "equipment_label" text NOT NULL,
  "equipment_definition_key" text,
  "attachment_label" text,
  "attachment_definition_key" text,
  "profile_kind" text NOT NULL,
  "geometry_certainty" text NOT NULL,
  "unit" "unit",
  "selection_provenance" text NOT NULL,
  "configuration_revision" integer NOT NULL,
  "configuration_hash" text NOT NULL,
  "geometry_version" integer DEFAULT 1 NOT NULL,
  "geometry_snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "session_equipment_snapshots_id_exercise_session_uq"
    UNIQUE("id", "session_exercise_id", "session_id"),
  CONSTRAINT "session_equipment_snapshots_id_exercise_uq"
    UNIQUE("id", "session_exercise_id"),
  CONSTRAINT "session_equipment_snapshots_profile_kind_valid"
    CHECK ("profile_kind" IN ('plate_loaded_implement', 'plate_loaded_machine', 'cable_machine', 'incremental_implement', 'bodyweight', 'resistance_band', 'other')),
  CONSTRAINT "session_equipment_snapshots_certainty_valid"
    CHECK ("geometry_certainty" IN ('known', 'partial', 'unknown')),
  CONSTRAINT "session_equipment_snapshots_provenance_valid"
    CHECK ("selection_provenance" IN ('auto_unique', 'user_selected', 'imported', 'legacy_unknown')),
  CONSTRAINT "session_equipment_snapshots_revision_valid"
    CHECK ("configuration_revision" >= 1 AND "geometry_version" >= 1),
  CONSTRAINT "session_equipment_snapshots_labels_valid"
    CHECK (length(btrim("equipment_label")) > 0 AND ("attachment_label" IS NULL OR length(btrim("attachment_label")) > 0)),
  CONSTRAINT "session_equipment_snapshots_hash_valid"
    CHECK ("configuration_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "session_equipment_snapshots_geometry_valid"
    CHECK (
      jsonb_typeof("geometry_snapshot") = 'object'
      AND ("geometry_snapshot"->>'version') = "geometry_version"::text
      AND ("geometry_snapshot"->>'kind') = "profile_kind"
    ),
  CONSTRAINT "session_equipment_snapshots_live_profile_shape_valid"
    CHECK (
      ("profile_kind" IN ('plate_loaded_implement', 'plate_loaded_machine', 'cable_machine') AND "equipment_item_id" IS NOT NULL AND "load_profile_id" IS NOT NULL)
      OR
      ("profile_kind" NOT IN ('plate_loaded_implement', 'plate_loaded_machine', 'cable_machine') AND "load_profile_id" IS NULL)
    ),
  CONSTRAINT "session_equipment_snapshots_attachment_shape_valid"
    CHECK (
      ("attachment_item_id" IS NULL AND "attachment_profile_id" IS NULL AND "attachment_label" IS NULL)
      OR
      ("attachment_item_id" IS NOT NULL AND "attachment_profile_id" IS NOT NULL AND "attachment_label" IS NOT NULL)
    )
);
--> statement-breakpoint
ALTER TABLE "session_equipment_snapshots"
  ADD CONSTRAINT "session_equipment_snapshots_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_equipment_snapshots"
  ADD CONSTRAINT "session_equipment_snapshots_session_owner_fk"
  FOREIGN KEY ("session_id", "user_id")
  REFERENCES "public"."workout_sessions"("id", "user_id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_equipment_snapshots"
  ADD CONSTRAINT "session_equipment_snapshots_exercise_session_fk"
  FOREIGN KEY ("session_exercise_id", "session_id")
  REFERENCES "public"."session_exercises"("id", "session_id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "session_equipment_snapshots_exercise_created_idx"
  ON "session_equipment_snapshots" USING btree ("session_exercise_id", "created_at");
--> statement-breakpoint
ALTER TABLE "session_exercises"
  ADD COLUMN "current_equipment_snapshot_id" uuid;
--> statement-breakpoint
ALTER TABLE "session_exercises"
  ADD CONSTRAINT "session_exercises_current_equipment_snapshot_fk"
  FOREIGN KEY ("current_equipment_snapshot_id", "id", "session_id")
  REFERENCES "public"."session_equipment_snapshots"("id", "session_exercise_id", "session_id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "completed_sets"
  ADD COLUMN "equipment_snapshot_id" uuid;
--> statement-breakpoint
ALTER TABLE "completed_sets"
  ADD COLUMN "load_entry_meaning" text DEFAULT 'legacy_unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "completed_sets"
  ADD CONSTRAINT "completed_sets_equipment_snapshot_fk"
  FOREIGN KEY ("equipment_snapshot_id", "session_exercise_id")
  REFERENCES "public"."session_equipment_snapshots"("id", "session_exercise_id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "completed_sets"
  ADD CONSTRAINT "completed_sets_load_entry_meaning_valid"
  CHECK ("load_entry_meaning" IN ('total_system', 'per_loading_point', 'displayed_stack', 'per_stack', 'combined_stacks', 'legacy_unknown'));
--> statement-breakpoint
ALTER TABLE "completed_sets"
  ADD CONSTRAINT "completed_sets_equipment_entry_pair_valid"
  CHECK (("equipment_snapshot_id" IS NULL AND "load_entry_meaning" = 'legacy_unknown') OR ("equipment_snapshot_id" IS NOT NULL AND "load_entry_meaning" <> 'legacy_unknown'));
--> statement-breakpoint
ALTER TABLE "session_occurrences"
  ADD COLUMN "equipment_snapshot_id" uuid;
--> statement-breakpoint
ALTER TABLE "session_occurrences"
  ADD CONSTRAINT "session_occurrences_equipment_snapshot_fk"
  FOREIGN KEY ("equipment_snapshot_id", "session_exercise_id", "session_id")
  REFERENCES "public"."session_equipment_snapshots"("id", "session_exercise_id", "session_id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "session_equipment_selection_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "session_exercise_id" uuid NOT NULL,
  "client_key" uuid NOT NULL,
  "operation" text NOT NULL,
  "canonical_payload_hash" text NOT NULL,
  "prior_snapshot_id" uuid,
  "resulting_snapshot_id" uuid,
  "result_code" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "session_equipment_selection_receipts_client_uq"
    UNIQUE("session_exercise_id", "client_key"),
  CONSTRAINT "session_equipment_selection_receipts_operation_valid"
    CHECK ("operation" IN ('select', 'clear')),
  CONSTRAINT "session_equipment_selection_receipts_hash_valid"
    CHECK ("canonical_payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "session_equipment_selection_receipts_result_valid"
    CHECK ("result_code" IN ('applied', 'no_change')),
  CONSTRAINT "session_equipment_selection_receipts_operation_shape_valid"
    CHECK (("operation" = 'select' AND "resulting_snapshot_id" IS NOT NULL) OR ("operation" = 'clear' AND "resulting_snapshot_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "session_equipment_selection_receipts"
  ADD CONSTRAINT "session_equipment_selection_receipts_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_equipment_selection_receipts"
  ADD CONSTRAINT "session_equipment_selection_receipts_session_owner_fk"
  FOREIGN KEY ("session_id", "user_id")
  REFERENCES "public"."workout_sessions"("id", "user_id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_equipment_selection_receipts"
  ADD CONSTRAINT "session_equipment_selection_receipts_exercise_session_fk"
  FOREIGN KEY ("session_exercise_id", "session_id")
  REFERENCES "public"."session_exercises"("id", "session_id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_equipment_selection_receipts"
  ADD CONSTRAINT "session_equipment_selection_receipts_prior_snapshot_fk"
  FOREIGN KEY ("prior_snapshot_id", "session_exercise_id", "session_id")
  REFERENCES "public"."session_equipment_snapshots"("id", "session_exercise_id", "session_id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_equipment_selection_receipts"
  ADD CONSTRAINT "session_equipment_selection_receipts_result_snapshot_fk"
  FOREIGN KEY ("resulting_snapshot_id", "session_exercise_id", "session_id")
  REFERENCES "public"."session_equipment_snapshots"("id", "session_exercise_id", "session_id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "session_equipment_selection_receipts_session_idx"
  ON "session_equipment_selection_receipts" USING btree ("session_id", "created_at");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_session_equipment_snapshot_live_ids()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_attachment_item_id uuid;
BEGIN
  IF NEW.equipment_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM equipment_items item
    WHERE item.id = NEW.equipment_item_id AND item.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Workout equipment snapshot item belongs to another account or does not exist.'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.load_profile_id IS NOT NULL THEN
    IF NEW.profile_kind = 'plate_loaded_implement' AND NOT EXISTS (
      SELECT 1 FROM barbell_configs profile
      WHERE profile.id = NEW.load_profile_id AND profile.user_id = NEW.user_id
        AND profile.equipment_item_id = NEW.equipment_item_id
    ) THEN
      RAISE EXCEPTION 'Workout equipment snapshot bar profile belongs to another account or does not exist.'
        USING ERRCODE = '23503';
    ELSIF NEW.profile_kind = 'plate_loaded_machine' AND NOT EXISTS (
      SELECT 1 FROM plate_loaded_machine_profiles profile
      WHERE profile.id = NEW.load_profile_id AND profile.user_id = NEW.user_id
        AND profile.equipment_item_id = NEW.equipment_item_id
    ) THEN
      RAISE EXCEPTION 'Workout equipment snapshot machine profile belongs to another account or does not exist.'
        USING ERRCODE = '23503';
    ELSIF NEW.profile_kind = 'cable_machine' AND NOT EXISTS (
      SELECT 1 FROM cable_machine_profiles profile
      WHERE profile.id = NEW.load_profile_id AND profile.user_id = NEW.user_id
        AND profile.equipment_item_id = NEW.equipment_item_id
    ) THEN
      RAISE EXCEPTION 'Workout equipment snapshot cable profile belongs to another account or does not exist.'
        USING ERRCODE = '23503';
    ELSIF NEW.profile_kind NOT IN ('plate_loaded_implement', 'plate_loaded_machine', 'cable_machine') THEN
      RAISE EXCEPTION 'That snapshot kind cannot reference this load profile.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.geometry_certainty = 'known' THEN
    IF NEW.profile_kind = 'plate_loaded_implement' AND NOT coalesce((
      jsonb_typeof(NEW.geometry_snapshot->'emptyWeight') = 'number'
      AND jsonb_typeof(NEW.geometry_snapshot->'collarWeight') = 'number'
      AND NEW.geometry_snapshot->>'unit' IN ('lb', 'kg')
      AND jsonb_typeof(NEW.geometry_snapshot->'sharedPlatePoolCompatible') = 'boolean'
    ), false) THEN
      RAISE EXCEPTION 'Known implement geometry is incomplete.' USING ERRCODE = '23514';
    ELSIF NEW.profile_kind = 'plate_loaded_machine' AND NOT coalesce((
      jsonb_typeof(NEW.geometry_snapshot->'startingResistance') = 'number'
      AND jsonb_typeof(NEW.geometry_snapshot->'loadingPointCount') = 'number'
      AND NEW.geometry_snapshot->>'balancingRule' IN ('single_point', 'identical_each_point')
      AND NEW.geometry_snapshot->>'targetEntryMeaning' IN ('total_system', 'per_loading_point')
      AND jsonb_typeof(NEW.geometry_snapshot->'compatiblePlates') = 'array'
    ), false) THEN
      RAISE EXCEPTION 'Known machine geometry is incomplete.' USING ERRCODE = '23514';
    ELSIF NEW.profile_kind = 'cable_machine' AND NOT coalesce((
      jsonb_typeof(NEW.geometry_snapshot->'stackCount') = 'number'
      AND NEW.geometry_snapshot->>'topology' IN ('shared_selection', 'independent_per_stack')
      AND NEW.geometry_snapshot->>'displayedUnit' IN ('lb', 'kg')
      AND jsonb_typeof(NEW.geometry_snapshot->'stackSteps') = 'array'
      AND jsonb_array_length(NEW.geometry_snapshot->'stackSteps') > 0
      AND NEW.geometry_snapshot->>'ratioStatus' IN ('known', 'unknown')
    ), false) THEN
      RAISE EXCEPTION 'Known cable geometry is incomplete.' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.attachment_profile_id IS NOT NULL THEN
    SELECT profile.equipment_item_id INTO v_attachment_item_id
    FROM cable_attachment_profiles profile
    WHERE profile.id = NEW.attachment_profile_id AND profile.user_id = NEW.user_id;
    IF v_attachment_item_id IS NULL OR v_attachment_item_id <> NEW.attachment_item_id THEN
      RAISE EXCEPTION 'Workout equipment snapshot attachment belongs to another account, does not exist, or does not match the item.'
        USING ERRCODE = '23503';
    END IF;
    IF NEW.profile_kind <> 'cable_machine' THEN
      RAISE EXCEPTION 'Only a cable-machine snapshot can retain an attachment.'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM cable_attachment_compatibilities compatibility
      WHERE compatibility.cable_profile_id = NEW.load_profile_id
        AND compatibility.attachment_profile_id = NEW.attachment_profile_id
        AND compatibility.user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'The selected attachment is not compatible with this cable profile.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_equipment_snapshots_live_ids_guard
BEFORE INSERT OR UPDATE ON session_equipment_snapshots
FOR EACH ROW EXECUTE FUNCTION validate_session_equipment_snapshot_live_ids();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_session_equipment_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Workout equipment snapshot evidence is immutable.'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_equipment_snapshots_immutable
BEFORE UPDATE ON session_equipment_snapshots
FOR EACH ROW EXECUTE FUNCTION protect_session_equipment_snapshot();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_session_equipment_selection_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Workout equipment selection receipts are immutable.'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_equipment_selection_receipts_immutable
BEFORE UPDATE ON session_equipment_selection_receipts
FOR EACH ROW EXECUTE FUNCTION protect_session_equipment_selection_receipt();
--> statement-breakpoint
DROP TRIGGER IF EXISTS protected_delete_guard ON session_equipment_snapshots;
--> statement-breakpoint
CREATE TRIGGER protected_delete_guard
BEFORE DELETE ON session_equipment_snapshots
FOR EACH ROW EXECUTE FUNCTION guard_protected_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS protected_delete_guard ON session_equipment_selection_receipts;
--> statement-breakpoint
CREATE TRIGGER protected_delete_guard
BEFORE DELETE ON session_equipment_selection_receipts
FOR EACH ROW EXECUTE FUNCTION guard_protected_delete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_completed_occurrence_equipment_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_set_snapshot_id uuid;
BEGIN
  IF NEW.completed_set_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT completed.equipment_snapshot_id INTO v_set_snapshot_id
  FROM completed_sets completed
  WHERE completed.id = NEW.completed_set_id
    AND completed.session_exercise_id = NEW.session_exercise_id;

  IF v_set_snapshot_id IS DISTINCT FROM NEW.equipment_snapshot_id THEN
    RAISE EXCEPTION 'A completed occurrence and completed set must retain the same equipment snapshot.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_occurrences_equipment_snapshot_equality
BEFORE INSERT OR UPDATE OF "completed_set_id", "equipment_snapshot_id", "session_exercise_id"
ON session_occurrences
FOR EACH ROW EXECUTE FUNCTION validate_completed_occurrence_equipment_snapshot();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_completed_set_equipment_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF ROW(OLD.equipment_snapshot_id, OLD.load_entry_meaning)
      IS NOT DISTINCT FROM ROW(NEW.equipment_snapshot_id, NEW.load_entry_meaning) THEN
    RETURN NEW;
  END IF;

  IF OLD.equipment_snapshot_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM session_occurrences occurrence
    WHERE occurrence.completed_set_id = OLD.id
      AND occurrence.outcome = 'completed'
  ) THEN
    RAISE EXCEPTION 'Completed set equipment evidence is immutable.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER completed_sets_equipment_evidence_immutable
BEFORE UPDATE OF "equipment_snapshot_id", "load_entry_meaning" ON completed_sets
FOR EACH ROW EXECUTE FUNCTION protect_completed_set_equipment_evidence();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_session_occurrence_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF ROW(
    OLD.id, OLD.session_id, OLD.session_exercise_id, OLD.kind, OLD.origin,
    OLD.sequence_idx, OLD.kind_ordinal, OLD.label, OLD.planned_exercise_id,
    OLD.planned_reps_min, OLD.planned_reps_max, OLD.planned_load,
    OLD.planned_load_unit, OLD.planned_load_percent, OLD.planned_load_text,
    OLD.planned_rest_sec, OLD.planned_note, OLD.group_snapshot_id,
    OLD.group_round, OLD.group_member_order_idx, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.session_id, NEW.session_exercise_id, NEW.kind, NEW.origin,
    NEW.sequence_idx, NEW.kind_ordinal, NEW.label, NEW.planned_exercise_id,
    NEW.planned_reps_min, NEW.planned_reps_max, NEW.planned_load,
    NEW.planned_load_unit, NEW.planned_load_percent, NEW.planned_load_text,
    NEW.planned_rest_sec, NEW.planned_note, NEW.group_snapshot_id,
    NEW.group_round, NEW.group_member_order_idx, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Workout occurrence plan and identity evidence is immutable.'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    OLD.outcome, OLD.outcome_reason, OLD.outcome_note, OLD.revision,
    OLD.resolved_at, OLD.completed_set_id, OLD.equipment_snapshot_id
  ) IS NOT DISTINCT FROM ROW(
    NEW.outcome, NEW.outcome_reason, NEW.outcome_note, NEW.revision,
    NEW.resolved_at, NEW.completed_set_id, NEW.equipment_snapshot_id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Workout occurrence transitions must advance exactly one revision.'
      USING ERRCODE = '40001';
  END IF;

  IF NOT (
    (OLD.outcome = 'pending' AND NEW.outcome IN ('completed', 'skipped', 'abandoned'))
    OR (
      OLD.outcome IN ('pending', 'completed', 'skipped')
      AND NEW.outcome = OLD.outcome
      AND NEW.outcome_reason IS NOT DISTINCT FROM OLD.outcome_reason
      AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
      AND NEW.completed_set_id IS NOT DISTINCT FROM OLD.completed_set_id
      AND (
        OLD.outcome = 'pending'
        OR NEW.equipment_snapshot_id IS NOT DISTINCT FROM OLD.equipment_snapshot_id
      )
    )
    OR (OLD.outcome IN ('skipped', 'abandoned') AND NEW.outcome = 'pending')
  ) THEN
    RAISE EXCEPTION 'Workout occurrence outcome transition is not allowed.'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
