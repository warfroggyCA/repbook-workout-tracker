import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { equipmentTypeEnum, unitEnum } from "./enums";
import { users } from "./user";

/** Free-form attributes per equipment type (plan §12 EquipmentItem.attrs). */
export type EquipmentAttrs = {
  minWeight?: number;
  maxWeight?: number;
  unit?: "lb" | "kg";
  adjustable?: boolean;
  pair?: boolean;
  increments?: number[];
  adjustableBench?: boolean;
  brand?: string;
  levels?: string[]; // e.g. band tensions
  notes?: string;
};

/**
 * Stable, searchable definitions for specific implements and attachments.
 * `equipmentTypeEnum` remains the broad availability/filtering category;
 * this table adds the detail needed to distinguish a trap bar, Smith
 * machine, rope attachment, suspension trainer, and similar equipment.
 */
export const equipmentDefinitions = pgTable(
  "equipment_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    category: equipmentTypeEnum("category").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("equipment_definitions_key_idx").on(t.key)]
);

export const equipmentItems = pgTable("equipment_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: equipmentTypeEnum("type").notNull(),
  definitionId: uuid("definition_id").references(() => equipmentDefinitions.id, {
    onDelete: "set null",
  }),
  label: text("label").notNull(),
  /** How many of this item the user owns (e.g. two Olympic bars). */
  quantity: integer("quantity").notNull().default(1),
  attrs: jsonb("attrs").$type<EquipmentAttrs>().notNull().default({}),
  available: boolean("available").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [uniqueIndex("equipment_items_id_user_uq").on(t.id, t.userId)]);

/**
 * One row per plate denomination the user owns. `quantity` is the total number
 * of individual plates of this size (not pairs), so odd counts are allowed —
 * a single 45 lb plate is `quantity: 1`. Barbell plate math derives the
 * loadable per-side count as `floor(quantity / 2)`.
 */
export const plateInventory = pgTable("plate_inventory", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  denomination: numeric("denomination", { precision: 7, scale: 2, mode: "number" }).notNull(), // in the profile unit
  unit: unitEnum("unit").notNull().default("lb"),
  quantity: integer("quantity").notNull(),
}, (t) => [
  uniqueIndex("plate_inventory_id_user_uq").on(t.id, t.userId),
  check("plate_inventory_denomination_positive", sql`${t.denomination} > 0`),
  check("plate_inventory_quantity_positive", sql`${t.quantity} > 0`),
]);

export const barbellConfigs = pgTable(
  "barbell_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    barType: text("bar_type").notNull(), // compatibility bridge: "olympic" | "ez"
    equipmentItemId: uuid("equipment_item_id"),
    unit: unitEnum("unit"),
    loadingKind: text("loading_kind"),
    sharedPlatePoolCompatible: boolean("shared_plate_pool_compatible"),
    barWeight: numeric("bar_weight", {
      precision: 7,
      scale: 2,
      mode: "number",
    }).notNull(),
    collarWeight: numeric("collar_weight", {
      precision: 7,
      scale: 2,
      mode: "number",
    }).notNull().default(0),
    /** Compatibility copy until the exact equipment item is authoritative. */
    quantity: integer("quantity").notNull().default(1),
    label: text("label").notNull(),
  },
  (t) => [
    uniqueIndex("barbell_configs_equipment_item_uq")
      .on(t.equipmentItemId)
      .where(sql`${t.equipmentItemId} IS NOT NULL`),
    foreignKey({
      name: "barbell_configs_item_owner_fk",
      columns: [t.equipmentItemId, t.userId],
      foreignColumns: [equipmentItems.id, equipmentItems.userId],
    }).onDelete("cascade"),
    check(
      "barbell_configs_loading_kind_valid",
      sql`${t.loadingKind} IS NULL OR ${t.loadingKind} IN ('olympic', 'ez', 'trap_hex', 'specialty')`,
    ),
    check(
      "barbell_configs_profile_bridge_complete",
      sql`(${t.equipmentItemId} IS NULL AND ${t.unit} IS NULL AND ${t.loadingKind} IS NULL AND ${t.sharedPlatePoolCompatible} IS NULL) OR (${t.equipmentItemId} IS NOT NULL AND ${t.unit} IS NOT NULL AND ${t.loadingKind} IS NOT NULL AND ${t.sharedPlatePoolCompatible} IS NOT NULL)`,
    ),
    check("barbell_configs_weight_positive", sql`${t.barWeight} > 0`),
    check("barbell_configs_collar_nonnegative", sql`${t.collarWeight} >= 0`),
    check("barbell_configs_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

export const plateLoadedMachineProfiles = pgTable(
  "plate_loaded_machine_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    equipmentItemId: uuid("equipment_item_id").notNull(),
    geometryCertainty: text("geometry_certainty").notNull(),
    startingResistance: numeric("starting_resistance", {
      precision: 7,
      scale: 2,
      mode: "number",
    }),
    startingResistanceUnit: unitEnum("starting_resistance_unit"),
    loadingPointCount: integer("loading_point_count"),
    balancingRule: text("balancing_rule"),
    targetEntryMeaning: text("target_entry_meaning"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("plate_loaded_machine_profiles_item_uq").on(t.equipmentItemId),
    uniqueIndex("plate_loaded_machine_profiles_id_user_uq").on(t.id, t.userId),
    foreignKey({
      name: "plate_loaded_machine_profiles_item_owner_fk",
      columns: [t.equipmentItemId, t.userId],
      foreignColumns: [equipmentItems.id, equipmentItems.userId],
    }).onDelete("cascade"),
    check(
      "plate_loaded_machine_profiles_certainty_valid",
      sql`${t.geometryCertainty} IN ('known', 'partial', 'unknown')`,
    ),
    check(
      "plate_loaded_machine_profiles_resistance_unit_pair",
      sql`(${t.startingResistance} IS NULL) = (${t.startingResistanceUnit} IS NULL)`,
    ),
    check(
      "plate_loaded_machine_profiles_resistance_valid",
      sql`${t.startingResistance} IS NULL OR ${t.startingResistance} >= 0`,
    ),
    check(
      "plate_loaded_machine_profiles_points_valid",
      sql`${t.loadingPointCount} IS NULL OR ${t.loadingPointCount} > 0`,
    ),
    check(
      "plate_loaded_machine_profiles_balancing_valid",
      sql`${t.balancingRule} IS NULL OR ${t.balancingRule} IN ('single_point', 'identical_each_point')`,
    ),
    check(
      "plate_loaded_machine_profiles_entry_valid",
      sql`${t.targetEntryMeaning} IS NULL OR ${t.targetEntryMeaning} IN ('total_system', 'per_loading_point')`,
    ),
    check(
      "plate_loaded_machine_profiles_single_point_count",
      sql`${t.balancingRule} <> 'single_point' OR ${t.loadingPointCount} = 1`,
    ),
    check(
      "plate_loaded_machine_profiles_unknown_empty",
      sql`${t.geometryCertainty} <> 'unknown' OR (${t.startingResistance} IS NULL AND ${t.startingResistanceUnit} IS NULL AND ${t.loadingPointCount} IS NULL AND ${t.balancingRule} IS NULL AND ${t.targetEntryMeaning} IS NULL)`,
    ),
    check(
      "plate_loaded_machine_profiles_known_complete",
      sql`${t.geometryCertainty} <> 'known' OR (${t.startingResistance} IS NOT NULL AND ${t.loadingPointCount} IS NOT NULL AND ${t.balancingRule} IS NOT NULL AND ${t.targetEntryMeaning} IS NOT NULL)`,
    ),
  ],
);

export const plateLoadedMachineCompatiblePlates = pgTable(
  "plate_loaded_machine_compatible_plates",
  {
    machineProfileId: uuid("machine_profile_id").notNull(),
    plateInventoryId: uuid("plate_inventory_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.machineProfileId, t.plateInventoryId] }),
    foreignKey({
      name: "machine_compatible_plates_profile_owner_fk",
      columns: [t.machineProfileId, t.userId],
      foreignColumns: [plateLoadedMachineProfiles.id, plateLoadedMachineProfiles.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "machine_compatible_plates_inventory_owner_fk",
      columns: [t.plateInventoryId, t.userId],
      foreignColumns: [plateInventory.id, plateInventory.userId],
    }).onDelete("cascade"),
    index("machine_compatible_plates_inventory_idx").on(t.plateInventoryId),
  ],
);

export const cableMachineProfiles = pgTable(
  "cable_machine_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    equipmentItemId: uuid("equipment_item_id").notNull(),
    geometryCertainty: text("geometry_certainty").notNull(),
    stackCount: integer("stack_count"),
    topology: text("topology"),
    displayedUnit: unitEnum("displayed_unit"),
    ratioStatus: text("ratio_status").notNull().default("unknown"),
    ratioNumerator: integer("ratio_numerator"),
    ratioDenominator: integer("ratio_denominator"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("cable_machine_profiles_item_uq").on(t.equipmentItemId),
    uniqueIndex("cable_machine_profiles_id_user_uq").on(t.id, t.userId),
    foreignKey({
      name: "cable_machine_profiles_item_owner_fk",
      columns: [t.equipmentItemId, t.userId],
      foreignColumns: [equipmentItems.id, equipmentItems.userId],
    }).onDelete("cascade"),
    check(
      "cable_machine_profiles_certainty_valid",
      sql`${t.geometryCertainty} IN ('known', 'partial', 'unknown')`,
    ),
    check(
      "cable_machine_profiles_stack_count_valid",
      sql`${t.stackCount} IS NULL OR ${t.stackCount} > 0`,
    ),
    check(
      "cable_machine_profiles_topology_valid",
      sql`${t.topology} IS NULL OR ${t.topology} IN ('shared_selection', 'independent_per_stack')`,
    ),
    check(
      "cable_machine_profiles_ratio_status_valid",
      sql`${t.ratioStatus} IN ('known', 'unknown')`,
    ),
    check(
      "cable_machine_profiles_ratio_valid",
      sql`(${t.ratioStatus} = 'unknown' AND ${t.ratioNumerator} IS NULL AND ${t.ratioDenominator} IS NULL) OR (${t.ratioStatus} = 'known' AND ${t.ratioNumerator} > 0 AND ${t.ratioDenominator} > 0)`,
    ),
    check(
      "cable_machine_profiles_unknown_empty",
      sql`${t.geometryCertainty} <> 'unknown' OR (${t.stackCount} IS NULL AND ${t.topology} IS NULL AND ${t.displayedUnit} IS NULL AND ${t.ratioStatus} = 'unknown' AND ${t.ratioNumerator} IS NULL AND ${t.ratioDenominator} IS NULL)`,
    ),
    check(
      "cable_machine_profiles_known_complete",
      sql`${t.geometryCertainty} <> 'known' OR (${t.stackCount} IS NOT NULL AND ${t.topology} IS NOT NULL AND ${t.displayedUnit} IS NOT NULL)`,
    ),
  ],
);

export const cableStackSteps = pgTable(
  "cable_stack_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    cableProfileId: uuid("cable_profile_id").notNull(),
    stackIndex: integer("stack_index").notNull(),
    stepIndex: integer("step_index").notNull(),
    positionLabel: text("position_label"),
    displayedLoad: numeric("displayed_load", {
      precision: 7,
      scale: 2,
      mode: "number",
    }).notNull(),
  },
  (t) => [
    uniqueIndex("cable_stack_steps_profile_stack_step_uq").on(
      t.cableProfileId,
      t.stackIndex,
      t.stepIndex,
    ),
    foreignKey({
      name: "cable_stack_steps_profile_owner_fk",
      columns: [t.cableProfileId, t.userId],
      foreignColumns: [cableMachineProfiles.id, cableMachineProfiles.userId],
    }).onDelete("cascade"),
    check("cable_stack_steps_stack_valid", sql`${t.stackIndex} >= 0`),
    check("cable_stack_steps_step_valid", sql`${t.stepIndex} >= 0`),
    check("cable_stack_steps_load_valid", sql`${t.displayedLoad} >= 0`),
    check(
      "cable_stack_steps_position_label_valid",
      sql`${t.positionLabel} IS NULL OR (length(btrim(${t.positionLabel})) > 0 AND length(${t.positionLabel}) <= 80)`,
    ),
  ],
);

export const cableAttachmentProfiles = pgTable(
  "cable_attachment_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    equipmentItemId: uuid("equipment_item_id").notNull(),
    attachmentKind: text("attachment_kind").notNull(),
    connectionStandard: text("connection_standard"),
    status: text("status").notNull().default("unknown"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("cable_attachment_profiles_item_uq").on(t.equipmentItemId),
    uniqueIndex("cable_attachment_profiles_id_user_uq").on(t.id, t.userId),
    foreignKey({
      name: "cable_attachment_profiles_item_owner_fk",
      columns: [t.equipmentItemId, t.userId],
      foreignColumns: [equipmentItems.id, equipmentItems.userId],
    }).onDelete("cascade"),
    check(
      "cable_attachment_profiles_kind_valid",
      sql`${t.attachmentKind} IN ('rope', 'straight_bar', 'lat_bar', 'v_bar', 'single_handle', 'ankle_cuff', 'other')`,
    ),
    check(
      "cable_attachment_profiles_connection_valid",
      sql`${t.connectionStandard} IS NULL OR (length(btrim(${t.connectionStandard})) > 0 AND length(${t.connectionStandard}) <= 120)`,
    ),
    check(
      "cable_attachment_profiles_status_valid",
      sql`${t.status} IN ('known', 'unknown')`,
    ),
  ],
);

export const cableAttachmentCompatibilities = pgTable(
  "cable_attachment_compatibilities",
  {
    cableProfileId: uuid("cable_profile_id").notNull(),
    attachmentProfileId: uuid("attachment_profile_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cableProfileId, t.attachmentProfileId] }),
    foreignKey({
      name: "cable_attachment_compatibilities_cable_owner_fk",
      columns: [t.cableProfileId, t.userId],
      foreignColumns: [cableMachineProfiles.id, cableMachineProfiles.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "cable_attachment_compatibilities_attachment_owner_fk",
      columns: [t.attachmentProfileId, t.userId],
      foreignColumns: [cableAttachmentProfiles.id, cableAttachmentProfiles.userId],
    }).onDelete("cascade"),
  ],
);
