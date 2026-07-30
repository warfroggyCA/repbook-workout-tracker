// Intent suite: proves one saved Live Coach response has at most one provider
// generation lease and an abandoned lease can be reclaimed safely.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  aiUsageEvents,
  coachingInsights,
  exercises,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import {
  completeLiveCoachResponse,
  prepareLiveCoachResponseStream,
  startLiveCoachTurn,
} from "@/services/live-coaching";
import {
  AIControlError,
  claimLiveCoachGeneration,
} from "@/services/ai-control";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("Live Coach generation lease invariants", () => {
  let database: TestDatabase;
  let userId: string;
  let sessionId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `generation-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Generation Squat",
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    [{ id: sessionId }] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Generation workout",
        startedAt: new Date("2026-07-13T14:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-13",
      })
      .returning({ id: workoutSessions.id });
    await database.db.insert(sessionExercises).values({
      sessionId,
      exerciseId: exercise.id,
      targetSets: 3,
      targetRepsMin: 6,
      targetRepsMax: 8,
    });
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await database.close();
  });

  it("allows only one provider generation for the same pending response", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_FAKE", "1");
    vi.stubEnv("AI_FAKE_STREAM_DELAY_MS", "0");
    const started = await startLiveCoachTurn(database.db, userId, {
      sessionId,
      sessionExerciseId: null,
      completedSetId: null,
      messageKind: "question",
      inputMode: "text",
      content: "Should I keep the same load?",
      clientKey: crypto.randomUUID(),
    });
    const responseId = started.pendingResponse!.id;
    const preferences = {
      aggressiveness: "conservative" as const,
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    };

    const attempts = await Promise.allSettled([
      prepareLiveCoachResponseStream(
        database.db,
        userId,
        preferences,
        responseId,
        null
      ),
      prepareLiveCoachResponseStream(
        database.db,
        userId,
        preferences,
        responseId,
        null
      ),
    ]);
    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof prepareLiveCoachResponseStream>>
      > => attempt.status === "fulfilled"
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected"
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(AIControlError);
    expect(rejected[0].reason).toMatchObject({ code: "already_running" });

    const prepared = fulfilled[0].value;
    expect(prepared.model).toBe("fake-dev");
    const answer = await prepared.value;
    const usage = await prepared.usage;
    await completeLiveCoachResponse(
      database.db,
      userId,
      responseId,
      prepared.context,
      answer,
      prepared.model,
      prepared.claim,
      usage
    );

    const [response] = await database.db
      .select()
      .from(coachingInsights)
      .where(eq(coachingInsights.id, responseId));
    const usageEvents = await database.db.select().from(aiUsageEvents);
    expect(response).toMatchObject({
      responseStatus: "completed",
      generationLeaseId: null,
      generationLeaseExpiresAt: null,
    });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ status: "completed", model: "fake-dev" });
  });

  it("times out an abandoned lease and safely reclaims the saved response", async () => {
    const started = await startLiveCoachTurn(database.db, userId, {
      sessionId,
      sessionExerciseId: null,
      completedSetId: null,
      messageKind: "question",
      inputMode: "text",
      content: "Can this expired answer be retried?",
      clientKey: crypto.randomUUID(),
    });
    const responseId = started.pendingResponse!.id;
    const firstNow = new Date("2026-07-13T20:00:00.000Z");
    const first = await claimLiveCoachGeneration(database.db, {
      userId,
      responseId,
      now: firstNow,
    });
    const second = await claimLiveCoachGeneration(database.db, {
      userId,
      responseId,
      now: new Date(firstNow.getTime() + 61_000),
    });

    expect(second.id).not.toBe(first.id);
    const events = await database.db.select().from(aiUsageEvents);
    expect(events).toEqual([
      expect.objectContaining({
        id: first.id,
        status: "timed_out",
        failureCode: "lease_expired",
      }),
      expect.objectContaining({ id: second.id, status: "running" }),
    ]);
    const response = await database.db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, responseId),
    });
    expect(response).toMatchObject({
      responseStatus: "generating",
      generationLeaseId: second.leaseId,
    });
  });
});
