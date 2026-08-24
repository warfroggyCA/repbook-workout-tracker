import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/db";
import {
  adaptationEvents,
  coachingInsights,
  completedSets,
  contextualNotes,
  fatigueLogs,
  healthActivities,
  painLogs,
  recommendations,
  sessionExerciseGroups,
  sessionEquipmentSnapshots,
  sessionExercises,
  sessionNotes,
  sessionOccurrences,
  userDecisions,
  users,
  workoutSessions,
} from "@/db/schema";

export const LLM_TRAINING_SOURCE_SCHEMA_VERSION = "llm-training-source/1";

class LlmTrainingSourceEvidenceChangedError extends Error {}

type LlmTrainingSourceBuildOptions = {
  afterStartingEvidenceRead?: (attempt: number) => Promise<void>;
};

function reportRecord(
  value: object,
  extraOmissions: ReadonlySet<string> = new Set(),
) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        key !== "userId" &&
        key !== "archivedAt" &&
        key !== "archiveOperationId" &&
        !extraOmissions.has(key),
    ),
  );
}

async function buildLlmTrainingSourceOnce(
  db: Db,
  userId: string,
  now: Date,
  afterStartingEvidenceRead?: () => Promise<void>,
) {
  const evidenceOwner = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { analysisEvidenceRevision: true },
  });
  if (!evidenceOwner) {
    throw new Error("Owner not found while preparing report source.");
  }
  const startingEvidenceRevision = String(
    evidenceOwner.analysisEvidenceRevision,
  );
  await afterStartingEvidenceRead?.();

  const [sessions, activities, pain, fatigue, recs, notes, liveMessages] =
    await Promise.all([
      db.query.workoutSessions.findMany({
        where: and(
          eq(workoutSessions.userId, userId),
          isNull(workoutSessions.archivedAt),
          inArray(workoutSessions.status, ["completed", "abandoned"]),
          lte(workoutSessions.startedAt, now),
          or(
            isNull(workoutSessions.finishedAt),
            lte(workoutSessions.finishedAt, now),
          ),
        ),
        orderBy: workoutSessions.startedAt,
        with: {
          exercises: {
            orderBy: sessionExercises.orderIdx,
            with: {
              exercise: { with: { family: true } },
              sets: {
                where: isNull(completedSets.archivedAt),
                orderBy: completedSets.setNo,
              },
            },
          },
          occurrences: {
            orderBy: sessionOccurrences.sequenceIdx,
            with: {
              plannedExercise: true,
              groupSnapshot: true,
            },
          },
          notes: {
            where: isNull(sessionNotes.archivedAt),
            orderBy: sessionNotes.createdAt,
          },
        },
      }),
      db.query.healthActivities.findMany({
        where: and(
          eq(healthActivities.userId, userId),
          isNull(healthActivities.archivedAt),
          lte(healthActivities.startedAt, now),
        ),
        orderBy: healthActivities.startedAt,
      }),
      db
        .select({
          id: painLogs.id,
          sessionId: painLogs.sessionId,
          exerciseId: painLogs.exerciseId,
          completedSetId: painLogs.completedSetId,
          bodyPart: painLogs.bodyPart,
          severity: painLogs.severity,
          source: painLogs.source,
          note: painLogs.note,
          createdAt: painLogs.createdAt,
        })
        .from(painLogs)
        .leftJoin(workoutSessions, eq(painLogs.sessionId, workoutSessions.id))
        .where(
          and(
            eq(painLogs.userId, userId),
            isNull(painLogs.archivedAt),
            lte(painLogs.createdAt, now),
            or(isNull(painLogs.sessionId), isNull(workoutSessions.archivedAt)),
          ),
        )
        .orderBy(painLogs.createdAt),
      db
        .select({
          id: fatigueLogs.id,
          sessionId: fatigueLogs.sessionId,
          severity: fatigueLogs.severity,
          note: fatigueLogs.note,
          createdAt: fatigueLogs.createdAt,
        })
        .from(fatigueLogs)
        .leftJoin(workoutSessions, eq(fatigueLogs.sessionId, workoutSessions.id))
        .where(
          and(
            eq(fatigueLogs.userId, userId),
            isNull(fatigueLogs.archivedAt),
            lte(fatigueLogs.createdAt, now),
            or(
              isNull(fatigueLogs.sessionId),
              isNull(workoutSessions.archivedAt),
            ),
          ),
        )
        .orderBy(fatigueLogs.createdAt),
      db.query.recommendations.findMany({
        where: and(
          eq(recommendations.userId, userId),
          isNull(recommendations.archivedAt),
          lte(recommendations.createdAt, now),
        ),
        orderBy: recommendations.createdAt,
        with: { exercise: true },
      }),
      db.query.contextualNotes.findMany({
        where: and(
          eq(contextualNotes.userId, userId),
          eq(contextualNotes.coachVisible, true),
          isNull(contextualNotes.archivedAt),
          lte(contextualNotes.recordedAt, now),
        ),
        orderBy: contextualNotes.recordedAt,
      }),
      db
        .select({
          id: coachingInsights.id,
          kind: coachingInsights.kind,
          content: coachingInsights.contentMd,
          dataDigest: coachingInsights.dataDigest,
          sessionId: coachingInsights.sessionId,
          sessionExerciseId: coachingInsights.sessionExerciseId,
          completedSetId: coachingInsights.completedSetId,
          replyToId: coachingInsights.replyToId,
          author: coachingInsights.author,
          messageKind: coachingInsights.messageKind,
          inputMode: coachingInsights.inputMode,
          responseStatus: coachingInsights.responseStatus,
          createdAt: coachingInsights.createdAt,
        })
        .from(coachingInsights)
        .innerJoin(
          workoutSessions,
          eq(coachingInsights.sessionId, workoutSessions.id),
        )
        .where(
          and(
            eq(coachingInsights.userId, userId),
            eq(coachingInsights.kind, "live_user"),
            isNull(coachingInsights.archivedAt),
            isNull(workoutSessions.archivedAt),
            inArray(workoutSessions.status, ["completed", "abandoned"]),
            lte(coachingInsights.createdAt, now),
          ),
        )
        .orderBy(coachingInsights.createdAt),
    ]);

  const sessionIds = sessions.map((session) => session.id);
  const recommendationIds = recs.map((recommendation) => recommendation.id);
  const [equipmentSnapshots, exerciseGroups, decisions, adaptations] =
    await Promise.all([
      sessionIds.length
        ? db.query.sessionEquipmentSnapshots.findMany({
            where: inArray(sessionEquipmentSnapshots.sessionId, sessionIds),
            orderBy: sessionEquipmentSnapshots.createdAt,
          })
        : Promise.resolve([]),
      sessionIds.length
        ? db.query.sessionExerciseGroups.findMany({
            where: inArray(sessionExerciseGroups.sessionId, sessionIds),
            orderBy: sessionExerciseGroups.orderIdx,
          })
        : Promise.resolve([]),
      recommendationIds.length
        ? db.query.userDecisions.findMany({
            where: inArray(userDecisions.recommendationId, recommendationIds),
            orderBy: userDecisions.decidedAt,
          })
        : Promise.resolve([]),
      recommendationIds.length
        ? db.query.adaptationEvents.findMany({
            where: and(
              eq(adaptationEvents.userId, userId),
              inArray(adaptationEvents.recommendationId, recommendationIds),
            ),
            orderBy: adaptationEvents.appliedAt,
          })
        : Promise.resolve([]),
    ]);

  const finalOwner = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { analysisEvidenceRevision: true },
  });
  if (
    !finalOwner ||
    String(finalOwner.analysisEvidenceRevision) !== startingEvidenceRevision
  ) {
    throw new LlmTrainingSourceEvidenceChangedError(
      "Training evidence changed while the report source was being assembled.",
    );
  }

  return {
    schemaVersion: LLM_TRAINING_SOURCE_SCHEMA_VERSION,
    evidenceCutoff: now.toISOString(),
    evidenceRevision: startingEvidenceRevision,
    scope:
      "All non-archived terminal workout evidence and AI-visible training context retained by Repbook at the cutoff. Account identity, archive metadata, private contextual notes, raw assistant/provider material, request/retry keys, worker identifiers, and operational secrets are omitted.",
    supplementalContextBoundary:
      "Session notes and saved user-authored Live Coach messages are retrieval-time context outside the analytical evidence revision.",
    interpretation:
      "Prescribed and performed snapshot fields are the historical source of truth. Current catalog references are included only for traceability and must not reinterpret older records.",
    workoutSessions: sessions.map((session) => {
      const {
        exercises: exerciseRows,
        occurrences: occurrenceRows,
        notes: noteRows,
        ...sessionRow
      } = session;
      return {
        ...reportRecord(sessionRow, new Set([
          "startRequestKey",
          "startRequestHash",
          "compilationAcceptanceKey",
        ])),
        sessionExercises: exerciseRows.map((sessionExercise) => {
          const { sets, exercise, ...sessionExerciseRow } = sessionExercise;
          return {
            ...reportRecord(sessionExerciseRow),
            currentCatalogExerciseReference: {
              id: exercise.id,
              name: exercise.name,
              familyId: exercise.familyId,
              familyName: exercise.family?.name ?? null,
            },
            completedSets: sets.map((set) =>
              reportRecord(set, new Set(["clientKey"])),
            ),
          };
        }),
        sessionOccurrences: occurrenceRows.map((occurrence) => {
          const {
            plannedExercise,
            groupSnapshot,
            ...occurrenceRow
          } = occurrence;
          return {
            ...reportRecord(occurrenceRow),
            currentCatalogPlannedExerciseReference: plannedExercise
              ? { id: plannedExercise.id, name: plannedExercise.name }
              : null,
            groupSnapshot,
          };
        }),
        sessionNotes: noteRows.map((note) => reportRecord(note)),
      };
    }),
    sessionEquipmentSnapshots: equipmentSnapshots.map((snapshot) =>
      reportRecord(snapshot),
    ),
    sessionExerciseGroups: exerciseGroups.map((group) => reportRecord(group)),
    independentActivities: activities.map((activity) =>
      reportRecord(
        activity,
        new Set(["fingerprint", "sourceMetadata", "sourceRecordId"]),
      ),
    ),
    painLogs: pain,
    fatigueLogs: fatigue,
    coachVisibleContextualNotes: notes.map((note) =>
      reportRecord(note, new Set(["clientKey", "creationPayloadHash"])),
    ),
    recommendations: recs.map((recommendation) => {
      const { exercise, ...recommendationRow } = recommendation;
      return {
        ...reportRecord(recommendationRow, new Set(["progressionJobId"])),
        currentCatalogExerciseReference: exercise
          ? { id: exercise.id, name: exercise.name }
          : null,
      };
    }),
    recommendationDecisions: decisions,
    recommendationAdaptations: adaptations.map((event) =>
      reportRecord(event),
    ),
    savedLiveCoachUserMessages: liveMessages,
  };
}

export async function buildLlmTrainingSource(
  db: Db,
  userId: string,
  now = new Date(),
  options: LlmTrainingSourceBuildOptions = {},
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await buildLlmTrainingSourceOnce(
        db,
        userId,
        now,
        () =>
          options.afterStartingEvidenceRead?.(attempt) ?? Promise.resolve(),
      );
    } catch (error) {
      if (!(error instanceof LlmTrainingSourceEvidenceChangedError)) {
        throw error;
      }
    }
  }
  throw new Error(
    "Training evidence changed while the report source was being assembled.",
  );
}
