import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  exercisePrescriptions,
  exercises,
  programs,
  programVersions,
  progressionJobs,
  recommendations,
  sessionExercises,
  userProfiles,
  users,
  workoutTemplateExercises,
  workoutTemplates,
  workoutSessions,
} from "@/db/schema";
import { normalizeWorkoutTimingCorrection } from "@/lib/workout-timing-correction";
import { restoreRecordVersion } from "@/services/record-versions";
import { correctCompletedWorkoutTiming } from "@/services/workout-timing-corrections";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

const now = new Date("2026-07-26T16:00:00.000Z");

describe("completed workout timing correction", () => {
  let database: TestDatabase;
  let userId: string;
  let sessionId: string;
  let setId: string;
  let slotLineageId: string;
  let sourceTemplateExerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `timing-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId,
      setupCompletedAt: now,
      timezone: "America/Toronto",
    });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: `Timing test ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    await database.db.transaction(async (tx) => {
      const [program] = await tx
        .insert(programs)
        .values({
          userId,
          name: "Timing correction Program",
          status: "archived",
          archivedAt: now,
        })
        .returning({ id: programs.id });
      const [version] = await tx
        .insert(programVersions)
        .values({ programId: program.id, activatedAt: now })
        .returning({ id: programVersions.id });
      const [template] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: version.id,
          name: "Timing correction day",
        })
        .returning({ id: workoutTemplates.id });
      const [slot] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: template.id,
          exerciseId: exercise.id,
          orderIdx: 0,
        })
        .returning({
          id: workoutTemplateExercises.id,
          lineageId: workoutTemplateExercises.lineageId,
        });
      sourceTemplateExerciseId = slot.id;
      slotLineageId = slot.lineageId;
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 1,
        repRangeMin: 6,
        repRangeMax: 8,
      });
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: version.id,
        })
        .where(eq(programs.id, program.id));
    });
    [{ id: sessionId }] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Timing correction workout",
        status: "completed",
        startedAt: new Date("2026-07-02T14:00:00.000Z"),
        finishedAt: new Date("2026-07-02T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-02",
      })
      .returning({ id: workoutSessions.id });
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId: exercise.id,
        sourceSlotLineageId: slotLineageId,
      })
      .returning({ id: sessionExercises.id });
    [{ id: setId }] = await database.db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        reps: 8,
      })
      .returning({ id: completedSets.id });
  });

  afterEach(async () => {
    await database.close();
  });

  function correction(
    mutationId = crypto.randomUUID(),
    localDate = "2026-07-01",
  ) {
    return {
      sessionId,
      clientMutationId: mutationId,
      expectedHistoryRevision: 0,
      reviewed: true as const,
      expected: {
        startedAtISO: "2026-07-02T14:00:00.000Z",
        finishedAtISO: "2026-07-02T15:00:00.000Z",
        timezone: "America/Toronto",
        localDate: "2026-07-02",
        precision: "instant" as const,
        excludeDurationFromAnalytics: false,
      },
      proposed: {
        timezone: "America/Toronto",
        localDate,
        timing: {
          precision: "instant" as const,
          localStartTime: "09:30:00",
          ambiguityChoice: null,
          durationSeconds: 3_600,
        },
      },
    };
  }

  it("normalizes date-only and explicit DST cases without guessing", () => {
    const dateOnly = normalizeWorkoutTimingCorrection(
      {
        ...correction(),
        proposed: {
          timezone: "America/Toronto",
          localDate: "2026-07-01",
          timing: { precision: "date_only" },
        },
      },
      now,
    );
    expect(dateOnly).toMatchObject({
      startedAt: new Date("2026-07-01T16:00:00.000Z"),
      finishedAt: null,
      performedTimePrecision: "date_only",
      excludeDurationFromAnalytics: true,
    });

    expect(() =>
      normalizeWorkoutTimingCorrection(
        {
          ...correction(),
          proposed: {
            timezone: "America/Toronto",
            localDate: "2026-03-08",
            timing: {
              precision: "instant",
              localStartTime: "02:30",
              ambiguityChoice: null,
              durationSeconds: null,
            },
          },
        },
        now,
      ),
    ).toThrow(/does not exist/);

    expect(() =>
      normalizeWorkoutTimingCorrection(
        {
          ...correction(),
          proposed: {
            timezone: "America/Toronto",
            localDate: "2026-11-01",
            timing: {
              precision: "instant",
              localStartTime: "01:30",
              ambiguityChoice: null,
              durationSeconds: null,
            },
          },
        },
        new Date("2026-11-03T00:00:00.000Z"),
      ),
    ).toThrow(/occurs twice/);
  });

  it("corrects atomically, reconciles exact retries, rejects stale tabs, and restores", async () => {
    const [pendingRecommendation, approvedRecommendation] =
      await database.db
        .insert(recommendations)
        .values([
          {
            userId,
            status: "pending",
            source: "rule",
            ruleId: "timing-correction-pending",
            sourceTemplateExerciseId,
            sourceSlotLineageId: slotLineageId,
            payload: {
              kind: "hold",
              templateExerciseId: sourceTemplateExerciseId,
              reason: "pending evidence",
            },
            reason: "pending evidence",
            evidence: { sessionIds: [sessionId], signals: {} },
          },
          {
            userId,
            status: "approved",
            source: "rule",
            ruleId: "timing-correction-approved",
            sourceTemplateExerciseId,
            sourceSlotLineageId: slotLineageId,
            payload: {
              kind: "hold",
              templateExerciseId: sourceTemplateExerciseId,
              reason: "approved evidence",
            },
            reason: "approved evidence",
            evidence: { sessionIds: [sessionId], signals: {} },
            decidedAt: now,
          },
        ])
        .returning({ id: recommendations.id });
    const mutationId = crypto.randomUUID();
    const input = correction(mutationId);
    await expect(
      correctCompletedWorkoutTiming(database.db, userId, input, now),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "corrected",
      historyRevision: 1,
    });
    await expect(
      correctCompletedWorkoutTiming(database.db, userId, input, now),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "replayed",
      versionId: mutationId,
    });
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
        columns: {
          startedAt: true,
          finishedAt: true,
          localDate: true,
          historyRevision: true,
        },
      }),
    ).toEqual({
      startedAt: new Date("2026-07-01T13:30:00.000Z"),
      finishedAt: new Date("2026-07-01T14:30:00.000Z"),
      localDate: "2026-07-01",
      historyRevision: 1,
    });
    const [version] = await database.db.query.recordVersions.findMany();
    expect(version).toMatchObject({
      id: mutationId,
      entityType: "workout_session",
      entityId: sessionId,
      action: "workout_session.timing_correction",
      changedFields: ["finished_at", "local_date", "started_at"],
    });
    expect(
      await database.db.query.progressionJobs.findMany({
        where: eq(progressionJobs.sessionId, sessionId),
      }),
    ).toHaveLength(1);
    await expect(
      database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, pendingRecommendation.id),
        columns: {
          status: true,
          reconciledAt: true,
          reconciliationReason: true,
        },
      }),
    ).resolves.toMatchObject({
      status: "expired",
      reconciledAt: expect.any(Date),
      reconciliationReason: expect.stringContaining("timing was corrected"),
    });
    await expect(
      database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, approvedRecommendation.id),
        columns: { status: true, reconciledAt: true },
      }),
    ).resolves.toEqual({ status: "approved", reconciledAt: null });

    await expect(
      correctCompletedWorkoutTiming(
        database.db,
        userId,
        correction(crypto.randomUUID()),
        now,
      ),
    ).resolves.toMatchObject({ ok: false, code: "stale" });

    const restoreMutationId = crypto.randomUUID();
    await expect(
      restoreRecordVersion(database.db, userId, version.id, {
        clientMutationId: restoreMutationId,
        expectedHistoryRevision: 1,
      }),
    ).resolves.toMatchObject({ ok: true, changed: true });
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
        columns: {
          startedAt: true,
          finishedAt: true,
          localDate: true,
          historyRevision: true,
        },
      }),
    ).toEqual({
      startedAt: new Date("2026-07-02T14:00:00.000Z"),
      finishedAt: new Date("2026-07-02T15:00:00.000Z"),
      localDate: "2026-07-02",
      historyRevision: 2,
    });
    expect(await database.db.query.recordVersions.findMany()).toHaveLength(2);
  });

  it("distinguishes stale, active, archived, and unavailable correction targets", async () => {
    const stale = correction();
    stale.expectedHistoryRevision = 1;
    await expect(
      correctCompletedWorkoutTiming(database.db, userId, stale, now),
    ).resolves.toMatchObject({ ok: false, code: "stale" });

    await database.db
      .update(workoutSessions)
      .set({ status: "in_progress", finishedAt: null })
      .where(eq(workoutSessions.id, sessionId));
    await expect(
      correctCompletedWorkoutTiming(database.db, userId, correction(), now),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_state",
      reason: expect.stringContaining("Only completed"),
    });

    await database.db
      .update(workoutSessions)
      .set({ status: "completed", finishedAt: now, archivedAt: now })
      .where(eq(workoutSessions.id, sessionId));
    await expect(
      correctCompletedWorkoutTiming(database.db, userId, correction(), now),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_state",
      reason: expect.stringContaining("archived"),
    });

    await expect(
      correctCompletedWorkoutTiming(
        database.db,
        crypto.randomUUID(),
        correction(),
        now,
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_state",
      reason: expect.stringContaining("not available"),
    });
  });

  it("preserves exact set timing by refusing an inconsistent workout correction", async () => {
    await database.db
      .update(completedSets)
      .set({
        observedCompletedAt: new Date("2026-07-02T14:20:00.000Z"),
        observedCompletionProvenance: "live_client",
        observedCompletionQuality: "trustworthy",
      })
      .where(eq(completedSets.id, setId));

    await expect(
      correctCompletedWorkoutTiming(
        database.db,
        userId,
        correction(),
        now,
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "observed_set_conflict",
    });
    expect(await database.db.query.recordVersions.findMany()).toHaveLength(0);
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
        columns: { localDate: true, historyRevision: true },
      }),
    ).toEqual({ localDate: "2026-07-02", historyRevision: 0 });
  });
});
