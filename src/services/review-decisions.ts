import {
  and,
  desc,
  eq,
  inArray,
  isNull,
} from "drizzle-orm";
import type { Db } from "@/db";
import {
  completedSets,
  exercises,
  painLogs,
  programs,
  programVersions,
  recommendations,
  sessionExercises,
  sessionOccurrences,
  workoutSessions,
  workoutTemplates,
  workoutTemplateExercises,
  type RecommendationEvidence,
  type RecommendationPayload,
} from "@/db/schema";
import { convertWeight, loadsEqual } from "@/lib/units";
import { classifySetMetricContainment } from "@/lib/set-metric-semantics";
import {
  recommendationEvidenceEligibleForAction,
  reconcilePendingPainRecommendations,
} from "@/services/recommendation-evidence-eligibility";

export type ReviewEvidenceItem = {
  label: string;
  value: string;
};

export type ReviewDecisionStatus =
  | "Accepted"
  | "Edited"
  | "Rejected"
  | "Expired"
  | "Undone";

export type OutcomeReadyDecision = {
  recommendationId: string;
  exerciseName: string;
  decisionStatus: "Accepted" | "Edited";
  changeSummary: string;
  decidedAt: Date;
  followupSessions: number;
  latestSessionId: string;
  latestSessionName: string;
  latestLocalDate: string;
  workingSets: number;
  measurableSets: number;
  targetsMet: number;
  rpeCount: number;
  averageRpe: number | null;
  painFlags: number;
  maxPainSeverity: number | null;
  evidenceLimited: boolean;
};

type DecisionHistoryInput = {
  status: "pending" | "approved" | "rejected" | "edited" | "expired";
  adaptations: Array<{ undoneAt: Date | null }>;
};

const signalLabels: Record<string, string> = {
  cleanExposures: "Clean completed workouts",
  hardMissExposures: "Repeated hard-miss workouts",
  worstPainSeverity: "Highest recorded pain flag",
  worstSeverity: "Highest recorded pain flag",
  painReports: "Recorded pain flags",
  positiveReports: "Recorded pain flags",
  holdReports: "Flags at 3/10 or higher",
  linkedSessions: "Workouts with a pain flag",
  windowDays: "Evidence window",
  releaseAt: "Hold checks again",
  highSeverityReview: "Higher-severity review",
  repeatedSessionReview: "Repeated-workout review",
  triggerEvidenceId: "Triggering pain flag",
  triggerSessionId: "Triggering workout",
  fromLoad: "Previous target",
  toLoad: "Suggested target",
};

const separatelyPresentedSignals = new Set([
  "alternatives",
  "suggestedExercise",
  "positiveReports",
  "linkedSessions",
  "triggerEvidenceId",
  "triggerSessionId",
  "highSeverityReview",
  "repeatedSessionReview",
]);

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function humanizeSignalKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function signalValue(
  key: string,
  value: unknown,
  loadUnit: "lb" | "kg" | null
): string | null {
  if (key === "worstPainSeverity" && typeof value === "number") {
    return `${value}/10`;
  }
  if (key === "windowDays" && typeof value === "number") {
    return plural(value, "day");
  }
  if (key === "releaseAt" && typeof value === "string") {
    const releaseAt = new Date(value);
    if (!Number.isNaN(releaseAt.getTime())) {
      return releaseAt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  }
  if (
    (key === "fromLoad" || key === "toLoad") &&
    typeof value === "number"
  ) {
    return `${value}${loadUnit ? ` ${loadUnit}` : ""}`;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => ["number", "string", "boolean"].includes(typeof item))
  ) {
    return value.map(String).join(", ");
  }
  return null;
}

export function buildReviewEvidenceItems(
  evidence: RecommendationEvidence,
  loadUnit: "lb" | "kg" | null
): ReviewEvidenceItem[] {
  const items: ReviewEvidenceItem[] = [];

  if (evidence.sessionIds?.length) {
    items.push({
      label: "Linked completed workouts",
      value: String(evidence.sessionIds.length),
    });
  }
  if (evidence.setIds?.length) {
    items.push({
      label: "Linked working sets",
      value: String(evidence.setIds.length),
    });
  }
  if (evidence.painLogIds?.length) {
    items.push({
      label: "Linked pain flags",
      value: String(evidence.painLogIds.length),
    });
  }

  for (const [key, rawValue] of Object.entries(evidence.signals ?? {})) {
    if (separatelyPresentedSignals.has(key)) continue;
    const value = signalValue(key, rawValue, loadUnit);
    if (!value) continue;
    items.push({
      label: signalLabels[key] ?? humanizeSignalKey(key),
      value,
    });
  }

  return items;
}

export function reviewDecisionStatus(
  decision: DecisionHistoryInput
): ReviewDecisionStatus {
  if (decision.adaptations.some((adaptation) => adaptation.undoneAt != null)) {
    return "Undone";
  }
  if (decision.status === "approved") return "Accepted";
  if (decision.status === "edited") return "Edited";
  if (decision.status === "rejected") return "Rejected";
  return "Expired";
}

function isRecommendationPayload(value: unknown): value is RecommendationPayload {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "load_change" ||
    kind === "rep_target_change" ||
    kind === "set_count_change" ||
    kind === "deload" ||
    kind === "substitution" ||
    kind === "remove_exercise" ||
    kind === "hold"
  );
}

function payloadFromSnapshot(snapshot: unknown): RecommendationPayload | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const payload = (snapshot as { payload?: unknown }).payload;
  return isRecommendationPayload(payload) ? payload : null;
}

export function summarizeRecommendationChange(
  payload: RecommendationPayload,
  suggestedExercise?: string | null
) {
  switch (payload.kind) {
    case "load_change":
      return `${payload.fromLoad ?? "No target"} → ${payload.toLoad} ${payload.loadUnit}`;
    case "rep_target_change":
      return `${payload.fromRepMax} → ${payload.toRepMax} reps`;
    case "set_count_change":
      return `${payload.fromSets} → ${payload.toSets} sets`;
    case "deload":
      return `Program deload for ${payload.durationSessionsPerTemplate} workout${
        payload.durationSessionsPerTemplate === 1 ? "" : "s"
      } per day`;
    case "substitution":
      return suggestedExercise
        ? `Switch to ${suggestedExercise}`
        : "Exercise substitution";
    case "remove_exercise":
      return "Remove exercise";
    case "hold":
      return "Hold the current target";
  }
}

function appliedPayload(input: {
  payload: RecommendationPayload;
  adaptations: Array<{ afterSnapshot: unknown }>;
  decisions: Array<{ editedPayload: RecommendationPayload | null }>;
}) {
  return (
    payloadFromSnapshot(input.adaptations[0]?.afterSnapshot) ??
    input.decisions[0]?.editedPayload ??
    input.payload
  );
}

function outcomeMatchesPayload(
  payload: RecommendationPayload,
  followup: {
    exerciseId: string;
    modificationType: "as_planned" | "substituted" | "added" | "skipped";
    targetLoad: number | null;
    targetLoadUnit: "lb" | "kg" | null;
  },
  recommendationExerciseId: string | null,
) {
  if (payload.kind === "load_change") {
    return (
      recommendationExerciseId != null &&
      followup.exerciseId === recommendationExerciseId &&
      followup.modificationType === "as_planned" &&
      followup.targetLoadUnit === payload.loadUnit &&
      loadsEqual(followup.targetLoad, payload.toLoad)
    );
  }
  return false;
}

function completedSetMatchesPayload(
  payload: RecommendationPayload,
  set: {
    weight: number | null;
    weightUnit: "lb" | "kg" | null;
  }
) {
  if (payload.kind === "load_change") {
    return (
      set.weight != null &&
      set.weightUnit != null &&
      loadsEqual(
        set.weight,
        convertWeight(payload.toLoad, payload.loadUnit, set.weightUnit)
      )
    );
  }
  return false;
}

export async function getReviewDecisionData(db: Db, userId: string) {
  await reconcilePendingPainRecommendations(db, userId);
  const [pendingRows, recentRows, acceptedRows] = await Promise.all([
    db.query.recommendations.findMany({
      where: and(
        eq(recommendations.userId, userId),
        eq(recommendations.status, "pending"),
        isNull(recommendations.archivedAt)
      ),
      orderBy: desc(recommendations.createdAt),
      with: { exercise: true },
    }),
    db.query.recommendations.findMany({
      where: and(
        eq(recommendations.userId, userId),
        inArray(recommendations.status, [
          "approved",
          "rejected",
          "edited",
          "expired",
        ]),
        isNull(recommendations.archivedAt)
      ),
      with: { exercise: true, decisions: true, adaptations: true },
    }),
    db.query.recommendations.findMany({
      where: and(
        eq(recommendations.userId, userId),
        inArray(recommendations.status, ["approved", "edited"]),
        isNull(recommendations.archivedAt)
      ),
      orderBy: desc(recommendations.createdAt),
      with: { exercise: true, decisions: true, adaptations: true },
    }),
  ]);
  const pending = (
    await Promise.all(
      pendingRows.map(async (recommendation) => ({
        recommendation,
        eligible: await recommendationEvidenceEligibleForAction(
          db,
          userId,
          recommendation,
        ),
      })),
    )
  )
    .filter(({ eligible }) => eligible)
    .map(({ recommendation }) => recommendation);

  // The recommendation is owner-scoped above, but adaptation_events also has
  // its own owner column. Defensively enforce both sides before using an
  // adaptation as publication or undo evidence.
  const recent = recentRows
    .map((recommendation) => ({
      ...recommendation,
      adaptations: recommendation.adaptations.filter(
        (adaptation) => adaptation.userId === userId
      ),
    }))
    .sort((left, right) => {
      const effectiveTime = (recommendation: typeof left) =>
        Math.max(
          recommendation.reconciledAt?.getTime() ?? 0,
          recommendation.decidedAt?.getTime() ?? 0,
          recommendation.createdAt.getTime(),
          ...recommendation.adaptations.map(
            (adaptation) => adaptation.undoneAt?.getTime() ?? 0
          )
        );
      return effectiveTime(right) - effectiveTime(left);
    })
    .slice(0, 20);
  const accepted = acceptedRows.map((recommendation) => ({
    ...recommendation,
    adaptations: recommendation.adaptations.filter(
      (adaptation) => adaptation.userId === userId
    ),
  }));

  const activeAcceptedDecisionCount = accepted.filter((recommendation) =>
    recommendation.adaptations.some((adaptation) => adaptation.undoneAt == null)
  ).length;
  const acceptedWithAdaptation = accepted.flatMap((recommendation) => {
    const adaptation = recommendation.adaptations[0];
    if (!adaptation || !recommendation.sourceSlotLineageId) return [];
    return [{ recommendation, adaptation }];
  });
  const activeAccepted = acceptedWithAdaptation.filter(
    ({ adaptation }) => adaptation.undoneAt == null
  );
  if (activeAccepted.length === 0) {
    return {
      pending,
      recent,
      outcomes: [] as OutcomeReadyDecision[],
      acceptedDecisionCount: activeAcceptedDecisionCount,
      outcomeSupportedDecisionCount: 0,
    };
  }
  const activeSupported = activeAccepted.filter(
    ({ recommendation }) =>
      appliedPayload(recommendation).kind === "load_change"
  );

  const lineageIds = [
    ...new Set(
      acceptedWithAdaptation.map(
        ({ recommendation }) => recommendation.sourceSlotLineageId!
      )
    ),
  ];
  const slots = await db
    .select({
      id: workoutTemplateExercises.id,
      lineageId: workoutTemplateExercises.lineageId,
    })
    .from(workoutTemplateExercises)
    .innerJoin(
      workoutTemplates,
      eq(workoutTemplates.id, workoutTemplateExercises.workoutTemplateId)
    )
    .innerJoin(
      programVersions,
      eq(programVersions.id, workoutTemplates.programVersionId)
    )
    .innerJoin(programs, eq(programs.id, programVersions.programId))
    .where(
      and(
        eq(programs.userId, userId),
        inArray(workoutTemplateExercises.lineageId, lineageIds)
      )
    );
  const slotLineage = new Map(slots.map((slot) => [slot.id, slot.lineageId]));

  if (slots.length === 0) {
    return {
      pending,
      recent,
      outcomes: [] as OutcomeReadyDecision[],
      acceptedDecisionCount: activeAcceptedDecisionCount,
      outcomeSupportedDecisionCount: 0,
    };
  }
  const usableLineageIds = new Set(slots.map((slot) => slot.lineageId));
  const outcomeSupportedDecisionCount = activeSupported.filter(
    ({ recommendation }) =>
      usableLineageIds.has(recommendation.sourceSlotLineageId!)
  ).length;

  const followups = await db
    .select({
      sessionExerciseId: sessionExercises.id,
      plannedSlotId: sessionExercises.plannedFromTemplateExerciseId,
      exerciseId: sessionExercises.exerciseId,
      modificationType: sessionExercises.modificationType,
      exerciseName: exercises.name,
      exerciseMetricType: exercises.metricType,
      exerciseLoadType: exercises.loadType,
      exerciseLoadSemantics: exercises.loadSemantics,
      targetLoad: sessionExercises.targetLoad,
      targetLoadUnit: sessionExercises.targetLoadUnit,
      sessionId: workoutSessions.id,
      sessionName: workoutSessions.templateName,
      localDate: workoutSessions.localDate,
      startedAt: workoutSessions.startedAt,
    })
    .from(sessionExercises)
    .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
    .innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
    .where(
      and(
        eq(workoutSessions.userId, userId),
        eq(workoutSessions.status, "completed"),
        isNull(workoutSessions.archivedAt),
        inArray(
          sessionExercises.plannedFromTemplateExerciseId,
          slots.map((slot) => slot.id)
        )
      )
    )
    .orderBy(desc(workoutSessions.startedAt));

  if (followups.length === 0) {
    return {
      pending,
      recent,
      outcomes: [] as OutcomeReadyDecision[],
      acceptedDecisionCount: activeAcceptedDecisionCount,
      outcomeSupportedDecisionCount,
    };
  }

  const sessionExerciseIds = followups.map((followup) => followup.sessionExerciseId);
  const sessionIds = [...new Set(followups.map((followup) => followup.sessionId))];
  const [candidateSets, pains, sessionExerciseOccurrences, completedOccurrences] = await Promise.all([
    db.query.completedSets.findMany({
      where: and(
        inArray(completedSets.sessionExerciseId, sessionExerciseIds),
        eq(completedSets.isWarmup, false),
        eq(completedSets.excludeFromAnalytics, false),
        isNull(completedSets.archivedAt)
      ),
    }),
    db.query.painLogs.findMany({
      where: and(
        eq(painLogs.userId, userId),
        inArray(painLogs.sessionId, sessionIds),
        isNull(painLogs.archivedAt)
      ),
    }),
    db.query.sessionExercises.findMany({
      where: inArray(sessionExercises.sessionId, sessionIds),
      columns: { sessionId: true, exerciseId: true },
    }),
    db.query.sessionOccurrences.findMany({
      where: and(
        inArray(sessionOccurrences.sessionId, sessionIds),
        eq(sessionOccurrences.kind, "working_set"),
        eq(sessionOccurrences.outcome, "completed")
      ),
      columns: { completedSetId: true },
    }),
  ]);
  const completedSetIds = new Set(
    completedOccurrences
      .map((occurrence) => occurrence.completedSetId)
      .filter((id): id is string => id != null)
  );
  const followupBySessionExerciseId = new Map(
    followups.map((followup) => [followup.sessionExerciseId, followup])
  );
  const sets = candidateSets.filter((set) => {
    if (!completedSetIds.has(set.id)) return false;
    const followup = followupBySessionExerciseId.get(set.sessionExerciseId);
    if (!followup) return false;
    return classifySetMetricContainment({
      recordedMetricType: set.metricType,
      performedSemanticsVersion: set.performedSemanticsVersion,
      performedLoadType: set.performedLoadType,
      performedLoadSemantics: set.performedLoadSemantics,
      currentExerciseMetricType: followup.exerciseMetricType,
      loadType: followup.exerciseLoadType,
      loadSemantics: followup.exerciseLoadSemantics,
      loadEntryMeaning: set.loadEntryMeaning,
      weight: set.weight,
      reps: set.reps,
      excludeFromAnalytics: set.excludeFromAnalytics,
    }).loadedWorkEligible;
  });
  const setsByExercise = new Map<string, typeof sets>();
  for (const set of sets) {
    const existing = setsByExercise.get(set.sessionExerciseId) ?? [];
    existing.push(set);
    setsByExercise.set(set.sessionExerciseId, existing);
  }
  const occurrenceCounts = new Map<string, number>();
  for (const occurrence of sessionExerciseOccurrences) {
    const key = `${occurrence.sessionId}:${occurrence.exerciseId}`;
    occurrenceCounts.set(key, (occurrenceCounts.get(key) ?? 0) + 1);
  }

  const outcomes = activeSupported.flatMap<OutcomeReadyDecision>(
    ({ recommendation, adaptation }) => {
      const lineageId = recommendation.sourceSlotLineageId!;
      const payload = appliedPayload(recommendation);
      const nextAdaptationAt = acceptedWithAdaptation
        .filter(
          (candidate) =>
            candidate.recommendation.sourceSlotLineageId === lineageId &&
            candidate.adaptation.appliedAt > adaptation.appliedAt
        )
        .map((candidate) => candidate.adaptation.appliedAt)
        .sort((left, right) => left.getTime() - right.getTime())[0];

      const matchingFollowups = followups.filter((followup) => {
        if (
          !followup.plannedSlotId ||
          slotLineage.get(followup.plannedSlotId) !== lineageId ||
          followup.startedAt <= adaptation.appliedAt ||
          (nextAdaptationAt && followup.startedAt >= nextAdaptationAt)
        ) {
          return false;
        }
        return outcomeMatchesPayload(
          payload,
          followup,
          recommendation.exerciseId,
        );
      });
      const observedFollowups = matchingFollowups.filter((followup) =>
        (setsByExercise.get(followup.sessionExerciseId) ?? []).some((set) =>
          completedSetMatchesPayload(payload, set)
        )
      );
      if (observedFollowups.length === 0) return [];

      const observedSets = observedFollowups.flatMap((followup) =>
        (setsByExercise.get(followup.sessionExerciseId) ?? []).filter((set) =>
          completedSetMatchesPayload(payload, set)
        )
      );
      const measurableSets = observedSets.filter(
        (set) => set.targetMet != null
      );
      const rpes = observedSets
        .map((set) => set.rpe)
        .filter((rpe): rpe is number => rpe != null);
      const observedSetIds = new Set(observedSets.map((set) => set.id));
      const observedSessionExerciseKeys = new Set(
        observedFollowups.map(
          (followup) => `${followup.sessionId}:${followup.exerciseId}`
        )
      );
      const observedPain = pains.filter((pain) => {
        if (pain.completedSetId) {
          return observedSetIds.has(pain.completedSetId);
        }
        if (!pain.sessionId || !pain.exerciseId) return false;
        const key = `${pain.sessionId}:${pain.exerciseId}`;
        return (
          observedSessionExerciseKeys.has(key) && occurrenceCounts.get(key) === 1
        );
      });
      const latest = observedFollowups[0];
      const suggestedExercise = (
        recommendation.evidence.signals as { suggestedExercise?: unknown }
      ).suggestedExercise;

      return [
        {
          recommendationId: recommendation.id,
          exerciseName:
            latest.exerciseName ?? recommendation.exercise?.name ?? "Program",
          decisionStatus:
            recommendation.status === "edited" ? "Edited" : "Accepted",
          changeSummary: summarizeRecommendationChange(
            payload,
            typeof suggestedExercise === "string" ? suggestedExercise : null
          ),
          decidedAt: recommendation.decidedAt ?? adaptation.appliedAt,
          followupSessions: new Set(
            observedFollowups.map((followup) => followup.sessionId)
          ).size,
          latestSessionId: latest.sessionId,
          latestSessionName: latest.sessionName ?? "Completed workout",
          latestLocalDate: latest.localDate,
          workingSets: observedSets.length,
          measurableSets: measurableSets.length,
          targetsMet: measurableSets.filter((set) => set.targetMet).length,
          rpeCount: rpes.length,
          averageRpe:
            rpes.length > 0
              ? Math.round(
                  (rpes.reduce((total, rpe) => total + rpe, 0) / rpes.length) *
                    10
                ) / 10
              : null,
          painFlags: observedPain.length,
          maxPainSeverity:
            observedPain.length > 0
              ? Math.max(...observedPain.map((pain) => pain.severity))
              : null,
          evidenceLimited:
            measurableSets.length < observedSets.length ||
            rpes.length < observedSets.length,
        },
      ];
    }
  );

  outcomes.sort((left, right) => right.decidedAt.getTime() - left.decidedAt.getTime());
  return {
    pending,
    recent,
    outcomes: outcomes.slice(0, 8),
    acceptedDecisionCount: activeAcceptedDecisionCount,
    outcomeSupportedDecisionCount,
  };
}
