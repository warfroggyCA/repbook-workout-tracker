import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  numeric,
  doublePrecision,
  boolean,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  check,
  foreignKey,
  primaryKey,
} from "drizzle-orm/pg-core";
import {
  sessionStatusEnum,
  modificationTypeEnum,
  skipReasonEnum,
  substitutionReasonEnum,
  painSourceEnum,
  metricTypeEnum,
  loadSemanticsEnum,
  unitEnum,
} from "./enums";
import { users, type CoachingPrefs } from "./user";
import type { RoutineWarmupSet } from "./user";
import { supersetGroups, workoutTemplates } from "./program";
import type { SessionCompilerInput, SessionCompilerOutput } from "@/lib/session-compiler";
import type { ProgramDayWarmupItem } from "@/lib/program-document";
import { exercises } from "./exercise";
import { historyImportBatches } from "./events";
import { archiveOperations } from "./archive";

export const workoutSessions = pgTable(
  "workout_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").references(() => workoutTemplates.id, {
      onDelete: "set null",
    }),
    templateName: text("template_name"), // denormalized so history survives template edits
    // Snapshotted once at workout start so later Program edits cannot change it.
    dayWarmupNotes: text("day_warmup_notes"),
    dayWarmupItems: jsonb("day_warmup_items")
      .$type<ProgramDayWarmupItem[]>()
      .notNull()
      .default([]),
    importBatchId: uuid("import_batch_id").references(
      () => historyImportBatches.id,
      { onDelete: "cascade" }
    ),
    source: text("source").notNull().default("tracker"),
    sourceWorkoutKey: text("source_workout_key"),
    historyRevision: integer("history_revision").notNull().default(0),
    performedTimePrecision: text("performed_time_precision")
      .notNull()
      .default("instant"),
    sourceProgramId: uuid("source_program_id"),
    sourceProgramVersionId: uuid("source_program_version_id"),
    sourceDayLineageId: uuid("source_day_lineage_id"),
    dataQualityFlags: jsonb("data_quality_flags")
      .$type<string[]>()
      .notNull()
      .default([]),
    excludeDurationFromAnalytics: boolean("exclude_duration_from_analytics")
      .notNull()
      .default(false),
    // Versioned active-time evidence. Null tuple means legacy/unsupported;
    // source started_at and finished_at remain the wall-clock record.
    activeDurationSemanticsVersion: integer(
      "active_duration_semantics_version",
    ),
    activeDurationSeconds: integer("active_duration_seconds"),
    activeDurationBasis: text("active_duration_basis"),
    status: sessionStatusEnum("status").notNull().default("in_progress"),
    timeBudgetMin: integer("time_budget_min"),
    // Owner-scoped idempotency identity for an explicit Today Start intent.
    // Legacy/imported/compiler sessions intentionally retain null here.
    startRequestKey: text("start_request_key"),
    startRequestHash: text("start_request_hash"),
    compilationAcceptanceKey: text("compilation_acceptance_key"),
    compilationSnapshot: jsonb("compilation_snapshot").$type<{
      proposalId: string;
      proposalHash: string;
      acceptedAt: string;
      input: SessionCompilerInput;
      output: SessionCompilerOutput;
    }>(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    timezone: text("timezone").notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveOperationId: uuid("archive_operation_id").references(
      () => archiveOperations.id,
      { onDelete: "set null" }
    ),
  },
  (t) => [
    index("sessions_user_started_idx").on(t.userId, t.startedAt),
    index("workout_sessions_active_history_idx")
      .on(t.userId, t.localDate, t.startedAt)
      .where(
        sql`${t.archivedAt} IS NULL AND ${t.status} IN ('completed', 'abandoned')`
      ),
    uniqueIndex("workout_sessions_one_active_uq")
      .on(t.userId)
      .where(sql`${t.status} = 'in_progress' AND ${t.archivedAt} IS NULL`),
    uniqueIndex("workout_sessions_start_request_uq")
      .on(t.userId, t.startRequestKey)
      .where(sql`${t.startRequestKey} IS NOT NULL`),
    uniqueIndex("workout_sessions_compilation_acceptance_uq")
      .on(t.userId, t.compilationAcceptanceKey)
      .where(sql`${t.compilationAcceptanceKey} IS NOT NULL`),
    uniqueIndex("workout_sessions_history_manual_source_uq")
      .on(t.userId, t.sourceWorkoutKey)
      .where(
        sql`${t.source} = 'history_manual' AND ${t.sourceWorkoutKey} IS NOT NULL`
      ),
    uniqueIndex("workout_sessions_id_user_uq").on(t.id, t.userId),
    check(
      "workout_sessions_history_revision_check",
      sql`${t.historyRevision} >= 0`
    ),
    check(
      "workout_sessions_performed_time_precision_check",
      sql`${t.performedTimePrecision} IN ('instant', 'date_only')`
    ),
    check(
      "workout_sessions_source_program_tuple_check",
      sql`num_nonnulls(${t.sourceProgramId}, ${t.sourceProgramVersionId}, ${t.sourceDayLineageId}) IN (0, 3)`
    ),
    check(
      "workout_sessions_local_calendar_check",
      sql`${t.localDate} = timezone(${t.timezone}, ${t.startedAt})::date`
    ),
    check(
      "workout_sessions_time_budget_check",
      sql`${t.timeBudgetMin} IS NULL OR ${t.timeBudgetMin} BETWEEN 5 AND 600`
    ),
    check(
      "workout_sessions_active_duration_tuple_check",
      sql`(
        ${t.activeDurationSemanticsVersion} IS NULL
        AND ${t.activeDurationSeconds} IS NULL
        AND ${t.activeDurationBasis} IS NULL
      ) OR (
        ${t.activeDurationSemanticsVersion} = 1
        AND ${t.activeDurationBasis} IS NOT NULL
        AND (
          (
            ${t.activeDurationBasis} IN ('wall_clock_no_stale_signal', 'owner_reported')
            AND ${t.activeDurationSeconds} IS NOT NULL
            AND ${t.activeDurationSeconds} BETWEEN 0 AND 604800
          ) OR (
            ${t.activeDurationBasis} = 'interruption_unknown'
            AND ${t.activeDurationSeconds} IS NULL
          )
        )
      )`
    ),
    check(
      "workout_sessions_start_request_identity_check",
      sql`(${t.startRequestKey} IS NULL AND ${t.startRequestHash} IS NULL) OR (${t.startRequestKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ${t.startRequestHash} ~ '^[0-9a-f]{64}$')`
    ),
    check(
      "workout_sessions_compilation_snapshot_check",
      sql`(${t.compilationAcceptanceKey} IS NULL AND ${t.compilationSnapshot} IS NULL) OR (${t.compilationAcceptanceKey} IS NOT NULL AND ${t.compilationSnapshot} IS NOT NULL AND ${t.source} = 'compiler')`
    ),
  ]
);

export type SessionEquipmentGeometrySnapshot = {
  version: number;
  kind: string;
} & Record<string, unknown>;

/**
 * Immutable point-in-time equipment evidence for an exact workout setup.
 * Live IDs are traceability only; labels, geometry, unit, and hash remain the
 * historical truth after inventory changes.
 */
export const sessionEquipmentSnapshots = pgTable(
  "session_equipment_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    sessionExerciseId: uuid("session_exercise_id").notNull(),
    equipmentItemId: uuid("equipment_item_id"),
    loadProfileId: uuid("load_profile_id"),
    attachmentItemId: uuid("attachment_item_id"),
    attachmentProfileId: uuid("attachment_profile_id"),
    equipmentLabel: text("equipment_label").notNull(),
    equipmentDefinitionKey: text("equipment_definition_key"),
    attachmentLabel: text("attachment_label"),
    attachmentDefinitionKey: text("attachment_definition_key"),
    profileKind: text("profile_kind").notNull(),
    geometryCertainty: text("geometry_certainty").notNull(),
    unit: unitEnum("unit"),
    selectionProvenance: text("selection_provenance").notNull(),
    configurationRevision: integer("configuration_revision").notNull(),
    configurationHash: text("configuration_hash").notNull(),
    geometryVersion: integer("geometry_version").notNull().default(1),
    geometrySnapshot: jsonb("geometry_snapshot")
      .$type<SessionEquipmentGeometrySnapshot>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("session_equipment_snapshots_id_exercise_session_uq").on(
      t.id,
      t.sessionExerciseId,
      t.sessionId,
    ),
    uniqueIndex("session_equipment_snapshots_id_exercise_uq").on(
      t.id,
      t.sessionExerciseId,
    ),
    index("session_equipment_snapshots_exercise_created_idx").on(
      t.sessionExerciseId,
      t.createdAt,
    ),
    foreignKey({
      name: "session_equipment_snapshots_session_owner_fk",
      columns: [t.sessionId, t.userId],
      foreignColumns: [workoutSessions.id, workoutSessions.userId],
    }).onDelete("cascade"),
    check(
      "session_equipment_snapshots_profile_kind_valid",
      sql`${t.profileKind} IN ('plate_loaded_implement', 'plate_loaded_machine', 'cable_machine', 'incremental_implement', 'bodyweight', 'resistance_band', 'other')`,
    ),
    check(
      "session_equipment_snapshots_certainty_valid",
      sql`${t.geometryCertainty} IN ('known', 'partial', 'unknown')`,
    ),
    check(
      "session_equipment_snapshots_provenance_valid",
      sql`${t.selectionProvenance} IN ('auto_unique', 'user_selected', 'imported', 'legacy_unknown')`,
    ),
    check(
      "session_equipment_snapshots_revision_valid",
      sql`${t.configurationRevision} >= 1 AND ${t.geometryVersion} >= 1`,
    ),
    check(
      "session_equipment_snapshots_labels_valid",
      sql`length(btrim(${t.equipmentLabel})) > 0 AND (${t.attachmentLabel} IS NULL OR length(btrim(${t.attachmentLabel})) > 0)`,
    ),
    check(
      "session_equipment_snapshots_hash_valid",
      sql`${t.configurationHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "session_equipment_snapshots_geometry_valid",
      sql`jsonb_typeof(${t.geometrySnapshot}) = 'object' AND (${t.geometrySnapshot}->>'version') = ${t.geometryVersion}::text AND (${t.geometrySnapshot}->>'kind') = ${t.profileKind}`,
    ),
    check(
      "session_equipment_snapshots_live_profile_shape_valid",
      sql`(${t.profileKind} IN ('plate_loaded_implement', 'plate_loaded_machine', 'cable_machine') AND ${t.equipmentItemId} IS NOT NULL AND ${t.loadProfileId} IS NOT NULL) OR (${t.profileKind} NOT IN ('plate_loaded_implement', 'plate_loaded_machine', 'cable_machine') AND ${t.loadProfileId} IS NULL)`,
    ),
  ],
);

export const sessionExerciseGroups = pgTable(
  "session_exercise_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => workoutSessions.id, { onDelete: "cascade" }),
    sourceGroupId: uuid("source_group_id").references(() => supersetGroups.id, {
      onDelete: "set null",
    }),
    lineageId: uuid("lineage_id"),
    provenance: text("provenance").notNull(),
    name: text("name").notNull(),
    orderIdx: integer("order_idx").notNull(),
    plannedRounds: integer("planned_rounds"),
    memberCount: integer("member_count"),
    restBetweenMembersSec: integer("rest_between_members_sec"),
    restBetweenRoundsSec: integer("rest_between_rounds_sec"),
    snapshotVersion: integer("snapshot_version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("session_exercise_groups_session_order_uq").on(
      t.sessionId,
      t.orderIdx,
    ),
    uniqueIndex("session_exercise_groups_id_session_uq").on(t.id, t.sessionId),
    index("session_exercise_groups_source_idx")
      .on(t.sourceGroupId, t.sessionId)
      .where(sql`${t.sourceGroupId} IS NOT NULL`),
    check(
      "session_exercise_groups_provenance_valid",
      sql`${t.provenance} IN ('program', 'compiler', 'import', 'legacy')`,
    ),
    check("session_exercise_groups_order_valid", sql`${t.orderIdx} >= 0`),
    check(
      "session_exercise_groups_rounds_valid",
      sql`${t.plannedRounds} IS NULL OR ${t.plannedRounds} >= 1`,
    ),
    check(
      "session_exercise_groups_member_count_valid",
      sql`${t.memberCount} IS NULL OR ${t.memberCount} >= 2`,
    ),
    check(
      "session_exercise_groups_member_rest_valid",
      sql`${t.restBetweenMembersSec} IS NULL OR ${t.restBetweenMembersSec} BETWEEN 0 AND 1800`,
    ),
    check(
      "session_exercise_groups_round_rest_valid",
      sql`${t.restBetweenRoundsSec} IS NULL OR ${t.restBetweenRoundsSec} BETWEEN 0 AND 1800`,
    ),
    check(
      "session_exercise_groups_snapshot_version_valid",
      sql`${t.snapshotVersion} >= 1`,
    ),
    check(
      "session_exercise_groups_canonical_plan_valid",
      sql`${t.provenance} IN ('import', 'legacy') OR (${t.plannedRounds} IS NOT NULL AND ${t.memberCount} IS NOT NULL AND ${t.restBetweenMembersSec} IS NOT NULL AND ${t.restBetweenRoundsSec} IS NOT NULL)`,
    ),
  ],
);

export const sessionExercises = pgTable(
  "session_exercises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => workoutSessions.id, { onDelete: "cascade" }),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    sourceExerciseKey: text("source_exercise_key"),
    sourceExerciseName: text("source_exercise_name"),
    // Immutable meaning captured when a Program prescription becomes a
    // workout fact. Null means legacy/imported/otherwise unknown, never an
    // invitation to infer from the mutable exercise catalog.
    prescribedSemanticsVersion: integer("prescribed_semantics_version"),
    prescribedExerciseName: text("prescribed_exercise_name"),
    prescribedMetricType: metricTypeEnum("prescribed_metric_type"),
    prescribedLoadType: text("prescribed_load_type"),
    prescribedLoadSemantics: loadSemanticsEnum("prescribed_load_semantics"),
    plannedFromTemplateExerciseId: uuid("planned_from_template_exercise_id"),
    sourceSlotLineageId: uuid("source_slot_lineage_id"),
    modificationType: modificationTypeEnum("modification_type")
      .notNull()
      .default("as_planned"),
    skipReason: skipReasonEnum("skip_reason"),
    substitutedForExerciseId: uuid("substituted_for_exercise_id").references(
      () => exercises.id,
      { onDelete: "restrict" }
    ),
    substitutionReason: substitutionReasonEnum("substitution_reason"),
    substitutedAt: timestamp("substituted_at", { withTimezone: true }),
    orderIdx: integer("order_idx").notNull().default(0),
    supersetKey: text("superset_key"), // session-local pairing key
    groupSnapshotId: uuid("group_snapshot_id"),
    groupMemberOrderIdx: integer("group_member_order_idx"),
    restSec: integer("rest_sec").notNull().default(90),
    // Targets snapshotted at session start (prescription may change later)
    targetSets: integer("target_sets"),
    targetRepsMin: integer("target_reps_min"),
    targetRepsMax: integer("target_reps_max"),
    targetLoad: numeric("target_load", { precision: 7, scale: 2, mode: "number" }),
    targetLoadUnit: unitEnum("target_load_unit"),
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
    currentEquipmentSnapshotId: uuid("current_equipment_snapshot_id"),
  },
  (t) => [
    index("session_exercises_session_idx").on(t.sessionId),
    index("session_exercises_slot_session_idx")
      .on(t.plannedFromTemplateExerciseId, t.sessionId)
      .where(sql`${t.plannedFromTemplateExerciseId} IS NOT NULL`),
    index("session_exercises_source_lineage_session_idx")
      .on(t.sourceSlotLineageId, t.sessionId)
      .where(sql`${t.sourceSlotLineageId} IS NOT NULL`),
    uniqueIndex("session_exercises_order_uq").on(t.sessionId, t.orderIdx),
    uniqueIndex("session_exercises_id_session_uq").on(t.id, t.sessionId),
    uniqueIndex("session_exercises_group_member_uq")
      .on(t.groupSnapshotId, t.groupMemberOrderIdx)
      .where(sql`${t.groupSnapshotId} IS NOT NULL`),
    foreignKey({
      name: "session_exercises_group_session_fk",
      columns: [t.groupSnapshotId, t.sessionId],
      foreignColumns: [sessionExerciseGroups.id, sessionExerciseGroups.sessionId],
    }).onDelete("cascade"),
    foreignKey({
      name: "session_exercises_current_equipment_snapshot_fk",
      columns: [t.currentEquipmentSnapshotId, t.id, t.sessionId],
      foreignColumns: [
        sessionEquipmentSnapshots.id,
        sessionEquipmentSnapshots.sessionExerciseId,
        sessionEquipmentSnapshots.sessionId,
      ],
    }).onDelete("no action"),
    check(
      "session_exercises_group_coordinates_valid",
      sql`(${t.groupSnapshotId} IS NULL AND ${t.groupMemberOrderIdx} IS NULL) OR (${t.groupSnapshotId} IS NOT NULL AND ${t.groupMemberOrderIdx} >= 0)`,
    ),
    check(
      "session_exercises_target_load_unit_check",
      sql`(${t.targetLoad} IS NULL AND ${t.targetLoadUnit} IS NULL) OR (${t.targetLoad} IS NOT NULL AND ${t.targetLoadUnit} IS NOT NULL)`
    ),
    check(
      "session_exercises_warmup_load_unit_check",
      sql`NOT jsonb_path_exists(${t.warmupSets}, '$[*] ? ((@.load != null && (!exists(@.loadUnit) || @.loadUnit == null)) || (@.load == null && exists(@.loadUnit) && @.loadUnit != null))')`
    ),
    check(
      "session_exercises_prescribed_semantics_check",
      sql`num_nonnulls(${t.prescribedSemanticsVersion}, ${t.prescribedExerciseName}, ${t.prescribedMetricType}, ${t.prescribedLoadType}, ${t.prescribedLoadSemantics}) IN (0, 5) AND (${t.prescribedSemanticsVersion} IS NULL OR (${t.prescribedSemanticsVersion} = 1 AND length(btrim(${t.prescribedExerciseName})) BETWEEN 1 AND 300 AND length(btrim(${t.prescribedLoadType})) BETWEEN 1 AND 50))`
    ),
  ]
);

export const completedSets = pgTable(
  "completed_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionExerciseId: uuid("session_exercise_id")
      .notNull()
      .references(() => sessionExercises.id, { onDelete: "cascade" }),
    setNo: integer("set_no").notNull(),
    // double precision: imported weights must round-trip exactly as recorded
    weight: doublePrecision("weight"), // null = bodyweight/band
    weightUnit: unitEnum("weight_unit"),
    equipmentSnapshotId: uuid("equipment_snapshot_id"),
    loadEntryMeaning: text("load_entry_meaning")
      .notNull()
      .default("legacy_unknown"),
    reps: integer("reps"),
    metricType: metricTypeEnum("metric_type")
      .notNull()
      .default("weight_reps"),
    // Nullable only for rows created before performed-semantics schema 1.
    // New writers snapshot these fields from the performed exercise so later
    // catalog edits cannot reinterpret completed workout evidence.
    performedSemanticsVersion: integer("performed_semantics_version"),
    performedLoadType: text("performed_load_type"),
    performedLoadSemantics: loadSemanticsEnum("performed_load_semantics"),
    distanceKm: real("distance_km"),
    durationSeconds: integer("duration_seconds"),
    rpe: real("rpe"), // ~6 easy / 7 ok / 8 hard / 9.5 grind
    rir: real("rir"),
    techniqueIssue: text("technique_issue"),
    limitationCause: text("limitation_cause"),
    isWarmup: boolean("is_warmup").notNull().default(false),
    targetMet: boolean("target_met"),
    restTakenSec: integer("rest_taken_sec"),
    note: text("note"),
    // Idempotency key for offline retry of the logSet action
    clientKey: text("client_key"),
    sourceSetIndex: integer("source_set_index"),
    sourceRow: integer("source_row"),
    excludeFromAnalytics: boolean("exclude_from_analytics")
      .notNull()
      .default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveOperationId: uuid("archive_operation_id").references(
      () => archiveOperations.id,
      { onDelete: "set null" }
    ),
    loggedAt: timestamp("logged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    observedCompletedAt: timestamp("observed_completed_at", {
      withTimezone: true,
    }),
    observedCompletionProvenance: text("observed_completion_provenance")
      .notNull()
      .default("unknown"),
    observedCompletionQuality: text("observed_completion_quality")
      .notNull()
      .default("unknown"),
  },
  (t) => [
    index("completed_sets_se_idx").on(t.sessionExerciseId),
    uniqueIndex("completed_sets_id_session_exercise_uq").on(
      t.id,
      t.sessionExerciseId,
    ),
    uniqueIndex("completed_sets_client_key_uq")
      .on(t.sessionExerciseId, t.clientKey)
      .where(sql`${t.clientKey} IS NOT NULL`),
    uniqueIndex("completed_sets_active_set_no_uq")
      .on(t.sessionExerciseId, t.setNo)
      .where(sql`${t.archivedAt} IS NULL`),
    foreignKey({
      name: "completed_sets_equipment_snapshot_fk",
      columns: [t.equipmentSnapshotId, t.sessionExerciseId],
      foreignColumns: [
        sessionEquipmentSnapshots.id,
        sessionEquipmentSnapshots.sessionExerciseId,
      ],
    }).onDelete("no action"),
    check(
      "completed_sets_weight_unit_check",
      sql`(${t.weight} IS NULL AND ${t.weightUnit} IS NULL) OR (${t.weight} IS NOT NULL AND ${t.weightUnit} IS NOT NULL)`
    ),
    check(
      "completed_sets_load_entry_meaning_valid",
      sql`${t.loadEntryMeaning} IN ('total_system', 'per_loading_point', 'displayed_stack', 'per_stack', 'combined_stacks', 'legacy_unknown')`,
    ),
    check(
      "completed_sets_equipment_entry_pair_valid",
      sql`(${t.equipmentSnapshotId} IS NULL AND ${t.loadEntryMeaning} = 'legacy_unknown') OR (${t.equipmentSnapshotId} IS NOT NULL AND ${t.loadEntryMeaning} <> 'legacy_unknown')`,
    ),
    check(
      "completed_sets_observed_completion_provenance_valid",
      sql`${t.observedCompletionProvenance} IN ('live_client', 'manual_explicit', 'import_source', 'unknown')`,
    ),
    check(
      "completed_sets_observed_completion_quality_valid",
      sql`${t.observedCompletionQuality} IN ('trustworthy', 'owner_reported', 'unknown')`,
    ),
    check(
      "completed_sets_observed_completion_tuple_valid",
      sql`(${t.observedCompletedAt} IS NULL AND ${t.observedCompletionProvenance} = 'unknown' AND ${t.observedCompletionQuality} = 'unknown') OR (${t.observedCompletedAt} IS NOT NULL AND ((${t.observedCompletionProvenance} = 'live_client' AND ${t.observedCompletionQuality} = 'trustworthy') OR (${t.observedCompletionProvenance} = 'import_source' AND ${t.observedCompletionQuality} = 'trustworthy') OR (${t.observedCompletionProvenance} = 'manual_explicit' AND ${t.observedCompletionQuality} = 'owner_reported')))`,
    ),
    check(
      "completed_sets_performed_semantics_tuple_valid",
      sql`(
        (${t.performedSemanticsVersion} IS NULL AND ${t.performedLoadType} IS NULL AND ${t.performedLoadSemantics} IS NULL)
        OR
        (${t.performedSemanticsVersion} = 1 AND ${t.performedLoadType} IS NOT NULL AND length(btrim(${t.performedLoadType})) > 0 AND ${t.performedLoadSemantics} IS NOT NULL)
      )`,
    ),
    check(
      "completed_sets_effort_measure_valid",
      sql`${t.rir} IS NULL OR (${t.rir} BETWEEN 0 AND 10 AND ${t.rpe} IS NULL)`,
    ),
    check(
      "completed_sets_technique_issue_valid",
      sql`${t.techniqueIssue} IS NULL OR ${t.techniqueIssue} IN ('bracing', 'range_of_motion', 'control', 'balance', 'positioning', 'tempo', 'other')`,
    ),
    check(
      "completed_sets_limitation_cause_valid",
      sql`${t.limitationCause} IS NULL OR ${t.limitationCause} IN ('strength_fatigue', 'breathing_conditioning', 'grip', 'mobility', 'pain', 'technique', 'equipment_setup', 'time', 'other')`,
    ),
  ]
);

export const sessionOccurrences = pgTable(
  "session_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => workoutSessions.id, { onDelete: "cascade" }),
    sessionExerciseId: uuid("session_exercise_id"),
    kind: text("kind").notNull(),
    origin: text("origin").notNull(),
    sequenceIdx: integer("sequence_idx").notNull(),
    kindOrdinal: integer("kind_ordinal").notNull(),
    label: text("label"),
    plannedExerciseId: uuid("planned_exercise_id").references(
      () => exercises.id,
      { onDelete: "restrict" },
    ),
    plannedRepsMin: integer("planned_reps_min"),
    plannedRepsMax: integer("planned_reps_max"),
    plannedLoad: numeric("planned_load", {
      precision: 7,
      scale: 2,
      mode: "number",
    }),
    plannedLoadUnit: unitEnum("planned_load_unit"),
    plannedLoadPercent: numeric("planned_load_percent", {
      precision: 5,
      scale: 2,
      mode: "number",
    }),
    plannedLoadText: text("planned_load_text"),
    plannedRestSec: integer("planned_rest_sec"),
    plannedNote: text("planned_note"),
    groupSnapshotId: uuid("group_snapshot_id"),
    groupRound: integer("group_round"),
    groupMemberOrderIdx: integer("group_member_order_idx"),
    outcome: text("outcome").notNull().default("pending"),
    outcomeReason: text("outcome_reason"),
    outcomeNote: text("outcome_note"),
    revision: integer("revision").notNull().default(0),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    completedSetId: uuid("completed_set_id"),
    equipmentSnapshotId: uuid("equipment_snapshot_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("session_occurrences_session_sequence_uq").on(
      t.sessionId,
      t.sequenceIdx,
    ),
    uniqueIndex("session_occurrences_completed_set_uq")
      .on(t.completedSetId)
      .where(sql`${t.completedSetId} IS NOT NULL`),
    uniqueIndex("session_occurrences_group_member_round_uq")
      .on(t.groupSnapshotId, t.groupRound, t.groupMemberOrderIdx)
      .where(sql`${t.groupSnapshotId} IS NOT NULL`),
    uniqueIndex("session_occurrences_day_kind_ordinal_uq")
      .on(t.sessionId, t.kind, t.kindOrdinal)
      .where(sql`${t.sessionExerciseId} IS NULL`),
    uniqueIndex("session_occurrences_exercise_kind_ordinal_uq")
      .on(t.sessionExerciseId, t.kind, t.kindOrdinal)
      .where(sql`${t.sessionExerciseId} IS NOT NULL`),
    index("session_occurrences_session_outcome_sequence_idx").on(
      t.sessionId,
      t.outcome,
      t.sequenceIdx,
    ),
    index("session_occurrences_session_exercise_idx").on(t.sessionExerciseId),
    foreignKey({
      name: "session_occurrences_exercise_session_fk",
      columns: [t.sessionExerciseId, t.sessionId],
      foreignColumns: [sessionExercises.id, sessionExercises.sessionId],
    }).onDelete("cascade"),
    foreignKey({
      name: "session_occurrences_group_session_fk",
      columns: [t.groupSnapshotId, t.sessionId],
      foreignColumns: [sessionExerciseGroups.id, sessionExerciseGroups.sessionId],
    }).onDelete("cascade"),
    foreignKey({
      name: "session_occurrences_completed_set_exercise_fk",
      columns: [t.completedSetId, t.sessionExerciseId],
      foreignColumns: [completedSets.id, completedSets.sessionExerciseId],
    }).onDelete("restrict"),
    foreignKey({
      name: "session_occurrences_equipment_snapshot_fk",
      columns: [t.equipmentSnapshotId, t.sessionExerciseId, t.sessionId],
      foreignColumns: [
        sessionEquipmentSnapshots.id,
        sessionEquipmentSnapshots.sessionExerciseId,
        sessionEquipmentSnapshots.sessionId,
      ],
    }).onDelete("no action"),
    check(
      "session_occurrences_kind_valid",
      sql`${t.kind} IN ('day_warmup', 'exercise_warmup', 'working_set')`,
    ),
    check(
      "session_occurrences_origin_valid",
      sql`${t.origin} IN ('planned', 'ad_hoc', 'imported', 'legacy')`,
    ),
    check(
      "session_occurrences_outcome_valid",
      sql`${t.outcome} IN ('pending', 'completed', 'skipped', 'abandoned', 'legacy_unrecorded')`,
    ),
    check(
      "session_occurrences_order_valid",
      sql`${t.sequenceIdx} >= 0 AND ${t.kindOrdinal} >= 0`,
    ),
    check(
      "session_occurrences_reps_valid",
      sql`(${t.plannedRepsMin} IS NULL AND ${t.plannedRepsMax} IS NULL) OR (${t.plannedRepsMin} >= 0 AND ${t.plannedRepsMax} >= ${t.plannedRepsMin})`,
    ),
    check(
      "session_occurrences_load_unit_valid",
      sql`(${t.plannedLoad} IS NULL AND ${t.plannedLoadUnit} IS NULL) OR (${t.plannedLoad} IS NOT NULL AND ${t.plannedLoadUnit} IS NOT NULL)`,
    ),
    check(
      "session_occurrences_load_representation_valid",
      sql`num_nonnulls(${t.plannedLoad}, ${t.plannedLoadPercent}, ${t.plannedLoadText}) <= 1`,
    ),
    check(
      "session_occurrences_load_percent_valid",
      sql`${t.plannedLoadPercent} IS NULL OR ${t.plannedLoadPercent} BETWEEN 0 AND 500`,
    ),
    check(
      "session_occurrences_rest_valid",
      sql`${t.plannedRestSec} IS NULL OR ${t.plannedRestSec} BETWEEN 0 AND 1800`,
    ),
    check(
      "session_occurrences_group_coordinates_valid",
      sql`(${t.groupSnapshotId} IS NULL AND ${t.groupRound} IS NULL AND ${t.groupMemberOrderIdx} IS NULL) OR (${t.groupSnapshotId} IS NOT NULL AND ${t.groupRound} >= 1 AND ${t.groupMemberOrderIdx} >= 0 AND ${t.kind} = 'working_set')`,
    ),
    check(
      "session_occurrences_exercise_identity_valid",
      sql`(${t.kind} = 'day_warmup' AND ${t.sessionExerciseId} IS NULL AND ${t.plannedExerciseId} IS NULL) OR (${t.kind} IN ('exercise_warmup', 'working_set') AND ${t.sessionExerciseId} IS NOT NULL AND ${t.plannedExerciseId} IS NOT NULL)`,
    ),
    check("session_occurrences_revision_valid", sql`${t.revision} >= 0`),
    check(
      "session_occurrences_resolution_valid",
      sql`(${t.outcome} IN ('pending', 'legacy_unrecorded') AND ${t.resolvedAt} IS NULL) OR (${t.outcome} IN ('completed', 'skipped', 'abandoned') AND ${t.resolvedAt} IS NOT NULL)`,
    ),
    check(
      "session_occurrences_completed_link_valid",
      sql`(${t.kind} = 'working_set' AND ${t.outcome} = 'completed' AND ${t.completedSetId} IS NOT NULL) OR ((${t.kind} <> 'working_set' OR ${t.outcome} <> 'completed') AND ${t.completedSetId} IS NULL)`,
    ),
  ],
);

export const sessionEquipmentSelectionReceipts = pgTable(
  "session_equipment_selection_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    sessionExerciseId: uuid("session_exercise_id").notNull(),
    clientKey: uuid("client_key").notNull(),
    operation: text("operation").notNull(),
    canonicalPayloadHash: text("canonical_payload_hash").notNull(),
    priorSnapshotId: uuid("prior_snapshot_id"),
    resultingSnapshotId: uuid("resulting_snapshot_id"),
    resultCode: text("result_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("session_equipment_selection_receipts_client_uq").on(
      t.sessionExerciseId,
      t.clientKey,
    ),
    index("session_equipment_selection_receipts_session_idx").on(
      t.sessionId,
      t.createdAt,
    ),
    foreignKey({
      name: "session_equipment_selection_receipts_session_owner_fk",
      columns: [t.sessionId, t.userId],
      foreignColumns: [workoutSessions.id, workoutSessions.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "session_equipment_selection_receipts_exercise_session_fk",
      columns: [t.sessionExerciseId, t.sessionId],
      foreignColumns: [sessionExercises.id, sessionExercises.sessionId],
    }).onDelete("cascade"),
    foreignKey({
      name: "session_equipment_selection_receipts_prior_snapshot_fk",
      columns: [t.priorSnapshotId, t.sessionExerciseId, t.sessionId],
      foreignColumns: [
        sessionEquipmentSnapshots.id,
        sessionEquipmentSnapshots.sessionExerciseId,
        sessionEquipmentSnapshots.sessionId,
      ],
    }).onDelete("no action"),
    foreignKey({
      name: "session_equipment_selection_receipts_result_snapshot_fk",
      columns: [t.resultingSnapshotId, t.sessionExerciseId, t.sessionId],
      foreignColumns: [
        sessionEquipmentSnapshots.id,
        sessionEquipmentSnapshots.sessionExerciseId,
        sessionEquipmentSnapshots.sessionId,
      ],
    }).onDelete("no action"),
    check(
      "session_equipment_selection_receipts_operation_valid",
      sql`${t.operation} IN ('select', 'clear')`,
    ),
    check(
      "session_equipment_selection_receipts_hash_valid",
      sql`${t.canonicalPayloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "session_equipment_selection_receipts_result_valid",
      sql`${t.resultCode} IN ('applied', 'no_change')`,
    ),
    check(
      "session_equipment_selection_receipts_operation_shape_valid",
      sql`(${t.operation} = 'select' AND ${t.resultingSnapshotId} IS NOT NULL) OR (${t.operation} = 'clear' AND ${t.resultingSnapshotId} IS NULL)`,
    ),
  ],
);

export const sessionOccurrenceMutations = pgTable(
  "session_occurrence_mutations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurrenceId: uuid("occurrence_id")
      .notNull()
      .references(() => sessionOccurrences.id, { onDelete: "cascade" }),
    clientKey: text("client_key").notNull(),
    operation: text("operation").notNull(),
    canonicalPayloadHash: text("canonical_payload_hash").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    resultCode: text("result_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("session_occurrence_mutations_client_key_uq").on(
      t.occurrenceId,
      t.clientKey,
    ),
    index("session_occurrence_mutations_created_idx").on(
      t.occurrenceId,
      t.createdAt,
    ),
    check(
      "session_occurrence_mutations_operation_valid",
      sql`${t.operation} IN ('complete', 'skip', 'restore', 'abandon', 'note')`,
    ),
    check(
      "session_occurrence_mutations_revision_valid",
      sql`${t.expectedRevision} >= 0 AND ${t.resultingRevision} >= ${t.expectedRevision}`,
    ),
    check(
      "session_occurrence_mutations_result_valid",
      sql`${t.resultCode} IN ('applied', 'no_change')`,
    ),
  ],
);

export const painLogs = pgTable(
  "pain_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => workoutSessions.id, {
      onDelete: "set null",
    }),
    exerciseId: uuid("exercise_id").references(() => exercises.id),
    completedSetId: uuid("completed_set_id"),
    bodyPart: text("body_part").notNull(),
    severity: integer("severity").notNull(), // 0-10
    source: painSourceEnum("source").notNull().default("set_flag"),
    note: text("note"),
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
    index("pain_logs_user_idx").on(t.userId, t.createdAt),
    index("pain_logs_active_session_idx")
      .on(t.sessionId)
      .where(sql`${t.archivedAt} IS NULL AND ${t.sessionId} IS NOT NULL`),
    uniqueIndex("pain_logs_active_completed_set_uq")
      .on(t.completedSetId)
      .where(sql`${t.archivedAt} IS NULL AND ${t.completedSetId} IS NOT NULL`),
  ]
);

export const fatigueLogs = pgTable(
  "fatigue_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => workoutSessions.id, {
      onDelete: "set null",
    }),
    severity: integer("severity").notNull(), // 1-5
    note: text("note"),
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
    index("fatigue_logs_active_user_created_idx")
      .on(t.userId, t.createdAt)
      .where(sql`${t.archivedAt} IS NULL`),
  ]
);

export const sessionNotes = pgTable("session_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => workoutSessions.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveOperationId: uuid("archive_operation_id").references(
    () => archiveOperations.id,
    { onDelete: "set null" }
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Durable handoff from workout completion to deterministic progression.
 * Completion only enqueues this row; a leased worker can retry independently.
 */
export const progressionJobs = pgTable(
  "progression_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    sourceSessionRevision: integer("source_session_revision")
      .notNull()
      .default(0),
    coachingPrefs: jsonb("coaching_prefs").$type<CoachingPrefs>().notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("progression_jobs_session_revision_uq").on(
      t.sessionId,
      t.sourceSessionRevision,
    ),
    uniqueIndex("progression_jobs_id_user_uq").on(t.id, t.userId),
    foreignKey({
      name: "progression_jobs_session_owner_fk",
      columns: [t.sessionId, t.userId],
      foreignColumns: [workoutSessions.id, workoutSessions.userId],
    }).onDelete("cascade"),
    index("progression_jobs_claim_idx").on(
      t.status,
      t.nextAttemptAt,
      t.leasedUntil
    ),
    index("progression_jobs_user_idx").on(t.userId, t.createdAt),
    check(
      "progression_jobs_status_check",
      sql`${t.status} IN ('pending', 'processing', 'completed', 'failed')`
    ),
    check(
      "progression_jobs_lease_check",
      sql`(${t.leaseToken} IS NULL) = (${t.leasedUntil} IS NULL)`
    ),
    check(
      "progression_jobs_processing_lease_check",
      sql`(${t.status} = 'processing') = (${t.leaseToken} IS NOT NULL)`
    ),
    check(
      "progression_jobs_completion_check",
      sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)`
    ),
    check(
      "progression_jobs_source_revision_check",
      sql`${t.sourceSessionRevision} >= 0`
    ),
  ]
);

/**
 * Exact historical input evidence consumed by one progression evaluation.
 * The worker revalidates both membership and revisions before committing.
 */
export const progressionJobInputSessions = pgTable(
  "progression_job_input_sessions",
  {
    jobId: uuid("job_id").notNull(),
    userId: uuid("user_id").notNull(),
    sourceSlotLineageId: uuid("source_slot_lineage_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    historyRevision: integer("history_revision").notNull(),
  },
  (t) => [
    primaryKey({
      name: "progression_job_input_sessions_pk",
      columns: [t.jobId, t.sourceSlotLineageId, t.sessionId],
    }),
    index("progression_job_input_sessions_session_idx").on(
      t.sessionId,
      t.historyRevision,
    ),
    foreignKey({
      name: "progression_job_input_sessions_job_owner_fk",
      columns: [t.jobId, t.userId],
      foreignColumns: [progressionJobs.id, progressionJobs.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "progression_job_input_sessions_session_owner_fk",
      columns: [t.sessionId, t.userId],
      foreignColumns: [workoutSessions.id, workoutSessions.userId],
    }).onDelete("cascade"),
    check(
      "progression_job_input_sessions_revision_check",
      sql`${t.historyRevision} >= 0`
    ),
  ],
);
