import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import type { Db } from "@/db";
import { camelRow, databaseConstraint, resultRows } from "@/db/result";
import {
  coachingInsights,
  completedSets,
  contextualNotes,
  constraints,
  equipmentItems,
  plateInventory,
  exercises,
  painLogs,
  sessionExercises,
  sessionNotes,
  sessionOccurrences,
  workoutSessions,
  type CoachingPrefs,
} from "@/db/schema";
import {
  AIUnavailableError,
  getAIProvider,
  type AIUsage,
} from "@/ai/provider";
import {
  coachingAnswerSchema,
  type CoachingAnswer,
} from "@/ai/tasks/coaching-qa/schema";
import { liveCoachingSystemPrompt } from "@/ai/tasks/live-coaching/prompt";
import { buildCoachingContext } from "@/services/coaching";
import {
  buildEquipmentAvailability,
  exerciseIsAvailable,
} from "@/engine/equipment-filter";
import { isPatternAllowedForSuggestions } from "@/engine/constraint-filter";
import { sortConversationMessages } from "@/lib/live-coach-order";
import {
  workingSetDisplayPosition,
  workingSetSemanticRole,
} from "@/lib/session-occurrences";
import {
  claimLiveCoachGeneration,
  estimateAICostMicrousd,
  type AIUsageClaim,
} from "@/services/ai-control";
import {
  classifyPrescriptionOutcome,
  classifySetMetricContainment,
  type SetMetricContainmentInput,
} from "@/lib/set-metric-semantics";

export type LiveCoachMessageKind = "question" | "observation";
export type LiveCoachInputMode = "text" | "dictation" | "realtime_voice";
export type LiveCoachResponseStatus = "saved" | "pending" | "completed" | "failed";

export function liveCoachSetEvidenceEligible(
  input: SetMetricContainmentInput,
): boolean {
  const containment = classifySetMetricContainment(input);
  return containment.measurementMeaning === "reps"
    ? containment.prescriptionOutcomeEligible
    : containment.automaticProgressionEligible;
}

export type LiveCoachMessage = {
  id: string;
  sessionId: string;
  sessionExerciseId: string | null;
  completedSetId: string | null;
  replyToId: string | null;
  author: "user" | "assistant";
  messageKind: "question" | "observation" | "answer";
  inputMode: LiveCoachInputMode;
  responseStatus: LiveCoachResponseStatus;
  content: string;
  answer: CoachingAnswer | null;
  model: string | null;
  failureReason: string | null;
  createdAtISO: string;
  completedAtISO: string | null;
};

export type StartLiveCoachTurnInput = {
  sessionId: string;
  sessionExerciseId?: string | null;
  completedSetId?: string | null;
  messageKind: LiveCoachMessageKind;
  inputMode: LiveCoachInputMode;
  content: string;
  clientKey: string;
};

export type StartLiveCoachTurnResult = {
  userMessage: LiveCoachMessage;
  pendingResponse: LiveCoachMessage | null;
};

type InsightRow = typeof coachingInsights.$inferSelect;

const uuidSchema = z.uuid();
const nullableUuidSchema = uuidSchema.nullable();
const nullableStringSchema = z.string().nullable();
const dateSchema = z.preprocess(
  (value) => {
    if (value instanceof Date) return value;
    if (typeof value !== "string") return value;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  },
  z.date()
);

const liveCoachInsightRowObjectSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  kind: z.string(),
  contentMd: z.string(),
  dataDigest: z.json(),
  model: nullableStringSchema,
  sessionId: nullableUuidSchema,
  sessionExerciseId: nullableUuidSchema,
  completedSetId: nullableUuidSchema,
  replyToId: nullableUuidSchema,
  author: z.enum(["user", "assistant"]).nullable(),
  messageKind: z.enum(["question", "observation", "answer"]).nullable(),
  inputMode: z.enum(["text", "dictation", "realtime_voice"]).nullable(),
  responseStatus: z
    .enum(["saved", "pending", "generating", "completed", "failed"])
    .nullable(),
  clientKey: nullableStringSchema,
  failureReason: nullableStringSchema,
  providerItemId: nullableStringSchema,
  generationLeaseId: nullableUuidSchema,
  generationLeaseExpiresAt: dateSchema.nullable(),
  generationStartedAt: dateSchema.nullable(),
  completedAt: dateSchema.nullable(),
  createdAt: dateSchema,
  archivedAt: dateSchema.nullable(),
  archiveOperationId: nullableUuidSchema,
});

// Drizzle returns camelCase keys while raw SQL returns snake_case keys. Keep
// both drivers behind this one canonical validation boundary.
const liveCoachInsightRowSchema = z.preprocess((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return camelRow(value as Record<string, unknown>);
}, liveCoachInsightRowObjectSchema);

function inputRowKeys(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

/**
 * Validates the complete database-row contract before Live Coach uses it.
 * Error details intentionally disclose field names only, never stored values.
 */
export function parseLiveCoachInsightRow(value: unknown): InsightRow {
  const keys = inputRowKeys(value);
  const invalidRowMessage = `Stored Live Coach row is invalid. Keys: ${
    keys.length > 0 ? keys.join(", ") : "[none]"
  }.`;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(invalidRowMessage);
  }

  const parsed = liveCoachInsightRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(invalidRowMessage);
  }
  return parsed.data;
}

function parseAnswer(row: InsightRow): CoachingAnswer | null {
  if (row.kind !== "live_assistant" || row.responseStatus !== "completed") {
    return null;
  }
  try {
    const parsed = coachingAnswerSchema.safeParse(JSON.parse(row.contentMd));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function toLiveCoachMessage(value: unknown): LiveCoachMessage {
  const row = parseLiveCoachInsightRow(value);
  if (
    !row.sessionId ||
    (row.kind !== "live_user" && row.kind !== "live_assistant") ||
    (row.author !== "user" && row.author !== "assistant") ||
    (row.messageKind !== "question" &&
      row.messageKind !== "observation" &&
      row.messageKind !== "answer") ||
    (row.inputMode !== "text" &&
      row.inputMode !== "dictation" &&
      row.inputMode !== "realtime_voice") ||
    (row.responseStatus !== "saved" &&
      row.responseStatus !== "pending" &&
      row.responseStatus !== "generating" &&
      row.responseStatus !== "completed" &&
      row.responseStatus !== "failed")
  ) {
    throw new Error("Stored Live Coach message is incomplete.");
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    sessionExerciseId: row.sessionExerciseId,
    completedSetId: row.completedSetId,
    replyToId: row.replyToId,
    author: row.author,
    messageKind: row.messageKind,
    inputMode: row.inputMode,
    responseStatus:
      row.responseStatus === "generating" ? "pending" : row.responseStatus,
    content: row.kind === "live_user" ? row.contentMd : "",
    answer: parseAnswer(row),
    model: row.model,
    failureReason: row.failureReason,
    createdAtISO: row.createdAt.toISOString(),
    completedAtISO: row.completedAt?.toISOString() ?? null,
  };
}

export async function listLiveCoachMessages(
  db: Db,
  userId: string,
  sessionId: string
): Promise<LiveCoachMessage[]> {
  const rows = await db.query.coachingInsights.findMany({
    where: and(
      eq(coachingInsights.userId, userId),
      eq(coachingInsights.sessionId, sessionId),
      inArray(coachingInsights.kind, ["live_user", "live_assistant"]),
      isNull(coachingInsights.archivedAt)
    ),
    orderBy: [asc(coachingInsights.createdAt), asc(coachingInsights.id)],
  });
  return sortConversationMessages(rows.map(toLiveCoachMessage));
}

export async function getLiveCoachResponse(
  db: Db,
  userId: string,
  responseId: string
): Promise<LiveCoachMessage | null> {
  const row = await db.query.coachingInsights.findFirst({
    where: and(
      eq(coachingInsights.id, responseId),
      eq(coachingInsights.userId, userId),
      eq(coachingInsights.kind, "live_assistant"),
      isNull(coachingInsights.archivedAt)
    ),
  });
  return row ? toLiveCoachMessage(row) : null;
}

function rowFromSql(row: Record<string, unknown>, prefix: "user" | "response") {
  const value = row[`${prefix}_row`];
  if (value == null) return null;
  return parseLiveCoachInsightRow(value);
}

export async function startLiveCoachTurn(
  db: Db,
  userId: string,
  input: StartLiveCoachTurnInput
): Promise<StartLiveCoachTurnResult> {
  const userMessageId = randomUUID();
  const responseId = randomUUID();
  const responseRequired = input.messageKind === "question";
  const contextRef = JSON.stringify({
    sessionId: input.sessionId,
    sessionExerciseId: input.sessionExerciseId ?? null,
    completedSetId: input.completedSetId ?? null,
    inputMode: input.inputMode,
  });
  const query = sql`
    WITH owned AS (
      SELECT ws.id
      FROM workout_sessions ws
      WHERE ws.id = ${input.sessionId}::uuid
        AND ws.user_id = ${userId}::uuid
        AND ws.archived_at IS NULL
        AND (${input.sessionExerciseId ?? null}::uuid IS NULL OR EXISTS (
          SELECT 1 FROM session_exercises se
          WHERE se.id = ${input.sessionExerciseId ?? null}::uuid
            AND se.session_id = ws.id
        ))
        AND (${input.completedSetId ?? null}::uuid IS NULL OR EXISTS (
          SELECT 1 FROM completed_sets cs
          JOIN session_exercises se ON se.id = cs.session_exercise_id
          WHERE cs.id = ${input.completedSetId ?? null}::uuid
            AND se.session_id = ws.id
            AND cs.archived_at IS NULL
        ))
    ), inserted_user AS (
      INSERT INTO coaching_insights (
        id, user_id, kind, content_md, data_digest, session_id,
        session_exercise_id, completed_set_id, author, message_kind,
        input_mode, response_status, client_key
      )
      SELECT
        ${userMessageId}::uuid, ${userId}::uuid, 'live_user', ${input.content},
        ${contextRef}::jsonb, owned.id, ${input.sessionExerciseId ?? null}::uuid,
        ${input.completedSetId ?? null}::uuid, 'user', ${input.messageKind},
        ${input.inputMode}, 'saved', ${input.clientKey}
      FROM owned
      ON CONFLICT (user_id, client_key)
        WHERE kind = 'live_user' AND client_key IS NOT NULL
      DO NOTHING
      RETURNING *
    ), selected_user AS (
      SELECT * FROM inserted_user
      UNION ALL
      SELECT ci.* FROM coaching_insights ci
      WHERE ci.user_id = ${userId}::uuid
        AND ci.kind = 'live_user'
        AND ci.client_key = ${input.clientKey}
        AND ci.session_id = ${input.sessionId}::uuid
        AND ci.session_exercise_id IS NOT DISTINCT FROM ${input.sessionExerciseId ?? null}::uuid
        AND ci.completed_set_id IS NOT DISTINCT FROM ${input.completedSetId ?? null}::uuid
        AND ci.message_kind = ${input.messageKind}
        AND ci.input_mode = ${input.inputMode}
        AND ci.content_md = ${input.content}
        AND NOT EXISTS (SELECT 1 FROM inserted_user)
      LIMIT 1
    ), inserted_response AS (
      INSERT INTO coaching_insights (
        id, user_id, kind, content_md, data_digest, session_id,
        session_exercise_id, completed_set_id, reply_to_id, author,
        message_kind, input_mode, response_status
      )
      SELECT
        ${responseId}::uuid, ${userId}::uuid, 'live_assistant', '',
        ${contextRef}::jsonb, u.session_id, u.session_exercise_id,
        u.completed_set_id, u.id, 'assistant', 'answer', u.input_mode, 'pending'
      FROM selected_user u
      WHERE ${responseRequired}::boolean
        AND u.message_kind = 'question'
        AND NOT EXISTS (
          SELECT 1 FROM coaching_insights existing
          WHERE existing.reply_to_id = u.id
            AND existing.kind = 'live_assistant'
            AND existing.response_status IN ('pending', 'generating', 'completed')
        )
      ON CONFLICT DO NOTHING
      RETURNING *
    ), selected_response AS (
      SELECT * FROM inserted_response
      UNION ALL
      SELECT ci.* FROM coaching_insights ci
      JOIN selected_user u ON u.id = ci.reply_to_id
      WHERE ci.kind = 'live_assistant'
        AND ci.response_status IN ('pending', 'generating', 'completed')
        AND NOT EXISTS (SELECT 1 FROM inserted_response)
      ORDER BY created_at DESC
      LIMIT 1
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'live_coach.message.create',
        'coaching_insight', u.id::text,
        CASE u.message_kind
          WHEN 'observation' THEN 'Saved a workout observation for Live Coach'
          ELSE 'Saved a workout question before asking Live Coach'
        END,
        jsonb_build_object(
          'sessionId', u.session_id,
          'sessionExerciseId', u.session_exercise_id,
          'inputMode', u.input_mode
        )
      FROM inserted_user u
      RETURNING id
    )
    SELECT
      to_jsonb(u) AS user_row,
      (SELECT to_jsonb(r) FROM selected_response r LIMIT 1) AS response_row
    FROM selected_user u
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) {
    throw new Error(
      "The workout message could not be reconciled with this saved identity."
    );
  }
  const userRow = rowFromSql(row, "user");
  const responseRow = rowFromSql(row, "response");
  if (!userRow) throw new Error("Live Coach could not save the message.");
  return {
    userMessage: toLiveCoachMessage(userRow),
    pendingResponse: responseRow ? toLiveCoachMessage(responseRow) : null,
  };
}

async function approvedSubstitutions(
  db: Db,
  userId: string,
  selectedExerciseId: string | null,
  enabled: boolean
) {
  if (!selectedExerciseId || !enabled) return [];
  const current = await db.query.exercises.findFirst({
    where: eq(exercises.id, selectedExerciseId),
  });
  if (!current) return [];
  const [candidates, equipmentRows, plateRows, userConstraints] = await Promise.all([
    db.query.exercises.findMany({
      where: eq(exercises.movementPattern, current.movementPattern),
      with: { equipmentRequirements: true },
      orderBy: asc(exercises.name),
    }),
    db.query.equipmentItems.findMany({ where: eq(equipmentItems.userId, userId) }),
    db.query.plateInventory.findMany({
      where: eq(plateInventory.userId, userId),
      columns: { denomination: true },
    }),
    db.query.constraints.findMany({ where: eq(constraints.userId, userId) }),
  ]);
  const inventory = buildEquipmentAvailability(equipmentRows, plateRows);
  return candidates
    .filter(
      (candidate) =>
        candidate.id !== current.id &&
        (candidate.userId == null || candidate.userId === userId) &&
        exerciseIsAvailable(candidate.equipmentRequirements, inventory) &&
        isPatternAllowedForSuggestions(candidate.movementPattern, userConstraints)
    )
    .slice(0, 12)
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      loadType: candidate.loadType,
    }));
}

function boundedText(value: string | null, maxLength = 1_000) {
  if (value == null) return null;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function minimizeRecentTraining(
  context: Awaited<ReturnType<typeof buildCoachingContext>>
) {
  const digest = context.trainingDigest;
  return {
    generatedAt: context.generatedAt,
    windowDays: context.windowDays,
    sampleData: context.sampleData,
    trainingDigest: {
      cadence: digest.cadence,
      targetOutcomes: digest.targetOutcomes,
      trends: digest.trends.slice(-12).map((trend) => ({
        exercise: trend.exercise,
        topSets: trend.topSets.slice(-6),
      })),
      families: digest.families.slice(0, 12),
      pain: digest.pain.slice(-10).map((entry) => ({
        ...entry,
        note: boundedText(entry.note, 500),
      })),
      fatigue: digest.fatigue.slice(-14),
      skips: digest.skips.slice(-10).map((entry) => ({
        ...entry,
        reason: boundedText(entry.reason, 500),
      })),
      substitutions: digest.substitutions.slice(-10).map((entry) => ({
        ...entry,
        reason: boundedText(entry.reason, 500),
      })),
      independentActivities: {
        rule: digest.independentActivities.rule,
        overview: digest.independentActivities.overview,
        measurementCoverage:
          digest.independentActivities.measurementCoverage,
        recent: digest.independentActivities.recent.slice(-7),
      },
      dataGaps: digest.dataGaps.slice(0, 12),
    },
  };
}

export async function buildLiveCoachingContext(
  db: Db,
  userId: string,
  coachingPreferences: CoachingPrefs,
  responseId: string,
  activeRestTimerSeconds: number | null,
  claim?: AIUsageClaim
) {
  const rawResponse = await db.query.coachingInsights.findFirst({
    where: and(
      eq(coachingInsights.id, responseId),
      eq(coachingInsights.userId, userId),
      eq(coachingInsights.kind, "live_assistant"),
      claim
        ? and(
            eq(coachingInsights.responseStatus, "generating"),
            eq(coachingInsights.generationLeaseId, claim.leaseId)
          )
        : eq(coachingInsights.responseStatus, "pending"),
      isNull(coachingInsights.archivedAt)
    ),
  });
  if (!rawResponse) {
    throw new Error("The pending Live Coach response was not found.");
  }
  const response = parseLiveCoachInsightRow(rawResponse);
  if (!response.replyToId || !response.sessionId) {
    throw new Error("The pending Live Coach response was not found.");
  }
  const rawUserMessage = await db.query.coachingInsights.findFirst({
    where: and(
      eq(coachingInsights.id, response.replyToId),
      eq(coachingInsights.userId, userId),
      eq(coachingInsights.kind, "live_user"),
      isNull(coachingInsights.archivedAt)
    ),
  });
  if (!rawUserMessage) {
    throw new Error("The saved workout question was not found.");
  }
  const userMessage = parseLiveCoachInsightRow(rawUserMessage);

  const session = await db.query.workoutSessions.findFirst({
    where: and(
      eq(workoutSessions.id, response.sessionId),
      eq(workoutSessions.userId, userId),
      isNull(workoutSessions.archivedAt)
    ),
    with: {
      exercises: {
        orderBy: sessionExercises.orderIdx,
        with: {
          exercise: true,
          sets: {
            where: isNull(completedSets.archivedAt),
            orderBy: completedSets.setNo,
          },
        },
      },
      painLogs: { where: isNull(painLogs.archivedAt) },
      notes: { where: isNull(sessionNotes.archivedAt) },
      occurrences: { orderBy: sessionOccurrences.sequenceIdx },
    },
  });
  if (!session) throw new Error("The workout is no longer available to Coach.");
  const selected = response.sessionExerciseId
    ? session.exercises.find((exercise) => exercise.id === response.sessionExerciseId)
    : null;
  if (response.sessionExerciseId && !selected) {
    throw new Error("The selected workout exercise is no longer available.");
  }

  const referencedExerciseIds = [
    ...new Set(
      [
        ...session.exercises.map((exercise) => exercise.substitutedForExerciseId),
        ...session.painLogs.map((pain) => pain.exerciseId),
      ]
        .filter((value): value is string => value != null)
    ),
  ];

  const [recentContext, substitutions, safetyConstraints, referencedExercises, visibleContextualNotes] = await Promise.all([
    buildCoachingContext(db, userId, coachingPreferences),
    approvedSubstitutions(
      db,
      userId,
      selected?.exerciseId ?? null,
      coachingPreferences.substitutionSuggestions
    ),
    db.query.constraints.findMany({
      where: eq(constraints.userId, userId),
      orderBy: asc(constraints.bodyPart),
    }),
    referencedExerciseIds.length > 0
      ? db.query.exercises.findMany({
          where: inArray(exercises.id, referencedExerciseIds),
        })
      : Promise.resolve([]),
    db
      .select({
        id: contextualNotes.id,
        body: contextualNotes.body,
        attachmentKind: contextualNotes.attachmentKind,
        sessionExerciseId: contextualNotes.sessionExerciseId,
        occurrenceId: contextualNotes.occurrenceId,
        completedSetId: contextualNotes.completedSetId,
        capturedContext: contextualNotes.capturedContext,
        recordedAt: contextualNotes.recordedAt,
      })
      .from(contextualNotes)
      .where(and(
        eq(contextualNotes.userId, userId),
        eq(contextualNotes.sessionId, session.id),
        eq(contextualNotes.coachVisible, true),
        isNull(contextualNotes.archivedAt),
      ))
      .orderBy(asc(contextualNotes.recordedAt), asc(contextualNotes.id)),
  ]);
  const exerciseNames = new Map(
    [
      ...session.exercises.map((exercise) => exercise.exercise),
      ...referencedExercises,
    ].map((exercise) => [exercise.id, exercise.name])
  );
  const coachExerciseMeaning = (
    exercise: (typeof session.exercises)[number],
  ) => {
    const usesPrescribedMeaning =
      exercise.prescribedSemanticsVersion === 1 &&
      exercise.modificationType !== "substituted" &&
      exercise.modificationType !== "added";
    return {
      usesPrescribedMeaning,
      prescribedSemanticsVersion: usesPrescribedMeaning ? 1 : null,
      name: usesPrescribedMeaning
        ? exercise.prescribedExerciseName!
        : exercise.exercise.name,
      metricType: usesPrescribedMeaning
        ? exercise.prescribedMetricType!
        : exercise.exercise.metricType,
      loadType: usesPrescribedMeaning
        ? exercise.prescribedLoadType!
        : exercise.exercise.loadType,
      loadSemantics: usesPrescribedMeaning
        ? exercise.prescribedLoadSemantics!
        : exercise.exercise.loadSemantics,
    };
  };
  const coachExerciseNamesBySessionExerciseId = new Map(
    session.exercises.map((exercise) => [
      exercise.id,
      coachExerciseMeaning(exercise).name,
    ]),
  );
  const completedWorkingSetIds = new Set(
    session.occurrences
      .filter(
        (occurrence) =>
          occurrence.kind === "working_set" &&
          occurrence.outcome === "completed" &&
          occurrence.completedSetId != null,
      )
      .map((occurrence) => occurrence.completedSetId as string),
  );
  const completedWorkingOccurrencesBySetId = new Map<
    string,
    typeof session.occurrences
  >();
  for (const occurrence of session.occurrences) {
    if (
      occurrence.kind !== "working_set" ||
      occurrence.outcome !== "completed" ||
      occurrence.completedSetId == null
    ) {
      continue;
    }
    const linked =
      completedWorkingOccurrencesBySetId.get(occurrence.completedSetId) ?? [];
    linked.push(occurrence);
    completedWorkingOccurrencesBySetId.set(occurrence.completedSetId, linked);
  }
  const workingSetsFor = (exercise: (typeof session.exercises)[number]) =>
    exercise.sets.filter(
      (set) => !set.isWarmup && completedWorkingSetIds.has(set.id),
    );
  const claimEligibleSetsFor = (
    exercise: (typeof session.exercises)[number],
  ) => {
    const meaning = coachExerciseMeaning(exercise);
    return workingSetsFor(exercise).filter(
      (set) =>
        liveCoachSetEvidenceEligible({
          recordedMetricType: set.metricType,
          prescribedSemanticsVersion: meaning.prescribedSemanticsVersion,
          performedSemanticsVersion: set.performedSemanticsVersion,
          performedLoadType: set.performedLoadType,
          performedLoadSemantics: set.performedLoadSemantics,
          currentExerciseMetricType: meaning.metricType,
          loadType: meaning.loadType,
          loadSemantics: meaning.loadSemantics,
          loadEntryMeaning: set.loadEntryMeaning,
          weight: set.weight,
          reps: set.reps,
          excludeFromAnalytics: set.excludeFromAnalytics,
        }),
    );
  };
  const occurrenceOutcomeLimit = 100;
  const outcomeOccurrences = session.occurrences.filter(
    (occurrence) =>
      occurrence.kind !== "working_set" ||
      occurrence.outcome !== "completed" ||
      occurrence.origin !== "planned",
  );
  const warmupResults = session.exercises
    .flatMap((exercise) => {
      const meaning = coachExerciseMeaning(exercise);
      return exercise.sets
        .filter(
          (set) =>
            set.isWarmup &&
            liveCoachSetEvidenceEligible({
              recordedMetricType: set.metricType,
              prescribedSemanticsVersion: meaning.prescribedSemanticsVersion,
              performedSemanticsVersion: set.performedSemanticsVersion,
              performedLoadType: set.performedLoadType,
              performedLoadSemantics: set.performedLoadSemantics,
              currentExerciseMetricType: meaning.metricType,
              loadType: meaning.loadType,
              loadSemantics: meaning.loadSemantics,
              loadEntryMeaning: set.loadEntryMeaning,
              weight: set.weight,
              reps: set.reps,
              excludeFromAnalytics: set.excludeFromAnalytics,
            }),
        )
        .map((set) => ({ exercise, set }));
    })
    .slice(-20);

  return {
    question: userMessage.contentMd,
    transport: {
      inputMode: userMessage.inputMode,
      rule: "Audio transport may supply a transcript later, but this saved text is the durable user message.",
    },
    liveWorkout: {
      id: session.id,
      name: session.templateName ?? "Workout",
      status: session.status,
      startedAt: session.startedAt,
      elapsedMinutes: Math.max(
        0,
        Math.floor((Date.now() - session.startedAt.getTime()) / 60_000)
      ),
      activeRestTimerSeconds,
      selectedExerciseId: selected?.id ?? null,
      selectedExercise: selected
        ? {
            name: coachExerciseMeaning(selected).name,
            plannedExercise: selected.substitutedForExerciseId
              ? (selected.prescribedExerciseName ??
                exerciseNames.get(selected.substitutedForExerciseId) ??
                null)
              : null,
            substitutionReason: selected.substitutionReason,
            movementPattern: coachExerciseMeaning(selected).usesPrescribedMeaning
              ? "unknown"
              : selected.exercise.movementPattern,
            target: {
              sets: selected.targetSets,
              repsMin: selected.targetRepsMin,
              repsMax: selected.targetRepsMax,
              load: selected.targetLoad,
              loadUnit: selected.targetLoadUnit,
              restSeconds: selected.restSec,
            },
            plannedNotes: boundedText(selected.notes),
            setsLogged: claimEligibleSetsFor(selected).slice(-20).map((set) => {
              const occurrences =
                completedWorkingOccurrencesBySetId.get(set.id) ?? [];
              const plannedOccurrences = occurrences.filter(
                (occurrence) => occurrence.origin === "planned",
              );
              const occurrence = occurrences.length === 1 ? occurrences[0] : null;
              const meaning = coachExerciseMeaning(selected);
              const semantics = classifySetMetricContainment({
                recordedMetricType: set.metricType,
                prescribedSemanticsVersion: meaning.prescribedSemanticsVersion,
                performedSemanticsVersion: set.performedSemanticsVersion,
                performedLoadType: set.performedLoadType,
                performedLoadSemantics: set.performedLoadSemantics,
                currentExerciseMetricType: meaning.metricType,
                loadType: meaning.loadType,
                loadSemantics: meaning.loadSemantics,
                loadEntryMeaning: set.loadEntryMeaning,
                weight: set.weight,
                reps: set.reps,
                excludeFromAnalytics: set.excludeFromAnalytics,
              });
              return {
                id: set.id,
                setNo: set.setNo,
                displayLabel: occurrence
                  ? workingSetDisplayPosition(occurrence, session.occurrences).label
                  : `Recorded set ${set.setNo}`,
                role: occurrence ? workingSetSemanticRole(occurrence) : "legacy",
                weight: set.weight,
                unit: set.weightUnit,
                reps: set.reps,
                rpe: set.rpe,
                note: boundedText(set.note, 500),
                targetOutcome:
                  selected.modificationType !== "as_planned" ||
                  plannedOccurrences.length === 0
                    ? null
                    : occurrence?.origin === "planned"
                    ? classifyPrescriptionOutcome({
                        semantics,
                        reps: set.reps,
                        weight: set.weight,
                        weightUnit: set.weightUnit,
                        targetRepsMin: occurrence.plannedRepsMin,
                        targetRepsMax: occurrence.plannedRepsMax,
                        targetLoad: occurrence.plannedLoad,
                        targetLoadUnit: occurrence.plannedLoadUnit,
                        targetLoadPercent: occurrence.plannedLoadPercent,
                        targetLoadText: occurrence.plannedLoadText,
                      })
                    : "unknown",
              };
            }),
            setsSuppressedFromClaims:
              workingSetsFor(selected).length -
              claimEligibleSetsFor(selected).length,
          }
        : null,
      allExercises: session.exercises.slice(0, 50).map((exercise) => ({
        id: exercise.id,
        name: coachExerciseMeaning(exercise).name,
        plannedExercise: exercise.substitutedForExerciseId
          ? (exercise.prescribedExerciseName ??
            exerciseNames.get(exercise.substitutedForExerciseId) ??
            null)
          : null,
        substitutionReason: exercise.substitutionReason,
        status: exercise.modificationType,
        targetSets: exercise.targetSets,
        setsLogged: workingSetsFor(exercise).length,
        plannedSetsLogged: workingSetsFor(exercise).filter(
          (set) => {
            const occurrences =
              completedWorkingOccurrencesBySetId.get(set.id) ?? [];
            return occurrences.length === 1 && occurrences[0].origin === "planned";
          },
        ).length,
        extraSetsLogged: workingSetsFor(exercise).filter((set) => {
          const occurrences =
            completedWorkingOccurrencesBySetId.get(set.id) ?? [];
          const occurrence = occurrences.length === 1 ? occurrences[0] : null;
          return occurrence ? workingSetSemanticRole(occurrence) === "extra" : false;
        }).length,
      })),
      occurrenceOutcomes: outcomeOccurrences
        .slice(0, occurrenceOutcomeLimit)
        .map((occurrence) => ({
          sequence: occurrence.sequenceIdx + 1,
          kind: occurrence.kind,
          origin: occurrence.origin,
          role: occurrence.kind === "working_set"
            ? workingSetSemanticRole(occurrence)
            : occurrence.origin,
          displayLabel: occurrence.kind === "working_set"
            ? workingSetDisplayPosition(occurrence, session.occurrences).label
            : null,
          exerciseName: occurrence.sessionExerciseId
            ? (coachExerciseNamesBySessionExerciseId.get(
                occurrence.sessionExerciseId,
              ) ?? null)
            : null,
          label: boundedText(occurrence.label, 120),
          outcome: occurrence.outcome,
          reason: boundedText(occurrence.outcomeReason, 160),
          note: boundedText(occurrence.outcomeNote, 500),
        })),
      occurrenceOutcomesTruncated:
        outcomeOccurrences.length > occurrenceOutcomeLimit,
      performedWarmupResults: warmupResults.map(({ exercise, set }) => ({
        exerciseName: coachExerciseMeaning(exercise).name,
        setNo: set.setNo,
        weight: set.weight,
        unit: set.weightUnit,
        reps: set.reps,
        rpe: set.rpe,
        note: boundedText(set.note, 500),
      })),
      painFlags: session.painLogs.slice(-10).map((pain) => ({
        exerciseId: pain.exerciseId,
        exerciseName: pain.exerciseId
          ? (exerciseNames.get(pain.exerciseId) ?? null)
          : null,
        bodyPart: pain.bodyPart,
        severity: pain.severity,
        note: boundedText(pain.note, 500),
      })),
      notes: session.notes.slice(-10).map((note) => boundedText(note.text)),
      contextualNotes: visibleContextualNotes.slice(-20).map((note) => ({
        id: note.id,
        attachmentKind: note.attachmentKind,
        sessionExerciseId: note.sessionExerciseId,
        occurrenceId: note.occurrenceId,
        completedSetId: note.completedSetId,
        body: boundedText(note.body),
        capturedContext: note.capturedContext,
        recordedAt: note.recordedAt,
        semantics: "User observation; not an objective diagnosis.",
      })),
    },
    approvedSubstitutions: substitutions,
    safetyConstraints: safetyConstraints.map((constraint) => ({
      bodyPart: constraint.bodyPart,
      avoid: constraint.avoid,
      cautious: constraint.cautious,
      affectedPatterns: constraint.affectedPatterns,
      painStopThreshold: constraint.painStopThreshold,
      note: boundedText(constraint.note, 500),
    })),
    recentTraining: minimizeRecentTraining(recentContext),
    controlRules: {
      noAutomaticChanges: true,
      substitutionsMustComeFromApprovedList: true,
      painRequiresExistingSafetyThresholds: true,
    },
  };
}

export async function prepareLiveCoachResponseStream(
  db: Db,
  userId: string,
  coachingPreferences: CoachingPrefs,
  responseId: string,
  activeRestTimerSeconds: number | null,
  abortSignal?: AbortSignal,
  existingClaim?: AIUsageClaim,
  networkHash?: string | null
) {
  const claim =
    existingClaim ??
    (await claimLiveCoachGeneration(db, {
      userId,
      responseId,
      networkHash,
    }));
  const context = await buildLiveCoachingContext(
    db,
    userId,
    coachingPreferences,
    responseId,
    activeRestTimerSeconds,
    claim
  );
  const result = await getAIProvider().streamStructured({
    task: "live_coaching",
    system: liveCoachingSystemPrompt,
    input: JSON.stringify(context),
    schema: coachingAnswerSchema,
    abortSignal,
  });
  return { claim, context, ...result };
}

export async function completeLiveCoachResponse(
  db: Db,
  userId: string,
  responseId: string,
  context: Awaited<ReturnType<typeof buildLiveCoachingContext>>,
  answerInput: CoachingAnswer,
  model: string,
  claim?: AIUsageClaim,
  usage?: AIUsage
): Promise<LiveCoachMessage> {
  if (claim && !usage) {
    throw new Error("Live Coach usage is required to finish a claimed response.");
  }
  const answer = coachingAnswerSchema.parse(answerInput);
  const now = new Date();
  const safeUsage = usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const estimatedCost = estimateAICostMicrousd(safeUsage);
  const minimalDigest = {
    schemaVersion: "2",
    generatedAt: now.toISOString(),
    sessionId: context.liveWorkout.id,
    sessionExerciseId: context.liveWorkout.selectedExerciseId,
    modelContextRetained: false,
  };
  const query = sql`
    WITH eligible AS MATERIALIZED (
      SELECT id
      FROM coaching_insights
      WHERE id = ${responseId}::uuid
        AND user_id = ${userId}::uuid
        AND kind = 'live_assistant'
        AND archived_at IS NULL
        AND (
          (${claim == null}::boolean AND response_status = 'pending')
          OR (
            ${claim != null}::boolean
            AND response_status = 'generating'
            AND generation_lease_id = ${claim?.leaseId ?? null}::uuid
          )
        )
      FOR UPDATE
    ), completed_usage AS (
      UPDATE ai_usage_events
      SET status = 'completed',
          model = ${model},
          input_tokens = ${safeUsage.inputTokens},
          output_tokens = ${safeUsage.outputTokens},
          total_tokens = ${safeUsage.totalTokens},
          estimated_cost_microusd = ${estimatedCost},
          failure_code = NULL,
          completed_at = ${now.toISOString()}::timestamptz
      WHERE id = ${claim?.id ?? null}::uuid
        AND lease_id = ${claim?.leaseId ?? null}::uuid
        AND status = 'running'
        AND EXISTS (SELECT 1 FROM eligible)
      RETURNING id
    ), updated AS (
      UPDATE coaching_insights response
      SET content_md = ${JSON.stringify(answer)},
          data_digest = ${JSON.stringify(minimalDigest)}::jsonb,
          model = ${model},
          response_status = 'completed',
          failure_reason = NULL,
          generation_lease_id = NULL,
          generation_lease_expires_at = NULL,
          completed_at = ${now.toISOString()}::timestamptz
      WHERE response.id IN (SELECT id FROM eligible)
        AND (${claim == null}::boolean OR EXISTS (SELECT 1 FROM completed_usage))
      RETURNING response.*
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'ai', 'live_coach.response.complete',
        'coaching_insight', id::text,
        'Answered a saved question during a workout',
        jsonb_build_object(
          'sessionId', session_id,
          'sessionExerciseId', session_exercise_id,
          'replyToId', reply_to_id,
          'model', model,
          'inputTokens', ${safeUsage.inputTokens}::integer,
          'outputTokens', ${safeUsage.outputTokens}::integer,
          'estimatedCostMicrousd', ${estimatedCost}::bigint
        )
      FROM updated
      RETURNING id
    )
    SELECT * FROM updated
  `;
  const raw = resultRows(await db.execute(query))[0];
  const row = raw ? parseLiveCoachInsightRow(raw) : undefined;
  if (!row) {
    const existing = await getLiveCoachResponse(db, userId, responseId);
    if (existing?.responseStatus === "completed") return existing;
    throw new Error("This Live Coach response was already completed or replaced.");
  }
  return toLiveCoachMessage(row);
}

export function liveCoachFailureReason(error: unknown, disconnected = false) {
  if (
    disconnected ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return "The connection closed before Coach could finish. Your original message is saved and can be retried.";
  }
  if (error instanceof AIUnavailableError) {
    return "Live Coach is not configured right now. Your message is saved and can be retried later.";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Live Coach reached its time limit before finishing. Your original message is saved and can be retried.";
  }
  return "Live Coach could not finish that answer. Your original message is saved and can be retried.";
}

export async function markLiveCoachResponseFailed(
  db: Db,
  userId: string,
  responseId: string,
  reason: string,
  claim?: AIUsageClaim,
  failureCode: "failed" | "cancelled" | "timed_out" = "failed"
): Promise<LiveCoachMessage | null> {
  const safeReason = reason.slice(0, 500);
  const query = sql`
    WITH eligible AS MATERIALIZED (
      SELECT id
      FROM coaching_insights
      WHERE id = ${responseId}::uuid
        AND user_id = ${userId}::uuid
        AND kind = 'live_assistant'
        AND archived_at IS NULL
        AND (
          (${claim == null}::boolean AND response_status = 'pending')
          OR (
            ${claim != null}::boolean
            AND response_status = 'generating'
            AND generation_lease_id = ${claim?.leaseId ?? null}::uuid
          )
        )
      FOR UPDATE
    ), failed_usage AS (
      UPDATE ai_usage_events
      SET status = ${failureCode},
          failure_code = ${failureCode},
          completed_at = now()
      WHERE id = ${claim?.id ?? null}::uuid
        AND lease_id = ${claim?.leaseId ?? null}::uuid
        AND status = 'running'
        AND EXISTS (SELECT 1 FROM eligible)
      RETURNING id
    ), updated AS (
      UPDATE coaching_insights response
      SET response_status = 'failed',
          failure_reason = ${safeReason},
          generation_lease_id = NULL,
          generation_lease_expires_at = NULL,
          completed_at = now()
      WHERE response.id IN (SELECT id FROM eligible)
        AND (${claim == null}::boolean OR EXISTS (SELECT 1 FROM failed_usage))
      RETURNING response.*
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'ai', 'live_coach.response.fail',
        'coaching_insight', id::text,
        'Live Coach could not answer; the original workout message was retained',
        jsonb_build_object('sessionId', session_id, 'replyToId', reply_to_id)
      FROM updated
      RETURNING id
    )
    SELECT * FROM updated
  `;
  const raw = resultRows(await db.execute(query))[0];
  const row = raw ? parseLiveCoachInsightRow(raw) : undefined;
  return row ? toLiveCoachMessage(row) : null;
}

export async function createLiveCoachRetry(
  db: Db,
  userId: string,
  userMessageId: string
): Promise<LiveCoachMessage> {
  const responseId = randomUUID();
  const query = sql`
    WITH source AS (
      SELECT ci.*
      FROM coaching_insights ci
      JOIN workout_sessions ws ON ws.id = ci.session_id
      WHERE ci.id = ${userMessageId}::uuid
        AND ci.user_id = ${userId}::uuid
        AND ci.kind = 'live_user'
        AND ci.message_kind = 'question'
        AND ci.archived_at IS NULL
        AND ws.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM coaching_insights active_response
          WHERE active_response.reply_to_id = ci.id
            AND active_response.kind = 'live_assistant'
            AND active_response.response_status IN ('pending', 'generating', 'completed')
        )
    ), inserted AS (
      INSERT INTO coaching_insights (
        id, user_id, kind, content_md, data_digest, session_id,
        session_exercise_id, completed_set_id, reply_to_id, author,
        message_kind, input_mode, response_status
      )
      SELECT
        ${responseId}::uuid, user_id, 'live_assistant', '', data_digest,
        session_id, session_exercise_id, completed_set_id, id,
        'assistant', 'answer', input_mode, 'pending'
      FROM source
      RETURNING *
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'live_coach.response.retry',
        'coaching_insight', id::text,
        'Retried a saved workout question with Live Coach',
        jsonb_build_object(
          'sessionId', session_id,
          'replyToId', reply_to_id
        )
      FROM inserted
      RETURNING id
    )
    SELECT * FROM inserted
  `;
  let raw: Record<string, unknown> | undefined;
  try {
    raw = resultRows(await db.execute(query))[0];
  } catch (error) {
    if (
      databaseConstraint(error) !==
      "coaching_insights_live_pending_reply_uq"
    ) {
      throw error;
    }
  }
  if (raw) return toLiveCoachMessage(parseLiveCoachInsightRow(raw));

  const active = resultRows(
    await db.execute(sql`
      SELECT response.*
      FROM coaching_insights response
      WHERE response.user_id = ${userId}::uuid
        AND response.reply_to_id = ${userMessageId}::uuid
        AND response.kind = 'live_assistant'
        AND response.response_status IN ('pending', 'generating', 'completed')
        AND response.archived_at IS NULL
      ORDER BY response.created_at, response.id
      LIMIT 1
    `)
  )[0];
  if (!active) {
    throw new Error(
      "This workout question already has a pending reply or is unavailable."
    );
  }
  return toLiveCoachMessage(parseLiveCoachInsightRow(active));
}
