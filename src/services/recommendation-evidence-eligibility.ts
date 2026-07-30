import { and, eq, inArray, isNull } from "drizzle-orm";
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

type RecommendationEvidenceCandidate = {
  payload: RecommendationPayload;
  evidence: RecommendationEvidence;
  exerciseId: string | null;
  sourceSlotLineageId: string | null;
  ruleId?: string | null;
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
  const refreshed = reviewed.filter(({ recommendation, painHold }) => {
    const expectedRule =
      painHold?.state === "hold"
        ? "pain_freeze"
        : painHold?.state === "substitution_review"
          ? "pain_substitute"
          : null;
    return expectedRule != null && recommendation.ruleId !== expectedRule;
  });
  for (const { recommendation, painHold } of refreshed) {
    if (!painHold?.explanation) continue;
    const expectedRule =
      painHold.state === "hold" ? "pain_freeze" : "pain_substitute";
    const templateExerciseId =
      recommendation.payload.kind === "deload"
        ? recommendation.sourceTemplateExerciseId
        : recommendation.payload.templateExerciseId;
    if (!templateExerciseId) continue;
    await db
      .update(recommendations)
      .set({
        ruleId: expectedRule,
        payload: {
          kind: "hold",
          templateExerciseId,
          reason: painHold.explanation,
        },
        reason: painHold.explanation,
        evidence: {
          signals: painHold.signals,
          sessionIds: painHold.sessionIds,
          painLogIds: painHold.evidenceIds,
        },
        reconciledAt: new Date(),
        reconciliationReason:
          "Live pain evidence changed, so this automatic status was refreshed without changing the Program.",
      })
      .where(
        and(
          eq(recommendations.userId, userId),
          eq(recommendations.id, recommendation.id),
          eq(recommendations.status, "pending"),
        ),
      );
  }

  const stale = reviewed.filter(
    ({ painHold }) =>
      painHold == null || painHold.state === "clear",
  );
  if (stale.length === 0) return refreshed.length;
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
        eq(recommendations.status, "pending"),
        inArray(
          recommendations.id,
          stale.map(({ recommendation }) => recommendation.id),
        ),
      ),
    )
    .returning({ id: recommendations.id });
  return refreshed.length + expired.length;
}
