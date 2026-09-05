import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { users, type RoutineWarmupSet } from "./user";
import { exercises } from "./exercise";
import { archiveOperations } from "./archive";
import { unitEnum } from "./enums";
import type {
  TimedPrescription,
  ProgramDayWarmupItem,
  StoredProgramDocument,
} from "@/lib/program-document";
import type {
  ProgramDayIntent,
  ProgramSlotIntent,
} from "@/lib/program-document";
import type { ProgramPreflightResult } from "@/lib/program-preflight";

export const programs = pgTable(
  "programs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Program"),
    status: text("status").notNull().default("active"),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => programVersions.id,
      { onDelete: "no action" }
    ),
    recommendationRevision: integer("recommendation_revision")
      .notNull()
      .default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveOperationId: uuid("archive_operation_id").references(
      () => archiveOperations.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("programs_one_active_user_uq")
      .on(t.userId)
      .where(sql`${t.status} = 'active' AND ${t.archivedAt} IS NULL`),
    uniqueIndex("programs_id_user_uq").on(t.id, t.userId),
    check(
      "programs_status_valid",
      sql`${t.status} IN ('active', 'inactive', 'archived')`
    ),
    check(
      "programs_current_version_state_check",
      sql`(${t.status} IN ('active', 'inactive') AND ${t.archivedAt} IS NULL AND ${t.currentVersionId} IS NOT NULL) OR (${t.status} = 'archived' AND ${t.archivedAt} IS NOT NULL)`
    ),
  ]
);

export const programVersions = pgTable(
  "program_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull().default(1),
    name: text("name").notNull().default("Program"),
    parentVersionId: uuid("parent_version_id").references(
      (): AnyPgColumn => programVersions.id,
      { onDelete: "no action" }
    ),
    restoredFromVersionId: uuid("restored_from_version_id").references(
      (): AnyPgColumn => programVersions.id,
      { onDelete: "no action" }
    ),
    publicationSource: text("publication_source")
      .notNull()
      .default("setup"),
    reviewHash: text("review_hash"),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceImportEventId: uuid("source_import_event_id"),
    changeSummary: text("change_summary"),
    documentSchemaVersion: integer("document_schema_version")
      .notNull()
      .default(1),
    publicationPreflight: jsonb("publication_preflight").$type<ProgramPreflightResult>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("program_versions_program_number_uq").on(
      t.programId,
      t.versionNo
    ),
    uniqueIndex("program_versions_id_program_uq").on(t.id, t.programId),
    foreignKey({
      name: "program_versions_parent_program_fk",
      columns: [t.parentVersionId, t.programId],
      foreignColumns: [t.id, t.programId],
    }),
    foreignKey({
      name: "program_versions_restore_program_fk",
      columns: [t.restoredFromVersionId, t.programId],
      foreignColumns: [t.id, t.programId],
    }),
    check("program_versions_number_positive", sql`${t.versionNo} >= 1`),
    check(
      "program_versions_document_schema_valid",
      sql`${t.documentSchemaVersion} IN (1, 2, 3)`,
    ),
    check(
      "program_versions_source_valid",
      sql`${t.publicationSource} IN ('setup', 'import', 'editor', 'recommendation', 'restore')`
    ),
  ]
);

export const workoutTemplates = pgTable(
  "workout_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    programVersionId: uuid("program_version_id")
      .notNull()
      .references(() => programVersions.id, { onDelete: "cascade" }),
    lineageId: uuid("lineage_id").notNull().defaultRandom(),
    name: text("name").notNull(),
    orderIdx: integer("order_idx").notNull().default(0),
    notes: text("notes"),
    warmupNotes: text("warmup_notes"),
    warmupItems: jsonb("warmup_items")
      .$type<ProgramDayWarmupItem[]>()
      .notNull()
      .default([]),
    intent: jsonb("intent").$type<ProgramDayIntent>(),
  },
  (t) => [
    uniqueIndex("workout_templates_version_order_uq").on(
      t.programVersionId,
      t.orderIdx
    ),
    uniqueIndex("workout_templates_version_lineage_uq").on(
      t.programVersionId,
      t.lineageId
    ),
    uniqueIndex("workout_templates_id_version_uq").on(
      t.id,
      t.programVersionId
    ),
    check("workout_templates_order_nonnegative", sql`${t.orderIdx} >= 0`),
  ]
);

export const supersetGroups = pgTable(
  "superset_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workoutTemplateId: uuid("workout_template_id")
      .notNull()
      .references(() => workoutTemplates.id, { onDelete: "cascade" }),
    lineageId: uuid("lineage_id").notNull().defaultRandom(),
    name: text("name").notNull().default("Superset"),
    orderIdx: integer("order_idx").notNull().default(0),
    plannedRounds: integer("planned_rounds"),
    restBetweenMembersSec: integer("rest_between_members_sec"),
    restAfterRoundSec: integer("rest_after_round_sec").notNull().default(90),
  },
  (t) => [
    uniqueIndex("superset_groups_template_order_uq").on(
      t.workoutTemplateId,
      t.orderIdx
    ),
    uniqueIndex("superset_groups_template_lineage_uq").on(
      t.workoutTemplateId,
      t.lineageId
    ),
    uniqueIndex("superset_groups_id_template_uq").on(
      t.id,
      t.workoutTemplateId
    ),
    check("superset_groups_order_nonnegative", sql`${t.orderIdx} >= 0`),
    check(
      "superset_groups_rounds_valid",
      sql`${t.plannedRounds} IS NULL OR ${t.plannedRounds} >= 1`
    ),
    check(
      "superset_groups_member_rest_valid",
      sql`${t.restBetweenMembersSec} IS NULL OR ${t.restBetweenMembersSec} BETWEEN 0 AND 1800`
    ),
    check(
      "superset_groups_rest_valid",
      sql`${t.restAfterRoundSec} BETWEEN 0 AND 1800`
    ),
  ]
);

export const workoutTemplateExercises = pgTable(
  "workout_template_exercises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workoutTemplateId: uuid("workout_template_id")
      .notNull()
      .references(() => workoutTemplates.id, { onDelete: "cascade" }),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    lineageId: uuid("lineage_id").notNull().defaultRandom(),
    orderIdx: integer("order_idx").notNull().default(0),
    supersetGroupId: uuid("superset_group_id").references(
      () => supersetGroups.id,
      { onDelete: "set null" }
    ),
    groupMemberOrderIdx: integer("group_member_order_idx"),
    restSec: integer("rest_sec").notNull().default(90),
    notes: text("notes"),
    warmupNotes: text("warmup_notes"),
    warmupSets: jsonb("warmup_sets")
      .$type<RoutineWarmupSet[]>()
      .notNull()
      .default([]),
    setNotes: jsonb("set_notes")
      .$type<Array<string | null>>()
      .notNull()
      .default([]),
    intent: jsonb("intent").$type<ProgramSlotIntent>(),
  },
  (t) => [
    index("wte_template_idx").on(t.workoutTemplateId),
    uniqueIndex("wte_template_lineage_uq").on(t.workoutTemplateId, t.lineageId),
    uniqueIndex("wte_template_order_uq").on(t.workoutTemplateId, t.orderIdx),
    foreignKey({
      name: "wte_superset_template_fk",
      columns: [t.supersetGroupId, t.workoutTemplateId],
      foreignColumns: [supersetGroups.id, supersetGroups.workoutTemplateId],
    }),
    check("wte_order_nonnegative", sql`${t.orderIdx} >= 0`),
    check(
      "wte_group_member_order_valid",
      sql`${t.groupMemberOrderIdx} IS NULL OR (${t.supersetGroupId} IS NOT NULL AND ${t.groupMemberOrderIdx} >= 0)`
    ),
    check("wte_rest_valid", sql`${t.restSec} BETWEEN 0 AND 1800`),
    check(
      "wte_warmup_load_unit_check",
      sql`NOT jsonb_path_exists(${t.warmupSets}, '$[*] ? ((@.load != null && (!exists(@.loadUnit) || @.loadUnit == null)) || (@.load == null && exists(@.loadUnit) && @.loadUnit != null))')`
    ),
  ]
);

export const programDrafts = pgTable(
  "program_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    baseVersionId: uuid("base_version_id")
      .notNull()
      .references(() => programVersions.id, { onDelete: "cascade" }),
    restoredFromVersionId: uuid("restored_from_version_id").references(
      () => programVersions.id,
      { onDelete: "cascade" }
    ),
    status: text("status").notNull().default("open"),
    revision: integer("revision").notNull().default(1),
    document: jsonb("document").$type<StoredProgramDocument>().notNull(),
    contentHash: text("content_hash").notNull(),
    lastMutationId: uuid("last_mutation_id").notNull(),
    reviewedRevision: integer("reviewed_revision"),
    reviewHash: text("review_hash"),
    reviewSummary: jsonb("review_summary"),
    publishedVersionId: uuid("published_version_id").references(
      () => programVersions.id,
      { onDelete: "cascade" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("program_drafts_one_open_program_uq")
      .on(t.programId)
      .where(sql`${t.status} = 'open'`),
    uniqueIndex("program_drafts_user_mutation_uq").on(
      t.userId,
      t.lastMutationId
    ),
    index("program_drafts_user_updated_idx").on(t.userId, t.updatedAt),
    foreignKey({
      name: "program_drafts_program_owner_fk",
      columns: [t.programId, t.userId],
      foreignColumns: [programs.id, programs.userId],
    }),
    foreignKey({
      name: "program_drafts_base_program_fk",
      columns: [t.baseVersionId, t.programId],
      foreignColumns: [programVersions.id, programVersions.programId],
    }),
    foreignKey({
      name: "program_drafts_restore_program_fk",
      columns: [t.restoredFromVersionId, t.programId],
      foreignColumns: [programVersions.id, programVersions.programId],
    }),
    foreignKey({
      name: "program_drafts_published_program_fk",
      columns: [t.publishedVersionId, t.programId],
      foreignColumns: [programVersions.id, programVersions.programId],
    }),
    check(
      "program_drafts_status_valid",
      sql`${t.status} IN ('open', 'published', 'discarded')`
    ),
    check("program_drafts_revision_positive", sql`${t.revision} >= 1`),
    check(
      "program_drafts_review_pair_check",
      sql`(${t.reviewedRevision} IS NULL AND ${t.reviewHash} IS NULL) OR (${t.reviewedRevision} IS NOT NULL AND ${t.reviewHash} IS NOT NULL)`
    ),
    check(
      "program_drafts_restore_source_check",
      sql`${t.restoredFromVersionId} IS NULL OR ${t.restoredFromVersionId} <> ${t.baseVersionId}`
    ),
  ]
);

/**
 * Current + historical targets for a template slot. The active prescription
 * is the one with `supersededById IS NULL`; approving an adaptation writes a
 * new row and links the old one (plan §12: prescription history = the
 * progression record).
 */
export const exercisePrescriptions = pgTable(
  "exercise_prescriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateExerciseId: uuid("template_exercise_id")
      .notNull()
      .references(() => workoutTemplateExercises.id, { onDelete: "cascade" }),
    sets: integer("sets").notNull(),
    repRangeMin: integer("rep_range_min"),
    repRangeMax: integer("rep_range_max"),
    timedPrescription: jsonb("timed_prescription").$type<TimedPrescription>(),
    targetLoad: numeric("target_load", { precision: 7, scale: 2, mode: "number" }), // null = bodyweight/band
    targetLoadUnit: unitEnum("target_load_unit"),
    progressionRuleId: text("progression_rule_id")
      .notNull()
      .default("double_progression"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    supersededById: uuid("superseded_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("prescriptions_slot_idx").on(t.templateExerciseId),
    uniqueIndex("exercise_prescriptions_active_slot_uq")
      .on(t.templateExerciseId)
      .where(sql`${t.supersededById} IS NULL`),
    check(
      "exercise_prescriptions_target_load_unit_check",
      sql`(${t.targetLoad} IS NULL AND ${t.targetLoadUnit} IS NULL) OR (${t.targetLoad} IS NOT NULL AND ${t.targetLoadUnit} IS NOT NULL)`
    ),
    check(
      "exercise_prescriptions_target_bounds_check",
      sql`${t.sets} BETWEEN 1 AND 20 AND ((${t.timedPrescription} IS NULL AND ${t.repRangeMin} IS NOT NULL AND ${t.repRangeMax} IS NOT NULL AND ${t.repRangeMin} BETWEEN 1 AND 100 AND ${t.repRangeMax} BETWEEN ${t.repRangeMin} AND 100) OR (${t.timedPrescription} IS NOT NULL AND ${t.repRangeMin} IS NULL AND ${t.repRangeMax} IS NULL AND ${t.progressionRuleId} = 'manual' AND repbook_valid_timed_prescription(${t.timedPrescription})))`
    ),
  ]
);
