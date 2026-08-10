import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  auditLogs,
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
import { analyticsWorkoutDurationMinutes } from "@/lib/workout-duration-quality";
import {
  claimProgressionJob,
  processProgressionJob,
} from "@/services/progression-jobs";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import { restoreRecordVersion } from "@/services/record-versions";
import {
  correctCompletedWorkoutActiveDuration,
  correctCompletedWorkoutTiming,
} from "@/services/workout-timing-corrections";
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

  it("corrects only active-duration evidence with an auditable retry-safe restore", async () => {
    const startedAt = new Date("2026-07-02T14:00:00.000Z");
    const finishedAt = new Date("2026-07-02T15:00:00.000Z");
    const [pendingRecommendation] = await database.db.insert(recommendations).values({
      userId,
      status: "pending",
      source: "rule",
      ruleId: "active-duration-correction-pending",
      sourceTemplateExerciseId,
      sourceSlotLineageId: slotLineageId,
      payload: {
        kind: "hold",
        templateExerciseId: sourceTemplateExerciseId,
        reason: "pending active-duration evidence",
      },
      reason: "pending active-duration evidence",
      evidence: { sessionIds: [sessionId], signals: {} },
    }).returning({ id: recommendations.id });
    const mutationId = crypto.randomUUID();
    const input = {
      sessionId,
      clientMutationId: mutationId,
      expectedHistoryRevision: 0,
      expected: {
        activeDurationSemanticsVersion: null,
        activeDurationSeconds: null,
        activeDurationBasis: null,
      },
      decision: {
        basis: "owner_reported" as const,
        activeDurationSeconds: 2_700,
      },
    };

    await expect(
      correctCompletedWorkoutActiveDuration(database.db, userId, input, now),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "corrected",
      versionId: mutationId,
      historyRevision: 1,
    });
    await expect(
      correctCompletedWorkoutActiveDuration(database.db, userId, input, now),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "replayed",
      versionId: mutationId,
      historyRevision: 1,
    });

    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
      columns: {
        startedAt: true,
        finishedAt: true,
        activeDurationSemanticsVersion: true,
        activeDurationSeconds: true,
        activeDurationBasis: true,
        excludeDurationFromAnalytics: true,
        historyRevision: true,
      },
    })).resolves.toEqual({
      startedAt,
      finishedAt,
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      historyRevision: 1,
    });
    await expect(database.db.query.recordVersions.findFirst({
      where: (version, { eq }) => eq(version.id, mutationId),
    })).resolves.toMatchObject({
      action: "workout_session.duration_correction",
      entityId: sessionId,
      changedFields: [
        "active_duration_basis",
        "active_duration_seconds",
        "active_duration_semantics_version",
      ],
    });
    await expect(database.db.query.progressionJobs.findMany({
      where: eq(progressionJobs.sessionId, sessionId),
    })).resolves.toHaveLength(1);
    await expect(database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, pendingRecommendation.id),
      columns: { status: true, reconciliationReason: true },
    })).resolves.toMatchObject({
      status: "expired",
      reconciliationReason: expect.stringContaining("active duration was corrected"),
    });

    const incompatibleSourceCorrection = correction(crypto.randomUUID());
    incompatibleSourceCorrection.expectedHistoryRevision = 1;
    incompatibleSourceCorrection.proposed.timing.durationSeconds = 1_800;
    await expect(correctCompletedWorkoutTiming(
      database.db,
      userId,
      incompatibleSourceCorrection,
      now,
    )).resolves.toMatchObject({
      ok: false,
      code: "failed",
      reason: expect.stringContaining("shorter than the reviewed active duration"),
    });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
      columns: { startedAt: true, finishedAt: true, historyRevision: true },
    })).resolves.toEqual({ startedAt, finishedAt, historyRevision: 1 });

    const restoreMutationId = crypto.randomUUID();
    await expect(restoreRecordVersion(database.db, userId, mutationId, {
      clientMutationId: restoreMutationId,
      expectedHistoryRevision: 1,
    })).resolves.toMatchObject({ ok: true, changed: true });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
      columns: {
        startedAt: true,
        finishedAt: true,
        activeDurationSemanticsVersion: true,
        activeDurationSeconds: true,
        activeDurationBasis: true,
        historyRevision: true,
      },
    })).resolves.toEqual({
      startedAt,
      finishedAt,
      activeDurationSemanticsVersion: null,
      activeDurationSeconds: null,
      activeDurationBasis: null,
      historyRevision: 2,
    });
  });

  it("keeps only the current revision runnable through correction and restore chains", async () => {
    const activeMutationId = crypto.randomUUID();
    const activeCorrection = {
      sessionId,
      clientMutationId: activeMutationId,
      expectedHistoryRevision: 0,
      expected: {
        activeDurationSemanticsVersion: null,
        activeDurationSeconds: null,
        activeDurationBasis: null,
      },
      decision: {
        basis: "owner_reported" as const,
        activeDurationSeconds: 2_700,
      },
    };
    await expect(correctCompletedWorkoutActiveDuration(
      database.db,
      userId,
      activeCorrection,
      now,
    )).resolves.toMatchObject({ ok: true, historyRevision: 1 });
    const [revisionOneJob] =
      await database.db.query.progressionJobs.findMany({
        where: eq(progressionJobs.sessionId, sessionId),
      });
    expect(revisionOneJob).toMatchObject({
      sourceSessionRevision: 1,
      status: "pending",
    });
    await expect(claimProgressionJob(database.db, revisionOneJob.id, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseSeconds: 300,
    })).resolves.toMatchObject({
      id: revisionOneJob.id,
      sourceSessionRevision: 1,
    });

    const timingMutationId = crypto.randomUUID();
    const timingCorrection = correction(timingMutationId);
    timingCorrection.expectedHistoryRevision = 1;
    const concurrentTimingResults = await Promise.all([
      correctCompletedWorkoutTiming(
        database.db,
        userId,
        timingCorrection,
        now,
      ),
      correctCompletedWorkoutTiming(
        database.db,
        userId,
        timingCorrection,
        now,
      ),
    ]);
    expect(concurrentTimingResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ok: true,
        outcome: "corrected",
        historyRevision: 2,
      }),
      expect.objectContaining({
        ok: true,
        outcome: "replayed",
        historyRevision: 2,
      }),
    ]));
    await expect(database.db.query.progressionJobs.findFirst({
      where: eq(progressionJobs.id, revisionOneJob.id),
    })).resolves.toMatchObject({
      status: "completed",
      leaseToken: null,
      leasedUntil: null,
      completedAt: expect.any(Date),
      lastError: expect.stringContaining("Superseded progression input"),
    });
    const revisionTwoJobs =
      await database.db.query.progressionJobs.findMany({
        where: eq(progressionJobs.sessionId, sessionId),
      });
    expect(revisionTwoJobs).toHaveLength(2);
    const revisionTwoJob = revisionTwoJobs.find(
      (job) => job.sourceSessionRevision === 2,
    );
    expect(revisionTwoJob).toMatchObject({ status: "pending" });
    await expect(claimProgressionJob(database.db, revisionTwoJob!.id, {
      now: () => new Date("2030-01-01T00:05:00.000Z"),
      leaseSeconds: 300,
    })).resolves.toMatchObject({
      id: revisionTwoJob!.id,
      sourceSessionRevision: 2,
    });

    const restoreMutationId = crypto.randomUUID();
    await expect(restoreRecordVersion(
      database.db,
      userId,
      timingMutationId,
      {
        clientMutationId: restoreMutationId,
        expectedHistoryRevision: 2,
      },
    )).resolves.toMatchObject({ ok: true, changed: true });
    await expect(restoreRecordVersion(
      database.db,
      userId,
      timingMutationId,
      {
        clientMutationId: restoreMutationId,
        expectedHistoryRevision: 2,
      },
    )).resolves.toMatchObject({ ok: true, changed: false });

    const finalJobs = await database.db.query.progressionJobs.findMany({
      where: eq(progressionJobs.sessionId, sessionId),
      orderBy: (job, { asc }) => [asc(job.sourceSessionRevision)],
    });
    expect(finalJobs).toHaveLength(3);
    expect(finalJobs.map((job) => ({
      revision: job.sourceSessionRevision,
      status: job.status,
      leaseToken: job.leaseToken,
    }))).toEqual([
      { revision: 1, status: "completed", leaseToken: null },
      { revision: 2, status: "completed", leaseToken: null },
      { revision: 3, status: "pending", leaseToken: null },
    ]);
    expect(finalJobs[1].lastError).toContain("Superseded progression input");
    expect(
      await evaluateApplicationIntegrity(database.db, userId),
    ).toEqual([]);
    await expect(claimProgressionJob(
      database.db,
      revisionOneJob.id,
      { now: () => new Date("2030-01-01T00:10:00.000Z") },
    )).resolves.toBeNull();
    await expect(processProgressionJob(
      database.db,
      finalJobs[2].id,
      {
        now: () => new Date("2030-01-01T00:10:00.000Z"),
        evaluate: async () => undefined,
      },
    )).resolves.toEqual({
      status: "completed",
      jobId: finalJobs[2].id,
    });
    expect(
      await evaluateApplicationIntegrity(database.db, userId),
    ).toEqual([]);
  });

  it("restores legacy timing without overwriting reviewed active-duration meaning", async () => {
    const legacyVersionId = crypto.randomUUID();
    const restoreMutationId = crypto.randomUUID();
    await database.db.execute(sql`
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${legacyVersionId}::uuid,
        session.user_id,
        'workout_session',
        session.id,
        'workout_session.timing_correction',
        (
          to_jsonb(session) || jsonb_build_object(
            'started_at', '2026-07-02T10:00:00.000Z'::text,
            'finished_at', '2026-07-02T14:00:00.000Z'::text,
            'exclude_duration_from_analytics', true,
            'data_quality_flags', jsonb_build_array(
              'workout_duration_over_3h',
              'legacy_timing_marker'
            )
          )
        )
          - 'active_duration_semantics_version'
          - 'active_duration_seconds'
          - 'active_duration_basis',
        to_jsonb(session)
          - 'active_duration_semantics_version'
          - 'active_duration_seconds'
          - 'active_duration_basis',
        ARRAY[
          'started_at',
          'finished_at',
          'exclude_duration_from_analytics',
          'data_quality_flags'
        ]::text[]
      FROM workout_sessions session
      WHERE session.id = ${sessionId}::uuid
    `);
    await database.db.update(workoutSessions).set({
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: [],
    }).where(eq(workoutSessions.id, sessionId));

    const restored = await restoreRecordVersion(
      database.db,
      userId,
      legacyVersionId,
      {
        clientMutationId: restoreMutationId,
        expectedHistoryRevision: 0,
      },
    );
    expect(restored).toMatchObject({ ok: true, changed: true });
    await expect(restoreRecordVersion(
      database.db,
      userId,
      legacyVersionId,
      {
        clientMutationId: restoreMutationId,
        expectedHistoryRevision: 0,
      },
    )).resolves.toMatchObject({ ok: true, changed: false });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    })).resolves.toMatchObject({
      startedAt: new Date("2026-07-02T10:00:00.000Z"),
      finishedAt: new Date("2026-07-02T14:00:00.000Z"),
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: [
        "legacy_timing_marker",
        "workout_elapsed_over_3h",
      ],
      historyRevision: 1,
    });
    const restoreVersion = await database.db.query.recordVersions.findFirst({
      where: (version, { eq }) =>
        eq(version.action, "workout_session.version_restore"),
    });
    expect(restoreVersion).toMatchObject({
      sourceVersionId: legacyVersionId,
      changedFields: expect.arrayContaining([
        "data_quality_flags",
        "finished_at",
        "started_at",
      ]),
    });
  });

  it("atomically rejects a legacy timing restore shorter than retained reviewed active time", async () => {
    const legacyVersionId = crypto.randomUUID();
    const restoreMutationId = crypto.randomUUID();
    await database.db.execute(sql`
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${legacyVersionId}::uuid,
        session.user_id,
        'workout_session',
        session.id,
        'workout_session.timing_correction',
        (
          to_jsonb(session) || jsonb_build_object(
            'started_at', '2026-07-02T13:30:00.000Z'::text,
            'finished_at', '2026-07-02T14:00:00.000Z'::text
          )
        )
          - 'active_duration_semantics_version'
          - 'active_duration_seconds'
          - 'active_duration_basis',
        to_jsonb(session)
          - 'active_duration_semantics_version'
          - 'active_duration_seconds'
          - 'active_duration_basis',
        ARRAY['started_at', 'finished_at']::text[]
      FROM workout_sessions session
      WHERE session.id = ${sessionId}::uuid
    `);
    await database.db.update(workoutSessions).set({
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: [],
    }).where(eq(workoutSessions.id, sessionId));

    const results = await Promise.all([
      restoreRecordVersion(database.db, userId, legacyVersionId, {
        clientMutationId: restoreMutationId,
        expectedHistoryRevision: 0,
      }),
      restoreRecordVersion(database.db, userId, legacyVersionId, {
        clientMutationId: restoreMutationId,
        expectedHistoryRevision: 0,
      }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        code: "active_duration_conflict",
        reason: expect.stringContaining(
          "shorter than the reviewed active duration",
        ),
      }),
      expect.objectContaining({
        ok: false,
        code: "active_duration_conflict",
      }),
    ]);
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    })).resolves.toMatchObject({
      startedAt: new Date("2026-07-02T14:00:00.000Z"),
      finishedAt: new Date("2026-07-02T15:00:00.000Z"),
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: [],
      historyRevision: 0,
    });
    await expect(
      database.db.query.recordVersions.findMany(),
    ).resolves.toHaveLength(1);
    await expect(database.db.query.auditLogs.findMany({
      where: eq(auditLogs.entityId, sessionId),
    })).resolves.toEqual([]);
    await expect(database.db.query.progressionJobs.findMany({
      where: eq(progressionJobs.sessionId, sessionId),
    })).resolves.toEqual([]);
    await expect(
      evaluateApplicationIntegrity(database.db, userId),
    ).resolves.toEqual([]);
  });

  it("restores legacy exclusion and quality flags when no reviewed active tuple is retained", async () => {
    const legacyVersionId = crypto.randomUUID();
    await database.db.execute(sql`
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${legacyVersionId}::uuid,
        session.user_id,
        'workout_session',
        session.id,
        'workout_session.timing_correction',
        (
          to_jsonb(session) || jsonb_build_object(
            'started_at', '2026-07-02T10:00:00.000Z'::text,
            'finished_at', '2026-07-02T14:00:00.000Z'::text,
            'exclude_duration_from_analytics', true,
            'data_quality_flags', jsonb_build_array(
              'workout_duration_over_3h',
              'legacy_timing_marker'
            )
          )
        )
          - 'active_duration_semantics_version'
          - 'active_duration_seconds'
          - 'active_duration_basis',
        to_jsonb(session)
          - 'active_duration_semantics_version'
          - 'active_duration_seconds'
          - 'active_duration_basis',
        ARRAY[
          'started_at',
          'finished_at',
          'exclude_duration_from_analytics',
          'data_quality_flags'
        ]::text[]
      FROM workout_sessions session
      WHERE session.id = ${sessionId}::uuid
    `);

    await expect(restoreRecordVersion(
      database.db,
      userId,
      legacyVersionId,
      {
        clientMutationId: crypto.randomUUID(),
        expectedHistoryRevision: 0,
      },
    )).resolves.toMatchObject({ ok: true, changed: true });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    })).resolves.toMatchObject({
      activeDurationSemanticsVersion: null,
      activeDurationSeconds: null,
      activeDurationBasis: null,
      excludeDurationFromAnalytics: true,
      dataQualityFlags: [
        "workout_duration_over_3h",
        "legacy_timing_marker",
      ],
      historyRevision: 1,
    });
  });

  it("retains reviewed active duration through an authorized date-only correction", async () => {
    await expect(correctCompletedWorkoutActiveDuration(
      database.db,
      userId,
      {
        sessionId,
        clientMutationId: crypto.randomUUID(),
        expectedHistoryRevision: 0,
        expected: {
          activeDurationSemanticsVersion: null,
          activeDurationSeconds: null,
          activeDurationBasis: null,
        },
        decision: {
          basis: "owner_reported",
          activeDurationSeconds: 2_700,
        },
      },
      now,
    )).resolves.toMatchObject({ ok: true, historyRevision: 1 });

    await expect(correctCompletedWorkoutTiming(
      database.db,
      userId,
      {
        ...correction(crypto.randomUUID()),
        expectedHistoryRevision: 1,
        proposed: {
          timezone: "America/Toronto",
          localDate: "2026-07-01",
          timing: { precision: "date_only" },
        },
      },
      now,
    )).resolves.toMatchObject({ ok: true, historyRevision: 2 });

    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
      columns: {
        startedAt: true,
        finishedAt: true,
        performedTimePrecision: true,
        activeDurationSemanticsVersion: true,
        activeDurationSeconds: true,
        activeDurationBasis: true,
        excludeDurationFromAnalytics: true,
        dataQualityFlags: true,
        historyRevision: true,
      },
    })).resolves.toEqual({
      startedAt: new Date("2026-07-01T16:00:00.000Z"),
      finishedAt: null,
      performedTimePrecision: "date_only",
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: ["unknown_time"],
      historyRevision: 2,
    });

    const unknownMutationId = crypto.randomUUID();
    const unknownCorrection = {
      sessionId,
      clientMutationId: unknownMutationId,
      expectedHistoryRevision: 2,
      expected: {
        activeDurationSemanticsVersion: 1,
        activeDurationSeconds: 2_700,
        activeDurationBasis: "owner_reported",
      },
      decision: { basis: "interruption_unknown" as const },
    };
    await expect(correctCompletedWorkoutActiveDuration(
      database.db,
      userId,
      unknownCorrection,
      now,
    )).resolves.toMatchObject({
      ok: true,
      outcome: "corrected",
      versionId: unknownMutationId,
      historyRevision: 3,
    });
    await expect(correctCompletedWorkoutActiveDuration(
      database.db,
      userId,
      unknownCorrection,
      now,
    )).resolves.toMatchObject({
      ok: true,
      outcome: "replayed",
      versionId: unknownMutationId,
      historyRevision: 3,
    });
    const unknownSession = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    });
    expect(unknownSession).toMatchObject({
      startedAt: new Date("2026-07-01T16:00:00.000Z"),
      finishedAt: null,
      performedTimePrecision: "date_only",
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
      excludeDurationFromAnalytics: true,
      dataQualityFlags: ["unknown_time", "workout_active_duration_unknown"],
      historyRevision: 3,
    });
    expect(analyticsWorkoutDurationMinutes(
      unknownSession!.startedAt,
      unknownSession!.finishedAt,
      unknownSession!.excludeDurationFromAnalytics,
      unknownSession!,
    )).toBeNull();

    await expect(correctCompletedWorkoutActiveDuration(
      database.db,
      userId,
      {
        ...unknownCorrection,
        clientMutationId: crypto.randomUUID(),
        decision: { basis: "owner_reported", activeDurationSeconds: 1_800 },
      },
      now,
    )).resolves.toMatchObject({ ok: false, code: "stale" });
    await expect(correctCompletedWorkoutActiveDuration(
      database.db,
      userId,
      {
        sessionId,
        clientMutationId: crypto.randomUUID(),
        expectedHistoryRevision: 3,
        expected: {
          activeDurationSemanticsVersion: 1,
          activeDurationSeconds: null,
          activeDurationBasis: "interruption_unknown",
        },
        decision: {
          basis: "owner_reported",
          activeDurationSeconds: 604_801,
        },
      },
      now,
    )).resolves.toMatchObject({
      ok: false,
      code: "failed",
      reason: expect.stringContaining("604800"),
    });

    const ownerMutationId = crypto.randomUUID();
    const ownerCorrection = {
      sessionId,
      clientMutationId: ownerMutationId,
      expectedHistoryRevision: 3,
      expected: {
        activeDurationSemanticsVersion: 1,
        activeDurationSeconds: null,
        activeDurationBasis: "interruption_unknown",
      },
      decision: {
        basis: "owner_reported" as const,
        activeDurationSeconds: 1_800,
      },
    };
    await expect(correctCompletedWorkoutActiveDuration(
      database.db,
      userId,
      ownerCorrection,
      now,
    )).resolves.toMatchObject({
      ok: true,
      outcome: "corrected",
      versionId: ownerMutationId,
      historyRevision: 4,
    });
    await expect(correctCompletedWorkoutActiveDuration(
      database.db,
      userId,
      ownerCorrection,
      now,
    )).resolves.toMatchObject({
      ok: true,
      outcome: "replayed",
      versionId: ownerMutationId,
      historyRevision: 4,
    });
    const finalSession = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    });
    expect(finalSession).toMatchObject({
      startedAt: new Date("2026-07-01T16:00:00.000Z"),
      finishedAt: null,
      performedTimePrecision: "date_only",
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 1_800,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: ["unknown_time"],
      historyRevision: 4,
    });
    expect(analyticsWorkoutDurationMinutes(
      finalSession!.startedAt,
      finalSession!.finishedAt,
      finalSession!.excludeDurationFromAnalytics,
      finalSession!,
    )).toBe(30);
  });

  it("rejects partial or incoherent active-duration tuples at the database boundary", async () => {
    await expect(database.db.update(workoutSessions).set({
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: null,
      activeDurationBasis: "owner_reported",
    }).where(eq(workoutSessions.id, sessionId))).rejects.toThrow();
    await expect(database.db.update(workoutSessions).set({
      activeDurationSemanticsVersion: null,
      activeDurationSeconds: 3_600,
      activeDurationBasis: null,
    }).where(eq(workoutSessions.id, sessionId))).rejects.toThrow();
  });
});
