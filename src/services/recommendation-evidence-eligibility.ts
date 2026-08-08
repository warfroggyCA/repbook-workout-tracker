import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import {
  completedSets,
  exercises,
  programs,
  recommendations,
  sessionExercises,
  sessionOccurrences,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
  type RecommendationEvidence,
  type RecommendationPayload,
} from "@/db/schema";
import { classifySetMetricContainment } from "@/lib/set-metric-semantics";
import { loadExercisePainHold } from "@/services/pain-hold";
import type { PainHoldClassification } from "@/engine/progression/pain-hold";
import { canonicalJson } from "@/services/snapshot-crypto";
import { PAIN_EVIDENCE_ALGORITHM_VERSION } from "@/lib/pain-evidence";
import {
  parseRecommendationReviewEvidence,
  withRecommendationReviewEvidence,
} from "@/lib/review-evidence";

type RecommendationEvidenceCandidate = {
  payload: RecommendationPayload;
  evidence: RecommendationEvidence;
  exerciseId: string | null;
  sourceSlotLineageId: string | null;
  ruleId?: string | null;
};

export type PainRecommendationReconciliationDependencies = {
  /** Test-only boundary for proving concurrent correction/restore behavior. */
  checkpoint?: (boundary: string) => void | Promise<void>;
};

async function loadPainRecommendationLiveState(
  db: Db,
  userId: string,
  recommendation: RecommendationEvidenceCandidate,
): Promise<PainHoldClassification | null> {
  if (!recommendation.exerciseId || !recommendation.sourceSlotLineageId) {
    return null;
  }
  const [currentSlot] = await db
    .select({ exerciseId: workoutTemplateExercises.exerciseId })
    .from(programs)
    .innerJoin(
      workoutTemplates,
      eq(workoutTemplates.programVersionId, programs.currentVersionId),
    )
    .innerJoin(
      workoutTemplateExercises,
      eq(
        workoutTemplateExercises.workoutTemplateId,
        workoutTemplates.id,
      ),
    )
    .where(
      and(
        eq(programs.userId, userId),
        eq(programs.status, "active"),
        isNull(programs.archivedAt),
        eq(
          workoutTemplateExercises.lineageId,
          recommendation.sourceSlotLineageId,
        ),
      ),
    )
    .limit(1);
  if (currentSlot?.exerciseId !== recommendation.exerciseId) return null;

  return loadExercisePainHold(db, {
    userId,
    exerciseId: recommendation.exerciseId,
  });
}

export async function filterRecommendationsEligibleForAction<
  T extends RecommendationEvidenceCandidate,
>(db: Db, userId: string, candidates: T[]): Promise<T[]> {
  const reviewed = await Promise.all(
    candidates.map(async (recommendation) => ({
      recommendation,
      eligible: await recommendationEvidenceEligibleForAction(
        db,
        userId,
        recommendation,
      ),
    })),
  );
  return reviewed
    .filter(({ eligible }) => eligible)
    .map(({ recommendation }) => recommendation);
}

/**
 * A pre-containment load recommendation remains a durable record, but it may
 * be shown or applied only when every linked set still proves exact,
 * owner-scoped, planned, comparable barbell evidence.
 */
export async function recommendationEvidenceEligibleForAction(
  db: Db,
  userId: string,
  recommendation: RecommendationEvidenceCandidate,
): Promise<boolean> {
  if (
    recommendation.ruleId === "pain_freeze" ||
    recommendation.ruleId === "pain_substitute"
  ) {
    const painHold = await loadPainRecommendationLiveState(
      db,
      userId,
      recommendation,
    );
    if (!painHold) return false;
    return recommendation.ruleId === "pain_freeze"
      ? painHold.state === "hold"
      : painHold.state === "substitution_review";
  }
  if (recommendation.payload.kind !== "load_change") return true;
  if (!recommendation.exerciseId || !recommendation.sourceSlotLineageId) {
    return false;
  }
  const setIds = [...new Set(recommendation.evidence.setIds ?? [])];
  if (setIds.length === 0) return false;

  const rows = await db
    .select({
      id: completedSets.id,
      metricType: completedSets.metricType,
      performedSemanticsVersion: completedSets.performedSemanticsVersion,
      performedLoadType: completedSets.performedLoadType,
      performedLoadSemantics: completedSets.performedLoadSemantics,
      loadEntryMeaning: completedSets.loadEntryMeaning,
      weight: completedSets.weight,
      reps: completedSets.reps,
      excludeFromAnalytics: completedSets.excludeFromAnalytics,
      exerciseId: sessionExercises.exerciseId,
      sourceSlotLineageId: sessionExercises.sourceSlotLineageId,
      modificationType: sessionExercises.modificationType,
      prescribedSemanticsVersion:
        sessionExercises.prescribedSemanticsVersion,
      exerciseMetricType: exercises.metricType,
      exerciseLoadType: exercises.loadType,
      exerciseLoadSemantics: exercises.loadSemantics,
    })
    .from(completedSets)
    .innerJoin(
      sessionExercises,
      eq(sessionExercises.id, completedSets.sessionExerciseId),
    )
    .innerJoin(
      workoutSessions,
      eq(workoutSessions.id, sessionExercises.sessionId),
    )
    .innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
    .innerJoin(
      sessionOccurrences,
      and(
        eq(sessionOccurrences.completedSetId, completedSets.id),
        eq(
          sessionOccurrences.sessionExerciseId,
          completedSets.sessionExerciseId,
        ),
        eq(sessionOccurrences.kind, "working_set"),
        eq(sessionOccurrences.outcome, "completed"),
      ),
    )
    .where(
      and(
        inArray(completedSets.id, setIds),
        eq(workoutSessions.userId, userId),
        eq(workoutSessions.status, "completed"),
        isNull(workoutSessions.archivedAt),
        isNull(completedSets.archivedAt),
      ),
    );
  if (rows.length !== setIds.length) return false;
  return rows.every(
    (set) =>
      set.exerciseId === recommendation.exerciseId &&
      set.sourceSlotLineageId === recommendation.sourceSlotLineageId &&
      set.modificationType === "as_planned" &&
      classifySetMetricContainment({
        recordedMetricType: set.metricType,
        prescribedSemanticsVersion: set.prescribedSemanticsVersion,
        performedSemanticsVersion: set.performedSemanticsVersion,
        performedLoadType: set.performedLoadType,
        performedLoadSemantics: set.performedLoadSemantics,
        currentExerciseMetricType: set.exerciseMetricType,
        loadType: set.exerciseLoadType,
        loadSemantics: set.exerciseLoadSemantics,
        loadEntryMeaning: set.loadEntryMeaning,
        weight: set.weight,
        reps: set.reps,
        excludeFromAnalytics: set.excludeFromAnalytics,
      }).automaticProgressionEligible,
  );
}

export async function reconcilePendingPainRecommendations(
  db: Db,
  userId: string,
  dependencies: PainRecommendationReconciliationDependencies = {},
): Promise<number> {
  const pending = await db.query.recommendations.findMany({
    where: and(
      eq(recommendations.userId, userId),
      eq(recommendations.status, "pending"),
      isNull(recommendations.archivedAt),
      inArray(recommendations.ruleId, ["pain_freeze", "pain_substitute"]),
    ),
  });
  const reviewed = await Promise.all(
    pending.map(async (recommendation) => ({
      recommendation,
      painHold: await loadPainRecommendationLiveState(
        db,
        userId,
        recommendation,
      ),
    })),
  );
  await dependencies.checkpoint?.("pain-recommendations-reviewed");
  const refreshes = reviewed.flatMap(({ recommendation, painHold }) => {
    const expectedRule: "pain_freeze" | "pain_substitute" | null =
      painHold?.state === "hold"
        ? "pain_freeze"
        : painHold?.state === "substitution_review"
          ? "pain_substitute"
          : null;
    if (expectedRule == null || !painHold?.explanation) return [];
    const explanation = painHold.explanation;
    const templateExerciseId =
      recommendation.payload.kind === "deload"
        ? recommendation.sourceTemplateExerciseId
        : recommendation.payload.templateExerciseId;
    if (!templateExerciseId) return [];
    const payload: RecommendationPayload =
      expectedRule === "pain_substitute" &&
      recommendation.ruleId === expectedRule &&
      recommendation.payload.kind === "substitution"
        ? recommendation.payload
        : {
            kind: "hold",
            templateExerciseId,
            reason: explanation,
          };
    const priorSignals = recommendation.evidence.signals as {
      suggestedExercise?: unknown;
      alternatives?: unknown;
    };
    const substitutionDisplaySignals =
      payload.kind === "substitution"
        ? {
            ...(typeof priorSignals.suggestedExercise === "string"
              ? { suggestedExercise: priorSignals.suggestedExercise }
              : {}),
            ...(Array.isArray(priorSignals.alternatives) &&
            priorSignals.alternatives.every(
              (alternative) => typeof alternative === "string",
            )
              ? { alternatives: priorSignals.alternatives }
              : {}),
          }
        : {};
    const baseEvidence: RecommendationEvidence = {
      signals: {
        ...painHold.signals,
        ...substitutionDisplaySignals,
      },
      sessionIds: painHold.sessionIds,
      painLogIds: painHold.evidenceIds,
    };
    const priorReview = parseRecommendationReviewEvidence(recommendation.evidence);
    const priorBaseEvidence = { ...recommendation.evidence };
    delete priorBaseEvidence.review;
    const claimInputsUnchanged =
      recommendation.ruleId === expectedRule &&
      recommendation.reason === explanation &&
      canonicalJson(recommendation.payload) === canonicalJson(payload) &&
      canonicalJson(priorBaseEvidence) === canonicalJson(baseEvidence);
    const evidence: RecommendationEvidence = withRecommendationReviewEvidence(baseEvidence, {
      payload,
      producer: "pain_consistency",
      sourceVersion: PAIN_EVIDENCE_ALGORITHM_VERSION,
      generatedAt:
        claimInputsUnchanged && priorReview.success
          ? new Date(priorReview.data.generatedAt)
          : undefined,
      limitations: [
        "Only explicit cited pain reports were evaluated. Missing pain fields remain unknown.",
        "This deterministic status has no confidence score and never diagnoses an injury.",
      ],
    });
    const changed =
      recommendation.ruleId !== expectedRule ||
      recommendation.reason !== explanation ||
      canonicalJson(recommendation.payload) !== canonicalJson(payload) ||
      canonicalJson(recommendation.evidence) !== canonicalJson(evidence);
    return changed
      ? [{ recommendation, expectedRule, explanation, payload, evidence }]
      : [];
  });
  let refreshedCount = 0;
  for (const {
    recommendation,
    expectedRule,
    explanation,
    payload,
    evidence,
  } of refreshes) {
    const updated = await db
      .update(recommendations)
      .set({
        ruleId: expectedRule,
        payload,
        reason: explanation,
        evidence,
        reconciledAt: new Date(),
        reconciliationReason:
          "Live pain evidence changed, so this automatic status was refreshed without changing the Program.",
      })
      .where(
        and(
          eq(recommendations.userId, userId),
          eq(recommendations.id, recommendation.id),
          eq(recommendations.status, "pending"),
          isNull(recommendations.archivedAt),
          sql`${recommendations.ruleId} IS NOT DISTINCT FROM ${recommendation.ruleId}`,
          eq(recommendations.reason, recommendation.reason),
          sql`${recommendations.payload} = ${JSON.stringify(recommendation.payload)}::jsonb`,
          sql`${recommendations.evidence} = ${JSON.stringify(recommendation.evidence)}::jsonb`,
        ),
      )
      .returning({ id: recommendations.id });
    refreshedCount += updated.length;
  }

  const stale = reviewed.filter(
    ({ painHold }) =>
      painHold == null || painHold.state === "clear",
  );
  if (stale.length === 0) return refreshedCount;
  let expiredCount = 0;
  for (const { recommendation } of stale) {
    const expired = await db
      .update(recommendations)
      .set({
        status: "expired",
        reconciledAt: new Date(),
        reconciliationReason:
          "The pain evidence window or exact Program exercise changed, so this older status expired.",
      })
      .where(
        and(
          eq(recommendations.userId, userId),
          eq(recommendations.id, recommendation.id),
          eq(recommendations.status, "pending"),
          isNull(recommendations.archivedAt),
          sql`${recommendations.ruleId} IS NOT DISTINCT FROM ${recommendation.ruleId}`,
          eq(recommendations.reason, recommendation.reason),
          sql`${recommendations.payload} = ${JSON.stringify(recommendation.payload)}::jsonb`,
          sql`${recommendations.evidence} = ${JSON.stringify(recommendation.evidence)}::jsonb`,
        ),
      )
      .returning({ id: recommendations.id });
    expiredCount += expired.length;
  }
  return refreshedCount + expiredCount;
}
