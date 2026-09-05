-- Add total added-plate entry without rewriting existing load or geometry meaning.
ALTER TABLE plate_loaded_machine_profiles
  DROP CONSTRAINT IF EXISTS plate_loaded_machine_profiles_resistance_unit_pair,
  ADD CONSTRAINT plate_loaded_machine_profiles_resistance_unit_pair CHECK (
    ((starting_resistance IS NULL) = (starting_resistance_unit IS NULL)) OR
    (target_entry_meaning IS NOT NULL AND target_entry_meaning = 'added_plates' AND starting_resistance_unit IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS plate_loaded_machine_profiles_entry_valid,
  ADD CONSTRAINT plate_loaded_machine_profiles_entry_valid CHECK (
    target_entry_meaning IS NULL OR target_entry_meaning IN ('total_system', 'per_loading_point', 'added_plates')
  ),
  DROP CONSTRAINT IF EXISTS plate_loaded_machine_profiles_known_complete,
  ADD CONSTRAINT plate_loaded_machine_profiles_known_complete CHECK (
    geometry_certainty <> 'known' OR (
      (starting_resistance IS NOT NULL OR target_entry_meaning = 'added_plates')
      AND starting_resistance_unit IS NOT NULL AND loading_point_count IS NOT NULL
      AND balancing_rule IS NOT NULL AND target_entry_meaning IS NOT NULL
    )
  );
--> statement-breakpoint
ALTER TABLE completed_sets
  DROP CONSTRAINT IF EXISTS completed_sets_load_entry_meaning_valid,
  ADD CONSTRAINT completed_sets_load_entry_meaning_valid CHECK (
    load_entry_meaning IN ('total_system', 'per_loading_point', 'added_plates', 'displayed_stack', 'per_stack', 'combined_stacks', 'legacy_unknown')
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_session_equipment_snapshot_live_ids()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_attachment_item_id uuid;
  v_restoring boolean := COALESCE(current_setting('workout_tracker.authorized_delete', true), '') = 'snapshot_restore';
BEGIN
  -- Restore may preserve historical truth after its live inventory IDs have
  -- disappeared, but it never bypasses immutable geometry validation below.
  IF NOT v_restoring AND NEW.equipment_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM equipment_items item
    WHERE item.id = NEW.equipment_item_id AND item.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Workout equipment snapshot item belongs to another account or does not exist.'
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_restoring AND NEW.load_profile_id IS NOT NULL THEN
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
      (
        (NEW.geometry_version = 1
          AND jsonb_typeof(NEW.geometry_snapshot->'startingResistance') = 'number'
          AND NEW.geometry_snapshot->>'targetEntryMeaning' IN ('total_system', 'per_loading_point'))
        OR (NEW.geometry_version = 2
          AND NEW.geometry_snapshot->>'targetEntryMeaning' = 'added_plates'
          AND NEW.geometry_snapshot->>'startingResistanceUnit' IN ('lb', 'kg')
          AND jsonb_typeof(NEW.geometry_snapshot->'startingResistance') IN ('number', 'null'))
      )
      AND jsonb_typeof(NEW.geometry_snapshot->'loadingPointCount') = 'number'
      AND NEW.geometry_snapshot->>'balancingRule' IN ('single_point', 'identical_each_point')
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

  IF NOT v_restoring AND NEW.attachment_profile_id IS NOT NULL THEN
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
      SELECT 1 FROM cable_attachment_compatibilities compatibility
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
