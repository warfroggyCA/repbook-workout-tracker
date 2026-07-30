-- Backfill only exact legacy Olympic/EZ bar relationships that are provably
-- one-to-one. Labels are matched first; remaining rows are paired only when
-- exactly one compatible config and one unclaimed compatible item remain.
WITH label_candidates AS (
  SELECT
    config.id AS config_id,
    item.id AS item_id,
    count(*) OVER (PARTITION BY config.id) AS config_match_count,
    count(*) OVER (PARTITION BY item.id) AS item_match_count
  FROM barbell_configs config
  JOIN equipment_items item
    ON item.user_id = config.user_id
   AND (
     (lower(btrim(config.bar_type)) = 'olympic' AND item.type = 'barbell')
     OR (lower(btrim(config.bar_type)) = 'ez' AND item.type = 'ez_bar')
   )
   AND lower(regexp_replace(btrim(item.label), '\s+', ' ', 'g'))
       = lower(regexp_replace(btrim(config.label), '\s+', ' ', 'g'))
  WHERE config.equipment_item_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM barbell_configs claimed
      WHERE claimed.equipment_item_id = item.id
    )
), unique_label_matches AS (
  SELECT config_id, item_id
  FROM label_candidates
  WHERE config_match_count = 1 AND item_match_count = 1
)
UPDATE barbell_configs config
SET equipment_item_id = matched.item_id,
    unit = coalesce(
      (SELECT profile.unit FROM user_profiles profile WHERE profile.user_id = config.user_id),
      'lb'::unit
    ),
    loading_kind = CASE lower(btrim(config.bar_type))
      WHEN 'olympic' THEN 'olympic'
      WHEN 'ez' THEN 'ez'
    END,
    shared_plate_pool_compatible = true
FROM unique_label_matches matched
WHERE config.id = matched.config_id;
--> statement-breakpoint
WITH remaining_candidates AS (
  SELECT
    config.id AS config_id,
    item.id AS item_id,
    count(*) OVER (PARTITION BY config.id) AS config_match_count,
    count(*) OVER (PARTITION BY item.id) AS item_match_count
  FROM barbell_configs config
  JOIN equipment_items item
    ON item.user_id = config.user_id
   AND (
     (lower(btrim(config.bar_type)) = 'olympic' AND item.type = 'barbell')
     OR (lower(btrim(config.bar_type)) = 'ez' AND item.type = 'ez_bar')
   )
  WHERE config.equipment_item_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM barbell_configs claimed
      WHERE claimed.equipment_item_id = item.id
    )
), sole_remaining_matches AS (
  SELECT config_id, item_id
  FROM remaining_candidates
  WHERE config_match_count = 1 AND item_match_count = 1
)
UPDATE barbell_configs config
SET equipment_item_id = matched.item_id,
    unit = coalesce(
      (SELECT profile.unit FROM user_profiles profile WHERE profile.user_id = config.user_id),
      'lb'::unit
    ),
    loading_kind = CASE lower(btrim(config.bar_type))
      WHEN 'olympic' THEN 'olympic'
      WHEN 'ez' THEN 'ez'
    END,
    shared_plate_pool_compatible = true
FROM sole_remaining_matches matched
WHERE config.id = matched.config_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bridge_unambiguous_legacy_bar_config()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item_type text;
  v_item_id uuid;
  v_item_count integer;
  v_competing_config_count integer;
BEGIN
  IF NEW.equipment_item_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF lower(btrim(NEW.bar_type)) = 'olympic' THEN
    v_item_type := 'barbell';
    NEW.loading_kind := 'olympic';
  ELSIF lower(btrim(NEW.bar_type)) = 'ez' THEN
    v_item_type := 'ez_bar';
    NEW.loading_kind := 'ez';
  ELSE
    RETURN NEW;
  END IF;

  -- Serialize same-account/type compatibility decisions so concurrent legacy
  -- inserts cannot both observe the same item as unclaimed.
  PERFORM 1
  FROM equipment_items item
  WHERE item.user_id = NEW.user_id AND item.type::text = v_item_type
  FOR UPDATE;

  SELECT count(*)::integer, (array_agg(item.id ORDER BY item.id))[1]
  INTO v_item_count, v_item_id
  FROM equipment_items item
  WHERE item.user_id = NEW.user_id
    AND item.type::text = v_item_type
    AND lower(regexp_replace(btrim(item.label), '\s+', ' ', 'g'))
        = lower(regexp_replace(btrim(NEW.label), '\s+', ' ', 'g'))
    AND NOT EXISTS (
      SELECT 1 FROM barbell_configs claimed
      WHERE claimed.equipment_item_id = item.id
    );

  SELECT count(*)::integer INTO v_competing_config_count
  FROM barbell_configs config
  WHERE config.user_id = NEW.user_id
    AND config.equipment_item_id IS NULL
    AND lower(btrim(config.bar_type)) = lower(btrim(NEW.bar_type))
    AND lower(regexp_replace(btrim(config.label), '\s+', ' ', 'g'))
        = lower(regexp_replace(btrim(NEW.label), '\s+', ' ', 'g'));

  IF v_item_count <> 1 OR v_competing_config_count <> 0 THEN
    SELECT count(*)::integer, (array_agg(item.id ORDER BY item.id))[1]
    INTO v_item_count, v_item_id
    FROM equipment_items item
    WHERE item.user_id = NEW.user_id
      AND item.type::text = v_item_type
      AND NOT EXISTS (
        SELECT 1 FROM barbell_configs claimed
        WHERE claimed.equipment_item_id = item.id
      );

    SELECT count(*)::integer INTO v_competing_config_count
    FROM barbell_configs config
    WHERE config.user_id = NEW.user_id
      AND config.equipment_item_id IS NULL
      AND lower(btrim(config.bar_type)) = lower(btrim(NEW.bar_type));
  END IF;

  IF v_item_count = 1 AND v_competing_config_count = 0 THEN
    NEW.equipment_item_id := v_item_id;
    NEW.unit := coalesce(
      (SELECT profile.unit FROM user_profiles profile WHERE profile.user_id = NEW.user_id),
      'lb'::unit
    );
    NEW.shared_plate_pool_compatible := true;
  ELSE
    NEW.equipment_item_id := NULL;
    NEW.unit := NULL;
    NEW.loading_kind := NULL;
    NEW.shared_plate_pool_compatible := NULL;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER barbell_configs_00_legacy_bridge_guard
BEFORE INSERT ON barbell_configs
FOR EACH ROW EXECUTE FUNCTION bridge_unambiguous_legacy_bar_config();
--> statement-breakpoint
CREATE OR REPLACE VIEW equipment_load_profile_repair_preview AS
SELECT plate.user_id, 'plate_inventory'::text AS entity, plate.id,
       CASE
         WHEN plate.denomination <= 0 THEN 'nonpositive_denomination'
         WHEN plate.quantity <= 0 THEN 'nonpositive_quantity'
       END AS issue
FROM plate_inventory plate
WHERE plate.denomination <= 0 OR plate.quantity <= 0
UNION ALL
SELECT profile.user_id, 'barbell_configs', profile.id,
       CASE
         WHEN profile.bar_weight <= 0 THEN 'nonpositive_empty_weight'
         WHEN profile.collar_weight < 0 THEN 'negative_collar_weight'
         WHEN profile.quantity <= 0 THEN 'nonpositive_quantity'
       END
FROM barbell_configs profile
WHERE profile.bar_weight <= 0 OR profile.collar_weight < 0 OR profile.quantity <= 0
UNION ALL
SELECT config.user_id, 'barbell_configs', config.id,
       CASE
         WHEN lower(btrim(config.bar_type)) NOT IN ('olympic', 'ez')
           THEN 'unsupported_legacy_bar_type'
         WHEN (
           SELECT count(*)
           FROM equipment_items item
           WHERE item.user_id = config.user_id
             AND (
               (lower(btrim(config.bar_type)) = 'olympic' AND item.type = 'barbell')
               OR (lower(btrim(config.bar_type)) = 'ez' AND item.type = 'ez_bar')
             )
             AND NOT EXISTS (
               SELECT 1 FROM barbell_configs claimed
               WHERE claimed.equipment_item_id = item.id
             )
         ) = 0 THEN 'missing_compatible_equipment_item'
         ELSE 'ambiguous_exact_equipment_relationship'
       END
FROM barbell_configs config
WHERE config.equipment_item_id IS NULL;
