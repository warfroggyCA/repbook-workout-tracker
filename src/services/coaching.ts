import type { Db } from "@/db";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import {
  coachingInsights,
  contextualNotes,
  workoutSessions,
  type CoachingPrefs,
} from "@/db/schema";
import { runControlledStructuredGeneration } from "@/services/ai-control";
import {
  coachingReviewSchema,
  type CoachingReview,
} from "@/ai/tasks/coaching-review/schema";
import { coachingReviewSystemPrompt } from "@/ai/tasks/coaching-review/prompt";
import {
  coachingAnswerSchema,
  type CoachingAnswer,
} from "@/ai/tasks/coaching-qa/schema";
import { coachingQaSystemPrompt } from "@/ai/tasks/coaching-qa/prompt";
import { buildTrainingDigest } from "@/services/digest";
import { TEST_DATA_PREFIX } from "@/services/workout-test-data";
import { TRAINING_CADENCE_ALGORITHM_VERSION } from "@/lib/training-cadence";
import { PRESCRIPTION_OUTCOME_ALGORITHM_VERSION } from "@/lib/set-metric-semantics";

const COACHING_WINDOW_DAYS = 84;

export type CoachingContext = Awaited<ReturnType<typeof buildCoachingContext>>;

export async function buildCoachingContext(
  db: Db,
  userId: string,
  coachingPreferences: CoachingPrefs,
  now = new Date()
) {
  const since = new Date(
    now.getTime() - COACHING_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const [trainingDigest, visibleContextualNotes] = await Promise.all([
    buildTrainingDigest(db, userId, since, now),
    db
      .select({
        id: contextualNotes.id,
        body: contextualNotes.body,
        attachmentKind: contextualNotes.attachmentKind,
        sessionId: contextualNotes.sessionId,
        sessionExerciseId: contextualNotes.sessionExerciseId,
        occurrenceId: contextualNotes.occurrenceId,
        completedSetId: contextualNotes.completedSetId,
        programId: contextualNotes.programId,
        programVersionId: contextualNotes.programVersionId,
        workoutTemplateId: contextualNotes.workoutTemplateId,
        workoutTemplateExerciseId: contextualNotes.workoutTemplateExerciseId,
        capturedContext: contextualNotes.capturedContext,
        recordedAt: contextualNotes.recordedAt,
      })
      .from(contextualNotes)
      .leftJoin(workoutSessions, eq(contextualNotes.sessionId, workoutSessions.id))
      .where(and(
        eq(contextualNotes.userId, userId),
        eq(contextualNotes.coachVisible, true),
        isNull(contextualNotes.archivedAt),
        or(isNull(contextualNotes.sessionId), isNull(workoutSessions.archivedAt)),
        gte(contextualNotes.recordedAt, since),
        lte(contextualNotes.recordedAt, now),
      ))
      .orderBy(desc(contextualNotes.recordedAt), desc(contextualNotes.id))
      .limit(40),
  ]);
  const sampleSessions = trainingDigest.sessions.filter((session) =>
    session.template?.startsWith(TEST_DATA_PREFIX)
  );

  return {
    generatedAt: now.toISOString(),
    windowDays: COACHING_WINDOW_DAYS,
    coachingPreferences,
    sampleData: {
      included: sampleSessions.length > 0,
      sessionCount: sampleSessions.length,
      realSessionCount: trainingDigest.sessions.length - sampleSessions.length,
      rule:
        "Sample sessions are a labelled demonstration only. Never treat them as the user's real performance or use them to change the real program.",
    },
    trainingDigest,
    contextualNotes: visibleContextualNotes.map((note) => ({
      ...note,
      body: note.body.slice(0, 1_000),
      semantics: "User observation; not an objective diagnosis.",
    })),
  };
}

export async function createTrainingReview(
  db: Db,
  userId: string,
  coachingPreferences: CoachingPrefs
) {
  const context = await buildCoachingContext(
    db,
    userId,
    coachingPreferences
  );
  const result = await runControlledStructuredGeneration(db, userId, {
    task: "weekly_review",
    system: coachingReviewSystemPrompt,
    input: JSON.stringify(context),
    schema: coachingReviewSchema,
  });
  const [insight] = await db
    .insert(coachingInsights)
    .values({
      userId,
      kind: "manual_review",
      contentMd: JSON.stringify(result.value),
      dataDigest: {
        generatedAt: context.generatedAt,
        windowDays: context.windowDays,
        sampleData: context.sampleData,
        completedSessions: context.trainingDigest.sessions.length,
        cadenceAlgorithmVersion: TRAINING_CADENCE_ALGORITHM_VERSION,
        prescriptionOutcomeAlgorithmVersion:
          PRESCRIPTION_OUTCOME_ALGORITHM_VERSION,
      },
      model: result.model,
    })
    .returning();

  return { insight, review: result.value, context };
}

export async function createCoachingAnswer(
  db: Db,
  userId: string,
  coachingPreferences: CoachingPrefs,
  question: string
) {
  const context = await buildCoachingContext(
    db,
    userId,
    coachingPreferences
  );
  const modelInput = { question, context };
  const result = await runControlledStructuredGeneration(db, userId, {
    task: "coaching_qa",
    system: coachingQaSystemPrompt,
    input: JSON.stringify(modelInput),
    schema: coachingAnswerSchema,
  });
  const [insight] = await db
    .insert(coachingInsights)
    .values({
      userId,
      kind: "qa",
      contentMd: JSON.stringify(result.value),
      dataDigest: {
        question,
        generatedAt: context.generatedAt,
        windowDays: context.windowDays,
        cadenceAlgorithmVersion: TRAINING_CADENCE_ALGORITHM_VERSION,
        prescriptionOutcomeAlgorithmVersion:
          PRESCRIPTION_OUTCOME_ALGORITHM_VERSION,
      },
      model: result.model,
    })
    .returning();

  return { insight, answer: result.value, context };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseStoredCoachingReview(
  content: string
): CoachingReview | null {
  const parsed = coachingReviewSchema.safeParse(parseJson(content));
  return parsed.success ? parsed.data : null;
}

export function parseStoredCoachingAnswer(
  content: string
): CoachingAnswer | null {
  const parsed = coachingAnswerSchema.safeParse(parseJson(content));
  return parsed.success ? parsed.data : null;
}

export function questionFromInsightDigest(digest: unknown): string | null {
  if (
    typeof digest !== "object" ||
    digest === null ||
    !("question" in digest) ||
    typeof digest.question !== "string"
  ) {
    return null;
  }
  return digest.question;
}
