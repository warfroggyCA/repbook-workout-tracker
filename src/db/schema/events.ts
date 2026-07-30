import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import {
  actorTypeEnum,
  importSourceEnum,
  importStatusEnum,
  exportKindEnum,
  aiTaskScopeEnum,
} from "./enums";
import { users } from "./user";
import { archiveOperations } from "./archive";
import { workoutSessions } from "./session";

/**
 * Every AI call that parses user input (setup, import, quick logs). Raw
 * input/output are quarantined here for audit; core tables only ever receive
 * user-confirmed payloads (plan §12/§13).
 */
export const aiParsingEvents = pgTable(
  "ai_parsing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: aiTaskScopeEnum("scope").notNull(),
    task: text("task").notNull(), // "equipment_parse" | "routine_parse" | "log_parse" | ...
    rawInput: text("raw_input").notNull(),
    inputSha256: text("input_sha256"),
    rawOutput: text("raw_output"),
    parsedJson: jsonb("parsed_json"),
    schemaVersion: text("schema_version").notNull().default("1"),
    confidence: real("confidence"),
    ambiguities: jsonb("ambiguities").notNull().default([]),
    confirmed: boolean("confirmed").notNull().default(false),
    confirmedPayload: jsonb("confirmed_payload"),
    resultSessionId: uuid("result_session_id").references(
      () => workoutSessions.id,
      { onDelete: "set null" }
    ),
    model: text("model"),
    latencyMs: integer("latency_ms"),
    rawRedactedAt: timestamp("raw_redacted_at", { withTimezone: true }),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_parsing_events_user_idx").on(t.userId, t.createdAt),
    index("ai_parsing_events_retention_idx")
      .on(t.retentionExpiresAt)
      .where(sql`${t.rawRedactedAt} IS NULL`),
    check(
      "ai_parsing_events_quick_log_unit_check",
      sql`${t.scope} <> 'log' OR ${t.parsedJson} IS NULL OR NOT jsonb_path_exists(${t.parsedJson}, '$.data.entries[*] ? (@.kind == "sets").sets[*] ? ((@.weight != null && (!exists(@.weightUnit) || @.weightUnit == null)) || (@.weight == null && exists(@.weightUnit) && @.weightUnit != null))')`
    ),
  ]
);

export const importEvents = pgTable(
  "import_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: importSourceEnum("source").notNull(),
    rawPayload: text("raw_payload").notNull(),
    payloadSha256: text("payload_sha256"),
    parsedPayload: jsonb("parsed_payload"),
    confirmedPayload: jsonb("confirmed_payload").$type<{
      schemaVersion: string;
      resolutions: unknown[];
    }>(),
    status: importStatusEnum("status").notNull().default("raw"),
    resultProgramVersionId: uuid("result_program_version_id"),
    rawRedactedAt: timestamp("raw_redacted_at", { withTimezone: true }),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("import_events_retention_idx")
      .on(t.retentionExpiresAt)
      .where(sql`${t.rawRedactedAt} IS NULL`),
    uniqueIndex("import_events_current_hevy_stage_uq")
      .on(t.userId)
      .where(sql`${t.source} = 'csv' AND ${t.status} = 'parsed'`),
  ]
);

export type HistoryImportSummary = {
  workouts: number;
  exerciseOccurrences: number;
  sets: number;
  warmupSets: number;
  supersetGroups: number;
  excludedExercises: number;
  warnings: number;
};

/** One reversible, provenance-preserving batch of imported workout history. */
export const historyImportBatches = pgTable(
  "history_import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    importEventId: uuid("import_event_id")
      .notNull()
      .references(() => importEvents.id, { onDelete: "restrict" }),
    source: text("source").notNull(),
    originalFilename: text("original_filename").notNull(),
    fileHash: text("file_hash").notNull(),
    timezone: text("timezone").notNull(),
    status: text("status").notNull().default("confirmed"),
    summary: jsonb("summary").$type<HistoryImportSummary>().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveOperationId: uuid("archive_operation_id").references(
      () => archiveOperations.id,
      { onDelete: "set null" }
    ),
  },
  (t) => [
    index("history_import_batches_user_idx").on(t.userId, t.confirmedAt),
    index("history_import_batches_hash_idx").on(t.userId, t.fileHash, t.status),
    // Concurrent confirms of the same file must not both land; the CTE's
    // NOT EXISTS guard cannot see a sibling transaction's uncommitted row.
    uniqueIndex("history_import_batches_confirmed_hash_uq")
      .on(t.userId, t.fileHash)
      .where(sql`${t.status} = 'confirmed'`),
  ]
);

export const exportEvents = pgTable("export_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: exportKindEnum("kind").notNull(),
  filters: jsonb("filters").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const expensiveOperationLeases = pgTable(
  "expensive_operation_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("expensive_operation_leases_user_kind_uq").on(t.userId, t.kind),
    index("expensive_operation_leases_expiry_idx").on(t.leaseExpiresAt),
    check(
      "expensive_operation_leases_kind_check",
      sql`${t.kind} IN ('import', 'export', 'backup', 'snapshot')`
    ),
    check(
      "expensive_operation_leases_pair_check",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`
    ),
  ]
);

/** Append-only trail; everything that changes plans or data points here. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorType: actorTypeEnum("actor_type").notNull(),
    action: text("action").notNull(), // "prescription.update", "recommendation.approve", ...
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    causeRef: jsonb("cause_ref"), // { recommendationId?, decisionId?, importEventId?, ... }
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("audit_logs_idempotency_uq")
      .on(t.userId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ]
);
