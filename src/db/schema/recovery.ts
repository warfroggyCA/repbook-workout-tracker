import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./user";

export type RecoveryRunDetails = Record<string, unknown>;
export type IntegrityFindingDetails = Record<string, unknown>;

/** Immutable evidence that a backup, restore, or integrity check completed. */
export const recoveryRuns = pgTable(
  "recovery_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    provider: text("provider"),
    sourceRef: text("source_ref"),
    summary: text("summary").notNull(),
    details: jsonb("details").$type<RecoveryRunDetails>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("recovery_runs_user_kind_completed_idx").on(
      t.userId,
      t.kind,
      t.completedAt
    ),
    check(
      "recovery_runs_kind_valid",
      sql`${t.kind} in ('database_backup', 'restore_drill', 'snapshot_integrity', 'application_integrity')`
    ),
    check(
      "recovery_runs_status_valid",
      sql`${t.status} in ('passed', 'warning', 'failed')`
    ),
    check(
      "recovery_runs_time_order_valid",
      sql`${t.completedAt} >= ${t.startedAt}`
    ),
  ]
);

/** Reviewable findings from one immutable application-integrity run. */
export const integrityFindings = pgTable(
  "integrity_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => recoveryRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    checkKey: text("check_key").notNull(),
    severity: text("severity").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    message: text("message").notNull(),
    details: jsonb("details")
      .$type<IntegrityFindingDetails>()
      .notNull()
      .default({}),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("integrity_findings_user_unresolved_idx").on(
      t.userId,
      t.resolvedAt,
      t.createdAt
    ),
    index("integrity_findings_run_idx").on(t.runId),
    check(
      "integrity_findings_severity_valid",
      sql`${t.severity} in ('warning', 'error')`
    ),
  ]
);
