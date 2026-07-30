CREATE UNIQUE INDEX "equipment_items_id_user_uq" ON "equipment_items" USING btree ("id", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "plate_inventory_id_user_uq" ON "plate_inventory" USING btree ("id", "user_id");
--> statement-breakpoint
ALTER TABLE "plate_inventory" ADD COLUMN "unit" "unit";
--> statement-breakpoint
UPDATE "plate_inventory" plate
SET "unit" = coalesce(profile."unit", 'lb'::"unit")
FROM "user_profiles" profile
WHERE profile."user_id" = plate."user_id";
--> statement-breakpoint
UPDATE "plate_inventory" SET "unit" = 'lb'::"unit" WHERE "unit" IS NULL;
--> statement-breakpoint
ALTER TABLE "plate_inventory" ALTER COLUMN "unit" SET DEFAULT 'lb'::"unit";
--> statement-breakpoint
ALTER TABLE "plate_inventory" ALTER COLUMN "unit" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "plate_inventory" ADD CONSTRAINT "plate_inventory_denomination_positive" CHECK ("denomination" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "plate_inventory" ADD CONSTRAINT "plate_inventory_quantity_positive" CHECK ("quantity" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD CONSTRAINT "barbell_configs_weight_positive" CHECK ("bar_weight" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD CONSTRAINT "barbell_configs_collar_nonnegative" CHECK ("collar_weight" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD CONSTRAINT "barbell_configs_quantity_positive" CHECK ("quantity" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD COLUMN "equipment_item_id" uuid;
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD COLUMN "unit" "unit";
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD COLUMN "loading_kind" text;
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD COLUMN "shared_plate_pool_compatible" boolean;
--> statement-breakpoint
CREATE UNIQUE INDEX "barbell_configs_equipment_item_uq" ON "barbell_configs" USING btree ("equipment_item_id") WHERE "equipment_item_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD CONSTRAINT "barbell_configs_item_owner_fk" FOREIGN KEY ("equipment_item_id", "user_id") REFERENCES "public"."equipment_items"("id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD CONSTRAINT "barbell_configs_loading_kind_valid" CHECK ("loading_kind" IS NULL OR "loading_kind" IN ('olympic', 'ez', 'trap_hex', 'specialty'));
--> statement-breakpoint
ALTER TABLE "barbell_configs" ADD CONSTRAINT "barbell_configs_profile_bridge_complete" CHECK (("equipment_item_id" IS NULL AND "unit" IS NULL AND "loading_kind" IS NULL AND "shared_plate_pool_compatible" IS NULL) OR ("equipment_item_id" IS NOT NULL AND "unit" IS NOT NULL AND "loading_kind" IS NOT NULL AND "shared_plate_pool_compatible" IS NOT NULL));
--> statement-breakpoint
CREATE TABLE "plate_loaded_machine_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "equipment_item_id" uuid NOT NULL,
  "geometry_certainty" text NOT NULL,
  "starting_resistance" numeric(7,2),
  "starting_resistance_unit" "unit",
  "loading_point_count" integer,
  "balancing_rule" text,
  "target_entry_meaning" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plate_loaded_machine_profiles_item_uq" UNIQUE("equipment_item_id"),
  CONSTRAINT "plate_loaded_machine_profiles_id_user_uq" UNIQUE("id", "user_id"),
  CONSTRAINT "plate_loaded_machine_profiles_certainty_valid" CHECK ("geometry_certainty" IN ('known', 'partial', 'unknown')),
  CONSTRAINT "plate_loaded_machine_profiles_resistance_unit_pair" CHECK (("starting_resistance" IS NULL) = ("starting_resistance_unit" IS NULL)),
  CONSTRAINT "plate_loaded_machine_profiles_resistance_valid" CHECK ("starting_resistance" IS NULL OR "starting_resistance" >= 0),
  CONSTRAINT "plate_loaded_machine_profiles_points_valid" CHECK ("loading_point_count" IS NULL OR "loading_point_count" > 0),
  CONSTRAINT "plate_loaded_machine_profiles_balancing_valid" CHECK ("balancing_rule" IS NULL OR "balancing_rule" IN ('single_point', 'identical_each_point')),
  CONSTRAINT "plate_loaded_machine_profiles_entry_valid" CHECK ("target_entry_meaning" IS NULL OR "target_entry_meaning" IN ('total_system', 'per_loading_point')),
  CONSTRAINT "plate_loaded_machine_profiles_single_point_count" CHECK ("balancing_rule" <> 'single_point' OR "loading_point_count" = 1),
  CONSTRAINT "plate_loaded_machine_profiles_unknown_empty" CHECK ("geometry_certainty" <> 'unknown' OR ("starting_resistance" IS NULL AND "starting_resistance_unit" IS NULL AND "loading_point_count" IS NULL AND "balancing_rule" IS NULL AND "target_entry_meaning" IS NULL)),
  CONSTRAINT "plate_loaded_machine_profiles_known_complete" CHECK ("geometry_certainty" <> 'known' OR ("starting_resistance" IS NOT NULL AND "loading_point_count" IS NOT NULL AND "balancing_rule" IS NOT NULL AND "target_entry_meaning" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "plate_loaded_machine_profiles" ADD CONSTRAINT "plate_loaded_machine_profiles_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plate_loaded_machine_profiles" ADD CONSTRAINT "plate_loaded_machine_profiles_item_owner_fk" FOREIGN KEY ("equipment_item_id", "user_id") REFERENCES "public"."equipment_items"("id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "plate_loaded_machine_compatible_plates" (
  "machine_profile_id" uuid NOT NULL,
  "plate_inventory_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  CONSTRAINT "plate_loaded_machine_compatible_plates_machine_profile_id_plate_inventory_id_pk" PRIMARY KEY("machine_profile_id", "plate_inventory_id")
);
--> statement-breakpoint
ALTER TABLE "plate_loaded_machine_compatible_plates" ADD CONSTRAINT "machine_compatible_plates_profile_owner_fk" FOREIGN KEY ("machine_profile_id", "user_id") REFERENCES "public"."plate_loaded_machine_profiles"("id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plate_loaded_machine_compatible_plates" ADD CONSTRAINT "machine_compatible_plates_inventory_owner_fk" FOREIGN KEY ("plate_inventory_id", "user_id") REFERENCES "public"."plate_inventory"("id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "machine_compatible_plates_inventory_idx" ON "plate_loaded_machine_compatible_plates" USING btree ("plate_inventory_id");
--> statement-breakpoint
CREATE TABLE "cable_machine_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "equipment_item_id" uuid NOT NULL,
  "geometry_certainty" text NOT NULL,
  "stack_count" integer,
  "topology" text,
  "displayed_unit" "unit",
  "ratio_status" text DEFAULT 'unknown' NOT NULL,
  "ratio_numerator" integer,
  "ratio_denominator" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cable_machine_profiles_item_uq" UNIQUE("equipment_item_id"),
  CONSTRAINT "cable_machine_profiles_id_user_uq" UNIQUE("id", "user_id"),
  CONSTRAINT "cable_machine_profiles_certainty_valid" CHECK ("geometry_certainty" IN ('known', 'partial', 'unknown')),
  CONSTRAINT "cable_machine_profiles_stack_count_valid" CHECK ("stack_count" IS NULL OR "stack_count" > 0),
  CONSTRAINT "cable_machine_profiles_topology_valid" CHECK ("topology" IS NULL OR "topology" IN ('shared_selection', 'independent_per_stack')),
  CONSTRAINT "cable_machine_profiles_ratio_status_valid" CHECK ("ratio_status" IN ('known', 'unknown')),
  CONSTRAINT "cable_machine_profiles_ratio_valid" CHECK (("ratio_status" = 'unknown' AND "ratio_numerator" IS NULL AND "ratio_denominator" IS NULL) OR ("ratio_status" = 'known' AND "ratio_numerator" > 0 AND "ratio_denominator" > 0)),
  CONSTRAINT "cable_machine_profiles_unknown_empty" CHECK ("geometry_certainty" <> 'unknown' OR ("stack_count" IS NULL AND "topology" IS NULL AND "displayed_unit" IS NULL AND "ratio_status" = 'unknown' AND "ratio_numerator" IS NULL AND "ratio_denominator" IS NULL)),
  CONSTRAINT "cable_machine_profiles_known_complete" CHECK ("geometry_certainty" <> 'known' OR ("stack_count" IS NOT NULL AND "topology" IS NOT NULL AND "displayed_unit" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "cable_machine_profiles" ADD CONSTRAINT "cable_machine_profiles_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cable_machine_profiles" ADD CONSTRAINT "cable_machine_profiles_item_owner_fk" FOREIGN KEY ("equipment_item_id", "user_id") REFERENCES "public"."equipment_items"("id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "cable_stack_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "cable_profile_id" uuid NOT NULL,
  "stack_index" integer NOT NULL,
  "step_index" integer NOT NULL,
  "position_label" text,
  "displayed_load" numeric(7,2) NOT NULL,
  CONSTRAINT "cable_stack_steps_profile_stack_step_uq" UNIQUE("cable_profile_id", "stack_index", "step_index"),
  CONSTRAINT "cable_stack_steps_stack_valid" CHECK ("stack_index" >= 0),
  CONSTRAINT "cable_stack_steps_step_valid" CHECK ("step_index" >= 0),
  CONSTRAINT "cable_stack_steps_load_valid" CHECK ("displayed_load" >= 0),
  CONSTRAINT "cable_stack_steps_position_label_valid" CHECK ("position_label" IS NULL OR (length(btrim("position_label")) > 0 AND length("position_label") <= 80))
);
--> statement-breakpoint
ALTER TABLE "cable_stack_steps" ADD CONSTRAINT "cable_stack_steps_profile_owner_fk" FOREIGN KEY ("cable_profile_id", "user_id") REFERENCES "public"."cable_machine_profiles"("id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "cable_attachment_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "equipment_item_id" uuid NOT NULL,
  "attachment_kind" text NOT NULL,
  "connection_standard" text,
  "status" text DEFAULT 'unknown' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cable_attachment_profiles_item_uq" UNIQUE("equipment_item_id"),
  CONSTRAINT "cable_attachment_profiles_id_user_uq" UNIQUE("id", "user_id"),
  CONSTRAINT "cable_attachment_profiles_kind_valid" CHECK ("attachment_kind" IN ('rope', 'straight_bar', 'lat_bar', 'v_bar', 'single_handle', 'ankle_cuff', 'other')),
  CONSTRAINT "cable_attachment_profiles_connection_valid" CHECK ("connection_standard" IS NULL OR (length(btrim("connection_standard")) > 0 AND length("connection_standard") <= 120)),
  CONSTRAINT "cable_attachment_profiles_status_valid" CHECK ("status" IN ('known', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "cable_attachment_profiles" ADD CONSTRAINT "cable_attachment_profiles_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cable_attachment_profiles" ADD CONSTRAINT "cable_attachment_profiles_item_owner_fk" FOREIGN KEY ("equipment_item_id", "user_id") REFERENCES "public"."equipment_items"("id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "cable_attachment_compatibilities" (
  "cable_profile_id" uuid NOT NULL,
  "attachment_profile_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  CONSTRAINT "cable_attachment_compatibilities_cable_profile_id_attachment_profile_id_pk" PRIMARY KEY("cable_profile_id", "attachment_profile_id")
);
--> statement-breakpoint
ALTER TABLE "cable_attachment_compatibilities" ADD CONSTRAINT "cable_attachment_compatibilities_cable_owner_fk" FOREIGN KEY ("cable_profile_id", "user_id") REFERENCES "public"."cable_machine_profiles"("id", "user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cable_attachment_compatibilities" ADD CONSTRAINT "cable_attachment_compatibilities_attachment_owner_fk" FOREIGN KEY ("attachment_profile_id", "user_id") REFERENCES "public"."cable_attachment_profiles"("id", "user_id") ON DELETE cascade ON UPDATE no action;
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
WHERE profile.bar_weight <= 0 OR profile.collar_weight < 0 OR profile.quantity <= 0;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_account_plate_unit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_profile_unit unit;
BEGIN
  SELECT profile.unit INTO v_profile_unit
  FROM user_profiles profile
  WHERE profile.user_id = NEW.user_id;
  IF v_profile_unit IS NULL THEN
    v_profile_unit := coalesce(NEW.unit, 'lb'::unit);
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.unit := v_profile_unit;
  ELSIF NEW.unit IS DISTINCT FROM v_profile_unit THEN
    RAISE EXCEPTION 'Plate inventory must use the account load unit.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER plate_inventory_account_unit_guard
BEFORE INSERT OR UPDATE OF "user_id", "unit" ON "plate_inventory"
FOR EACH ROW EXECUTE FUNCTION enforce_account_plate_unit();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_equipment_account_unit_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.unit IS DISTINCT FROM OLD.unit AND (
    EXISTS (SELECT 1 FROM plate_inventory plate WHERE plate.user_id = NEW.user_id)
    OR EXISTS (SELECT 1 FROM barbell_configs profile WHERE profile.user_id = NEW.user_id AND profile.unit IS NOT NULL)
    OR EXISTS (SELECT 1 FROM plate_loaded_machine_profiles profile WHERE profile.user_id = NEW.user_id AND profile.starting_resistance_unit IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Change or convert exact equipment loads before changing the account load unit.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_profiles_equipment_unit_guard
BEFORE UPDATE OF "unit" ON "user_profiles"
FOR EACH ROW EXECUTE FUNCTION protect_equipment_account_unit_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_equipment_load_profile_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item_type text;
BEGIN
  SELECT item.type::text INTO v_item_type
  FROM equipment_items item
  WHERE item.id = NEW.equipment_item_id AND item.user_id = NEW.user_id;

  IF v_item_type IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'barbell_configs' THEN
    IF NOT (
      (NEW.loading_kind = 'olympic' AND v_item_type = 'barbell') OR
      (NEW.loading_kind = 'ez' AND v_item_type = 'ez_bar') OR
      (NEW.loading_kind = 'trap_hex' AND v_item_type = 'trap_bar') OR
      (NEW.loading_kind = 'specialty' AND v_item_type = 'other')
    ) THEN
      RAISE EXCEPTION 'The load profile does not match the equipment item type.' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'plate_loaded_machine_profiles' AND v_item_type NOT IN ('machine', 'smith_machine') THEN
    RAISE EXCEPTION 'A plate-loaded machine profile requires a machine item.' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'cable_machine_profiles' AND v_item_type <> 'cable' THEN
    RAISE EXCEPTION 'A cable profile requires a cable item.' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'cable_attachment_profiles' AND v_item_type <> 'other' THEN
    RAISE EXCEPTION 'A cable attachment profile requires a distinct attachment item.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER barbell_configs_item_type_guard BEFORE INSERT OR UPDATE OF "equipment_item_id", "user_id", "loading_kind", "unit" ON "barbell_configs" FOR EACH ROW WHEN (NEW."equipment_item_id" IS NOT NULL) EXECUTE FUNCTION validate_equipment_load_profile_item();
--> statement-breakpoint
CREATE TRIGGER plate_loaded_machine_profiles_item_type_guard BEFORE INSERT OR UPDATE OF "equipment_item_id", "user_id", "starting_resistance_unit" ON "plate_loaded_machine_profiles" FOR EACH ROW EXECUTE FUNCTION validate_equipment_load_profile_item();
--> statement-breakpoint
CREATE TRIGGER cable_machine_profiles_item_type_guard BEFORE INSERT OR UPDATE OF "equipment_item_id", "user_id" ON "cable_machine_profiles" FOR EACH ROW EXECUTE FUNCTION validate_equipment_load_profile_item();
--> statement-breakpoint
CREATE TRIGGER cable_attachment_profiles_item_type_guard BEFORE INSERT OR UPDATE OF "equipment_item_id", "user_id" ON "cable_attachment_profiles" FOR EACH ROW EXECUTE FUNCTION validate_equipment_load_profile_item();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_bar_profile_unit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_profile_unit unit;
BEGIN
  SELECT profile.unit INTO v_profile_unit FROM user_profiles profile WHERE profile.user_id = NEW.user_id;
  IF NEW.unit IS NOT NULL AND v_profile_unit IS NOT NULL AND NEW.unit IS DISTINCT FROM v_profile_unit THEN
    RAISE EXCEPTION 'Bar profiles must use the account plate-pool unit.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER barbell_configs_unit_guard
BEFORE INSERT OR UPDATE OF "user_id", "unit" ON "barbell_configs"
FOR EACH ROW EXECUTE FUNCTION validate_bar_profile_unit();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_machine_profile_unit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_profile_unit unit;
BEGIN
  SELECT profile.unit INTO v_profile_unit FROM user_profiles profile WHERE profile.user_id = NEW.user_id;
  IF NEW.starting_resistance_unit IS NOT NULL AND v_profile_unit IS NOT NULL AND NEW.starting_resistance_unit IS DISTINCT FROM v_profile_unit THEN
    RAISE EXCEPTION 'Plate-loaded machine profiles must use the account plate-pool unit.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER plate_loaded_machine_profiles_unit_guard
BEFORE INSERT OR UPDATE OF "user_id", "starting_resistance_unit" ON "plate_loaded_machine_profiles"
FOR EACH ROW EXECUTE FUNCTION validate_machine_profile_unit();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_equipment_item_profile_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.type IS NOT DISTINCT FROM OLD.type THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM barbell_configs profile WHERE profile.equipment_item_id = OLD.id)
     OR EXISTS (SELECT 1 FROM plate_loaded_machine_profiles profile WHERE profile.equipment_item_id = OLD.id)
     OR EXISTS (SELECT 1 FROM cable_machine_profiles profile WHERE profile.equipment_item_id = OLD.id)
     OR EXISTS (SELECT 1 FROM cable_attachment_profiles profile WHERE profile.equipment_item_id = OLD.id) THEN
    RAISE EXCEPTION 'Remove or replace the exact load profile before changing equipment type.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER equipment_items_profile_type_guard
BEFORE UPDATE OF "type" ON "equipment_items"
FOR EACH ROW EXECUTE FUNCTION protect_equipment_item_profile_type();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_machine_compatible_plate_unit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_machine_unit unit;
  v_plate_unit unit;
BEGIN
  SELECT profile.starting_resistance_unit INTO v_machine_unit
  FROM plate_loaded_machine_profiles profile
  WHERE profile.id = NEW.machine_profile_id AND profile.user_id = NEW.user_id;
  SELECT plate.unit INTO v_plate_unit
  FROM plate_inventory plate
  WHERE plate.id = NEW.plate_inventory_id AND plate.user_id = NEW.user_id;
  IF v_machine_unit IS NULL OR v_plate_unit IS NULL OR v_machine_unit IS DISTINCT FROM v_plate_unit THEN
    RAISE EXCEPTION 'Compatible machine plates must use the machine profile unit.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER machine_compatible_plates_unit_guard
BEFORE INSERT OR UPDATE ON "plate_loaded_machine_compatible_plates"
FOR EACH ROW EXECUTE FUNCTION validate_machine_compatible_plate_unit();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_cable_stack_step()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_stack_count integer;
  v_topology text;
BEGIN
  SELECT profile.stack_count, profile.topology INTO v_stack_count, v_topology
  FROM cable_machine_profiles profile
  WHERE profile.id = NEW.cable_profile_id AND profile.user_id = NEW.user_id;

  IF v_stack_count IS NULL OR v_topology IS NULL OR NOT (
    (v_topology = 'shared_selection' AND NEW.stack_index = 0) OR
    (v_topology = 'independent_per_stack' AND NEW.stack_index BETWEEN 1 AND v_stack_count)
  ) THEN
    RAISE EXCEPTION 'Cable stack step does not match the profile topology and stack count.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cable_stack_steps_stack_guard BEFORE INSERT OR UPDATE OF "cable_profile_id", "user_id", "stack_index" ON "cable_stack_steps" FOR EACH ROW EXECUTE FUNCTION validate_cable_stack_step();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_cable_profile_stack_steps()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cable_stack_steps step
    WHERE step.cable_profile_id = NEW.id
      AND NOT (
        (NEW.topology = 'shared_selection' AND step.stack_index = 0) OR
        (NEW.topology = 'independent_per_stack' AND step.stack_index BETWEEN 1 AND NEW.stack_count)
      )
  ) THEN
    RAISE EXCEPTION 'Cable profile change would invalidate stored stack steps.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cable_machine_profiles_stack_steps_guard BEFORE UPDATE OF "stack_count", "topology" ON "cable_machine_profiles" FOR EACH ROW EXECUTE FUNCTION validate_cable_profile_stack_steps();
