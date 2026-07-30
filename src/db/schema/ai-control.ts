import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./user";

/**
 * Prompt-free AI metering. This is intentionally separate from model inputs
 * and outputs so quotas and cost review never require retaining health text.
 */
export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    logicalKey: text("logical_key").notNull(),
    status: text("status").notNull().default("running"),
    leaseId: uuid("lease_id").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    networkHash: text("network_hash"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCostMicrousd: integer("estimated_cost_microusd"),
    audioSeconds: integer("audio_seconds"),
    failureCode: text("failure_code"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("ai_usage_events_user_started_idx").on(t.userId, t.startedAt),
    index("ai_usage_events_network_started_idx").on(t.networkHash, t.startedAt),
    index("ai_usage_events_running_lease_idx")
      .on(t.status, t.leaseExpiresAt)
      .where(sql`${t.status} = 'running'`),
    uniqueIndex("ai_usage_events_running_logical_uq")
      .on(t.userId, t.logicalKey)
      .where(sql`${t.status} = 'running'`),
    check(
      "ai_usage_events_status_valid",
      sql`${t.status} IN ('running', 'completed', 'failed', 'cancelled', 'timed_out')`
    ),
    check(
      "ai_usage_events_usage_nonnegative",
      sql`COALESCE(${t.inputTokens}, 0) >= 0 AND COALESCE(${t.outputTokens}, 0) >= 0 AND COALESCE(${t.totalTokens}, 0) >= 0 AND COALESCE(${t.estimatedCostMicrousd}, 0) >= 0 AND COALESCE(${t.audioSeconds}, 0) >= 0`
    ),
  ]
);
