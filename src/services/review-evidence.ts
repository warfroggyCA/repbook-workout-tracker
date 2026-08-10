import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import {
  completedSets,
  exercises,
  painLogs,
  sessionExercises,
  workoutSessions,
  type RecommendationEvidence,
  type RecommendationPayload,
  type RecommendationReviewEvidence,
  type ReviewDecisionSnapshot,
} from "@/db/schema";
import { parseRecommendationReviewEvidence } from "@/lib/review-evidence";
import { recommendationEvidenceEligibleForAction } from "@/services/recommendation-evidence-eligibility";
import { externalAnalysisRecommendationIsCurrent } from "@/services/external-analysis-review";

export type ReviewEvidenceState =
  | "supported"
  | "contradictory"
  | "unsupported"
  | "stale"
  | "external";

export type ReviewEvidenceLink = {
  id: string;
  kind: "workout" | "set" | "pain";
  label: string;
  href: string;
};

export type ReviewEvidenceAssessment = {
  state: ReviewEvidenceState;
  actionable: boolean;
  explanation: string;
  metadata: RecommendationReviewEvidence | null;
  links: ReviewEvidenceLink[];
};

type ReviewCandidate = {
  id: string;
  insightId?: string | null;
  source: "rule" | "ai";
  ruleId: string | null;
  payload: RecommendationPayload;
  reason: string;
  evidence: RecommendationEvidence;
  exerciseId: string | null;
  sourceSlotLineageId: string | null;
  reviewRevision: number;
  deferRevision: number;
};

function unique(values: string[] | undefined) {
  return [...new Set(values ?? [])];
}

function evidenceHref(
  sessionId: string,
  recommendationId: string,
  hash = "",
) {
  const params = new URLSearchParams({
    range: "12w",
    returnTo: "review",
    recommendationId,
  });
  return `/history/${encodeURIComponent(sessionId)}?${params.toString()}${hash}`;
}

export async function resolveReviewEvidenceBatch<T extends ReviewCandidate>(
  db: Db,
  userId: string,
  candidates: T[],
): Promise<Map<string, ReviewEvidenceAssessment>> {
  const sessionIds = unique(candidates.flatMap((item) => item.evidence.sessionIds ?? []));
  const setIds = unique(candidates.flatMap((item) => item.evidence.setIds ?? []));
  const painIds = unique(candidates.flatMap((item) => item.evidence.painLogIds ?? []));

  const [sessionRows, setRows, painRows] = await Promise.all([
    sessionIds.length === 0
      ? []
      : db
          .select({
            id: workoutSessions.id,
            name: workoutSessions.templateName,
            localDate: workoutSessions.localDate,
          })
          .from(workoutSessions)
          .where(and(
            inArray(workoutSessions.id, sessionIds),
            eq(workoutSessions.userId, userId),
            eq(workoutSessions.status, "completed"),
            isNull(workoutSessions.archivedAt),
          )),
    setIds.length === 0
      ? []
      : db
          .select({
            id: completedSets.id,
            sessionId: sessionExercises.sessionId,
            setNo: completedSets.setNo,
            exerciseName: exercises.name,
          })
          .from(completedSets)
          .innerJoin(sessionExercises, eq(sessionExercises.id, completedSets.sessionExerciseId))
          .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
          .innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
          .where(and(
            inArray(completedSets.id, setIds),
            eq(workoutSessions.userId, userId),
            eq(workoutSessions.status, "completed"),
            isNull(workoutSessions.archivedAt),
            isNull(completedSets.archivedAt),
          )),
    painIds.length === 0
      ? []
      : db
          .select({
            id: painLogs.id,
            sessionId: painLogs.sessionId,
            bodyPart: painLogs.bodyPart,
            severity: painLogs.severity,
          })
          .from(painLogs)
          .innerJoin(workoutSessions, eq(workoutSessions.id, painLogs.sessionId))
          .where(and(
            inArray(painLogs.id, painIds),
            eq(painLogs.userId, userId),
            eq(workoutSessions.userId, userId),
            eq(workoutSessions.status, "completed"),
            isNull(workoutSessions.archivedAt),
            isNull(painLogs.archivedAt),
          )),
  ]);

  const sessions = new Map(sessionRows.map((row) => [row.id, row]));
  const sets = new Map(setRows.map((row) => [row.id, row]));
  const pains = new Map(painRows.map((row) => [row.id, row]));
  const assessments = new Map<string, ReviewEvidenceAssessment>();
  const externalCurrent = new Map(
    await Promise.all(
      candidates.map(async (recommendation) => [
        recommendation.id,
        recommendation.evidence.review?.producer === "external_analysis"
          ? await externalAnalysisRecommendationIsCurrent(db, userId, recommendation)
          : false,
      ] as const),
    ),
  );
  const eligibility = new Map(await Promise.all(candidates.map(async (recommendation) => {
    const expectedSessions = unique(recommendation.evidence.sessionIds);
    const expectedSets = unique(recommendation.evidence.setIds);
    const expectedPains = unique(recommendation.evidence.painLogIds);
    const referencesPresent =
      expectedSessions.every((id) => sessions.has(id)) &&
      expectedSets.every((id) => sets.has(id)) &&
      expectedPains.every((id) => pains.has(id));
    const hasEvidence =
      expectedSessions.length + expectedSets.length + expectedPains.length > 0;
    const parsed = parseRecommendationReviewEvidence(recommendation.evidence);
    const eligible = parsed.success &&
      parsed.data.producer !== "external_analysis" &&
      referencesPresent && hasEvidence
      ? await recommendationEvidenceEligibleForAction(db, userId, recommendation)
      : false;
    return [recommendation.id, eligible] as const;
  })));

  for (const recommendation of candidates) {
    const expectedSessions = unique(recommendation.evidence.sessionIds);
    const expectedSets = unique(recommendation.evidence.setIds);
    const expectedPains = unique(recommendation.evidence.painLogIds);
    const referencesPresent =
      expectedSessions.every((id) => sessions.has(id)) &&
      expectedSets.every((id) => sets.has(id)) &&
      expectedPains.every((id) => pains.has(id));
    const hasEvidence =
      expectedSessions.length + expectedSets.length + expectedPains.length > 0;
    const parsed = parseRecommendationReviewEvidence(recommendation.evidence);
    const baseEligible = eligibility.get(recommendation.id) ?? false;
    const externalEvidenceCount =
      recommendation.evidence.externalAnalysis?.citedEvidenceIds.length ?? 0;
    const isExternal = parsed.success && parsed.data.producer === "external_analysis";

    let state: ReviewEvidenceState;
    let explanation: string;
    if (!referencesPresent) {
      state = "stale";
      explanation = "One or more cited records are no longer current owner-scoped evidence. Refresh or reject this proposal; it cannot be applied.";
    } else if (!parsed.success || (!hasEvidence && (!isExternal || externalEvidenceCount === 0))) {
      state = "unsupported";
      explanation = "This retained proposal lacks the complete versioned evidence contract. Its claim remains visible, but it cannot change the Program.";
    } else if (isExternal && !externalCurrent.get(recommendation.id)) {
      state = "stale";
      explanation = "The imported response, cited evidence, or current Program changed after import. Regenerate the package before accepting this proposal.";
    } else if (isExternal) {
      state = "external";
      explanation = "The response identity, cited owner-scoped records, and current Program still match. Repbook validated the boundary, not the quality of the external advice.";
    } else if (parsed.data.quality === "contradictory") {
      state = "contradictory";
      explanation = "The cited evidence is explicitly contradictory. Review or reject the proposal; it cannot change the Program.";
    } else if (parsed.data.quality === "unsupported") {
      state = "unsupported";
      explanation = "The cited evidence is explicitly unsupported. The proposal remains visible but cannot change the Program.";
    } else if (!baseEligible) {
      state = "stale";
      explanation = "The cited facts or current Program changed after this proposal was created. It cannot be applied without a fresh proposal.";
    } else {
      state = "supported";
      explanation = "The exact cited records remain current and owner-scoped. Approval would affect only a new future Program version.";
    }

    const links: ReviewEvidenceLink[] = [];
    for (const id of expectedSessions) {
      const session = sessions.get(id);
      if (!session) continue;
      links.push({
        id,
        kind: "workout",
        label: `${session.name ?? "Completed workout"} · ${session.localDate}`,
        href: evidenceHref(id, recommendation.id),
      });
    }
    for (const id of expectedSets) {
      const set = sets.get(id);
      if (!set) continue;
      links.push({
        id,
        kind: "set",
        label: `${set.exerciseName} · performed set ${set.setNo}`,
        href: evidenceHref(set.sessionId, recommendation.id, `#performed-set-${id}`),
      });
    }
    for (const id of expectedPains) {
      const pain = pains.get(id);
      if (!pain?.sessionId) continue;
      links.push({
        id,
        kind: "pain",
        label: `Pain: ${pain.bodyPart} ${pain.severity}/10`,
        href: evidenceHref(pain.sessionId, recommendation.id, `#pain-evidence-${id}`),
      });
    }

    assessments.set(recommendation.id, {
      state,
      actionable:
        (state === "supported" || state === "external") &&
        recommendation.payload.kind !== "hold",
      explanation,
      metadata: parsed.success ? parsed.data : null,
      links,
    });
  }
  return assessments;
}

export async function resolveReviewEvidence(
  db: Db,
  userId: string,
  candidate: ReviewCandidate,
) {
  return (await resolveReviewEvidenceBatch(db, userId, [candidate])).get(candidate.id)!;
}

export function buildReviewDecisionSnapshot(
  recommendation: ReviewCandidate,
  assessment: ReviewEvidenceAssessment,
  recordedAt = new Date(),
): ReviewDecisionSnapshot {
  return {
    schemaVersion: "review-decision-v1",
    recommendationId: recommendation.id,
    reviewRevision: recommendation.reviewRevision,
    deferRevision: recommendation.deferRevision,
    recordedAt: recordedAt.toISOString(),
    evidenceState: assessment.state,
    source: recommendation.source,
    ruleId: recommendation.ruleId,
    payload: recommendation.payload,
    reason: recommendation.reason,
    evidence: recommendation.evidence,
  };
}
