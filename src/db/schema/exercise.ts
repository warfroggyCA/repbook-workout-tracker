import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  activityClassEnum,
  movementPatternEnum,
  equipmentTypeEnum,
  loadSemanticsEnum,
  metricTypeEnum,
  exerciseMediaHostingEnum,
  exerciseMediaMatchScopeEnum,
  exerciseMediaStatusEnum,
  exerciseMediaTypeEnum,
} from "./enums";
import { equipmentDefinitions } from "./equipment";
import { users } from "./user";

export type ExerciseVariantAttributes = {
  angle?: string;
  position?: string;
  grip?: string;
  attachment?: string;
  laterality?: "bilateral" | "unilateral" | "alternating";
  assistance?: "none" | "weighted" | "assisted";
  machine?: string;
};

/** Analytical parent only. Exercise records remain the trackable variants. */
export const exerciseFamilies = pgTable(
  "exercise_families",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    movementPattern: movementPatternEnum("movement_pattern").notNull(),
    primaryMuscles: jsonb("primary_muscles").$type<string[]>().notNull(),
    secondaryMuscles: jsonb("secondary_muscles")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("exercise_families_key_idx").on(t.key),
    uniqueIndex("exercise_families_name_idx").on(t.name),
  ]
);

export const exercises = pgTable(
  "exercises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // null userId = seeded library exercise; set = user-created custom exercise
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").references(() => exerciseFamilies.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    movementPattern: movementPatternEnum("movement_pattern").notNull(),
    primaryMuscles: jsonb("primary_muscles").$type<string[]>().notNull(),
    secondaryMuscles: jsonb("secondary_muscles")
      .$type<string[]>()
      .notNull()
      .default([]),
    isUnilateral: boolean("is_unilateral").notNull().default(false),
    // Load rounding domain: barbell math vs dumbbell/kettlebell increments vs none
    loadType: text("load_type").notNull().default("external"), // "barbell" | "ez_bar" | "dumbbell" | "kettlebell" | "band" | "bodyweight" | "external"
    activityClass: activityClassEnum("activity_class")
      .notNull()
      .default("strength"),
    metricType: metricTypeEnum("metric_type")
      .notNull()
      .default("weight_reps"),
    loadSemantics: loadSemanticsEnum("load_semantics")
      .notNull()
      .default("total"),
    variantKey: text("variant_key").notNull().default("standard"),
    variantAttributes: jsonb("variant_attributes")
      .$type<ExerciseVariantAttributes>()
      .notNull()
      .default({}),
    catalogReviewed: boolean("catalog_reviewed").notNull().default(false),
    createdFromImportEventId: uuid("created_from_import_event_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("exercises_name_idx").on(t.name),
    uniqueIndex("exercises_family_variant_idx").on(t.familyId, t.variantKey),
  ]
);

/** Item-level source and licence provenance for the curated catalog. */
export const exerciseSources = pgTable(
  "exercise_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "cascade" }),
    sourceName: text("source_name").notNull(),
    sourceId: text("source_id"),
    sourceUrl: text("source_url"),
    license: text("license"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [index("exercise_sources_exercise_idx").on(t.exerciseId)]
);

export type ExerciseMediaRightsEvidence = {
  licenseUrl?: string;
  sourceFileSha1?: string;
  sourcePageRevisionId?: string;
  attributionRequired?: boolean;
  reviewNotes?: string;
};

/** Internal per-asset rights and hosting evidence; never projected directly to clients. */
export const exerciseMediaAssets = pgTable(
  "exercise_media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mediaType: exerciseMediaTypeEnum("media_type").notNull(),
    displayUrl: text("display_url").notNull(),
    originalAssetUrl: text("original_asset_url").notNull(),
    sourcePageUrl: text("source_page_url").notNull(),
    creator: text("creator").notNull(),
    license: text("license").notNull(),
    attributionText: text("attribution_text"),
    hosting: exerciseMediaHostingEnum("hosting").notNull(),
    redistributionAllowed: boolean("redistribution_allowed").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: doublePrecision("duration_seconds"),
    altText: text("alt_text").notNull(),
    title: text("title"),
    rightsEvidence: jsonb("rights_evidence")
      .$type<ExerciseMediaRightsEvidence>()
      .notNull()
      .default({}),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    status: exerciseMediaStatusEnum("status").notNull().default("pending"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("exercise_media_assets_checksum_idx").on(t.checksumSha256),
    index("exercise_media_assets_status_idx").on(t.status, t.disabledAt),
    check(
      "exercise_media_assets_dimensions_check",
      sql`(${t.width} IS NULL AND ${t.height} IS NULL) OR (${t.width} > 0 AND ${t.height} > 0)`
    ),
    check(
      "exercise_media_assets_duration_check",
      sql`${t.durationSeconds} IS NULL OR ${t.durationSeconds} > 0`
    ),
    check(
      "exercise_media_assets_withdrawn_check",
      sql`${t.status} <> 'withdrawn' OR ${t.withdrawnAt} IS NOT NULL`
    ),
  ]
);

export type ExerciseMediaVariantAttributes = Record<
  string,
  string | boolean | null
>;

/**
 * Exact-variant links are the default. Family reuse must also reproduce the
 * complete equipment signature and variant attributes before projection.
 */
export const exerciseMediaAssociations = pgTable(
  "exercise_media_associations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => exerciseMediaAssets.id, { onDelete: "cascade" }),
    exerciseId: uuid("exercise_id").references(() => exercises.id, {
      onDelete: "cascade",
    }),
    familyId: uuid("family_id").references(() => exerciseFamilies.id, {
      onDelete: "cascade",
    }),
    matchScope: exerciseMediaMatchScopeEnum("match_scope").notNull(),
    equipmentSignature: jsonb("equipment_signature")
      .$type<string[]>()
      .notNull()
      .default([]),
    variantAttributes: jsonb("variant_attributes")
      .$type<ExerciseMediaVariantAttributes>()
      .notNull()
      .default({}),
    matchNotes: text("match_notes").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isThumbnail: boolean("is_thumbnail").notNull().default(false),
    isPreferred: boolean("is_preferred").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("exercise_media_associations_asset_idx").on(t.assetId),
    index("exercise_media_associations_exercise_idx").on(t.exerciseId, t.sortOrder),
    index("exercise_media_associations_family_idx").on(t.familyId, t.sortOrder),
    check("exercise_media_associations_order_check", sql`${t.sortOrder} >= 0`),
    check(
      "exercise_media_associations_target_check",
      sql`(
        ${t.matchScope} = 'exact_variant'
        AND ${t.exerciseId} IS NOT NULL
        AND ${t.familyId} IS NULL
      ) OR (
        ${t.matchScope} = 'equivalent_family'
        AND ${t.exerciseId} IS NULL
        AND ${t.familyId} IS NOT NULL
        AND jsonb_array_length(${t.equipmentSignature}) > 0
      )`
    ),
  ]
);

export const exerciseAliases = pgTable(
  "exercise_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
  },
  (t) => [index("exercise_aliases_alias_idx").on(t.alias)]
);

/** User-confirmed, source-scoped mappings; never treated as global aliases. */
export const externalExerciseMappings = pgTable(
  "external_exercise_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceExerciseId: text("source_exercise_id"),
    sourceName: text("source_name").notNull(),
    sourceEquipment: text("source_equipment"),
    normalizedKey: text("normalized_key").notNull(),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "cascade" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("external_exercise_mappings_user_source_key_idx").on(
      t.userId,
      t.source,
      t.normalizedKey
    ),
    index("external_exercise_mappings_exercise_idx").on(t.exerciseId),
  ]
);

/**
 * All rows for an exercise are required together (barbell bench = barbell +
 * bench + rack). `minWeight` lets the filter exclude e.g. DB moves needing
 * more than the owned 35 lb dumbbells.
 */
export const exerciseEquipmentRequirements = pgTable(
  "exercise_equipment_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "cascade" }),
    equipmentType: equipmentTypeEnum("equipment_type").notNull(),
    equipmentDefinitionId: uuid("equipment_definition_id").references(
      () => equipmentDefinitions.id,
      { onDelete: "set null" }
    ),
    minWeight: numeric("min_weight", { precision: 7, scale: 2, mode: "number" }),
  }
);
