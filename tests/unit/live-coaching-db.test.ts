import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import {
  coachingInsights,
  completedSets,
  exercises,
  sessionOccurrences,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import {
  buildLiveCoachingContext,
  completeLiveCoachResponse,
  createLiveCoachRetry,
  getLiveCoachResponse,
  listLiveCoachMessages,
  liveCoachSetEvidenceEligible,
  markLiveCoachResponseFailed,
  startLiveCoachTurn,
  toLiveCoachMessage,
} from "@/services/live-coaching";
import {
  archiveWorkoutRecord,
  getWorkoutArchivePreview,
  restoreArchiveOperation,
} from "@/services/archive";
import { buildTrainingDigest, renderCoachingBrief } from "@/services/digest";
import { buildContextualNotesCsv, buildJsonBackup, buildLiveCoachCsv } from "@/services/export";
import {
  captureUserSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
} from "@/services/snapshot-capture";
import { createContextualNote } from "@/services/contextual-notes";
import { runPrivacyRetention } from "@/services/privacy-retention";
import { buildCoachingContext } from "@/services/coaching";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("Live Coach set evidence containment", () => {
  it("allows repetitions and the barbell golden path but refuses EZ- and trap-bar load advice", () => {
    expect(
      liveCoachSetEvidenceEligible({
        recordedMetricType: "reps",
        currentExerciseMetricType: "reps",
        loadType: "bodyweight",
        loadSemantics: "none",
        loadEntryMeaning: "legacy_unknown",
        weight: null,
        reps: 10,
      }),
    ).toBe(true);
    expect(
      liveCoachSetEvidenceEligible({
        recordedMetricType: "weight_reps",
        currentExerciseMetricType: "weight_reps",
        loadType: "barbell",
        loadSemantics: "total",
        loadEntryMeaning: "total_system",
        weight: 135,
        reps: 8,
      }),
    ).toBe(true);
    for (const loadType of ["ez_bar", "trap_bar"]) {
      expect(
        liveCoachSetEvidenceEligible({
          recordedMetricType: "weight_reps",
          currentExerciseMetricType: "weight_reps",
          loadType,
          loadSemantics: "total",
          loadEntryMeaning: "total_system",
          weight: 75,
          reps: 8,
        }),
      ).toBe(false);
    }
  });
});

function contextualContext(destination: "workout") {
  return {
    schemaVersion: 1 as const,
    destination,
    workflow: "Live Coach fixture",
    workoutPhase: "working" as const,
    originatedFromSimulation: false,
    programDay: null,
    plannedExercise: null,
    performedExercise: null,
    occurrence: null,
    loadRepetitions: null,
    restContext: null,
    reviewContext: null,
  };
}

const LIVE_COACH_ROW_IDS = {
  id: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  replyToId: "00000000-0000-4000-8000-000000000004",
} as const;

const LIVE_COACH_ANSWER = {
  answer: "Keep the load steady and reassess after the next set.",
  evidence: ["The prior set was completed at the planned load."],
  dataGaps: ["Only one completed set is available."],
  safetyNote: null,
};

function camelLiveCoachRow() {
  return {
    id: LIVE_COACH_ROW_IDS.id,
    userId: LIVE_COACH_ROW_IDS.userId,
    kind: "live_assistant",
    contentMd: JSON.stringify(LIVE_COACH_ANSWER),
    dataDigest: { latestSet: 1 },
    model: "test-model",
    sessionId: LIVE_COACH_ROW_IDS.sessionId,
    sessionExerciseId: null,
    completedSetId: null,
    replyToId: LIVE_COACH_ROW_IDS.replyToId,
    author: "assistant",
    messageKind: "answer",
    inputMode: "text",
    responseStatus: "completed",
    clientKey: null,
    failureReason: null,
    providerItemId: "provider-item-1",
    generationLeaseId: null,
    generationLeaseExpiresAt: null,
    generationStartedAt: new Date("2026-07-15T11:59:00.000Z"),
    completedAt: new Date("2026-07-15T12:00:30.000Z"),
    createdAt: new Date("2026-07-15T12:00:00.000Z"),
    archivedAt: null,
    archiveOperationId: null,
  };
}

function snakeLiveCoachRow() {
  const row = camelLiveCoachRow();
  return {
    id: row.id,
    user_id: row.userId,
    kind: row.kind,
    content_md: row.contentMd,
    data_digest: row.dataDigest,
    model: row.model,
    session_id: row.sessionId,
    session_exercise_id: row.sessionExerciseId,
    completed_set_id: row.completedSetId,
    reply_to_id: row.replyToId,
    author: row.author,
    message_kind: row.messageKind,
    input_mode: row.inputMode,
    response_status: row.responseStatus,
    client_key: row.clientKey,
    failure_reason: row.failureReason,
    provider_item_id: row.providerItemId,
    generation_lease_id: row.generationLeaseId,
    generation_lease_expires_at: row.generationLeaseExpiresAt,
    generation_started_at: row.generationStartedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    archived_at: row.archivedAt,
    archive_operation_id: row.archiveOperationId,
  };
}

describe("Live Coach driver row validation", () => {
  it("maps complete snake-case SQL and camel-case Drizzle rows identically", () => {
    const expected = {
      id: LIVE_COACH_ROW_IDS.id,
      sessionId: LIVE_COACH_ROW_IDS.sessionId,
      sessionExerciseId: null,
      completedSetId: null,
      replyToId: LIVE_COACH_ROW_IDS.replyToId,
      author: "assistant",
      messageKind: "answer",
      inputMode: "text",
      responseStatus: "completed",
      content: "",
      answer: LIVE_COACH_ANSWER,
      model: "test-model",
      failureReason: null,
      createdAtISO: "2026-07-15T12:00:00.000Z",
      completedAtISO: "2026-07-15T12:00:30.000Z",
    };

    expect(toLiveCoachMessage(camelLiveCoachRow())).toEqual(expected);
    expect(toLiveCoachMessage(snakeLiveCoachRow())).toEqual(expected);
  });

  it.each([
    ["missing id", (row: Record<string, unknown>) => delete row.id],
    ["malformed id", (row: Record<string, unknown>) => (row.id = "not-a-uuid")],
    [
      "missing nullable date",
      (row: Record<string, unknown>) => delete row.generationLeaseExpiresAt,
    ],
    [
      "invalid required date",
      (row: Record<string, unknown>) => (row.createdAt = "not-a-date"),
    ],
    [
      "invalid nullable date",
      (row: Record<string, unknown>) => (row.completedAt = "not-a-date"),
    ],
    [
      "malformed nullable uuid",
      (row: Record<string, unknown>) => (row.replyToId = "not-a-uuid"),
    ],
    [
      "invalid author",
      (row: Record<string, unknown>) => (row.author = "system"),
    ],
    [
      "invalid message kind",
      (row: Record<string, unknown>) => (row.messageKind = "status"),
    ],
    [
      "invalid input mode",
      (row: Record<string, unknown>) => (row.inputMode = "voice_note"),
    ],
    [
      "invalid response status",
      (row: Record<string, unknown>) => (row.responseStatus = "queued"),
    ],
  ])("rejects a %s", (_label, mutate) => {
    const row: Record<string, unknown> = camelLiveCoachRow();
    mutate(row);
    expect(() => toLiveCoachMessage(row)).toThrow();
  });

  it("reports only the exact sorted input key set when validation fails", () => {
    const row: Record<string, unknown> = camelLiveCoachRow();
    row.id = "secret-invalid-id";
    row.contentMd = "secret workout content";
    row.dataDigest = { secret: "secret digest" };
    row.model = "secret model";
    row.createdAt = "secret invalid date";
    const expectedKeys = Object.keys(row).sort().join(", ");

    let message = "";
    try {
      toLiveCoachMessage(row);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      `Stored Live Coach row is invalid. Keys: ${expectedKeys}.`
    );
    expect(message).not.toContain("secret-invalid-id");
    expect(message).not.toContain("secret workout content");
    expect(message).not.toContain("secret digest");
    expect(message).not.toContain("secret model");
    expect(message).not.toContain("secret invalid date");
  });

  it("accepts unknown additive columns without exposing them", () => {
    const row = { ...camelLiveCoachRow(), future_driver_column: "ignored" };
    expect(toLiveCoachMessage(row)).toMatchObject({
      id: LIVE_COACH_ROW_IDS.id,
      answer: LIVE_COACH_ANSWER,
    });
  });

  it("preserves generating and malformed completed-answer behavior", () => {
    expect(
      toLiveCoachMessage({
        ...camelLiveCoachRow(),
        responseStatus: "generating",
      }).responseStatus
    ).toBe("pending");
    expect(
      toLiveCoachMessage({
        ...camelLiveCoachRow(),
        contentMd: "not json",
      }).answer
    ).toBeNull();
  });

  it("validates context-query rows before using their values", async () => {
    const malformedResponse: Record<string, unknown> = camelLiveCoachRow();
    malformedResponse.id = "not-a-uuid";
    const findFirst = vi.fn().mockResolvedValue(malformedResponse);
    const fakeDb = {
      query: { coachingInsights: { findFirst } },
    } as unknown as Db;
    const expectedKeys = Object.keys(malformedResponse).sort().join(", ");

    await expect(
      buildLiveCoachingContext(
        fakeDb,
        LIVE_COACH_ROW_IDS.userId,
        {
          aggressiveness: "conservative",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: false,
        },
        LIVE_COACH_ROW_IDS.id,
        null
      )
    ).rejects.toThrow(
      `Stored Live Coach row is invalid. Keys: ${expectedKeys}.`
    );
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("does not hide a malformed nested SQL row", async () => {
    const fakeDb = {
      execute: vi.fn().mockResolvedValue([{ user_row: [] }]),
    } as unknown as Db;

    await expect(
      startLiveCoachTurn(fakeDb, LIVE_COACH_ROW_IDS.userId, {
        sessionId: LIVE_COACH_ROW_IDS.sessionId,
        messageKind: "observation",
        inputMode: "text",
        content: "The set felt controlled.",
        clientKey: "driver-row-validation",
      })
    ).rejects.toThrow("Stored Live Coach row is invalid. Keys: [none].");
  });
});

describe("Live Coach durable workout conversation", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let sessionId: string;
  let sessionExerciseId: string;
  let exerciseId: string;
  let equipmentSnapshotId: string;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `live-coach-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values({ userId });
    const [exercise] = await db
      .insert(exercises)
      .values({
        name: `Live Coach Squat ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        secondaryMuscles: ["glutes"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id, name: exercises.name });
    exerciseId = exercise.id;
    [{ id: sessionId }] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Live Coach workout",
        status: "in_progress",
        startedAt: new Date("2026-07-11T18:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-11",
      })
      .returning({ id: workoutSessions.id });
    [{ id: sessionExerciseId }] = await db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId: exercise.id,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: exercise.name,
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        orderIdx: 0,
        targetSets: 3,
        targetRepsMin: 5,
        targetRepsMax: 8,
        targetLoad: 135,
        targetLoadUnit: "lb",
        restSec: 120,
      })
      .returning({ id: sessionExercises.id });
    equipmentSnapshotId = await createTotalSystemTestSnapshot(db, {
      userId,
      sessionId,
      sessionExerciseId,
      unit: "lb",
    });
    const [completedSet] = await db.insert(completedSets).values({
      sessionExerciseId,
      setNo: 1,
      weight: 135,
      weightUnit: "lb",
      reps: 7,
      rpe: 8,
      targetMet: true,
      metricType: "weight_reps",
      performedSemanticsVersion: 1,
      performedLoadType: "barbell",
      performedLoadSemantics: "total",
      equipmentSnapshotId,
      loadEntryMeaning: "total_system",
    }).returning({ id: completedSets.id });
    await db.insert(sessionOccurrences).values({
      sessionId,
      sessionExerciseId,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      revision: 1,
      resolvedAt: new Date("2026-07-11T18:05:00.000Z"),
      completedSetId: completedSet.id,
      equipmentSnapshotId,
    });
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("uses frozen prescribed meaning and suppresses unknown legacy evidence", async () => {
    const [{ id: isolatedUserId }] = await db
      .insert(users)
      .values({ email: `live-coach-t06-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values({ userId: isolatedUserId });
    const [frozenExercise, legacyExercise] = await db
      .insert(exercises)
      .values([
        {
          name: "Catalog press before mutation",
          movementPattern: "horizontal_push" as const,
          primaryMuscles: ["chest"],
          secondaryMuscles: ["triceps"],
          metricType: "weight_reps" as const,
          loadType: "barbell",
          loadSemantics: "total" as const,
        },
        {
          name: "Mutable legacy row",
          movementPattern: "horizontal_push" as const,
          primaryMuscles: ["chest"],
          secondaryMuscles: ["triceps"],
          metricType: "weight_reps" as const,
          loadType: "barbell",
          loadSemantics: "total" as const,
        },
      ])
      .returning({ id: exercises.id });
    const [{ id: isolatedSessionId }] = await db
      .insert(workoutSessions)
      .values({
        userId: isolatedUserId,
        templateName: "T06 Live Coach containment",
        status: "in_progress",
        startedAt: new Date("2026-07-12T18:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-12",
      })
      .returning({ id: workoutSessions.id });
    const [frozenSessionExercise, legacySessionExercise] = await db
      .insert(sessionExercises)
      .values([
        {
          sessionId: isolatedSessionId,
          exerciseId: frozenExercise.id,
          prescribedSemanticsVersion: 1,
          prescribedExerciseName: "Frozen prescribed press",
          prescribedMetricType: "weight_reps" as const,
          prescribedLoadType: "barbell",
          prescribedLoadSemantics: "total" as const,
          orderIdx: 0,
          targetSets: 1,
          targetRepsMin: 5,
          targetRepsMax: 8,
          targetLoad: 135,
          targetLoadUnit: "lb" as const,
        },
        {
          sessionId: isolatedSessionId,
          exerciseId: legacyExercise.id,
          orderIdx: 1,
          targetSets: 1,
          targetRepsMin: 5,
          targetRepsMax: 8,
          targetLoad: 95,
          targetLoadUnit: "lb" as const,
        },
      ])
      .returning({ id: sessionExercises.id });
    const frozenEquipmentSnapshotId = await createTotalSystemTestSnapshot(db, {
      userId: isolatedUserId,
      sessionId: isolatedSessionId,
      sessionExerciseId: frozenSessionExercise.id,
      unit: "lb",
    });
    const legacyEquipmentSnapshotId = await createTotalSystemTestSnapshot(db, {
      userId: isolatedUserId,
      sessionId: isolatedSessionId,
      sessionExerciseId: legacySessionExercise.id,
      unit: "lb",
    });
    const [frozenSet, legacySet] = await db
      .insert(completedSets)
      .values([
        {
          sessionExerciseId: frozenSessionExercise.id,
          setNo: 1,
          weight: 135,
          weightUnit: "lb" as const,
          reps: 6,
          targetMet: true,
          metricType: "weight_reps" as const,
          equipmentSnapshotId: frozenEquipmentSnapshotId,
          loadEntryMeaning: "total_system",
        },
        {
          sessionExerciseId: legacySessionExercise.id,
          setNo: 1,
          weight: 95,
          weightUnit: "lb" as const,
          reps: 6,
          targetMet: true,
          metricType: "weight_reps" as const,
          equipmentSnapshotId: legacyEquipmentSnapshotId,
          loadEntryMeaning: "total_system",
        },
        {
          sessionExerciseId: legacySessionExercise.id,
          setNo: 2,
          weight: 45,
          weightUnit: "lb" as const,
          reps: 8,
          isWarmup: true,
          metricType: "weight_reps" as const,
          equipmentSnapshotId: legacyEquipmentSnapshotId,
          loadEntryMeaning: "total_system",
        },
      ])
      .returning({ id: completedSets.id });
    await db.insert(sessionOccurrences).values([
      {
        sessionId: isolatedSessionId,
        sessionExerciseId: frozenSessionExercise.id,
        kind: "working_set" as const,
        origin: "planned" as const,
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: frozenExercise.id,
        outcome: "completed" as const,
        revision: 1,
        resolvedAt: new Date("2026-07-12T18:05:00.000Z"),
        completedSetId: frozenSet.id,
        equipmentSnapshotId: frozenEquipmentSnapshotId,
      },
      {
        sessionId: isolatedSessionId,
        sessionExerciseId: legacySessionExercise.id,
        kind: "working_set" as const,
        origin: "planned" as const,
        sequenceIdx: 1,
        kindOrdinal: 0,
        plannedExerciseId: legacyExercise.id,
        outcome: "completed" as const,
        revision: 1,
        resolvedAt: new Date("2026-07-12T18:10:00.000Z"),
        completedSetId: legacySet.id,
        equipmentSnapshotId: legacyEquipmentSnapshotId,
      },
    ]);
    await db
      .update(exercises)
      .set({
        name: "Changed catalog press",
        movementPattern: "vertical_push",
        metricType: "reps",
        loadType: "bodyweight",
        loadSemantics: "none",
      })
      .where(eq(exercises.id, frozenExercise.id));

    const frozenTurn = await startLiveCoachTurn(db, isolatedUserId, {
      sessionId: isolatedSessionId,
      sessionExerciseId: frozenSessionExercise.id,
      completedSetId: null,
      messageKind: "question",
      inputMode: "text",
      content: "Does the prescribed set still count?",
      clientKey: crypto.randomUUID(),
    });
    const frozenContext = await buildLiveCoachingContext(
      db,
      isolatedUserId,
      {
        aggressiveness: "conservative",
        deloadSuggestions: true,
        substitutionSuggestions: true,
        weeklyReview: false,
      },
      frozenTurn.pendingResponse!.id,
      null,
    );
    expect(frozenContext.liveWorkout.selectedExercise).toMatchObject({
      name: "Frozen prescribed press",
      movementPattern: "unknown",
      setsSuppressedFromClaims: 0,
    });
    expect(frozenContext.liveWorkout.selectedExercise?.setsLogged).toEqual([
      expect.objectContaining({
        weight: 135,
        reps: 6,
        targetOutcome: "unknown",
      }),
    ]);
    expect(frozenContext.liveWorkout.allExercises[0]?.name).toBe(
      "Frozen prescribed press",
    );

    const legacyTurn = await startLiveCoachTurn(db, isolatedUserId, {
      sessionId: isolatedSessionId,
      sessionExerciseId: legacySessionExercise.id,
      completedSetId: null,
      messageKind: "question",
      inputMode: "text",
      content: "Can unknown legacy meaning drive a claim?",
      clientKey: crypto.randomUUID(),
    });
    const legacyContext = await buildLiveCoachingContext(
      db,
      isolatedUserId,
      {
        aggressiveness: "conservative",
        deloadSuggestions: true,
        substitutionSuggestions: true,
        weeklyReview: false,
      },
      legacyTurn.pendingResponse!.id,
      null,
    );
    expect(legacyContext.liveWorkout.selectedExercise?.setsLogged).toEqual([]);
    expect(
      legacyContext.liveWorkout.selectedExercise?.setsSuppressedFromClaims,
    ).toBe(1);
    expect(legacyContext.liveWorkout.performedWarmupResults).toEqual([]);
  }, 30_000);

  it("saves before answering, retries safely, and follows the workout through recovery", async () => {
    const clientKey = crypto.randomUUID();
    const started = await startLiveCoachTurn(db, userId, {
      sessionId,
      sessionExerciseId,
      completedSetId: null,
      messageKind: "question",
      inputMode: "text",
      content: "The first set felt harder than expected. Should I lower the load?",
      clientKey,
    });
    expect(started.userMessage).toMatchObject({
      author: "user",
      messageKind: "question",
      responseStatus: "saved",
      sessionExerciseId,
    });
    expect(started.pendingResponse).toMatchObject({
      author: "assistant",
      responseStatus: "pending",
      replyToId: started.userMessage.id,
    });

    const repeated = await startLiveCoachTurn(db, userId, {
      sessionId,
      sessionExerciseId,
      completedSetId: null,
      messageKind: "question",
      inputMode: "text",
      content: "The first set felt harder than expected. Should I lower the load?",
      clientKey,
    });
    expect(repeated.userMessage.id).toBe(started.userMessage.id);
    expect(repeated.pendingResponse?.id).toBe(started.pendingResponse?.id);
    await expect(
      startLiveCoachTurn(db, userId, {
        sessionId,
        sessionExerciseId,
        completedSetId: null,
        messageKind: "question",
        inputMode: "text",
        content: "Different text must not reuse an acknowledged identity.",
        clientKey,
      })
    ).rejects.toThrow("could not be reconciled");
    expect(
      await db.query.coachingInsights.findMany({
        where: eq(coachingInsights.clientKey, clientKey),
      })
    ).toHaveLength(1);

    const failed = await markLiveCoachResponseFailed(
      db,
      userId,
      started.pendingResponse!.id,
      "Injected model interruption; the question remains saved."
    );
    expect(failed).toMatchObject({ responseStatus: "failed" });
    const retry = await createLiveCoachRetry(db, userId, started.userMessage.id);
    expect(retry).toMatchObject({
      responseStatus: "pending",
      replyToId: started.userMessage.id,
    });
    await expect(
      createLiveCoachRetry(db, userId, started.userMessage.id)
    ).resolves.toMatchObject({
      id: retry.id,
      responseStatus: "pending",
      replyToId: started.userMessage.id,
    });
    const completedAnswer = {
      answer: "Hold the load for the next set and reassess after a full two-minute rest.",
      evidence: ["Set 1: 135 lb × 7 at RPE 8", "Planned rest: 120 seconds"],
      dataGaps: ["Only one working set is logged so far."],
      safetyNote: null,
    };
    await db.insert(completedSets).values([
      {
        sessionExerciseId,
        setNo: 2,
        weight: 999,
        weightUnit: "lb",
        reps: 1,
        targetMet: true,
        note: "Unlinked raw result must not enter working evidence.",
        metricType: "weight_reps",
        equipmentSnapshotId,
        loadEntryMeaning: "total_system",
      },
      {
        sessionExerciseId,
        setNo: 3,
        weight: 45,
        weightUnit: "lb",
        reps: 8,
        isWarmup: true,
        note: "Imported warm-up result stays separate from working volume.",
        sourceSetIndex: 2,
        metricType: "weight_reps",
        equipmentSnapshotId,
        loadEntryMeaning: "total_system",
      },
    ]);
    await db.insert(sessionOccurrences).values([
      {
        sessionId,
        sessionExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 1,
        kindOrdinal: 1,
        plannedExerciseId: exerciseId,
        outcome: "skipped",
        outcomeReason: "fatigue",
        outcomeNote: "Stopped before the second working set.",
        revision: 1,
        resolvedAt: new Date("2026-07-11T18:08:00.000Z"),
      },
      {
        sessionId,
        kind: "day_warmup",
        origin: "planned",
        sequenceIdx: 2,
        kindOrdinal: 0,
        label: "Bike ramp",
        outcome: "completed",
        outcomeNote: "Five calm minutes.",
        revision: 1,
        resolvedAt: new Date("2026-07-11T18:01:00.000Z"),
      },
      {
        sessionId,
        sessionExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 3,
        kindOrdinal: 2,
        plannedExerciseId: exerciseId,
        outcome: "abandoned",
        outcomeReason: "finished_early",
        outcomeNote: "Time expired.",
        revision: 1,
        resolvedAt: new Date("2026-07-11T18:10:00.000Z"),
      },
    ]);
    const [assistedFact] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId,
        setNo: 4,
        weight: 40,
        weightUnit: "lb",
        reps: 6,
        metricType: "assisted_reps",
        targetMet: true,
        equipmentSnapshotId,
        loadEntryMeaning: "total_system",
        note: "Preserved assisted fact must not become a loaded Coach claim.",
      })
      .returning({ id: completedSets.id });
    await db.insert(sessionOccurrences).values({
      sessionId,
      sessionExerciseId,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 105,
      kindOrdinal: 3,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      revision: 1,
      resolvedAt: new Date("2026-07-11T18:09:00.000Z"),
      completedSetId: assistedFact.id,
      equipmentSnapshotId,
    });
    await db.insert(sessionOccurrences).values(
      Array.from({ length: 101 }, (_, index) => ({
        sessionId,
        kind: "day_warmup" as const,
        origin: "legacy" as const,
        sequenceIdx: index + 4,
        kindOrdinal: index + 1,
        label: `Bounded legacy warm-up ${index + 1}`,
        outcome: "legacy_unrecorded" as const,
      })),
    );
    const visibleNote = await createContextualNote(db, userId, {
        clientKey: crypto.randomUUID(),
        body: "Coach may use this reviewed observation.",
        coachVisible: true,
        inputMode: "reviewed_dictation",
        attachmentKind: "workout",
        sessionId,
        capturedContext: contextualContext("workout"),
        recordedAt: "2026-07-11T18:06:00.000Z",
      });
    const privateNote = await createContextualNote(db, userId, {
        clientKey: crypto.randomUUID(),
        body: "This observation remains private.",
        coachVisible: false,
        inputMode: "typed",
        attachmentKind: "workout",
        sessionId,
        capturedContext: contextualContext("workout"),
        recordedAt: "2026-07-11T18:07:00.000Z",
      });
    expect(visibleNote.outcome).toBe("saved");
    expect(privateNote.outcome).toBe("saved");
    await runPrivacyRetention(db, new Date("2026-07-11T18:08:00.000Z"));
    const ownerNotesCsv = await buildContextualNotesCsv(db, userId, null);
    expect(ownerNotesCsv).toContain("Coach may use this reviewed observation.");
    expect(ownerNotesCsv).toContain("This observation remains private.");
    const reviewContext = await buildCoachingContext(db, userId, {
      aggressiveness: "conservative",
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: false,
    }, new Date("2026-07-11T18:08:00.000Z"));
    expect(reviewContext.contextualNotes).toEqual([
      expect.objectContaining({ body: "Coach may use this reviewed observation." }),
    ]);
    const context = await buildLiveCoachingContext(
      db,
      userId,
      {
        aggressiveness: "conservative",
        deloadSuggestions: true,
        substitutionSuggestions: true,
        weeklyReview: false,
      },
      retry.id,
      120
    );
    expect(context.liveWorkout.selectedExercise?.setsLogged).toHaveLength(1);
    expect(
      context.liveWorkout.selectedExercise?.setsSuppressedFromClaims
    ).toBe(1);
    expect(context.liveWorkout.contextualNotes).toEqual([
      expect.objectContaining({ body: "Coach may use this reviewed observation." }),
    ]);
    expect(context.liveWorkout.selectedExercise?.setsLogged[0]).toMatchObject({
      setNo: 1,
      weight: 135,
      reps: 7,
    });
    expect(context.liveWorkout.allExercises[0]?.setsLogged).toBe(2);
    expect(context.liveWorkout.performedWarmupResults).toEqual([
      expect.objectContaining({
        exerciseName: expect.stringContaining("Live Coach Squat"),
        setNo: 3,
        weight: 45,
        reps: 8,
        note: "Imported warm-up result stays separate from working volume.",
      }),
    ]);
    expect(context.liveWorkout.occurrenceOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "working_set",
          outcome: "skipped",
          reason: "fatigue",
          note: "Stopped before the second working set.",
        }),
        expect.objectContaining({
          kind: "day_warmup",
          label: "Bike ramp",
          outcome: "completed",
          note: "Five calm minutes.",
        }),
        expect.objectContaining({
          kind: "working_set",
          outcome: "abandoned",
          reason: "finished_early",
          note: "Time expired.",
        }),
      ]),
    );
    expect(context.liveWorkout.occurrenceOutcomes).toHaveLength(100);
    expect(context.liveWorkout.occurrenceOutcomesTruncated).toBe(true);
    const durableAnswer = await completeLiveCoachResponse(
      db,
      userId,
      retry.id,
      context,
      completedAnswer,
      "test-model"
    );
    expect(durableAnswer).toMatchObject({
      id: retry.id,
      responseStatus: "completed",
      answer: completedAnswer,
    });
    expect(
      await completeLiveCoachResponse(
        db,
        userId,
        retry.id,
        context,
        completedAnswer,
        "duplicate-model-call"
      )
    ).toMatchObject({ id: retry.id, model: "test-model" });
    expect(await getLiveCoachResponse(db, userId, retry.id)).toMatchObject({
      id: retry.id,
      responseStatus: "completed",
    });
    await expect(
      createLiveCoachRetry(db, userId, started.userMessage.id)
    ).resolves.toMatchObject({ id: retry.id, responseStatus: "completed" });

    const dictationClientKey = crypto.randomUUID();
    const observation = await startLiveCoachTurn(db, userId, {
      sessionId,
      sessionExerciseId,
      completedSetId: null,
      messageKind: "observation",
      inputMode: "dictation",
      content: "My bracing felt better after slowing the setup down.",
      clientKey: dictationClientKey,
    });
    expect(observation.pendingResponse).toBeNull();
    expect(observation.userMessage.inputMode).toBe("dictation");
    const repeatedDictation = await startLiveCoachTurn(db, userId, {
      sessionId,
      sessionExerciseId,
      completedSetId: null,
      messageKind: "observation",
      inputMode: "dictation",
      content: "My bracing felt better after slowing the setup down.",
      clientKey: dictationClientKey,
    });
    expect(repeatedDictation.userMessage.id).toBe(observation.userMessage.id);

    const messages = await listLiveCoachMessages(db, userId, sessionId);
    expect(messages).toHaveLength(4);
    expect(messages.find((message) => message.id === retry.id)?.answer).toEqual(
      completedAnswer
    );

    await expect(
      db.delete(coachingInsights).where(eq(coachingInsights.id, started.userMessage.id))
    ).rejects.toThrow();

    await db
      .update(workoutSessions)
      .set({
        status: "completed",
        finishedAt: new Date("2026-07-11T19:00:00.000Z"),
      })
      .where(eq(workoutSessions.id, sessionId));
    await db
      .update(coachingInsights)
      .set({ createdAt: new Date("2026-07-11T18:30:00.000Z") })
      .where(eq(coachingInsights.sessionId, sessionId));
    const [digest, csv, backup, snapshot] = await Promise.all([
      buildTrainingDigest(
        db,
        userId,
        new Date("2026-07-01T00:00:00.000Z"),
        new Date("2026-07-12T00:00:00.000Z")
      ),
      buildLiveCoachCsv(db, userId, null),
      buildJsonBackup(db, userId),
      captureUserSnapshot(db, userId, new Date("2026-07-12T00:00:00.000Z"), "test"),
    ]);
    expect(digest.liveCoachContext.messages).toHaveLength(2);
    expect(digest.sessions[0]?.exercises[0]?.sets).not.toContain(
      "assisted reps",
    );
    expect(
      digest.sessions[0]?.exercises[0]?.performedSets.some((set) =>
        set.metrics.includes("assisted reps") &&
        set.metrics.includes("exclude from conclusions"),
      ),
    ).toBe(true);
    expect(JSON.stringify(digest.sessions)).not.toContain(
      "Preserved assisted fact must not become a loaded Coach claim.",
    );
    const coachingBrief = renderCoachingBrief(digest);
    expect(coachingBrief).toContain("My bracing felt better");
    expect(coachingBrief).toContain(
      "No supported planned set target outcome is available.",
    );
    expect(coachingBrief).not.toContain(
      "100% of working sets met their target.",
    );
    expect(csv).toContain("The first set felt harder");
    expect(csv).toContain("Hold the load for the next set");
    expect(backup.schemaVersion).toBe("37");
    expect(backup.canonical.tables.coaching_insights).toHaveLength(4);
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.tables.coaching_insights).toHaveLength(4);

    const preview = await getWorkoutArchivePreview(db, userId, sessionId);
    expect(preview?.coachingMessages).toBe(4);
    const archived = await archiveWorkoutRecord(db, userId, sessionId);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error(archived.reason);
    expect(await listLiveCoachMessages(db, userId, sessionId)).toHaveLength(0);
    expect(await buildLiveCoachCsv(db, userId, null)).not.toContain(
      "The first set felt harder"
    );
    expect(
      (
        await buildTrainingDigest(
          db,
          userId,
          new Date("2026-07-01T00:00:00.000Z"),
          new Date("2026-07-12T00:00:00.000Z")
        )
      ).liveCoachContext.messages
    ).toHaveLength(0);
    expect(
      (await buildJsonBackup(db, userId)).canonical.tables.coaching_insights
    ).toHaveLength(4);

    expect((await restoreArchiveOperation(db, userId, archived.operationId)).ok).toBe(true);
    expect(await listLiveCoachMessages(db, userId, sessionId)).toHaveLength(4);
  }, 30_000);

  it("saves and reconciles a queued message after its workout is completed", async () => {
    const [completedSession] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Completed while offline",
        status: "completed",
        startedAt: new Date("2026-07-12T20:00:00.000Z"),
        finishedAt: new Date("2026-07-12T21:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-12",
      })
      .returning({ id: workoutSessions.id });
    const clientKey = crypto.randomUUID();
    const input = {
      sessionId: completedSession.id,
      sessionExerciseId: null,
      completedSetId: null,
      messageKind: "observation" as const,
      inputMode: "text" as const,
      content: "This was queued before I finished the workout.",
      clientKey,
    };

    const saved = await startLiveCoachTurn(db, userId, input);
    const reconciled = await startLiveCoachTurn(db, userId, input);
    expect(saved.userMessage).toMatchObject({
      id: reconciled.userMessage.id,
      sessionId: completedSession.id,
      content: input.content,
      responseStatus: "saved",
    });
    expect(saved.pendingResponse).toBeNull();
    expect(
      await db.query.coachingInsights.findMany({
        where: eq(coachingInsights.clientKey, clientKey),
      })
    ).toHaveLength(1);
  });
});
