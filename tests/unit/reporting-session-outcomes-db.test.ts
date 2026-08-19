import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@/db";
import {
  auditLogs,
  exercisePrescriptions,
  exercises,
  fatigueLogs,
  progressionJobs,
  programVersions,
  programs,
  sessionExercises,
  sessionNotes,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import type { ProgramDayIntent } from "@/lib/program-document";
import {
  abandonWorkoutSession,
  completeWorkoutSession,
  mutateWorkoutOccurrence,
  startWorkoutSession,
} from "@/services/session-lifecycle";
import {
  restoreRecordVersion,
  updateSessionExerciseWithVersion,
} from "@/services/record-versions";
import {
  createMigratedTestDatabase,
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";
import { logWorkoutSet } from "../helpers/log-workout-set";

const coachingUser = (id: string) => ({
  id,
  coachingPrefs: {
    aggressiveness: "conservative" as const,
    deloadSuggestions: true,
    substitutionSuggestions: true,
    weeklyReview: true,
  },
});

function dayIntent(
  target: { minMinutes: number; maxMinutes: number },
  durationOverride: ProgramDayIntent["durationOverride"] = null,
): ProgramDayIntent {
  return {
    primaryOutcome: "strength",
    secondaryOutcomes: [],
    identity: { kind: "movement_balance", anchorSlotLineageIds: [] },
    targetDuration: target,
    minimumUsefulDurationMinutes: target.minMinutes,
    fatigueTolerance: "normal",
    orderingPolicy: "preserve",
    pairingPolicy: "preserve",
    durationOverride,
    note: null,
  };
}

async function seedLifecycle(
  db: Db,
  intent: ProgramDayIntent | null = dayIntent({
    minMinutes: 40,
    maxMinutes: 45,
  }),
  sets = 1,
) {
  const [{ id: userId }] = await db
    .insert(users)
    .values({ email: `reporting-lifecycle-${crypto.randomUUID()}@example.com` })
    .returning({ id: users.id });
  await db.insert(userProfiles).values({
    userId,
    timezone: "America/Toronto",
  });
  const [{ id: exerciseId }] = await db
    .insert(exercises)
    .values({
      name: `Reporting press ${crypto.randomUUID()}`,
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "dumbbell",
      metricType: "weight_reps",
      loadSemantics: "per_implement",
    })
    .returning({ id: exercises.id });

  let templateId = "";
  await db.transaction(async (tx) => {
    const [program] = await tx
      .insert(programs)
      .values({
        userId,
        name: "Reporting lifecycle Program",
        status: "archived",
        archivedAt: new Date(),
      })
      .returning({ id: programs.id });
    const [version] = await tx
      .insert(programVersions)
      .values({
        programId: program.id,
        documentSchemaVersion: intent == null ? 1 : 3,
      })
      .returning({ id: programVersions.id });
    const [template] = await tx
      .insert(workoutTemplates)
      .values({
        programVersionId: version.id,
        name: "Reporting lifecycle day",
        intent,
      })
      .returning({ id: workoutTemplates.id });
    templateId = template.id;
    const [slot] = await tx
      .insert(workoutTemplateExercises)
      .values({
        workoutTemplateId: templateId,
        exerciseId,
        orderIdx: 0,
      })
      .returning({ id: workoutTemplateExercises.id });
    await tx.insert(exercisePrescriptions).values({
      templateExerciseId: slot.id,
      sets,
      repRangeMin: 8,
      repRangeMax: 10,
      targetLoad: 30,
      targetLoadUnit: "lb",
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
  return { userId, templateId, exerciseId };
}

describe("reporting session completion and planned-duration writers", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("freezes reviewed Program duration separately from the session cap", async () => {
    const fixture = await seedLifecycle(database.db);
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
      60,
    );

    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    })).resolves.toMatchObject({
      timeBudgetMin: 60,
      plannedDurationSemanticsVersion: 1,
      plannedDurationMinMinutes: 40,
      plannedDurationMaxMinutes: 45,
      plannedDurationSource: "program_day_target",
    });
    await expect(database.db.execute(sql`
      UPDATE workout_sessions
      SET planned_duration_semantics_version = 1,
          planned_duration_min_minutes = 50,
          planned_duration_max_minutes = 55,
          planned_duration_source = 'program_day_duration_override'
      WHERE id = ${started.sessionId}::uuid
    `)).rejects.toThrow();
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    })).resolves.toMatchObject({
      plannedDurationSemanticsVersion: 1,
      plannedDurationMinMinutes: 40,
      plannedDurationMaxMinutes: 45,
      plannedDurationSource: "program_day_target",
    });
  });

  it("prefers an explicit reviewed Program duration override", async () => {
    const fixture = await seedLifecycle(
      database.db,
      dayIntent(
        { minMinutes: 40, maxMinutes: 45 },
        {
          minMinutes: 50,
          maxMinutes: 55,
          note: "This reviewed day consistently needs longer transitions.",
        },
      ),
    );
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
      60,
    );

    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    })).resolves.toMatchObject({
      timeBudgetMin: 60,
      plannedDurationSemanticsVersion: 1,
      plannedDurationMinMinutes: 50,
      plannedDurationMaxMinutes: 55,
      plannedDurationSource: "program_day_duration_override",
    });
  });

  it("keeps planned duration unknown when reviewed Program intent is absent", async () => {
    const fixture = await seedLifecycle(database.db, null);
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
      45,
    );

    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    })).resolves.toMatchObject({
      timeBudgetMin: 45,
      plannedDurationSemanticsVersion: null,
      plannedDurationMinMinutes: null,
      plannedDurationMaxMinutes: null,
      plannedDurationSource: null,
    });
  });

  it("freezes prescribed counting applicability without re-reading mutable exercise laterality", async () => {
    const knownFixture = await seedLifecycle(database.db);
    const known = await startWorkoutSession(
      database.db,
      knownFixture.userId,
      knownFixture.templateId,
    );
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, known.sessionId),
    })).resolves.toMatchObject({
      prescribedCountingSemanticsVersion: 1,
      prescribedCountingBasis: "not_applicable",
    });
    await database.db
      .update(exercises)
      .set({ isUnilateral: true })
      .where(eq(exercises.id, knownFixture.exerciseId));
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, known.sessionId),
    })).resolves.toMatchObject({
      prescribedCountingSemanticsVersion: 1,
      prescribedCountingBasis: "not_applicable",
    });
    await expect(database.db.execute(sql`
      UPDATE session_exercises
      SET prescribed_counting_semantics_version = NULL,
          prescribed_counting_basis = NULL
      WHERE session_id = ${known.sessionId}::uuid
    `)).rejects.toThrow();
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, known.sessionId),
    })).resolves.toMatchObject({
      prescribedCountingSemanticsVersion: 1,
      prescribedCountingBasis: "not_applicable",
    });

    const unknownFixture = await seedLifecycle(database.db);
    await database.db
      .update(exercises)
      .set({ isUnilateral: true })
      .where(eq(exercises.id, unknownFixture.exerciseId));
    const unknown = await startWorkoutSession(
      database.db,
      unknownFixture.userId,
      unknownFixture.templateId,
    );
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, unknown.sessionId),
    })).resolves.toMatchObject({
      prescribedCountingSemanticsVersion: null,
      prescribedCountingBasis: null,
    });
    await database.db
      .update(exercises)
      .set({ isUnilateral: false })
      .where(eq(exercises.id, unknownFixture.exerciseId));
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, unknown.sessionId),
    })).resolves.toMatchObject({
      prescribedCountingSemanticsVersion: null,
      prescribedCountingBasis: null,
    });
  });

  it("requires an explicit reason and stores time-limit resolution atomically", async () => {
    const fixture = await seedLifecycle(database.db);
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
    );

    await expect(completeWorkoutSession(
      database.db,
      coachingUser(fixture.userId),
      { sessionId: started.sessionId },
    )).resolves.toMatchObject({
      outcome: "completion_reason_required",
      alreadyFinished: false,
    });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    })).resolves.toMatchObject({
      status: "in_progress",
      completionSemanticsVersion: null,
      completionState: null,
      completionReason: null,
    });

    const completed = await completeWorkoutSession(
      database.db,
      coachingUser(fixture.userId),
      {
        sessionId: started.sessionId,
        note: "Retain these exact finish details.",
        fatigue: 3,
        completionReason: "time_limit_reached",
      },
    );
    expect(completed).toMatchObject({ outcome: "completed" });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    })).resolves.toMatchObject({
      status: "completed",
      completionSemanticsVersion: 1,
      completionState: "completed_with_remaining_work",
      completionReason: "time_limit_reached",
    });
    await expect(database.db.execute(sql`
      UPDATE workout_sessions
      SET completion_reason = 'fatigue'
      WHERE id = ${started.sessionId}::uuid
    `)).rejects.toThrow();
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    })).resolves.toMatchObject({
      completionSemanticsVersion: 1,
      completionState: "completed_with_remaining_work",
      completionReason: "time_limit_reached",
    });
    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId));
    expect(occurrences).toEqual([
      expect.objectContaining({
        outcome: "abandoned",
        outcomeReason: "session_end:time_limit_reached",
        resolutionSemanticsVersion: 1,
        resolutionReasonCode: "time_limit_reached",
      }),
    ]);

    const retainedClosure = async () => ({
      session: await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, started.sessionId),
      }),
      occurrences: await database.db
        .select()
        .from(sessionOccurrences)
        .where(eq(sessionOccurrences.sessionId, started.sessionId)),
      notes: await database.db.select().from(sessionNotes),
      fatigue: await database.db.select().from(fatigueLogs),
      audits: await database.db.select().from(auditLogs),
      progression: await database.db.select().from(progressionJobs),
    });
    const closureBeforeRetries = await retainedClosure();

    await expect(completeWorkoutSession(
      database.db,
      coachingUser(fixture.userId),
      {
        sessionId: started.sessionId,
        note: "Retain these exact finish details.",
        fatigue: 3,
        completionReason: "time_limit_reached",
      },
    )).resolves.toMatchObject({
      outcome: "already_finished",
      alreadyFinished: true,
    });
    expect(await retainedClosure()).toEqual(closureBeforeRetries);

    const changedFinishPayloads = [
      {
        note: "A different finish note must not be accepted as the same retry.",
        fatigue: 3,
        completionReason: "time_limit_reached" as const,
      },
      {
        note: "Retain these exact finish details.",
        fatigue: 4,
        completionReason: "time_limit_reached" as const,
      },
      {
        note: "Retain these exact finish details.",
        fatigue: 3,
        durationDecision: {
          basis: "owner_reported" as const,
          activeDurationSeconds: 0,
        },
        completionReason: "time_limit_reached" as const,
      },
      {
        note: "Retain these exact finish details.",
        fatigue: 3,
        completionReason: "fatigue" as const,
      },
    ];
    for (const changedPayload of changedFinishPayloads) {
      await expect(completeWorkoutSession(
        database.db,
        coachingUser(fixture.userId),
        { sessionId: started.sessionId, ...changedPayload },
      )).resolves.toMatchObject({
        outcome: "finish_payload_conflict",
        alreadyFinished: true,
        reason: expect.stringContaining("different retained finish details"),
      });
    }
    expect(await retainedClosure()).toEqual(closureBeforeRetries);
  });

  it("classifies fully performed work separately from resolved changes", async () => {
    const performedFixture = await seedLifecycle(database.db);
    const performed = await startWorkoutSession(
      database.db,
      performedFixture.userId,
      performedFixture.templateId,
    );
    const [performedExercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, performed.sessionId));
    await expect(logWorkoutSet(database.db, performedFixture.userId, {
      sessionExerciseId: performedExercise.id,
      setNo: 1,
      weight: 30,
      weightUnit: "lb",
      reps: 10,
      clientKey: "reporting-performed-set",
    })).resolves.toMatchObject({ outcome: "saved" });
    await expect(completeWorkoutSession(
      database.db,
      coachingUser(performedFixture.userId),
      { sessionId: performed.sessionId },
    )).resolves.toMatchObject({ outcome: "completed" });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, performed.sessionId),
    })).resolves.toMatchObject({
      completionState: "completed_as_prescribed",
      completionReason: null,
    });

    const changedFixture = await seedLifecycle(database.db);
    const changed = await startWorkoutSession(
      database.db,
      changedFixture.userId,
      changedFixture.templateId,
    );
    const [plannedOccurrence] = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, changed.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    await expect(mutateWorkoutOccurrence(database.db, changedFixture.userId, {
      occurrenceId: plannedOccurrence.id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 0,
      operation: "skip",
      reason: "time",
    })).resolves.toMatchObject({ outcome: "saved" });
    await expect(database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, plannedOccurrence.id),
    })).resolves.toMatchObject({
      outcomeReason: "time",
      resolutionSemanticsVersion: null,
      resolutionReasonCode: null,
    });
    await expect(completeWorkoutSession(
      database.db,
      coachingUser(changedFixture.userId),
      { sessionId: changed.sessionId },
    )).resolves.toMatchObject({ outcome: "completed" });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, changed.sessionId),
    })).resolves.toMatchObject({
      completionState: "completed_with_changes",
      completionReason: null,
    });
  });

  it("retains a canonical structured reason for an explicit skip", async () => {
    const fixture = await seedLifecycle(database.db);
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
    );
    const [occurrence] = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId));
    const structuredClientKey = crypto.randomUUID();

    await expect(mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: occurrence.id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 0,
      operation: "skip",
      reasonCode: "time" as never,
    })).rejects.toThrow();
    await expect(mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: occurrence.id,
      clientKey: structuredClientKey,
      expectedRevision: 0,
      operation: "skip",
      reasonCode: "equipment_unavailable_incompatible",
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: {
        state: "skipped",
        reason: "equipment_unavailable_incompatible",
        resolutionSemanticsVersion: 1,
        resolutionReasonCode: "equipment_unavailable_incompatible",
      },
    });
    await expect(mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: occurrence.id,
      clientKey: structuredClientKey,
      expectedRevision: 0,
      operation: "skip",
      reasonCode: "equipment_unavailable_incompatible",
    })).resolves.toMatchObject({
      outcome: "replayed",
      occurrence: {
        resolutionSemanticsVersion: 1,
        resolutionReasonCode: "equipment_unavailable_incompatible",
      },
    });
    await expect(mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: occurrence.id,
      clientKey: structuredClientKey,
      expectedRevision: 0,
      operation: "skip",
      reasonCode: "user_choice",
    })).resolves.toEqual({ outcome: "retry_identity_conflict" });
    await expect(mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: occurrence.id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 1,
      operation: "restore",
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: {
        state: "pending",
        reason: null,
        resolutionSemanticsVersion: null,
        resolutionReasonCode: null,
      },
    });
  });

  it("preserves individual skips while whole-exercise skip, restore, and unskip manage only their own canonical tuples", async () => {
    const fixture = await seedLifecycle(
      database.db,
      dayIntent({ minMinutes: 40, maxMinutes: 45 }),
      3,
    );
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
    );
    const [exercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, exercise.id))
      .orderBy(asc(sessionOccurrences.sequenceIdx));

    await expect(mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: occurrences[0].id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 0,
      operation: "skip",
      reasonCode: "user_choice",
    })).resolves.toMatchObject({ outcome: "saved" });

    const skipped = await updateSessionExerciseWithVersion(
      database.db,
      fixture.userId,
      exercise.id,
      {
        modificationType: "skipped",
        skipReason: "time_limit_reached",
      },
      "session_exercise.skip",
      { activeOnly: true },
    );
    expect(skipped).toMatchObject({ ok: true, changed: true });
    if (!skipped.ok || !skipped.versionId) {
      throw new Error("The whole-exercise skip did not retain a version.");
    }

    const readOutcomes = () => database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, exercise.id))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    expect(await readOutcomes()).toEqual([
      expect.objectContaining({
        outcome: "skipped",
        outcomeReason: "user_choice",
        resolutionSemanticsVersion: 1,
        resolutionReasonCode: "user_choice",
      }),
      expect.objectContaining({
        outcome: "skipped",
        outcomeReason: "exercise:time_limit_reached",
        resolutionSemanticsVersion: 1,
        resolutionReasonCode: "time_limit_reached",
      }),
      expect.objectContaining({
        outcome: "skipped",
        outcomeReason: "exercise:time_limit_reached",
        resolutionSemanticsVersion: 1,
        resolutionReasonCode: "time_limit_reached",
      }),
    ]);

    const restoredSkip = await restoreRecordVersion(
      database.db,
      fixture.userId,
      skipped.versionId,
      { activeOnly: true },
    );
    expect(restoredSkip).toMatchObject({ ok: true, changed: true });
    if (!restoredSkip.ok || !restoredSkip.versionId) {
      throw new Error("The whole-exercise skip restore was not versioned.");
    }
    expect(await readOutcomes()).toEqual([
      expect.objectContaining({
        outcome: "skipped",
        resolutionReasonCode: "user_choice",
      }),
      expect.objectContaining({
        outcome: "pending",
        outcomeReason: null,
        resolutionSemanticsVersion: null,
        resolutionReasonCode: null,
      }),
      expect.objectContaining({
        outcome: "pending",
        outcomeReason: null,
        resolutionSemanticsVersion: null,
        resolutionReasonCode: null,
      }),
    ]);

    await expect(restoreRecordVersion(
      database.db,
      fixture.userId,
      restoredSkip.versionId,
      { activeOnly: true },
    )).resolves.toMatchObject({ ok: true, changed: true });
    expect(await readOutcomes()).toEqual([
      expect.objectContaining({
        outcome: "skipped",
        resolutionReasonCode: "user_choice",
      }),
      expect.objectContaining({
        outcome: "skipped",
        outcomeReason: "exercise:time_limit_reached",
        resolutionSemanticsVersion: 1,
        resolutionReasonCode: "time_limit_reached",
      }),
      expect.objectContaining({
        outcome: "skipped",
        outcomeReason: "exercise:time_limit_reached",
        resolutionSemanticsVersion: 1,
        resolutionReasonCode: "time_limit_reached",
      }),
    ]);

    await expect(updateSessionExerciseWithVersion(
      database.db,
      fixture.userId,
      exercise.id,
      { modificationType: "as_planned", skipReason: null },
      "session_exercise.unskip",
      { activeOnly: true },
    )).resolves.toMatchObject({ ok: true, changed: true });
    expect(await readOutcomes()).toEqual([
      expect.objectContaining({
        outcome: "skipped",
        resolutionReasonCode: "user_choice",
      }),
      expect.objectContaining({
        outcome: "pending",
        outcomeReason: null,
        resolutionSemanticsVersion: null,
        resolutionReasonCode: null,
      }),
      expect.objectContaining({
        outcome: "pending",
        outcomeReason: null,
        resolutionSemanticsVersion: null,
        resolutionReasonCode: null,
      }),
    ]);
  });

  it("stores abandonment without relabelling it as completed", async () => {
    const fixture = await seedLifecycle(database.db);
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
    );
    await abandonWorkoutSession(
      database.db,
      fixture.userId,
      started.sessionId,
    );

    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    })).resolves.toMatchObject({
      status: "abandoned",
      completionSemanticsVersion: 1,
      completionState: "abandoned",
      completionReason: "user_choice",
    });
    await expect(database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.sessionId, started.sessionId),
    })).resolves.toMatchObject({
      outcome: "abandoned",
      outcomeReason: "workout_abandoned",
      resolutionSemanticsVersion: 1,
      resolutionReasonCode: "user_choice",
    });
  });
});

describe("reporting session outcome migration", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => database?.close());

  it("replays an exact pre-0083 legacy occurrence receipt after the additive upgrade", async () => {
    database = await createTestDatabaseAtMigration(
      "0082_named_program_library",
    );
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const occurrenceId = crypto.randomUUID();
    const mutationId = crypto.randomUUID();
    const clientKey = "pre-0083-legacy-occurrence-receipt";
    const legacyPayload = {
      operation: "skip",
      expectedRevision: 0,
      reason: "legacy time",
      note: null,
    };
    const legacyHash = createHash("sha256")
      .update(JSON.stringify(legacyPayload))
      .digest("hex");
    await database.db.execute(sql`
      INSERT INTO users (id, email)
      VALUES (${userId}::uuid, ${`legacy-replay-${userId}@example.com`})
    `);
    await database.db.execute(sql`
      INSERT INTO workout_sessions (
        id, user_id, status, started_at, timezone, local_date
      ) VALUES (
        ${sessionId}::uuid, ${userId}::uuid, 'in_progress',
        '2026-08-18T12:00:00.000Z'::timestamptz,
        'UTC', '2026-08-18'
      )
    `);
    await database.db.execute(sql`
      INSERT INTO session_occurrences (
        id, session_id, kind, origin, sequence_idx, kind_ordinal,
        outcome, outcome_reason, revision, resolved_at
      ) VALUES (
        ${occurrenceId}::uuid, ${sessionId}::uuid,
        'day_warmup', 'planned', 0, 0,
        'skipped', 'legacy time', 1,
        '2026-08-18T12:05:00.000Z'::timestamptz
      )
    `);
    await database.db.execute(sql`
      INSERT INTO session_occurrence_mutations (
        id, occurrence_id, client_key, operation, canonical_payload_hash,
        expected_revision, resulting_revision, result_code
      ) VALUES (
        ${mutationId}::uuid, ${occurrenceId}::uuid, ${clientKey}::text,
        'skip', ${legacyHash}::text, 0, 1, 'applied'
      )
    `);

    await migrateTestDatabaseThrough(
      database,
      "0083_reporting_session_outcomes",
    );

    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId,
      clientKey,
      expectedRevision: 0,
      operation: "skip",
      reason: "legacy time",
    })).resolves.toMatchObject({
      outcome: "replayed",
      occurrence: {
        state: "skipped",
        reason: "legacy time",
        revision: 1,
        resolutionSemanticsVersion: null,
        resolutionReasonCode: null,
      },
    });
  }, 30_000);

  it("preserves legacy unknowns and enforces complete semantic tuples", async () => {
    database = await createTestDatabaseAtMigration(
      "0082_named_program_library",
    );
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const unplannedSessionId = crypto.randomUUID();
    const invalidUnplannedSessionId = crypto.randomUUID();
    const linkedUnplannedSessionId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    const missingPrescriptionCountingId = crypto.randomUUID();
    const durationCountingId = crypto.randomUUID();
    const occurrenceId = crypto.randomUUID();
    await database.db.execute(sql`
      INSERT INTO users (id, email)
      VALUES (${userId}::uuid, ${`legacy-report-${userId}@example.com`})
    `);
    await database.db.execute(sql`
      INSERT INTO exercises (
        id, user_id, name, movement_pattern, primary_muscles,
        is_unilateral, metric_type
      ) VALUES (
        ${exerciseId}::uuid, ${userId}::uuid,
        ${`Legacy counting ${exerciseId}`}::text,
        'horizontal_push', '["chest"]'::jsonb, false, 'weight_reps'
      )
    `);
    await database.db.execute(sql`
      INSERT INTO workout_sessions (
        id, user_id, status, started_at, finished_at, timezone, local_date
      ) VALUES (
        ${sessionId}::uuid, ${userId}::uuid, 'completed',
        '2026-08-18T12:00:00.000Z'::timestamptz,
        '2026-08-18T13:00:00.000Z'::timestamptz,
        'UTC', '2026-08-18'
      )
    `);
    await database.db.execute(sql`
      INSERT INTO session_exercises (
        id, session_id, exercise_id, order_idx
      ) VALUES (
        ${sessionExerciseId}::uuid, ${sessionId}::uuid,
        ${exerciseId}::uuid, 0
      )
    `);
    await database.db.execute(sql`
      INSERT INTO session_occurrences (
        id, session_id, kind, origin, sequence_idx, kind_ordinal, outcome
      ) VALUES (
        ${occurrenceId}::uuid, ${sessionId}::uuid,
        'day_warmup', 'legacy', 0, 0, 'legacy_unrecorded'
      )
    `);

    await migrateTestDatabaseThrough(
      database,
      "0083_reporting_session_outcomes",
    );

    const [legacy] = await database.db
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId));
    expect(legacy).toMatchObject({
      plannedDurationSemanticsVersion: null,
      plannedDurationMinMinutes: null,
      plannedDurationMaxMinutes: null,
      plannedDurationSource: null,
      completionSemanticsVersion: null,
      completionState: null,
      completionReason: null,
    });
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, sessionExerciseId),
    })).resolves.toMatchObject({
      prescribedCountingSemanticsVersion: null,
      prescribedCountingBasis: null,
    });
    await expect(database.db.execute(sql`
      UPDATE workout_sessions
      SET planned_duration_semantics_version = 1
      WHERE id = ${sessionId}::uuid
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      INSERT INTO workout_sessions (
        id, user_id, status, started_at, finished_at, timezone, local_date,
        completion_semantics_version, completion_state, completion_reason
      ) VALUES (
        ${unplannedSessionId}::uuid, ${userId}::uuid, 'completed',
        '2026-08-18T14:00:00.000Z'::timestamptz,
        '2026-08-18T15:00:00.000Z'::timestamptz,
        'UTC', '2026-08-18', 1, 'completed_without_prescription', NULL
      )
    `)).resolves.toBeDefined();
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, unplannedSessionId),
    })).resolves.toMatchObject({
      completionSemanticsVersion: 1,
      completionState: "completed_without_prescription",
      completionReason: null,
    });
    await expect(database.db.execute(sql`
      INSERT INTO workout_sessions (
        id, user_id, status, started_at, finished_at, timezone, local_date,
        completion_semantics_version, completion_state, completion_reason
      ) VALUES (
        ${invalidUnplannedSessionId}::uuid, ${userId}::uuid, 'completed',
        '2026-08-18T16:00:00.000Z'::timestamptz,
        '2026-08-18T17:00:00.000Z'::timestamptz,
        'UTC', '2026-08-18', 1, 'completed_without_prescription', 'user_choice'
      )
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      INSERT INTO workout_sessions (
        id, user_id, status, started_at, finished_at, timezone, local_date,
        source_program_id, source_program_version_id, source_day_lineage_id,
        completion_semantics_version, completion_state, completion_reason
      ) VALUES (
        ${linkedUnplannedSessionId}::uuid, ${userId}::uuid, 'completed',
        '2026-08-18T18:00:00.000Z'::timestamptz,
        '2026-08-18T19:00:00.000Z'::timestamptz,
        'UTC', '2026-08-18',
        ${crypto.randomUUID()}::uuid,
        ${crypto.randomUUID()}::uuid,
        ${crypto.randomUUID()}::uuid,
        1, 'completed_without_prescription', NULL
      )
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      UPDATE workout_sessions
      SET planned_duration_semantics_version = 1,
          planned_duration_min_minutes = 40,
          planned_duration_max_minutes = 45,
          planned_duration_source = 'program_day_target'
      WHERE id = ${sessionId}::uuid
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      UPDATE workout_sessions
      SET completion_semantics_version = 1,
          completion_state = 'completed_with_remaining_work'
      WHERE id = ${sessionId}::uuid
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      UPDATE session_occurrences
      SET resolution_semantics_version = 1,
          resolution_reason_code = 'time_limit_reached'
      WHERE id = ${occurrenceId}::uuid
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      UPDATE session_exercises
      SET prescribed_counting_semantics_version = 1
      WHERE id = ${sessionExerciseId}::uuid
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      UPDATE session_exercises
      SET prescribed_counting_semantics_version = 1,
          prescribed_counting_basis = 'per_side'
      WHERE id = ${sessionExerciseId}::uuid
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      INSERT INTO session_exercises (
        id, session_id, exercise_id, order_idx,
        prescribed_counting_semantics_version, prescribed_counting_basis
      ) VALUES (
        ${missingPrescriptionCountingId}::uuid, ${sessionId}::uuid,
        ${exerciseId}::uuid, 1, 1, 'not_applicable'
      )
    `)).rejects.toThrow();
    await expect(database.db.execute(sql`
      INSERT INTO session_exercises (
        id, session_id, exercise_id, order_idx,
        prescribed_semantics_version, prescribed_exercise_name,
        prescribed_metric_type, prescribed_load_type,
        prescribed_load_semantics,
        prescribed_counting_semantics_version, prescribed_counting_basis
      ) VALUES (
        ${durationCountingId}::uuid, ${sessionId}::uuid,
        ${exerciseId}::uuid, 2,
        1, 'Legacy duration', 'duration', 'bodyweight', 'none',
        1, 'not_applicable'
      )
    `)).rejects.toThrow();
  }, 30_000);
});
