import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  loadsEqual,
  MAX_STORED_LOAD,
  normalizeStoredLoad,
} from "@/lib/units";
import {
  recommendations,
  userDecisions,
  type RecommendationPayload,
  type ReviewDecisionSnapshot,
} from "@/db/schema";
import { loadExercisePainHold } from "@/services/pain-hold";
import {
  buildReviewDecisionSnapshot,
  resolveReviewEvidence,
} from "@/services/review-evidence";

export type RecommendationCheckpoint = (boundary: string) => void | Promise<void>;

export type RecommendationProgramPublicationResult =
  | { ok: true; programVersionId: string }
  | { ok: false; reason: "not_pending" | "stale" | "invalid" | "conflict" };

export type PublishRecommendationProgramVersion = (
  db: Db,
  userId: string,
  input: {
    recommendationId: string;
    expectedPayload: RecommendationPayload;
    appliedPayload: RecommendationPayload;
    decision: "approve" | "edit";
    expectedReviewRevision: number;
    expectedDeferRevision: number;
    reviewSnapshot: ReviewDecisionSnapshot;
  }
) => Promise<RecommendationProgramPublicationResult>;

export type RecommendationDecisionDependencies = {
  checkpoint?: RecommendationCheckpoint;
  /** Immutable Program publisher; approval has no in-place mutation fallback. */
  publishProgramVersion?: PublishRecommendationProgramVersion;
  /** Test-only database failure injection. Any non-null value aborts the statement. */
  failureAt?: string;
};

export const AUTOMATIC_HOLD_NOTICE_DISMISSED_REASON =
  "You dismissed this notice. The recorded positive pain reports still count, and your Program wasn’t changed.";

function isAutomaticHoldNotice(
  recommendation: Awaited<ReturnType<typeof getOwnedRecommendation>>
) {
  return (
    recommendation?.source === "rule" &&
    ["pain_freeze", "pain_substitute"].includes(recommendation.ruleId ?? "") &&
    recommendation.payload?.kind === "hold"
  );
}

const storedLoadSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(MAX_STORED_LOAD);

const loadChangePayloadSchema = z.object({
  kind: z.literal("load_change"),
  templateExerciseId: z.string().uuid(),
  fromLoad: storedLoadSchema.nullable(),
  toLoad: storedLoadSchema,
  loadUnit: z.enum(["lb", "kg"]),
});

const substitutionPayloadSchema = z.object({
  kind: z.literal("substitution"),
  templateExerciseId: z.string().uuid(),
  fromExerciseId: z.string().uuid(),
  toExerciseId: z.string().uuid(),
});

const actionablePayloadSchema = z.discriminatedUnion("kind", [
  loadChangePayloadSchema,
  substitutionPayloadSchema,
]);

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameDecisionPayload(left: unknown, right: RecommendationPayload) {
  const parsedLeft = actionablePayloadSchema.safeParse(left);
  const parsedRight = actionablePayloadSchema.safeParse(right);
  if (
    parsedLeft.success &&
    parsedRight.success &&
    parsedLeft.data.kind === "load_change" &&
    parsedRight.data.kind === "load_change"
  ) {
    return (
      parsedLeft.data.templateExerciseId === parsedRight.data.templateExerciseId &&
      loadsEqual(parsedLeft.data.fromLoad, parsedRight.data.fromLoad) &&
      loadsEqual(parsedLeft.data.toLoad, parsedRight.data.toLoad) &&
      parsedLeft.data.loadUnit === parsedRight.data.loadUnit
    );
  }
  return sameJson(left, right);
}

async function getOwnedRecommendation(
  db: Db,
  userId: string,
  recommendationId: string
) {
  return db.query.recommendations.findFirst({
    where: and(
      eq(recommendations.id, recommendationId),
      eq(recommendations.userId, userId),
      isNull(recommendations.archivedAt)
    ),
  });
}

async function existingDecision(
  db: Db,
  recommendationId: string
) {
  return db.query.userDecisions.findFirst({
    where: eq(userDecisions.recommendationId, recommendationId),
  });
}

async function approveRetryResult(
  db: Db,
  recommendationId: string,
  edited: boolean,
  payload: RecommendationPayload
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const decision = await existingDecision(db, recommendationId);
  if (
    decision &&
    ((!edited && decision.decision === "approve" && decision.editedPayload == null) ||
      (edited &&
        decision.decision === "edit" &&
        sameDecisionPayload(decision.editedPayload, payload)))
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: decision
      ? `This recommendation was already ${decision.decision === "reject" ? "rejected" : "approved with different values"}.`
      : "This recommendation is no longer pending.",
  };
}

export async function approveRecommendationDecision(
  db: Db,
  userId: string,
  input: {
    recommendationId: string;
    editedToLoad?: number;
    expectedReviewRevision: number;
    expectedDeferRevision: number;
  },
  dependencies: RecommendationDecisionDependencies = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const checkpoint = dependencies.checkpoint ?? (() => undefined);
  const recommendation = await getOwnedRecommendation(
    db,
    userId,
    input.recommendationId
  );
  if (!recommendation) return { ok: false, reason: "Recommendation not found." };
  if (
    input.expectedReviewRevision !== recommendation.reviewRevision ||
    input.expectedDeferRevision !== recommendation.deferRevision
  ) {
    return { ok: false, reason: "This proposal changed. Refresh and review its current evidence." };
  }
  if (recommendation.deferredAt != null) {
    return { ok: false, reason: "Resume this deferred review before making a decision." };
  }

  const parsed = actionablePayloadSchema.safeParse(recommendation.payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "This recommendation type cannot be applied automatically.",
    };
  }

  if (
    input.editedToLoad != null &&
    (!Number.isFinite(input.editedToLoad) ||
      input.editedToLoad < 0 ||
      input.editedToLoad > MAX_STORED_LOAD)
  ) {
    return {
      ok: false,
      reason: `The edited load must be between zero and ${MAX_STORED_LOAD}.`,
    };
  }

  let payload: RecommendationPayload =
    parsed.data.kind === "load_change"
      ? {
          ...parsed.data,
          fromLoad:
            parsed.data.fromLoad == null
              ? null
              : normalizeStoredLoad(parsed.data.fromLoad),
          toLoad: normalizeStoredLoad(parsed.data.toLoad),
        }
      : parsed.data;
  const editedToLoad =
    input.editedToLoad == null
      ? undefined
      : normalizeStoredLoad(input.editedToLoad);
  const edited =
    editedToLoad != null &&
    payload.kind === "load_change" &&
    !loadsEqual(editedToLoad, payload.toLoad);
  if (edited && payload.kind === "load_change") {
    payload = { ...payload, toLoad: editedToLoad! };
  }
  if (recommendation.status !== "pending") {
    return approveRetryResult(db, recommendation.id, edited, payload);
  }
  const assessment = await resolveReviewEvidence(db, userId, recommendation);
  if (!assessment.actionable) {
    return {
      ok: false,
      reason: assessment.explanation,
    };
  }
  if (
    payload.kind === "load_change" &&
    (payload.fromLoad == null || payload.toLoad > payload.fromLoad) &&
    recommendation.exerciseId
  ) {
    const painHold = await loadExercisePainHold(db, {
      userId,
      exerciseId: recommendation.exerciseId,
    });
    if (painHold.blocksProgression) {
      return {
        ok: false,
        reason: painHold.explanation!,
      };
    }
  }

  if (!dependencies.publishProgramVersion) {
    return {
      ok: false,
      reason:
        "Program version publishing is temporarily unavailable. Refresh and try again.",
    };
  }

  await checkpoint("recommendation-ready");
  const publication = await dependencies.publishProgramVersion(db, userId, {
    recommendationId: recommendation.id,
    expectedPayload: parsed.data,
    appliedPayload: payload,
    decision: edited ? "edit" : "approve",
    expectedReviewRevision: recommendation.reviewRevision,
    expectedDeferRevision: recommendation.deferRevision,
    reviewSnapshot: buildReviewDecisionSnapshot(recommendation, assessment),
  });

  if (publication.ok) {
    await checkpoint("recommendation-applied");
    return { ok: true };
  }

  if (publication.reason === "not_pending") {
    return approveRetryResult(db, recommendation.id, edited, payload);
  }
  const latest = await getOwnedRecommendation(db, userId, recommendation.id);
  if (latest && latest.status !== "pending") {
    return approveRetryResult(db, recommendation.id, edited, payload);
  }
  return {
    ok: false,
    reason:
      publication.reason === "conflict"
        ? "The Program changed while this recommendation was being applied. Refresh and review the current plan."
        : "The recommendation was not applied because the Program, safety information, equipment, or exercise availability changed. Review the current plan and try again.",
  };
}

export async function rejectRecommendationDecision(
  db: Db,
  userId: string,
  input: {
    recommendationId: string;
    reason?: string;
    expectedReviewRevision: number;
    expectedDeferRevision: number;
  },
  dependencies: RecommendationDecisionDependencies = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const checkpoint = dependencies.checkpoint ?? (() => undefined);
  const reason = input.reason?.trim() || null;
  const recommendation = await getOwnedRecommendation(
    db,
    userId,
    input.recommendationId
  );
  if (!recommendation) return { ok: false, reason: "Recommendation not found." };
  if (recommendation.status !== "pending") {
    const decision = await existingDecision(db, recommendation.id);
    return decision?.decision === "reject" && (decision.reason ?? null) === reason
      ? { ok: true }
      : {
          ok: false,
          reason: decision
            ? `This recommendation was already ${decision.decision === "reject" ? "rejected with a different reason" : "approved"}.`
            : "This recommendation is no longer pending.",
        };
  }
  if (
    input.expectedReviewRevision !== recommendation.reviewRevision ||
    input.expectedDeferRevision !== recommendation.deferRevision
  ) {
    return { ok: false, reason: "This proposal changed. Refresh and review its current evidence." };
  }
  if (recommendation.deferredAt != null) {
    return { ok: false, reason: "Resume this deferred review before making a decision." };
  }

  const decisionId = randomUUID();
  const assessment = await resolveReviewEvidence(db, userId, recommendation);
  const reviewSnapshot = buildReviewDecisionSnapshot(recommendation, assessment);
  await checkpoint("recommendation-ready");
  const query = sql`
    WITH claimed AS (
      UPDATE recommendations recommendation
      SET status = 'rejected',
          decided_at = now()
      WHERE recommendation.id = ${recommendation.id}::uuid
        AND recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.review_revision = ${recommendation.reviewRevision}::int
        AND recommendation.defer_revision = ${recommendation.deferRevision}::int
        AND recommendation.deferred_at IS NULL
      RETURNING recommendation.id
    ), recorded_decision AS (
      INSERT INTO user_decisions (id, recommendation_id, decision, reason, review_snapshot)
      SELECT ${decisionId}::uuid, claimed.id, 'reject', ${reason}, ${JSON.stringify(reviewSnapshot)}::jsonb
      FROM claimed
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        CASE
          WHEN (SELECT count(*) FROM recorded_decision) = 1
            AND ${dependencies.failureAt ?? null}::text IS NULL
          THEN ${userId}::uuid
          ELSE NULL::uuid
        END,
        'user',
        'recommendation.reject',
        'recommendation',
        claimed.id::text,
        CASE WHEN ${reason}::text IS NULL
          THEN 'Rejected recommendation'
          ELSE 'Rejected: ' || ${reason}::text
        END,
        jsonb_build_object('recommendationId', claimed.id),
        'recommendation:' || claimed.id::text || ':decision'
      FROM claimed
      RETURNING id
    )
    SELECT claimed.id
    FROM claimed
    WHERE EXISTS (SELECT 1 FROM recorded_audit)
  `;
  const applied = resultRows(await db.execute(query)).length === 1;
  if (applied) {
    await checkpoint("recommendation-rejected");
    return { ok: true };
  }

  const decision = await existingDecision(db, recommendation.id);
  return decision?.decision === "reject" && (decision.reason ?? null) === reason
    ? { ok: true }
    : {
        ok: false,
        reason: decision
          ? `This recommendation was already ${decision.decision === "reject" ? "rejected with a different reason" : "approved"}.`
          : "This recommendation is no longer pending.",
      };
}

const revisitOnSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  },
  "Choose a valid revisit date.",
);

export async function deferRecommendationDecision(
  db: Db,
  userId: string,
  input: {
    recommendationId: string;
    expectedReviewRevision: number;
    expectedDeferRevision: number;
    revisitOn?: string;
    reason?: string;
  },
  dependencies: RecommendationDecisionDependencies = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const recommendation = await getOwnedRecommendation(db, userId, input.recommendationId);
  if (!recommendation) return { ok: false, reason: "Recommendation not found." };
  if (recommendation.payload.kind === "hold") {
    return { ok: false, reason: "Automatic hold notices can be dismissed, not deferred." };
  }
  const parsedRevisitOn = input.revisitOn
    ? revisitOnSchema.safeParse(input.revisitOn)
    : null;
  if (parsedRevisitOn && !parsedRevisitOn.success) {
    return { ok: false, reason: "Choose a valid revisit date." };
  }
  const revisitOn = parsedRevisitOn?.data ?? null;
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > 500) {
    return { ok: false, reason: "The defer note must be 500 characters or fewer." };
  }
  if (
    recommendation.deferredAt != null &&
    recommendation.revisitOn === revisitOn &&
    (recommendation.deferReason ?? null) === reason
  ) {
    return { ok: true };
  }
  if (recommendation.status !== "pending" || recommendation.archivedAt != null) {
    return { ok: false, reason: "This proposal is no longer pending." };
  }
  if (
    recommendation.reviewRevision !== input.expectedReviewRevision ||
    recommendation.deferRevision !== input.expectedDeferRevision
  ) {
    return { ok: false, reason: "This proposal changed. Refresh before deferring it." };
  }
  await dependencies.checkpoint?.("recommendation-defer-ready");
  const applied = resultRows(await db.execute(sql`
    WITH claimed AS (
      UPDATE recommendations recommendation
      SET deferred_at = statement_timestamp(),
          revisit_on = ${revisitOn}::date,
          defer_reason = ${reason}
      WHERE recommendation.id = ${recommendation.id}::uuid
        AND recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.review_revision = ${input.expectedReviewRevision}::int
        AND recommendation.defer_revision = ${input.expectedDeferRevision}::int
      RETURNING recommendation.id, recommendation.review_revision, recommendation.defer_revision
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        CASE WHEN ${dependencies.failureAt ?? null}::text IS NULL THEN ${userId}::uuid ELSE NULL::uuid END,
        'user', 'recommendation.defer', 'recommendation', claimed.id::text,
        CASE WHEN ${revisitOn}::date IS NULL THEN 'Deferred recommendation review' ELSE 'Deferred recommendation review until ' || ${revisitOn}::text END,
        jsonb_build_object('recommendationId', claimed.id, 'reviewRevision', claimed.review_revision, 'deferRevision', claimed.defer_revision),
        'recommendation:' || claimed.id::text || ':defer:' || claimed.defer_revision::text
      FROM claimed
      RETURNING id
    )
    SELECT claimed.id FROM claimed WHERE EXISTS (SELECT 1 FROM recorded_audit)
  `)).length === 1;
  if (applied) return { ok: true };
  const latest = await getOwnedRecommendation(db, userId, recommendation.id);
  return latest?.deferredAt != null &&
    latest.revisitOn === revisitOn &&
    (latest.deferReason ?? null) === reason
    ? { ok: true }
    : { ok: false, reason: "This proposal changed while it was being deferred. Refresh and try again." };
}

export async function resumeRecommendationDecision(
  db: Db,
  userId: string,
  input: {
    recommendationId: string;
    expectedReviewRevision: number;
    expectedDeferRevision: number;
  },
  dependencies: RecommendationDecisionDependencies = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const recommendation = await getOwnedRecommendation(db, userId, input.recommendationId);
  if (!recommendation) return { ok: false, reason: "Recommendation not found." };
  if (recommendation.deferredAt == null) return { ok: true };
  if (
    recommendation.status !== "pending" ||
    recommendation.reviewRevision !== input.expectedReviewRevision ||
    recommendation.deferRevision !== input.expectedDeferRevision
  ) {
    return { ok: false, reason: "This deferred proposal changed. Refresh before resuming it." };
  }
  const applied = resultRows(await db.execute(sql`
    WITH claimed AS (
      UPDATE recommendations recommendation
      SET deferred_at = NULL, revisit_on = NULL, defer_reason = NULL
      WHERE recommendation.id = ${recommendation.id}::uuid
        AND recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.review_revision = ${input.expectedReviewRevision}::int
        AND recommendation.defer_revision = ${input.expectedDeferRevision}::int
        AND recommendation.deferred_at IS NOT NULL
      RETURNING recommendation.id, recommendation.review_revision, recommendation.defer_revision
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        CASE WHEN ${dependencies.failureAt ?? null}::text IS NULL THEN ${userId}::uuid ELSE NULL::uuid END,
        'user', 'recommendation.resume', 'recommendation', claimed.id::text,
        'Resumed deferred recommendation review',
        jsonb_build_object('recommendationId', claimed.id, 'reviewRevision', claimed.review_revision, 'deferRevision', claimed.defer_revision),
        'recommendation:' || claimed.id::text || ':resume:' || claimed.defer_revision::text
      FROM claimed
      RETURNING id
    )
    SELECT claimed.id FROM claimed WHERE EXISTS (SELECT 1 FROM recorded_audit)
  `)).length === 1;
  return applied
    ? { ok: true }
    : { ok: false, reason: "This proposal changed while it was being resumed. Refresh and try again." };
}

export async function dismissAutomaticHoldNotice(
  db: Db,
  userId: string,
  input: { recommendationId: string },
  dependencies: RecommendationDecisionDependencies = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const checkpoint = dependencies.checkpoint ?? (() => undefined);
  const recommendation = await getOwnedRecommendation(
    db,
    userId,
    input.recommendationId
  );
  if (!recommendation) return { ok: false, reason: "Notice not found." };
  if (!isAutomaticHoldNotice(recommendation)) {
    return {
      ok: false,
      reason: "Only an automatic hold notice can be dismissed.",
    };
  }
  if (recommendation.status !== "pending") {
    return recommendation.status === "expired" &&
      recommendation.reconciliationReason ===
        AUTOMATIC_HOLD_NOTICE_DISMISSED_REASON
      ? { ok: true }
      : { ok: false, reason: "This notice is no longer pending." };
  }

  await checkpoint("hold-notice-ready");
  const query = sql`
    WITH claimed AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          decided_at = NULL,
          reconciled_at = statement_timestamp(),
          reconciliation_reason = ${AUTOMATIC_HOLD_NOTICE_DISMISSED_REASON}
      WHERE recommendation.id = ${recommendation.id}::uuid
        AND recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.source = 'rule'
        AND recommendation.rule_id IS NOT DISTINCT FROM ${recommendation.ruleId}
        AND recommendation.payload->>'kind' = 'hold'
        AND recommendation.reason = ${recommendation.reason}
        AND recommendation.payload = ${JSON.stringify(recommendation.payload)}::jsonb
        AND recommendation.evidence = ${JSON.stringify(recommendation.evidence)}::jsonb
      RETURNING recommendation.id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        CASE
          WHEN ${dependencies.failureAt ?? null}::text IS NULL
          THEN ${userId}::uuid
          ELSE NULL::uuid
        END,
        'user',
        'recommendation.notice_dismiss',
        'recommendation',
        claimed.id::text,
        'Dismissed automatic pain hold notice',
        jsonb_build_object('recommendationId', claimed.id),
        'recommendation:' || claimed.id::text || ':notice-dismiss'
      FROM claimed
      RETURNING id
    )
    SELECT claimed.id
    FROM claimed
    WHERE EXISTS (SELECT 1 FROM recorded_audit)
  `;
  const applied = resultRows(await db.execute(query)).length === 1;
  if (applied) {
    await checkpoint("hold-notice-dismissed");
    return { ok: true };
  }

  const latest = await getOwnedRecommendation(db, userId, recommendation.id);
  if (
    latest?.status === "expired" &&
    latest.reconciliationReason ===
      AUTOMATIC_HOLD_NOTICE_DISMISSED_REASON
  ) {
    return { ok: true };
  }
  if (latest?.status === "pending" && isAutomaticHoldNotice(latest)) {
    return {
      ok: false,
      reason:
        "This notice changed while you were dismissing it. Review the current notice and try again.",
    };
  }
  return latest?.status === "pending"
    ? {
        ok: false,
        reason: "Only an automatic hold notice can be dismissed.",
      }
    : { ok: false, reason: "This notice is no longer pending." };
}
