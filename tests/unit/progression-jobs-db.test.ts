import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  auditLogs,
  completedSets,
  exercisePrescriptions,
  exercises,
  programs,
  progressionJobInputSessions,
  progressionJobs,
  programVersions,
  recommendations,
  sessionExercises,
  sessionOccurrences,
  userDecisions,
  userProfiles,
  users,
  workoutTemplateExercises,
  workoutTemplates,
  workoutSessions,
} from "@/db/schema";
import {
  completeWorkoutSession,
  startWorkoutSession,
} from "@/services/session-lifecycle";
import { logWorkoutSet } from "../helpers/log-workout-set";
import {
  claimProgressionJob,
  drainProgressionJobs,
  processProgressionJob,
} from "@/services/progression-jobs";
import { evaluateRecentProgression } from "@/services/progression";
import { buildJsonBackup } from "@/services/export";
import {
  getOrCreateProgramDraft,
  reviewProgramDraft,
  saveProgramDraft,
} from "@/services/program-drafts";
import { publishProgramDraft } from "@/services/program-publication";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("durable progression job handoff", () => {
  let database: TestDatabase;
  let userId: string;
  let programId: string;
  let versionId: string;
  let exerciseId: string;
  let slotLineageId: string;
  let templateId: string;

  const coachingPrefs = {
    aggressiveness: "aggressive" as const,
    deloadSuggestions: true,
    substitutionSuggestions: true,
    weeklyReview: true,
  };

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `progression-job-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId, unit: "lb" });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Progression Job Squat",
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        // Progression behavior is isolated here from exact implement selection.
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    exerciseId = exercise.id;
    await database.db.transaction(async (tx) => {
      const [program] = await tx
        .insert(programs)
        .values({
          userId,
          name: "Progression Job Program",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      programId = program.id;
      const [version] = await tx
        .insert(programVersions)
        .values({ programId: program.id, activatedAt: new Date() })
        .returning({ id: programVersions.id });
      versionId = version.id;
      [{ id: templateId }] = await tx
        .insert(workoutTemplates)
        .values({ programVersionId: version.id, name: "Progression Job Day" })
        .returning({ id: workoutTemplates.id });
      const [slot] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: templateId,
          exerciseId: exercise.id,
          orderIdx: 0,
        })
        .returning({
          id: workoutTemplateExercises.id,
          lineageId: workoutTemplateExercises.lineageId,
        });
      slotLineageId = slot.lineageId;
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 1,
        repRangeMin: 6,
        repRangeMax: 8,
        targetLoad: 100,
        targetLoadUnit: "lb",
      });
      await tx
        .update(programs)
        .set({ status: "active", archivedAt: null, currentVersionId: version.id })
        .where(eq(programs.id, program.id));
    });
  }, 30_000);

  afterEach(async () => database.close());

  async function completeFixture() {
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      templateId
    );
    const [sessionExercise] = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, sessionId));
    const equipmentSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId,
        sessionId,
        sessionExerciseId: sessionExercise.id,
        unit: "lb",
      },
    );
    const [logged] = await database.db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        metricType: "weight_reps",
        equipmentSnapshotId,
        loadEntryMeaning: "total_system",
      })
      .returning({ id: completedSets.id });
    await database.db
      .update(sessionOccurrences)
      .set({
        outcome: "completed",
        resolvedAt: new Date(),
        completedSetId: logged.id,
        equipmentSnapshotId,
        revision: sql`${sessionOccurrences.revision} + 1`,
      })
      .where(eq(sessionOccurrences.sessionExerciseId, sessionExercise.id));
    const result = await completeWorkoutSession(
      database.db,
      { id: userId, coachingPrefs },
      { sessionId, note: "Durable first", fatigue: 2 }
    );
    const progressionJobId = result.progressionJobId;
    if (!progressionJobId) throw new Error("Progression job missing");
    return {
      ...result,
      progressionJobId,
      sessionId,
      sessionExerciseId: sessionExercise.id,
    };
  }

  it("finishes the workout with a pending job before progression runs", async () => {
    const result = await completeFixture();
    expect(result.alreadyFinished).toBe(false);
    expect(await database.db.select().from(recommendations)).toHaveLength(0);
    expect(await database.db.select().from(progressionJobs)).toEqual([
      expect.objectContaining({
        id: result.progressionJobId,
        sessionId: result.sessionId,
        status: "pending",
        attempts: 0,
      }),
    ]);
    const backup = await buildJsonBackup(database.db, userId);
    expect(backup.schemaVersion).toBe("31");
    expect(backup.canonical.tables.progression_jobs).toEqual([
      expect.objectContaining({ id: result.progressionJobId }),
    ]);
  });

  it("processes an already-queued current-revision job for an on-demand review", async () => {
    const result = await completeFixture();

    await expect(
      evaluateRecentProgression(database.db, userId, coachingPrefs),
    ).resolves.toBe(1);

    expect(
      await database.db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, result.progressionJobId),
      }),
    ).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("contains a captured job when current exercise semantics no longer support load claims", async () => {
    const result = await completeFixture();
    await database.db
      .update(exercises)
      .set({
        metricType: "assisted_reps",
        loadSemantics: "assistance",
      })
      .where(eq(exercises.id, exerciseId));

    await expect(
      processProgressionJob(database.db, result.progressionJobId)
    ).resolves.toMatchObject({ status: "completed" });
    expect(await database.db.select().from(recommendations)).toHaveLength(0);
  });

  it("reopens a completed current-revision job with current coaching preferences", async () => {
    const result = await completeFixture();
    const conservativePrefs = {
      ...coachingPrefs,
      aggressiveness: "conservative" as const,
    };

    await expect(
      evaluateRecentProgression(database.db, userId, conservativePrefs),
    ).resolves.toBe(1);
    expect(await database.db.select().from(recommendations)).toHaveLength(0);

    await expect(
      evaluateRecentProgression(database.db, userId, coachingPrefs),
    ).resolves.toBe(1);

    expect(await database.db.select().from(progressionJobs)).toEqual([
      expect.objectContaining({
        id: result.progressionJobId,
        sourceSessionRevision: 0,
        coachingPrefs,
        status: "completed",
        attempts: 1,
      }),
    ]);
    const [pendingRecommendation] = await database.db.select().from(recommendations);
    expect(pendingRecommendation).toEqual(
      expect.objectContaining({
        progressionJobId: result.progressionJobId,
        source: "rule",
        status: "pending",
      }),
    );

    await expect(
      evaluateRecentProgression(database.db, userId, conservativePrefs),
    ).resolves.toBe(1);
    expect(await database.db.select().from(recommendations)).toEqual([
      expect.objectContaining({
        progressionJobId: result.progressionJobId,
        status: "expired",
        reconciliationReason:
          "Superseded by progression re-evaluation.",
      }),
    ]);

    await expect(
      evaluateRecentProgression(database.db, userId, coachingPrefs),
    ).resolves.toBe(1);
    expect(await database.db.select().from(recommendations)).toEqual([
      expect.objectContaining({
        id: pendingRecommendation.id,
        progressionJobId: result.progressionJobId,
        status: "pending",
        reconciliationReason: null,
        reconciledAt: null,
      }),
    ]);
  });

  it("leases one job to only one competing worker", async () => {
    const { progressionJobId } = await completeFixture();
    const first = await claimProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseSeconds: 10,
    });
    expect(first).not.toBeNull();
    const second = await claimProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:05.000Z"),
      leaseSeconds: 10,
    });
    expect(second).toBeNull();
  });

  it("does not reopen or rewrite an actively leased job during on-demand review", async () => {
    const { progressionJobId } = await completeFixture();
    const claimed = await claimProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseSeconds: 60,
    });
    expect(claimed).not.toBeNull();

    const conservativePrefs = {
      ...coachingPrefs,
      aggressiveness: "conservative" as const,
    };
    await expect(
      evaluateRecentProgression(database.db, userId, conservativePrefs),
    ).resolves.toBe(0);

    expect(
      await database.db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, progressionJobId),
      }),
    ).toMatchObject({
      status: "processing",
      coachingPrefs,
      attempts: 1,
      leaseToken: claimed?.leaseToken,
      leasedUntil: new Date("2030-01-01T00:01:00.000Z"),
    });
  });

  it("reclaims an expired lease during on-demand review", async () => {
    const { progressionJobId } = await completeFixture();
    await expect(
      claimProgressionJob(database.db, progressionJobId, {
        now: () => new Date("2030-01-01T00:00:00.000Z"),
        leaseSeconds: 60,
      }),
    ).resolves.not.toBeNull();
    await database.db
      .update(progressionJobs)
      .set({ leasedUntil: new Date("2020-01-01T00:01:00.000Z") })
      .where(eq(progressionJobs.id, progressionJobId));
    const conservativePrefs = {
      ...coachingPrefs,
      aggressiveness: "conservative" as const,
    };

    await expect(
      evaluateRecentProgression(database.db, userId, conservativePrefs),
    ).resolves.toBe(1);
    expect(
      await database.db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, progressionJobId),
      }),
    ).toMatchObject({
      status: "completed",
      coachingPrefs: conservativePrefs,
      attempts: 2,
      leaseToken: null,
      leasedUntil: null,
    });
  });

  it("recaptures the current progression input window during on-demand review", async () => {
    const older = await completeFixture();
    await database.db
      .update(workoutSessions)
      .set({
        startedAt: new Date("2026-01-01T12:00:00.000Z"),
        finishedAt: new Date("2026-01-01T13:00:00.000Z"),
        localDate: "2026-01-01",
      })
      .where(eq(workoutSessions.id, older.sessionId));
    const latest = await completeFixture();
    await database.db
      .update(workoutSessions)
      .set({
        startedAt: new Date("2026-01-02T12:00:00.000Z"),
        finishedAt: new Date("2026-01-02T13:00:00.000Z"),
        localDate: "2026-01-02",
      })
      .where(eq(workoutSessions.id, latest.sessionId));
    await evaluateRecentProgression(database.db, userId, coachingPrefs);

    await database.db
      .update(workoutSessions)
      .set({ historyRevision: 1 })
      .where(eq(workoutSessions.id, older.sessionId));
    await expect(
      evaluateRecentProgression(database.db, userId, coachingPrefs),
    ).resolves.toBe(1);

    expect(
      await database.db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, latest.progressionJobId),
      }),
    ).toMatchObject({ status: "completed", lastError: null });
    expect(
      await database.db
        .select()
        .from(progressionJobInputSessions)
        .where(eq(progressionJobInputSessions.jobId, latest.progressionJobId)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: older.sessionId,
          historyRevision: 1,
        }),
        expect.objectContaining({
          sessionId: latest.sessionId,
          historyRevision: 0,
        }),
      ]),
    );

    const [decided] = await database.db
      .select()
      .from(recommendations)
      .where(eq(recommendations.progressionJobId, latest.progressionJobId));
    await database.db
      .update(recommendations)
      .set({ status: "approved", decidedAt: new Date() })
      .where(eq(recommendations.id, decided.id));
    await database.db.insert(userDecisions).values({
      recommendationId: decided.id,
      decision: "approve",
    });
    await database.db
      .update(workoutSessions)
      .set({ historyRevision: 2 })
      .where(eq(workoutSessions.id, older.sessionId));

    await expect(
      evaluateRecentProgression(database.db, userId, coachingPrefs),
    ).resolves.toBe(0);
    expect(
      await database.db
        .select()
        .from(progressionJobInputSessions)
        .where(eq(progressionJobInputSessions.jobId, latest.progressionJobId)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: older.sessionId,
          historyRevision: 1,
        }),
      ]),
    );
  });

  it("revokes an expired lease before on-demand takeover", async () => {
    const { progressionJobId } = await completeFixture();
    let releaseOldWorker!: () => void;
    let signalOldClaim!: () => void;
    const oldClaimed = new Promise<void>((resolve) => {
      signalOldClaim = resolve;
    });
    const holdOldWorker = new Promise<void>((resolve) => {
      releaseOldWorker = resolve;
    });
    const oldWorker = processProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseSeconds: 60,
      afterClaim: async () => {
        signalOldClaim();
        await holdOldWorker;
      },
    });
    await oldClaimed;
    await database.db
      .update(progressionJobs)
      .set({ leasedUntil: new Date("2020-01-01T00:01:00.000Z") })
      .where(eq(progressionJobs.id, progressionJobId));

    await expect(
      evaluateRecentProgression(database.db, userId, coachingPrefs),
    ).resolves.toBe(1);
    releaseOldWorker();
    await expect(oldWorker).resolves.toEqual({
      status: "lease_lost",
      jobId: progressionJobId,
    });
    expect(await database.db.select().from(progressionJobs)).toEqual([
      expect.objectContaining({
        id: progressionJobId,
        status: "completed",
        attempts: 2,
        leaseToken: null,
      }),
    ]);
  });

  it("does not clear evidence from an exhausted expired lease", async () => {
    const { progressionJobId } = await completeFixture();
    const claim = await claimProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseSeconds: 60,
    });
    await database.db
      .update(progressionJobs)
      .set({
        attempts: 5,
        leasedUntil: new Date("2020-01-01T00:01:00.000Z"),
      })
      .where(eq(progressionJobs.id, progressionJobId));
    const inputs = await database.db
      .select()
      .from(progressionJobInputSessions)
      .where(eq(progressionJobInputSessions.jobId, progressionJobId));

    await expect(
      evaluateRecentProgression(database.db, userId, coachingPrefs),
    ).resolves.toBe(0);
    expect(
      await database.db
        .select()
        .from(progressionJobInputSessions)
        .where(eq(progressionJobInputSessions.jobId, progressionJobId)),
    ).toEqual(inputs);
    expect(
      await database.db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, progressionJobId),
      }),
    ).toMatchObject({
      status: "processing",
      attempts: 5,
      leaseToken: claim?.leaseToken,
      leasedUntil: new Date("2020-01-01T00:01:00.000Z"),
    });
  });

  it("does not reopen a job whose recommendation was archived", async () => {
    const { progressionJobId } = await completeFixture();
    await evaluateRecentProgression(database.db, userId, coachingPrefs);
    const [recommendation] = await database.db.select().from(recommendations);
    await database.db
      .update(recommendations)
      .set({ archivedAt: new Date() })
      .where(eq(recommendations.id, recommendation.id));
    const inputs = await database.db
      .select()
      .from(progressionJobInputSessions)
      .where(eq(progressionJobInputSessions.jobId, progressionJobId));

    await expect(
      evaluateRecentProgression(database.db, userId, coachingPrefs),
    ).resolves.toBe(0);
    expect(
      await database.db
        .select()
        .from(progressionJobInputSessions)
        .where(eq(progressionJobInputSessions.jobId, progressionJobId)),
    ).toEqual(inputs);
    expect(
      await database.db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, progressionJobId),
      }),
    ).toMatchObject({ status: "completed" });
    expect(await database.db.select().from(recommendations)).toEqual([
      expect.objectContaining({
        id: recommendation.id,
        status: "pending",
        archivedAt: expect.any(Date),
      }),
    ]);
  });

  it("propagates an on-demand worker failure instead of publishing stale review input", async () => {
    await completeFixture();
    const injected = new Error("injected on-demand worker failure");

    await expect(
      evaluateRecentProgression(database.db, userId, coachingPrefs, {
        processJob: async (_db, jobId) => ({
          status: "failed",
          jobId,
          retryScheduled: true,
          error: injected,
        }),
      }),
    ).rejects.toBe(injected);
  });

  it("keeps the prior pending recommendation when on-demand re-evaluation fails", async () => {
    const { progressionJobId } = await completeFixture();
    await evaluateRecentProgression(database.db, userId, coachingPrefs);
    const [prior] = await database.db.select().from(recommendations);
    expect(prior).toMatchObject({
      progressionJobId,
      status: "pending",
    });
    await database.db
      .update(progressionJobs)
      .set({
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(0),
        completedAt: null,
      })
      .where(eq(progressionJobs.id, progressionJobId));

    await expect(
      processProgressionJob(database.db, progressionJobId, {
        evaluate: async () => {
          throw new Error("injected on-demand refresh failure");
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      retryScheduled: true,
    });

    expect(await database.db.select().from(recommendations)).toEqual([
      expect.objectContaining({
        id: prior.id,
        status: "pending",
        reconciliationReason: null,
        reconciledAt: null,
      }),
    ]);

    await database.db
      .update(progressionJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(progressionJobs.id, progressionJobId));
    await expect(
      processProgressionJob(database.db, progressionJobId),
    ).resolves.toMatchObject({ status: "completed" });
    expect(await database.db.select().from(recommendations)).toEqual([
      expect.objectContaining({
        id: prior.id,
        status: "pending",
        reconciliationReason: null,
        reconciledAt: null,
      }),
    ]);
  });

  it("rejects inconsistent lease and completion states at the database boundary", async () => {
    const { progressionJobId } = await completeFixture();
    await expect(
      database.db
        .update(progressionJobs)
        .set({ status: "processing" })
        .where(eq(progressionJobs.id, progressionJobId))
    ).rejects.toThrow();
    await expect(
      database.db
        .update(progressionJobs)
        .set({ completedAt: new Date() })
        .where(eq(progressionJobs.id, progressionJobId))
    ).rejects.toThrow();
    expect(
      await database.db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, progressionJobId),
      })
    ).toMatchObject({ status: "pending", leaseToken: null, completedAt: null });
  });

  it("releases a failed job with backoff and safely retries it", async () => {
    const { progressionJobId } = await completeFixture();
    const firstNow = new Date("2030-01-01T00:00:00.000Z");
    const failed = await processProgressionJob(database.db, progressionJobId, {
      now: () => firstNow,
      evaluate: async () => {
        throw new Error("injected progression failure");
      },
    });
    expect(failed.status).toBe("failed");
    expect(await database.db.select().from(progressionJobs)).toEqual([
      expect.objectContaining({
        status: "pending",
        attempts: 1,
        lastError: "injected progression failure",
      }),
    ]);

    const retry = await processProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:03.000Z"),
      evaluate: async () => undefined,
    });
    expect(retry.status).toBe("completed");
    expect(await database.db.select().from(progressionJobs)).toEqual([
      expect.objectContaining({ status: "completed", attempts: 2 }),
    ]);
  });

  it("initializes missing input evidence for a legacy job that already has attempts", async () => {
    const { progressionJobId, sessionId } = await completeFixture();
    await database.db
      .update(progressionJobs)
      .set({ attempts: 2 })
      .where(eq(progressionJobs.id, progressionJobId));

    await expect(
      processProgressionJob(database.db, progressionJobId),
    ).resolves.toMatchObject({ status: "completed" });
    expect(
      await database.db
        .select()
        .from(progressionJobInputSessions)
        .where(eq(progressionJobInputSessions.jobId, progressionJobId)),
    ).toEqual([
      expect.objectContaining({
        jobId: progressionJobId,
        sessionId,
        sourceSlotLineageId: slotLineageId,
        historyRevision: 0,
      }),
    ]);
  });

  it("reclaims an expired lease but never a live lease", async () => {
    const { progressionJobId } = await completeFixture();
    const first = await claimProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseSeconds: 10,
    });
    expect(first).not.toBeNull();
    await expect(
      claimProgressionJob(database.db, progressionJobId, {
        now: () => new Date("2030-01-01T00:00:05.000Z"),
        leaseSeconds: 10,
      })
    ).resolves.toBeNull();
    const reclaimed = await claimProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:11.000Z"),
      leaseSeconds: 10,
    });
    expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("completes a superseded job without recommendations when captured history changes", async () => {
    const { progressionJobId, sessionId } = await completeFixture();
    const first = await claimProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseSeconds: 1,
    });
    expect(first).not.toBeNull();
    await database.db
      .update(workoutSessions)
      .set({ historyRevision: 1 })
      .where(eq(workoutSessions.id, sessionId));

    await expect(processProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:02.000Z"),
    })).resolves.toEqual({ status: "stale", jobId: progressionJobId });
    expect(await database.db.select().from(recommendations)).toHaveLength(0);
    expect(
      await database.db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, progressionJobId),
      }),
    ).toMatchObject({
      status: "completed",
      lastError: expect.stringContaining("Superseded progression input"),
    });
  });

  it("preserves a decided recommendation when captured history becomes stale", async () => {
    const { progressionJobId, sessionId } = await completeFixture();
    await evaluateRecentProgression(database.db, userId, coachingPrefs);
    const [recommendation] = await database.db.select().from(recommendations);
    await database.db
      .update(recommendations)
      .set({ status: "approved", decidedAt: new Date() })
      .where(eq(recommendations.id, recommendation.id));
    await database.db.insert(userDecisions).values({
      recommendationId: recommendation.id,
      decision: "approve",
    });
    await database.db
      .update(progressionJobs)
      .set({
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(0),
        completedAt: null,
      })
      .where(eq(progressionJobs.id, progressionJobId));
    await claimProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseSeconds: 1,
    });
    await database.db
      .update(workoutSessions)
      .set({ historyRevision: 1 })
      .where(eq(workoutSessions.id, sessionId));

    await expect(
      processProgressionJob(database.db, progressionJobId, {
        now: () => new Date("2030-01-01T00:00:02.000Z"),
      }),
    ).resolves.toEqual({ status: "stale", jobId: progressionJobId });
    expect(await database.db.select().from(recommendations)).toEqual([
      expect.objectContaining({
        id: recommendation.id,
        status: "approved",
      }),
    ]);
    expect(await database.db.select().from(userDecisions)).toEqual([
      expect.objectContaining({
        recommendationId: recommendation.id,
        decision: "approve",
      }),
    ]);
  });

  it("does not duplicate a recommendation when the worker fails after evaluation", async () => {
    const { progressionJobId } = await completeFixture();
    const failed = await processProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      checkpoint: async () => {
        throw new Error("lost acknowledgement after evaluation");
      },
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual(
      expect.objectContaining({ message: "lost acknowledgement after evaluation" })
    );
    expect(await database.db.select().from(recommendations)).toHaveLength(0);

    const retried = await processProgressionJob(database.db, progressionJobId, {
      now: () => new Date("2030-01-01T00:00:03.000Z"),
    });
    expect(retried.status).toBe("completed");
    expect(await database.db.select().from(recommendations)).toHaveLength(1);
    const audits = await database.db.select().from(auditLogs);
    expect(audits.filter(({ action }) => action === "recommendation.create")).toHaveLength(1);
  });

  it("finishes a queued progression job against the matching slot in the current version", async () => {
    const { progressionJobId } = await completeFixture();
    let currentSlotId = "";
    await database.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(programVersions)
        .values({
          programId,
          versionNo: 2,
          parentVersionId: versionId,
          publicationSource: "editor",
          activatedAt: new Date(),
        })
        .returning({ id: programVersions.id });
      const [template] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: version.id,
          name: "Renamed Progression Day",
        })
        .returning({ id: workoutTemplates.id });
      const [slot] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: template.id,
          exerciseId,
          lineageId: slotLineageId,
          orderIdx: 0,
        })
        .returning({ id: workoutTemplateExercises.id });
      currentSlotId = slot.id;
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 1,
        repRangeMin: 6,
        repRangeMax: 8,
        targetLoad: 100,
        targetLoadUnit: "lb",
      });
      await tx
        .update(programs)
        .set({ currentVersionId: version.id })
        .where(eq(programs.id, programId));
    });

    await expect(
      processProgressionJob(database.db, progressionJobId)
    ).resolves.toMatchObject({ status: "completed" });
    const [recommendation] = await database.db.select().from(recommendations);
    expect(recommendation).toMatchObject({
      status: "pending",
      sourceTemplateExerciseId: currentSlotId,
      sourceSlotLineageId: slotLineageId,
    });
    expect(recommendation.payload).toMatchObject({
      kind: "load_change",
      templateExerciseId: currentSlotId,
      fromLoad: 100,
      toLoad: 105,
    });
  });

  it("does not carry progression into a replacement slot with new lineage", async () => {
    const { progressionJobId } = await completeFixture();
    await database.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(programVersions)
        .values({
          programId,
          versionNo: 2,
          parentVersionId: versionId,
          publicationSource: "editor",
          activatedAt: new Date(),
        })
        .returning({ id: programVersions.id });
      const [template] = await tx
        .insert(workoutTemplates)
        .values({ programVersionId: version.id, name: "Replacement Day" })
        .returning({ id: workoutTemplates.id });
      const [slot] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: template.id,
          exerciseId,
          lineageId: crypto.randomUUID(),
          orderIdx: 0,
        })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 1,
        repRangeMin: 6,
        repRangeMax: 8,
        targetLoad: 100,
        targetLoadUnit: "lb",
      });
      await tx
        .update(programs)
        .set({ currentVersionId: version.id })
        .where(eq(programs.id, programId));
    });

    await expect(
      processProgressionJob(database.db, progressionJobId)
    ).resolves.toMatchObject({ status: "completed" });
    expect(await database.db.select().from(recommendations)).toHaveLength(0);
  });

  it("honors a held target without creating a progression recommendation", async () => {
    const state = await getOrCreateProgramDraft(database.db, userId);
    if (!state) throw new Error("Program draft missing.");
    const document = structuredClone(state.draft.document);
    document.name = "Held Progression Program";
    document.days[0].exercises[0].progressionRuleId = "hold";
    const saved = await saveProgramDraft(database.db, userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      mutationId: crypto.randomUUID(),
      document,
    });
    if (saved.status !== "saved") throw new Error("Held draft did not save.");
    const review = await reviewProgramDraft(
      database.db,
      userId,
      state.draft.id,
      saved.revision
    );
    if (!review || review.status !== "publishable") {
      throw new Error("Held draft did not review.");
    }
    const published = await publishProgramDraft(database.db, userId, {
      draftId: state.draft.id,
      expectedRevision: saved.revision,
      reviewHash: review.hash,
    });
    if (!published.ok) throw new Error(published.reason);
    const currentTemplate = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, published.programVersionId),
    });
    if (!currentTemplate) throw new Error("Held template missing.");
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      currentTemplate.id
    );
    const sessionExercise = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, sessionId),
    });
    if (!sessionExercise) throw new Error("Held session exercise missing.");
    const logged = await logWorkoutSet(database.db, userId, {
      sessionExerciseId: sessionExercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: crypto.randomUUID(),
    });
    if (logged.outcome !== "saved") {
      throw new Error(`Held progression set did not save: ${logged.outcome}`);
    }
    const completed = await completeWorkoutSession(
      database.db,
      { id: userId, coachingPrefs },
      { sessionId }
    );
    if (!completed.progressionJobId) throw new Error("Held progression job missing.");
    await expect(processProgressionJob(database.db, completed.progressionJobId))
      .resolves.toMatchObject({ status: "completed" });
    expect(await database.db.select().from(recommendations)).toHaveLength(0);
  });

  it("drains only the configured number of ready jobs and reports the remainder", async () => {
    await completeFixture();
    await completeFixture();
    await completeFixture();

    const result = await drainProgressionJobs(database.db, { maxJobs: 2 });
    expect(result).toMatchObject({
      attempted: 2,
      completed: 2,
      bounded: true,
      after: { ready: 1 },
    });
  });

  it("allows concurrent drainers without processing one job twice", async () => {
    await completeFixture();
    await completeFixture();
    await completeFixture();
    await Promise.all([
      drainProgressionJobs(database.db, { maxJobs: 10 }),
      drainProgressionJobs(database.db, { maxJobs: 10 }),
    ]);

    const jobs = await database.db.select().from(progressionJobs);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.status === "completed")).toBe(true);
    expect(jobs.every((job) => job.attempts === 1)).toBe(true);
  });

  it("recovers an expired lease at the retry limit as a permanent failure", async () => {
    const { progressionJobId } = await completeFixture();
    await database.db
      .update(progressionJobs)
      .set({
        status: "processing",
        attempts: 5,
        leaseToken: crypto.randomUUID(),
        leasedUntil: new Date("2029-12-31T23:59:00.000Z"),
      })
      .where(eq(progressionJobs.id, progressionJobId));

    const result = await drainProgressionJobs(database.db, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(result).toMatchObject({
      attempted: 0,
      exhaustedRecovered: 1,
      ok: false,
      after: { failed: 1, expiredLeases: 0, exhausted: 0 },
    });
    expect(
      await database.db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, progressionJobId),
      })
    ).toMatchObject({ status: "failed", leaseToken: null, leasedUntil: null });
  });
});
