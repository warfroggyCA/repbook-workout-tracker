import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  recommendationStatusEnum,
  recommendationSourceEnum,
  decisionEnum,
} from "./enums";
import { users } from "./user";
import { exercises } from "./exercise";
import { archiveOperations } from "./archive";
import {
  completedSets,
  progressionJobs,
  sessionExercises,
  workoutSessions,
} from "./session";
import { programVersions } from "./program";

/**
 * Typed change payloads. Recommendations carry one of these; approving one
 * applies exactly this change (or the user-edited version) — nothing else.
 */
export type RecommendationPayload =
  | {
      kind: "load_change";
      templateExerciseId: string;
      fromLoad: number | null;
      toLoad: number;
      loadUnit: "lb" | "kg";
    }
  | { kind: "rep_target_change"; templateExerciseId: string; fromRepMax: number; toRepMax: number }
  | { kind: "set_count_change"; templateExerciseId: string; fromSets: number; toSets: number }
  | { kind: "deload"; scope: "program"; volumeFactor: number; loadFactor: number; durationSessionsPerTemplate: number }
  | { kind: "substitution"; templateExerciseId: string; fromExerciseId: string; toExerciseId: string }
  | { kind: "remove_exercise"; templateExerciseId: string }
  | { kind: "hold"; templateExerciseId: string; reason: string };

export type RecommendationEvidence = {
  signals: Record<string, unknown>;
  sessionIds?: string[];
  setIds?: string[];
  painLogIds?: string[];
};

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: recommendationStatusEnum("status").notNull().default("pending"),
    source: recommendationSourceEnum("source").notNull(),
    ruleId: text("rule_id"),
    insightId: uuid("insight_id"),
    exerciseId: uuid("exercise_id").references(() => exercises.id),
    progressionJobId: uuid("progression_job_id").references(
      () => progressionJobs.id,
      { onDelete: "set null" }
    ),
    sourceTemplateExerciseId: uuid("source_template_exercise_id"),
    sourceSlotLineageId: uuid("source_slot_lineage_id"),
    payload: jsonb("payload").$type<RecommendationPayload>().notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<RecommendationEvidence>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciliationReason: text("reconciliation_reason"),
    reconciledByProgramVersionId: uuid(
      "reconciled_by_program_version_id"
    ).references(() => programVersions.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveOperationId: uuid("archive_operation_id").references(
      () => archiveOperations.id,
      { onDelete: "set null" }
    ),
  },
  (t) => [
    index("recommendations_user_status_idx").on(t.userId, t.status),
    index("recommendations_active_slot_state_idx")
      .on(t.userId, t.sourceTemplateExerciseId, t.decidedAt)
      .where(
        sql`${t.archivedAt} IS NULL AND ${t.sourceTemplateExerciseId} IS NOT NULL`
      ),
    index("recommendations_lineage_state_idx")
      .on(t.userId, t.sourceSlotLineageId, t.status)
      .where(
        sql`${t.archivedAt} IS NULL AND ${t.sourceSlotLineageId} IS NOT NULL`
      ),
    uniqueIndex("recommendations_progression_job_lineage_uq")
      .on(t.progressionJobId, t.sourceSlotLineageId)
      .where(
        sql`${t.progressionJobId} IS NOT NULL AND ${t.sourceSlotLineageId} IS NOT NULL`
      ),
    check(
      "recommendations_load_unit_check",
      sql`${t.payload}->>'kind' <> 'load_change' OR COALESCE(${t.payload}->>'loadUnit' IN ('lb', 'kg'), false)`
    ),
    check(
      "recommendations_reconciliation_reason_check",
      sql`${t.status} <> 'expired' OR (nullif(btrim(${t.reconciliationReason}), '') IS NOT NULL AND ${t.reconciledAt} IS NOT NULL)`
    ),
  ]
);

export const userDecisions = pgTable(
  "user_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    decision: decisionEnum("decision").notNull(),
    editedPayload: jsonb("edited_payload").$type<RecommendationPayload>(),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("user_decisions_recommendation_uq").on(t.recommendationId),
    check(
      "user_decisions_load_unit_check",
      sql`${t.editedPayload} IS NULL OR ${t.editedPayload}->>'kind' <> 'load_change' OR COALESCE(${t.editedPayload}->>'loadUnit' IN ('lb', 'kg'), false)`
    ),
  ]
);

export const adaptationEvents = pgTable(
  "adaptation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id),
    beforeSnapshot: jsonb("before_snapshot").notNull(),
    afterSnapshot: jsonb("after_snapshot").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("adaptation_events_recommendation_uq").on(t.recommendationId),
    check(
      "adaptation_events_before_load_unit_check",
      sql`NOT jsonb_path_exists(${t.beforeSnapshot}, '$.prescription ? ((@.targetLoad != null && (!exists(@.targetLoadUnit) || @.targetLoadUnit == null)) || (@.targetLoad == null && exists(@.targetLoadUnit) && @.targetLoadUnit != null))')`
    ),
    check(
      "adaptation_events_after_load_unit_check",
      sql`NOT jsonb_path_exists(${t.afterSnapshot}, '$.prescription ? ((@.targetLoad != null && (!exists(@.targetLoadUnit) || @.targetLoadUnit == null)) || (@.targetLoad == null && exists(@.targetLoadUnit) && @.targetLoadUnit != null))')`
    ),
  ]
);

/** V2: AI reviews/Q&A. Table exists so recommendations can reference it. */
export const coachingInsights = pgTable(
  "coaching_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "manual_review" | "qa" | "live_user" | "live_assistant"
    contentMd: text("content_md").notNull(),
    dataDigest: jsonb("data_digest").notNull(), // exactly what the model saw
    model: text("model"),

    // Live Coach is text-first, but these nullable transport fields also fit
    // future dictation and Realtime voice turns without changing the durable
    // workout conversation model. Existing snapshot rows intentionally remain
    // valid with null values in every additive field.
    sessionId: uuid("session_id").references(() => workoutSessions.id, {
      onDelete: "cascade",
    }),
    sessionExerciseId: uuid("session_exercise_id").references(
      () => sessionExercises.id,
      { onDelete: "set null" }
    ),
    completedSetId: uuid("completed_set_id").references(
      () => completedSets.id,
      { onDelete: "set null" }
    ),
    replyToId: uuid("reply_to_id"),
    author: text("author"),
    messageKind: text("message_kind"),
    inputMode: text("input_mode"),
    responseStatus: text("response_status"),
    clientKey: text("client_key"),
    failureReason: text("failure_reason"),
    providerItemId: text("provider_item_id"),
    generationLeaseId: uuid("generation_lease_id"),
    generationLeaseExpiresAt: timestamp("generation_lease_expires_at", {
      withTimezone: true,
    }),
    generationStartedAt: timestamp("generation_started_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveOperationId: uuid("archive_operation_id").references(
      () => archiveOperations.id,
      { onDelete: "set null" }
    ),
  },
  (t) => [
    index("coaching_insights_session_created_idx").on(t.sessionId, t.createdAt),
    uniqueIndex("coaching_insights_live_client_key_uq")
      .on(t.userId, t.clientKey)
      .where(sql`${t.kind} = 'live_user' AND ${t.clientKey} IS NOT NULL`),
    uniqueIndex("coaching_insights_live_pending_reply_uq")
      .on(t.replyToId)
      .where(
        sql`${t.kind} = 'live_assistant' AND ${t.responseStatus} IN ('pending', 'generating') AND ${t.replyToId} IS NOT NULL`
      ),
    check(
      "coaching_insights_author_valid",
      sql`${t.author} IS NULL OR ${t.author} IN ('user', 'assistant')`
    ),
    check(
      "coaching_insights_message_kind_valid",
      sql`${t.messageKind} IS NULL OR ${t.messageKind} IN ('question', 'observation', 'answer')`
    ),
    check(
      "coaching_insights_input_mode_valid",
      sql`${t.inputMode} IS NULL OR ${t.inputMode} IN ('text', 'dictation', 'realtime_voice')`
    ),
    check(
      "coaching_insights_response_status_valid",
      sql`${t.responseStatus} IS NULL OR ${t.responseStatus} IN ('saved', 'pending', 'generating', 'completed', 'failed')`
    ),
    check(
      "coaching_insights_generation_lease_valid",
      sql`(${t.responseStatus} = 'generating' AND ${t.generationLeaseId} IS NOT NULL AND ${t.generationLeaseExpiresAt} IS NOT NULL AND ${t.generationStartedAt} IS NOT NULL) OR (${t.responseStatus} IS DISTINCT FROM 'generating' AND ${t.generationLeaseId} IS NULL AND ${t.generationLeaseExpiresAt} IS NULL)`
    ),
  ]
);
