import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import type {
  ProgramScheduleDocument,
  ScheduledProgramEventIntentSnapshot,
} from "@/lib/program-schedule";
import { users } from "./user";
import { programs, programVersions, workoutTemplates } from "./program";

/**
 * Owner-scoped scheduling root for one Program. The current version is
 * nullable so the root and its first immutable version can be created in one
 * transaction before the pointer is advanced.
 */
export const programSchedules = pgTable(
  "program_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    programId: uuid("program_id").notNull(),
    currentVersionId: uuid("current_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("program_schedules_program_uq").on(t.programId),
    uniqueIndex("program_schedules_id_user_program_uq").on(
      t.id,
      t.userId,
      t.programId,
    ),
    foreignKey({
      name: "program_schedules_program_owner_fk",
      columns: [t.programId, t.userId],
      foreignColumns: [programs.id, programs.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * Immutable, validated schedule publication. It records the exact reviewed
 * Program version rather than consulting whichever Program version is current
 * later.
 */
export const programScheduleVersions = pgTable(
  "program_schedule_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    programId: uuid("program_id").notNull(),
    scheduleId: uuid("schedule_id").notNull(),
    versionNo: integer("version_no").notNull(),
    parentVersionId: uuid("parent_version_id").references(
      (): AnyPgColumn => programScheduleVersions.id,
      { onDelete: "no action" },
    ),
    sourceProgramVersionId: uuid("source_program_version_id").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    document: jsonb("document").$type<ProgramScheduleDocument>().notNull(),
    contentHash: text("content_hash").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("program_schedule_versions_schedule_number_uq").on(
      t.scheduleId,
      t.versionNo,
    ),
    uniqueIndex("program_schedule_versions_identity_root_uq").on(
      t.id,
      t.scheduleId,
      t.userId,
      t.programId,
    ),
    uniqueIndex("program_schedule_versions_event_source_uq").on(
      t.id,
      t.scheduleId,
      t.userId,
      t.programId,
      t.sourceProgramVersionId,
    ),
    foreignKey({
      name: "program_schedule_versions_schedule_owner_fk",
      columns: [t.scheduleId, t.userId, t.programId],
      foreignColumns: [
        programSchedules.id,
        programSchedules.userId,
        programSchedules.programId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "program_schedule_versions_parent_root_fk",
      columns: [t.parentVersionId, t.scheduleId, t.userId, t.programId],
      foreignColumns: [t.id, t.scheduleId, t.userId, t.programId],
    }).onDelete("no action"),
    foreignKey({
      name: "program_schedule_versions_source_program_fk",
      columns: [t.sourceProgramVersionId, t.programId],
      foreignColumns: [programVersions.id, programVersions.programId],
    }).onDelete("no action"),
    check(
      "program_schedule_versions_number_positive",
      sql`${t.versionNo} >= 1`,
    ),
    check(
      "program_schedule_versions_parent_distinct",
      sql`${t.parentVersionId} IS NULL OR ${t.parentVersionId} <> ${t.id}`,
    ),
    check(
      "program_schedule_versions_document_valid",
      sql`${t.schemaVersion} = 1 AND jsonb_typeof(${t.document}) = 'object' AND jsonb_typeof(${t.document}->'schemaVersion') = 'string' AND (${t.document}->>'schemaVersion') = 'program-schedule/1'`,
    ),
    check(
      "program_schedule_versions_hash_valid",
      sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * Operational instances of immutable schedule intent. Only lifecycle state,
 * the current planned date, adjustment evidence, revision, and resolution
 * timestamps are mutable after insertion.
 */
export const scheduledProgramEvents = pgTable(
  "scheduled_program_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    programId: uuid("program_id").notNull(),
    scheduleId: uuid("schedule_id").notNull(),
    scheduleVersionId: uuid("schedule_version_id").notNull(),
    sourceProgramVersionId: uuid("source_program_version_id").notNull(),
    sourcePhaseId: uuid("source_phase_id").notNull(),
    sourcePhaseName: text("source_phase_name").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    kind: text("kind").notNull(),
    scheduleKind: text("schedule_kind").notNull(),
    routineLineageId: uuid("routine_lineage_id"),
    intentSnapshot: jsonb("intent_snapshot")
      .$type<ScheduledProgramEventIntentSnapshot>()
      .notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    cyclePosition: integer("cycle_position").notNull(),
    programWeek: integer("program_week").notNull(),
    originalLocalDate: date("original_local_date", { mode: "string" }).notNull(),
    currentLocalDate: date("current_local_date", { mode: "string" }).notNull(),
    timezone: text("timezone").notNull(),
    status: text("status").notNull().default("scheduled"),
    adjustmentKind: text("adjustment_kind"),
    revision: integer("revision").notNull().default(0),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("scheduled_program_events_version_source_event_idx").on(
      t.scheduleVersionId,
      t.sourceEventId,
    ),
    uniqueIndex("scheduled_program_events_version_sequence_uq").on(
      t.scheduleVersionId,
      t.sequenceNo,
    ),
    index("scheduled_program_events_owner_date_status_idx").on(
      t.userId,
      t.currentLocalDate,
      t.status,
    ),
    foreignKey({
      name: "scheduled_program_events_exact_version_fk",
      columns: [
        t.scheduleVersionId,
        t.scheduleId,
        t.userId,
        t.programId,
        t.sourceProgramVersionId,
      ],
      foreignColumns: [
        programScheduleVersions.id,
        programScheduleVersions.scheduleId,
        programScheduleVersions.userId,
        programScheduleVersions.programId,
        programScheduleVersions.sourceProgramVersionId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "scheduled_program_events_routine_lineage_fk",
      columns: [t.sourceProgramVersionId, t.routineLineageId],
      foreignColumns: [
        workoutTemplates.programVersionId,
        workoutTemplates.lineageId,
      ],
    }).onDelete("no action"),
    check(
      "scheduled_program_events_phase_name_valid",
      sql`length(btrim(${t.sourcePhaseName})) > 0`,
    ),
    check(
      "scheduled_program_events_kind_valid",
      sql`${t.kind} IN ('resistance', 'cardio', 'recovery', 'rest')`,
    ),
    check(
      "scheduled_program_events_schedule_kind_valid",
      sql`${t.scheduleKind} IN ('fixed_7_day', 'rolling')`,
    ),
    check(
      "scheduled_program_events_routine_lineage_shape",
      sql`(${t.kind} = 'resistance' AND ${t.routineLineageId} IS NOT NULL) OR (${t.kind} <> 'resistance' AND ${t.routineLineageId} IS NULL)`,
    ),
    check(
      "scheduled_program_events_intent_snapshot_valid",
      sql`jsonb_typeof(${t.intentSnapshot}) = 'object'
        AND ${t.intentSnapshot} ?& ARRAY['id', 'kind']
        AND jsonb_typeof(${t.intentSnapshot}->'id') = 'string'
        AND jsonb_typeof(${t.intentSnapshot}->'kind') = 'string'
        AND ${t.intentSnapshot}->>'id' = ${t.sourceEventId}::text
        AND ${t.intentSnapshot}->>'kind' = ${t.kind}
        AND (
          (${t.kind} = 'resistance' AND jsonb_typeof(${t.intentSnapshot}->'routineLineageId') = 'string' AND ${t.intentSnapshot}->>'routineLineageId' = ${t.routineLineageId}::text)
          OR (
            ${t.kind} <> 'resistance'
            AND NOT ${t.intentSnapshot} ? 'routineLineageId'
          )
        )`,
    ),
    check(
      "scheduled_program_events_position_valid",
      sql`${t.sequenceNo} >= 1 AND ${t.cyclePosition} >= 1 AND ${t.programWeek} >= 1`,
    ),
    check(
      "scheduled_program_events_timezone_valid",
      sql`length(btrim(${t.timezone})) > 0`,
    ),
    check(
      "scheduled_program_events_status_valid",
      sql`${t.status} IN ('scheduled', 'started', 'completed', 'skipped', 'superseded', 'abandoned')`,
    ),
    check(
      "scheduled_program_events_adjustment_valid",
      sql`${t.adjustmentKind} IS NULL OR ${t.adjustmentKind} IN ('shift', 'manual')`,
    ),
    check(
      "scheduled_program_events_revision_valid",
      sql`${t.revision} >= 0`,
    ),
    check(
      "scheduled_program_events_resolution_valid",
      sql`(${t.status} IN ('scheduled', 'started') AND ${t.resolvedAt} IS NULL) OR (${t.status} IN ('completed', 'skipped', 'superseded', 'abandoned') AND ${t.resolvedAt} IS NOT NULL)`,
    ),
  ],
);
