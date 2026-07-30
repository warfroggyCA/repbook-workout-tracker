import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import {
  completedSets,
  exercises,
  sessionExercises,
  sessionOccurrences,
  workoutSessions,
  type RecommendationEvidence,
  type RecommendationPayload,
} from "@/db/schema";
import { classifySetMetricContainment } from "@/lib/set-metric-semantics";

type RecommendationEvidenceCandidate = {
  payload: RecommendationPayload;
  evidence: RecommendationEvidence;
  exerciseId: string | null;
  sourceSlotLineageId: string | null;
};

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
