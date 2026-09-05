import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  aiParsingEvents,
  aiUsageEvents,
  coachingInsights,
  dataSnapshots,
  exercises,
  importEvents,
  programs,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { equipmentParseSchema } from "@/ai/tasks/equipment-parse/schema";
import {
  claimAIUsage,
  completeAIUsage,
  runControlledStructuredGeneration,
} from "@/services/ai-control";
import { runPrivacyRetention } from "@/services/privacy-retention";
import { activateProgramAtomically } from "@/services/program-activation";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import {
  archiveAIHistory,
  getAIHistoryArchivePreview,
} from "@/services/ai-privacy";
import {
  getArchiveList,
  restoreArchiveOperation,
} from "@/services/archive";
import {
  createPermanentDeleteGrant,
  getPermanentDeletePreview,
  permanentlyDeleteArchiveOperation,
  PERMANENT_DELETE_CONFIRMATION,
} from "@/services/permanent-delete";
import {
  createMigratedTestDatabase,
  createStartBarrier,
  type TestDatabase,
} from "../helpers/database";

const NOW = new Date("2026-07-13T20:00:00.000Z");

describe("AI cost, concurrency, and privacy controls", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await database.close();
  });

  async function createUser(label: string) {
    const [user] = await database.db
      .insert(users)
      .values({ email: `${label}-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    return user.id;
  }

  function reservation(totalTokens = 1_000) {
    return {
      inputTokens: Math.max(0, totalTokens - 100),
      outputTokens: Math.min(100, totalTokens),
      totalTokens,
    };
  }

  async function completedEvents(
    userId: string,
    count: number,
    overrides: Partial<typeof aiUsageEvents.$inferInsert> = {}
  ) {
    await database.db.insert(aiUsageEvents).values(
      Array.from({ length: count }, (_, index) => ({
        userId,
        task: "equipment_parse",
        logicalKey: `completed:${crypto.randomUUID()}:${index}`,
        status: "completed",
        leaseId: crypto.randomUUID(),
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostMicrousd: 0,
        startedAt: new Date(NOW.getTime() - 60_000),
        completedAt: NOW,
        ...overrides,
      }))
    );
  }

  it("atomically allows two running requests and rejects a simultaneous third", async () => {
    const userId = await createUser("concurrency");
    const start = createStartBarrier(3);
    const attempts = await Promise.allSettled(
      Array.from({ length: 3 }, (_, index) =>
        (async () => {
          await start();
          return claimAIUsage(database.db, {
            userId,
            task: "equipment_parse",
            logicalKey: `parallel:${index}`,
            reservedUsage: reservation(),
            now: NOW,
          });
        })()
      )
    );
    const claims = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : []
    );
    const failures = attempts.flatMap((attempt) =>
      attempt.status === "rejected" ? [attempt.reason] : []
    );

    expect(claims).toHaveLength(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "concurrent_limit" });
    expect(await database.db.select().from(aiUsageEvents)).toHaveLength(2);

    await Promise.all(
      claims.map((claim) =>
        completeAIUsage(database.db, claim, {
          model: "test-model",
          usage: reservation(250),
          now: NOW,
        })
      )
    );
  });

  it("enforces request, network, token, cost, and transcription budgets", async () => {
    const rateUser = await createUser("rate");
    await completedEvents(rateUser, 20);
    await expect(
      claimAIUsage(database.db, {
        userId: rateUser,
        task: "equipment_parse",
        reservedUsage: reservation(),
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "rate_limit" });

    const networkSource = await createUser("network-source");
    const networkTarget = await createUser("network-target");
    await completedEvents(networkSource, 40, { networkHash: "daily-network" });
    await expect(
      claimAIUsage(database.db, {
        userId: networkTarget,
        task: "equipment_parse",
        networkHash: "daily-network",
        reservedUsage: reservation(),
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "network_rate_limit" });

    const tokenUser = await createUser("tokens");
    await completedEvents(tokenUser, 1, { totalTokens: 249_500 });
    await expect(
      claimAIUsage(database.db, {
        userId: tokenUser,
        task: "equipment_parse",
        reservedUsage: reservation(1_000),
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "token_limit" });

    const costUser = await createUser("cost");
    await completedEvents(costUser, 1, { estimatedCostMicrousd: 4_950_000 });
    await expect(
      claimAIUsage(database.db, {
        userId: costUser,
        task: "equipment_parse",
        reservedUsage: {
          inputTokens: 0,
          outputTokens: 1_000,
          totalTokens: 1_000,
        },
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "cost_limit" });

    const routineUser = await createUser("routine-override");
    await completedEvents(routineUser, 1, {
      totalTokens: 249_500,
      estimatedCostMicrousd: 4_950_000,
    });
    const routineClaim = await claimAIUsage(database.db, {
      userId: routineUser,
      task: "routine_build",
      reservedUsage: reservation(10_000),
      now: NOW,
    });
    await completeAIUsage(database.db, routineClaim, {
      model: "test-model",
      usage: reservation(100),
      now: NOW,
    });

    const transcriptionRateUser = await createUser("transcription-rate");
    await completedEvents(transcriptionRateUser, 10, {
      task: "live_coach_transcription",
      audioSeconds: 1,
    });
    await expect(
      claimAIUsage(database.db, {
        userId: transcriptionRateUser,
        task: "live_coach_transcription",
        reservedUsage: reservation(0),
        audioSeconds: 1,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "transcription_rate_limit" });

    const durationUser = await createUser("transcription-duration");
    await completedEvents(durationUser, 1, {
      task: "live_coach_transcription",
      audioSeconds: 1_190,
    });
    await expect(
      claimAIUsage(database.db, {
        userId: durationUser,
        task: "live_coach_transcription",
        reservedUsage: reservation(0),
        audioSeconds: 20,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "transcription_duration_limit" });
  });

  it("reclaims expired work and records model usage without storing prompts", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_FAKE", "1");
    const userId = await createUser("usage");
    const expired = await claimAIUsage(database.db, {
      userId,
      task: "equipment_parse",
      logicalKey: "reclaimable",
      reservedUsage: reservation(),
      leaseSeconds: 1,
      now: new Date(NOW.getTime() - 2_000),
    });
    const reclaimed = await claimAIUsage(database.db, {
      userId,
      task: "equipment_parse",
      logicalKey: "reclaimable",
      reservedUsage: reservation(),
      now: NOW,
    });
    expect(reclaimed.id).not.toBe(expired.id);
    expect(await database.db.query.aiUsageEvents.findFirst({
      where: eq(aiUsageEvents.id, expired.id),
    })).toMatchObject({ status: "timed_out", failureCode: "lease_expired" });
    await completeAIUsage(database.db, reclaimed, {
      model: "test-model",
      usage: reservation(10),
      now: NOW,
    });

    const prompt = "Private equipment prompt that must not enter metering";
    const result = await runControlledStructuredGeneration(database.db, userId, {
      task: "equipment_parse",
      system: "Return structured equipment.",
      input: prompt,
      schema: equipmentParseSchema,
      logicalKey: "metered-success",
    });
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    const usage = await database.db.query.aiUsageEvents.findFirst({
      where: eq(aiUsageEvents.logicalKey, "metered-success"),
    });
    expect(usage).toMatchObject({
      status: "completed",
      model: "fake-dev",
      totalTokens: result.usage.totalTokens,
    });
    expect(JSON.stringify(usage)).not.toContain(prompt);
  });

  it("cancels a slow provider at the hard deadline and marks the lease timed out", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_FAKE", "1");
    vi.stubEnv("AI_FAKE_PARSE_DELAY_MS", "100");
    const userId = await createUser("timeout");
    await expect(
      runControlledStructuredGeneration(database.db, userId, {
        task: "equipment_parse",
        system: "Return structured equipment.",
        input: "A rack and barbell",
        schema: equipmentParseSchema,
        logicalKey: "hard-timeout",
        deadlineMs: 10,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await database.db.query.aiUsageEvents.findFirst({
      where: eq(aiUsageEvents.logicalKey, "hard-timeout"),
    })).toMatchObject({ status: "timed_out", failureCode: "timed_out" });
  });

  it("expires abandoned raw material while preserving validated application data", async () => {
    const userId = await createUser("retention");
    await database.db.insert(userProfiles).values({ userId, unit: "lb" });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: `Retention exercise ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    const [workout] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Retained workout",
        status: "completed",
        startedAt: new Date("2026-07-12T18:00:00.000Z"),
        finishedAt: new Date("2026-07-12T19:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-12",
      })
      .returning();
    const program = await activateProgramAtomically(database.db, {
      userId,
      loadUnit: "lb",
      programName: "Retained program",
      days: [{
        name: "Retained day",
        exercises: [{
          exerciseId: exercise.id,
          sets: 3,
          repMin: 6,
          repMax: 8,
          targetLoad: 100,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Privacy retention fixture",
      auditAction: "program.activate",
      auditSummary: "Activated privacy retention fixture",
    });
    if (!program.ok) throw new Error(program.reason);
    const [confirmedImport, abandonedImport] = await database.db
      .insert(importEvents)
      .values([
        {
          userId,
          source: "paste",
          rawPayload: "confirmed private routine",
          parsedPayload: { temporary: true },
          confirmedPayload: { schemaVersion: "1", resolutions: [] },
          status: "confirmed",
        },
        {
          userId,
          source: "csv",
          rawPayload: "abandoned private csv",
          parsedPayload: { temporary: true },
          status: "parsed",
          retentionExpiresAt: new Date(NOW.getTime() - 1),
        },
      ])
      .returning();
    const [parseEvent] = await database.db
      .insert(aiParsingEvents)
      .values({
        userId,
        scope: "setup",
        task: "equipment_parse",
        rawInput: "private setup text",
        rawOutput: "private provider output",
        parsedJson: { temporary: true },
        confirmed: true,
        confirmedPayload: { items: [] },
      })
      .returning();
    const [coach] = await database.db
      .insert(coachingInsights)
      .values({
        userId,
        kind: "qa",
        contentMd: "Durable answer",
        dataDigest: { question: "Private question", fullContext: "x".repeat(2_000) },
      })
      .returning();
    await completedEvents(userId, 1, {
      startedAt: new Date("2026-03-01T00:00:00.000Z"),
      completedAt: new Date("2026-03-01T00:00:01.000Z"),
    });

    const safeBackup = await captureUserSnapshot(
      database.db,
      userId,
      NOW,
      "privacy-test"
    );
    expect(safeBackup.schemaVersion).toBe("37");
    expect(safeBackup.tables.import_events).toHaveLength(2);
    expect(safeBackup.tables.import_events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: confirmedImport.id,
        status: "confirmed",
        raw_payload: "",
        parsed_payload: null,
      }),
      expect.objectContaining({
        id: abandonedImport.id,
        status: "discarded",
        raw_payload: "",
        parsed_payload: null,
      }),
    ]));
    expect(safeBackup.tables.ai_parsing_events).toEqual([
      expect.objectContaining({
        id: parseEvent.id,
        raw_input: "",
        raw_output: null,
        parsed_json: null,
      }),
    ]);
    expect(JSON.stringify(safeBackup.tables.coaching_insights)).not.toContain(
      "fullContext"
    );
    expect(await database.db.query.importEvents.findFirst({
      where: eq(importEvents.id, abandonedImport.id),
    })).toMatchObject({ rawPayload: "abandoned private csv", status: "parsed" });

    const result = await runPrivacyRetention(database.db, NOW);
    expect(result).toMatchObject({
      expiredImports: 1,
      redactedImports: 2,
      redactedAiParses: 1,
      minimizedCoachContexts: 1,
      expiredUsageEvents: 1,
    });

    expect(await database.db.query.importEvents.findFirst({
      where: eq(importEvents.id, confirmedImport.id),
    })).toMatchObject({
      status: "confirmed",
      rawPayload: "",
      parsedPayload: null,
      confirmedPayload: { schemaVersion: "1", resolutions: [] },
      payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await database.db.query.importEvents.findFirst({
      where: eq(importEvents.id, abandonedImport.id),
    })).toMatchObject({ status: "discarded", rawPayload: "", parsedPayload: null });
    expect(await database.db.query.aiParsingEvents.findFirst({
      where: eq(aiParsingEvents.id, parseEvent.id),
    })).toMatchObject({
      rawInput: "",
      rawOutput: null,
      parsedJson: null,
      confirmedPayload: { items: [] },
      inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await database.db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, coach.id),
    })).toMatchObject({
      contentMd: "Durable answer",
      dataDigest: {
        schemaVersion: "2",
        question: "Private question",
        modelContextRetained: false,
      },
    });
    expect(await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, workout.id),
    })).toBeDefined();
    expect(await database.db.query.programs.findFirst({
      where: eq(programs.id, program.programId),
    })).toBeDefined();
  });

  it("lets the user archive, restore, and permanently delete the exact AI history scope", async () => {
    const userId = await createUser("ai-archive");
    await database.db.insert(coachingInsights).values([
      {
        userId,
        kind: "manual_review",
        contentMd: "First durable answer",
        dataDigest: { fullContext: "private context one" },
      },
      {
        userId,
        kind: "qa",
        contentMd: "Second durable answer",
        dataDigest: { question: "Private question", fullContext: "private context two" },
      },
    ]);
    const [parseEvent] = await database.db
      .insert(aiParsingEvents)
      .values({
        userId,
        scope: "import",
        task: "routine_parse",
        rawInput: "private imported routine",
        rawOutput: "private model result",
        parsedJson: { temporary: true },
      })
      .returning();

    const preview = await getAIHistoryArchivePreview(database.db, userId);
    expect(preview).toEqual({ coachingInsights: 2, parsingInputs: 1 });
    const archived = await archiveAIHistory(database.db, userId, preview);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error(archived.reason);
    expect(await getArchiveList(database.db, userId, ["ai_history"])).toHaveLength(1);
    expect(await database.db.query.coachingInsights.findMany()).toEqual([
      expect.objectContaining({ archivedAt: expect.any(Date) }),
      expect.objectContaining({ archivedAt: expect.any(Date) }),
    ]);
    expect(await database.db.query.aiParsingEvents.findFirst({
      where: eq(aiParsingEvents.id, parseEvent.id),
    })).toMatchObject({
      rawInput: "",
      rawOutput: null,
      parsedJson: null,
      inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    expect(
      await restoreArchiveOperation(database.db, userId, archived.operationId)
    ).toMatchObject({ ok: true });
    expect(
      (await database.db.query.coachingInsights.findMany()).every(
        (insight) => insight.archivedAt == null
      )
    ).toBe(true);

    const archiveAgain = await archiveAIHistory(
      database.db,
      userId,
      await getAIHistoryArchivePreview(database.db, userId)
    );
    expect(archiveAgain.ok).toBe(true);
    if (!archiveAgain.ok) throw new Error(archiveAgain.reason);
    const deletePreview = await getPermanentDeletePreview(
      database.db,
      userId,
      archiveAgain.operationId
    );
    expect(deletePreview).toMatchObject({
      rootType: "ai_history",
      deleteCounts: { coachingInsights: 2 },
      blockers: [],
    });
    const deleteNow = new Date();
    const grant = await createPermanentDeleteGrant(
      database.db,
      userId,
      archiveAgain.operationId,
      "dev-login",
      deleteNow,
      deleteNow
    );
    expect(grant.ok).toBe(true);
    if (!grant.ok) throw new Error(grant.reason);
    const snapshotId = crypto.randomUUID();
    await database.db.insert(dataSnapshots).values({
      id: snapshotId,
      userId,
      name: "AI history delete safety snapshot",
      reason: "pre_permanent_delete",
      sourceOperationId: archiveAgain.operationId,
      status: "verified",
      objectPath: `snapshots/${userId}/${snapshotId}.wtbk`,
      appVersion: "test",
      schemaVersion: "14",
      sizeBytes: 1,
      recordCounts: {},
      plaintextChecksum: "plaintext",
      ciphertextChecksum: "ciphertext",
      encryptionAlgorithm: "aes-256-gcm",
      encryptionKeyVersion: "v1",
      snapshotKind: "automatic",
      verifiedAt: deleteNow,
    });
    const deleted = await permanentlyDeleteArchiveOperation(
      database.db,
      userId,
      archiveAgain.operationId,
      grant.token,
      PERMANENT_DELETE_CONFIRMATION,
      snapshotId
    );
    if (!deleted.ok) throw new Error(deleted.reason);
    expect(await database.db.query.coachingInsights.findMany()).toHaveLength(0);
    expect(await database.db.query.aiParsingEvents.findFirst({
      where: eq(aiParsingEvents.id, parseEvent.id),
    })).toMatchObject({ rawInput: "", rawOutput: null, parsedJson: null });
  });
});
