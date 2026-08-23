import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  exercises,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { createMigratedTestDatabase, type TestDatabase } from "../helpers/database";
import { buildJsonBackup, buildSetsCsv } from "@/services/export";
import { buildCoachingContext } from "@/services/coaching";
import { getHistoryReport } from "@/services/history-report";

const actionContext = vi.hoisted(() => ({
  database: null as TestDatabase["db"] | null,
  user: null as {
    id: string;
    profile: {
      unit: "lb";
      timezone: "America/Toronto";
      coachingPrefs: Record<string, never>;
    };
  } | null,
}));

vi.mock("@/db", () => ({
  getDb: vi.fn(async () => {
    if (!actionContext.database) throw new Error("Test database is missing");
    return actionContext.database;
  }),
}));

vi.mock("@/lib/user", () => ({
  getCurrentUser: vi.fn(async () => {
    if (!actionContext.user) throw new Error("Test user is missing");
    return actionContext.user;
  }),
}));

vi.mock("@/lib/user-id-cache", () => ({
  getCurrentUserIdFast: vi.fn(async () => {
    if (!actionContext.user) throw new Error("Test user is missing");
    return actionContext.user.id;
  }),
  refreshCurrentUserIdFast: vi.fn(async () => {
    if (!actionContext.user) throw new Error("Test user is missing");
    return actionContext.user.id;
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));

import {
  confirmExerciseUnskipped,
  correctAcknowledgedSet,
  correctWorkoutActiveDuration,
  skipExercise,
} from "@/app/actions/sessions";

describe("session action named results", () => {
  let database: TestDatabase;
  let ownerId: string;
  let otherUserId: string;
  let activeExerciseId: string;
  let completedSessionId: string;
  let completedExerciseId: string;
  let activeSetId: string;
  let completedSetId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    actionContext.database = database.db;
    [{ id: ownerId }, { id: otherUserId }] = await database.db
      .insert(users)
      .values([
        { email: `action-owner-${crypto.randomUUID()}@example.com` },
        { email: `action-other-${crypto.randomUUID()}@example.com` },
      ])
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values([
      { userId: ownerId },
      { userId: otherUserId },
    ]);
    actionContext.user = {
      id: ownerId,
      profile: {
        unit: "lb",
        timezone: "America/Toronto",
        coachingPrefs: {},
      },
    };

    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Action Result Press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "dumbbell",
        metricType: "weight_reps",
        loadSemantics: "per_implement",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    const [activeSession, completedSession, otherSession] = await database.db
      .insert(workoutSessions)
      .values([
        {
          userId: ownerId,
          templateName: "Active action workout",
          status: "in_progress",
          startedAt: new Date("2026-07-18T12:00:00.000Z"),
          timezone: "America/Toronto",
          localDate: "2026-07-18",
        },
        {
          userId: ownerId,
          templateName: "Completed action workout",
          status: "completed",
          startedAt: new Date("2026-07-17T12:00:00.000Z"),
          finishedAt: new Date("2026-07-17T13:00:00.000Z"),
          timezone: "America/Toronto",
          localDate: "2026-07-17",
        },
        {
          userId: otherUserId,
          templateName: "Other owner workout",
          status: "in_progress",
          startedAt: new Date("2026-07-16T12:00:00.000Z"),
          timezone: "America/Toronto",
          localDate: "2026-07-16",
        },
      ])
      .returning({ id: workoutSessions.id });
    const insertedExercises = await database.db
      .insert(sessionExercises)
      .values([
        {
          sessionId: activeSession.id,
          exerciseId: exercise.id,
          prescribedSemanticsVersion: 1,
          prescribedExerciseName: "Action Result Press",
          prescribedMetricType: "weight_reps",
          prescribedLoadType: "dumbbell",
          prescribedLoadSemantics: "per_implement",
          orderIdx: 0,
        },
        {
          sessionId: completedSession.id,
          exerciseId: exercise.id,
          prescribedSemanticsVersion: 1,
          prescribedExerciseName: "Action Result Press",
          prescribedMetricType: "weight_reps",
          prescribedLoadType: "dumbbell",
          prescribedLoadSemantics: "per_implement",
          orderIdx: 0,
        },
        {
          sessionId: otherSession.id,
          exerciseId: exercise.id,
          prescribedSemanticsVersion: 1,
          prescribedExerciseName: "Action Result Press",
          prescribedMetricType: "weight_reps",
          prescribedLoadType: "dumbbell",
          prescribedLoadSemantics: "per_implement",
          orderIdx: 0,
        },
      ])
      .returning({ id: sessionExercises.id });
    activeExerciseId = insertedExercises[0].id;
    completedSessionId = completedSession.id;
    completedExerciseId = insertedExercises[1].id;
    const [activeSet, completedSet] = await database.db
      .insert(completedSets)
      .values([
        {
          sessionExerciseId: activeExerciseId,
          setNo: 1,
          weight: 40,
          weightUnit: "lb",
          reps: 8,
          metricType: "weight_reps",
          performedSemanticsVersion: 1,
          performedLoadType: "dumbbell",
          performedLoadSemantics: "per_implement",
          clientKey: `active-${crypto.randomUUID()}`,
        },
        {
          sessionExerciseId: completedExerciseId,
          setNo: 1,
          weight: 45,
          weightUnit: "lb",
          reps: 8,
          metricType: "weight_reps",
          performedSemanticsVersion: 1,
          performedLoadType: "dumbbell",
          performedLoadSemantics: "per_implement",
          clientKey: `completed-${crypto.randomUUID()}`,
        },
      ])
      .returning({ id: completedSets.id });
    activeSetId = activeSet.id;
    completedSetId = completedSet.id;
    await database.db.insert(sessionOccurrences).values([
      {
        sessionId: activeSession.id,
        sessionExerciseId: activeExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
        outcome: "completed",
        revision: 1,
        resolvedAt: new Date("2026-07-18T12:15:00.000Z"),
        completedSetId: activeSetId,
      },
      {
        sessionId: completedSession.id,
        sessionExerciseId: completedExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
        outcome: "completed",
        revision: 1,
        resolvedAt: new Date("2026-07-17T12:15:00.000Z"),
        completedSetId,
      },
    ]);
  }, 30_000);

  afterEach(async () => {
    actionContext.database = null;
    actionContext.user = null;
    await database.close();
  });

  it("returns a named failure instead of throwing for a completed workout", async () => {
    await expect(
      skipExercise({
        sessionExerciseId: completedExerciseId,
        reason: "time",
        expectedHistoryRevision: 0,
      })
    ).resolves.toEqual({
      ok: false,
      code: "not_active",
      message: "Only an active workout can be changed.",
    });
  });

  it("returns the same named failure when the exercise belongs to another owner", async () => {
    const rows = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
      .where(eq(workoutSessions.userId, otherUserId));
    expect(rows[0]).toBeTruthy();
    await expect(
      skipExercise({
        sessionExerciseId: rows[0].id,
        reason: "time",
        expectedHistoryRevision: 0,
      })
    ).resolves.toMatchObject({ ok: false, code: "not_active" });
  });

  it("rejects a delayed skip after a newer return-to-workout fence", async () => {
    await expect(confirmExerciseUnskipped({
      sessionExerciseId: activeExerciseId,
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: true, historyRevision: 1 });

    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "equipment",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: false, code: "skip_stale" });

    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { modificationType: true, skipReason: true },
    })).resolves.toEqual({
      modificationType: "as_planned",
      skipReason: null,
    });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.userId, ownerId),
      columns: { historyRevision: true },
      orderBy: (session, { desc }) => desc(session.startedAt),
    })).resolves.toEqual({ historyRevision: 1 });
  });

  it("rejects a stale replay after the original skip fence wins", async () => {
    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "equipment",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: true, historyRevision: 1 });

    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "equipment",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: false, code: "skip_stale" });

    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { modificationType: true, skipReason: true },
    })).resolves.toEqual({
      modificationType: "skipped",
      skipReason: "equipment",
    });
  });

  it("restores a workout-added exercise as workout-only after remove and Undo", async () => {
    await database.db
      .update(sessionExercises)
      .set({ modificationType: "added" })
      .where(eq(sessionExercises.id, activeExerciseId));

    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "user_choice",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: true, historyRevision: 1 });
    await expect(confirmExerciseUnskipped({
      sessionExerciseId: activeExerciseId,
      expectedHistoryRevision: 1,
    })).resolves.toMatchObject({
      ok: true,
      historyRevision: 2,
      modificationType: "added",
    });
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { modificationType: true, skipReason: true },
    })).resolves.toEqual({
      modificationType: "added",
      skipReason: null,
    });
  });

  it("rejects a delayed un-skip after a newer skip choice wins", async () => {
    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "equipment",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: true, historyRevision: 1 });
    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "pain",
      expectedHistoryRevision: 1,
    })).resolves.toMatchObject({ ok: true, historyRevision: 2 });

    await expect(confirmExerciseUnskipped({
      sessionExerciseId: activeExerciseId,
      expectedHistoryRevision: 1,
    })).resolves.toMatchObject({ ok: false, code: "unskip_stale" });

    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { modificationType: true, skipReason: true },
    })).resolves.toEqual({
      modificationType: "skipped",
      skipReason: "pain",
    });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.userId, ownerId),
      columns: { historyRevision: true },
      orderBy: (session, { desc }) => desc(session.startedAt),
    })).resolves.toEqual({ historyRevision: 2 });
  });

  it("routes a date-only reviewed active-duration correction through the owner action", async () => {
    await database.db.update(workoutSessions).set({
      finishedAt: null,
      performedTimePrecision: "date_only",
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: ["unknown_time"],
    }).where(eq(workoutSessions.id, completedSessionId));

    await expect(correctWorkoutActiveDuration({
      sessionId: completedSessionId,
      clientMutationId: crypto.randomUUID(),
      expectedHistoryRevision: 0,
      expected: {
        activeDurationSemanticsVersion: 1,
        activeDurationSeconds: 2_700,
        activeDurationBasis: "owner_reported",
      },
      decision: { basis: "interruption_unknown" },
    })).resolves.toMatchObject({
      ok: true,
      outcome: "corrected",
      sessionId: completedSessionId,
      historyRevision: 1,
    });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, completedSessionId),
    })).resolves.toMatchObject({
      finishedAt: null,
      performedTimePrecision: "date_only",
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
      excludeDurationFromAnalytics: true,
      historyRevision: 1,
    });
  });

  it("corrects an acknowledged active-workout set only after review", async () => {
    await expect(correctAcknowledgedSet({
      setId: activeSetId,
      values: {
        weight: 40,
        weightUnit: "lb",
        reps: 10,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      expected: {
        weight: 40,
        weightUnit: "lb",
        reps: 8,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      expectedHistoryRevision: 0,
      clientMutationId: crypto.randomUUID(),
      category: "measurement_entry",
      reasonNote: null,
      source: "active_workout",
      reviewed: true,
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      historyRevision: 1,
    });
    const [saved] = await database.db
      .select({ reps: completedSets.reps })
      .from(completedSets)
      .where(eq(completedSets.id, activeSetId));
    expect(saved.reps).toBe(10);
  });

  it("corrects only a reviewed completed working set and records immutable evidence", async () => {
    const expected = {
      weight: 45,
      weightUnit: "lb" as const,
      reps: 8,
      distanceKm: null,
      durationSeconds: null,
      rpe: null,
      note: null,
    };
    await expect(correctAcknowledgedSet({
      setId: completedSetId,
      values: {
        weight: 47.5,
        weightUnit: "lb",
        reps: 9,
        distanceKm: null,
        durationSeconds: null,
        rpe: 8.5,
        note: "Reviewed after the workout",
      },
      expected,
      expectedHistoryRevision: 0,
      clientMutationId: crypto.randomUUID(),
      category: "measurement_entry",
      reasonNote: "Checked the training log",
      source: "workout_history",
      reviewed: true,
    })).resolves.toMatchObject({ ok: true, changed: true });

    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, completedSetId),
        columns: { weight: true, reps: true, rpe: true, note: true },
      }),
    ).toEqual({
      weight: 47.5,
      reps: 9,
      rpe: 8.5,
      note: "Reviewed after the workout",
    });
    expect(await database.db.query.recordVersions.findMany()).toEqual([
      expect.objectContaining({
        entityType: "completed_set",
        entityId: completedSetId,
        action: "set.completed_correction",
      }),
    ]);

    const [csv, backup, coachContext, history] = await Promise.all([
      buildSetsCsv(database.db, ownerId, null),
      buildJsonBackup(database.db, ownerId),
      buildCoachingContext(
        database.db,
        ownerId,
        {
          aggressiveness: "conservative",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: false,
        },
        new Date("2026-07-22T12:00:00.000Z"),
      ),
      getHistoryReport(
        database.db,
        ownerId,
        "all",
        3,
        new Date("2026-07-22T12:00:00.000Z"),
      ),
    ]);
    expect(csv).toContain("47.5");
    expect(csv).toContain("Reviewed after the workout");
    expect(JSON.stringify(backup.canonical)).toContain("set.completed_correction");
    expect(JSON.stringify(backup.canonical)).toContain("Reviewed after the workout");
    expect(JSON.stringify(coachContext.trainingDigest)).toContain("47.5");
    expect(JSON.stringify(coachContext.trainingDigest)).toContain(
      "exclude from conclusions",
    );
    expect(coachContext.trainingDigest.dataGaps).toContain(
      "1 set metric has limited calculation eligibility and is preserved but excluded from unsupported conclusions."
    );
    expect(history.overview.semanticExclusions).toContainEqual({
      reason: "per_implement_not_aggregatable",
      count: 1,
    });

    await expect(correctAcknowledgedSet({
      setId: completedSetId,
      values: {
        weight: 50,
        weightUnit: "lb",
        reps: 10,
        distanceKm: null,
        durationSeconds: null,
        rpe: 9,
        note: null,
      },
      expected,
      expectedHistoryRevision: 0,
      clientMutationId: crypto.randomUUID(),
      category: "measurement_entry",
      reasonNote: null,
      source: "workout_history",
      reviewed: true,
    })).resolves.toMatchObject({
      ok: false,
      code: "correction_rejected",
    });
    expect(await database.db.query.recordVersions.findMany()).toHaveLength(1);
  });

  it("rejects a stale correction surface when the workout phase changed", async () => {
    await expect(correctAcknowledgedSet({
      setId: activeSetId,
      values: {
        weight: 40,
        weightUnit: "lb",
        reps: 9,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      expected: {
        weight: 40,
        weightUnit: "lb",
        reps: 8,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      expectedHistoryRevision: 0,
      clientMutationId: crypto.randomUUID(),
      category: "measurement_entry",
      reasonNote: null,
      source: "workout_history",
      reviewed: true,
    })).resolves.toMatchObject({ ok: false, code: "correction_stale_context" });
    expect(await database.db.query.recordVersions.findMany()).toHaveLength(0);
  });
});
