// Intent suite: proves workout creation, set delivery, completion, and abandon
// remain owned, atomic, replay-safe, and bound to the current Program version.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import {
  auditLogs,
  completedSets,
  exerciseEquipmentRequirements,
  exercisePrescriptions,
  exercises,
  fatigueLogs,
  programs,
  progressionJobs,
  programVersions,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrenceMutations,
  sessionOccurrences,
  sessionNotes,
  userProfiles,
  users,
  workoutSessions,
  supersetGroups,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import {
  abandonWorkoutSession,
  addWorkoutExercise,
  appendWorkoutSetOccurrence,
  cleanupIncompleteWorkoutCreation,
  completeWorkoutSession,
  findOwnedActiveWorkout,
  IncompleteWorkoutCreationError,
  mutateWorkoutOccurrence,
  StaleWorkoutTemplateError,
  startWorkoutSession,
} from "@/services/session-lifecycle";
import { logWorkoutSet } from "../helpers/log-workout-set";
import { updateSessionExerciseWithVersion } from "@/services/record-versions";
import { buildSetsCsv } from "@/services/export";
import { buildTrainingDigest, renderCoachingBrief } from "@/services/digest";
import {
  createMigratedTestDatabase,
  createStartBarrier,
  failAfterBoundary,
  getWorkoutIntegrity,
  runSimultaneously,
  type TestDatabase,
} from "../helpers/database";
import { PRODUCTION_WORKOUT_START_WARMUP } from "../fixtures/production-workout-start-contract";

describe("workout lifecycle ownership and atomicity invariants", () => {
  let database: TestDatabase;
  let userId: string;
  let programId: string;
  let versionId: string;
  let exerciseId: string;
  let templateId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `lifecycle-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Lifecycle Squat",
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "dumbbell",
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
          name: "Lifecycle Program",
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
        .values({ programVersionId: version.id, name: "Lifecycle Day", warmupNotes: "Five minutes easy, then ramp up" })
        .returning({ id: workoutTemplates.id });
      const [slot] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: templateId,
          exerciseId: exercise.id,
          orderIdx: 0,
        })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 3,
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

  it("fails closed when a device tries to start a superseded Program day", async () => {
    let currentTemplateId = "";
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
        .values({ programVersionId: version.id, name: "Current Day" })
        .returning({ id: workoutTemplates.id });
      currentTemplateId = template.id;
      const [slot] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: template.id,
          exerciseId,
          orderIdx: 0,
        })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 3,
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
      startWorkoutSession(database.db, userId, templateId)
    ).rejects.toBeInstanceOf(StaleWorkoutTemplateError);
    expect(await database.db.select().from(workoutSessions)).toHaveLength(0);
    await expect(
      startWorkoutSession(database.db, userId, currentTemplateId)
    ).resolves.toMatchObject({ existing: false });
  });

  it("records the device timezone and local date when a workout starts", async () => {
    const result = await startWorkoutSession(
      database.db,
      userId,
      templateId,
      undefined,
      {
        now: () => new Date("2026-07-01T02:30:00.000Z"),
        timezone: "America/Vancouver",
      }
    );
    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, result.sessionId),
    });
    expect(session).toMatchObject({
      timezone: "America/Vancouver",
      localDate: "2026-06-30",
      dayWarmupNotes: "Five minutes easy, then ramp up",
    });
    expect(session?.dayWarmupItems).toEqual([]);
    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, result.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    expect(occurrences).toHaveLength(3);
    expect(occurrences.every((occurrence) => occurrence.kind === "working_set"))
      .toBe(true);
    expect(occurrences.some((occurrence) =>
      occurrence.label === "Five minutes easy, then ramp up"
    )).toBe(false);
  });

  it("starts from the retained production legacy percentage warm-up shape", async () => {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('workout_tracker.program_publish', 'authorized', true)`);
      await tx
        .update(workoutTemplateExercises)
        .set({ warmupSets: PRODUCTION_WORKOUT_START_WARMUP.map((item) => ({ ...item })) })
        .where(eq(workoutTemplateExercises.workoutTemplateId, templateId));
    });

    const started = await startWorkoutSession(database.db, userId, templateId);
    const warmups = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));

    expect(warmups.filter((item) => item.kind === "exercise_warmup")).toEqual([
      expect.objectContaining({ plannedLoadText: "empty bar", plannedLoadPercent: null }),
      expect.objectContaining({ plannedLoadText: null, plannedLoadPercent: 55 }),
      expect.objectContaining({ plannedLoadText: null, plannedLoadPercent: 72 }),
      expect.objectContaining({ plannedLoadText: null, plannedLoadPercent: 88 }),
    ]);
  });

  it("reconciles only the owner's unarchived active workout", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);

    await expect(findOwnedActiveWorkout(database.db, userId)).resolves.toMatchObject({
      id: started.sessionId,
    });

    await database.db
      .update(workoutSessions)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(workoutSessions.id, started.sessionId));

    await expect(findOwnedActiveWorkout(database.db, userId)).resolves.toBeUndefined();
  });

  it("atomically snapshots structured warm-ups and every tri-set occurrence in execution order", async () => {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('workout_tracker.program_publish', 'authorized', true)`);
      await tx
        .update(workoutTemplates)
        .set({
          warmupItems: [
            {
              key: crypto.randomUUID(),
              label: "Shoulder circles",
              reps: 10,
              load: null,
              loadUnit: null,
              loadPercent: null,
              loadText: null,
              notes: null,
            },
            {
              key: crypto.randomUUID(),
              label: "Band pull-aparts",
              reps: 20,
              load: null,
              loadUnit: null,
              loadPercent: null,
              loadText: "light band",
              notes: "Keep ribs down",
            },
          ],
        })
        .where(eq(workoutTemplates.id, templateId));
      const [group] = await tx
        .insert(supersetGroups)
        .values({
          workoutTemplateId: templateId,
          name: "Lifecycle tri-set",
          orderIdx: 0,
          plannedRounds: 2,
          restBetweenMembersSec: 20,
          restAfterRoundSec: 90,
        })
        .returning({ id: supersetGroups.id });
      const [existingSlot] = await tx
        .select({ id: workoutTemplateExercises.id })
        .from(workoutTemplateExercises)
        .where(eq(workoutTemplateExercises.workoutTemplateId, templateId));
      await tx
        .update(workoutTemplateExercises)
        .set({
          supersetGroupId: group.id,
          groupMemberOrderIdx: 0,
          warmupSets: [{
            label: "Empty bar",
            reps: 10,
            load: null,
            loadUnit: null,
            loadPercent: null,
            loadText: "empty bar",
            notes: null,
          }],
        })
        .where(eq(workoutTemplateExercises.id, existingSlot.id));
      await tx
        .update(exercisePrescriptions)
        .set({ sets: 2 })
        .where(eq(exercisePrescriptions.templateExerciseId, existingSlot.id));
      for (const memberOrder of [1, 2]) {
        const [slot] = await tx
          .insert(workoutTemplateExercises)
          .values({
            workoutTemplateId: templateId,
            exerciseId,
            orderIdx: memberOrder,
            supersetGroupId: group.id,
            groupMemberOrderIdx: memberOrder,
          })
          .returning({ id: workoutTemplateExercises.id });
        await tx.insert(exercisePrescriptions).values({
          templateExerciseId: slot.id,
          sets: 2,
          repRangeMin: 8 + memberOrder,
          repRangeMax: 10 + memberOrder,
          targetLoad: 100 - memberOrder * 10,
          targetLoadUnit: "lb",
        });
      }
    });

    const started = await startWorkoutSession(database.db, userId, templateId);
    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    });
    const groups = await database.db
      .select()
      .from(sessionExerciseGroups)
      .where(eq(sessionExerciseGroups.sessionId, started.sessionId));
    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));

    expect(session?.dayWarmupItems).toHaveLength(2);
    expect(groups).toEqual([
      expect.objectContaining({
        provenance: "program",
        plannedRounds: 2,
        memberCount: 3,
        restBetweenMembersSec: 20,
        restBetweenRoundsSec: 90,
      }),
    ]);
    expect(occurrences.map((occurrence) => occurrence.kind)).toEqual([
      "day_warmup",
      "day_warmup",
      "exercise_warmup",
      "working_set",
      "working_set",
      "working_set",
      "working_set",
      "working_set",
      "working_set",
    ]);
    expect(
      occurrences
        .filter((occurrence) => occurrence.kind === "working_set")
        .map((occurrence) => [
          occurrence.groupRound,
          occurrence.groupMemberOrderIdx,
        ]),
    ).toEqual([
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ]);
    expect(
      occurrences
        .filter((occurrence) => occurrence.kind === "working_set")
        .map((occurrence) => occurrence.plannedRestSec),
    ).toEqual([20, 20, 90, 20, 20, 0]);
  });

  it("keeps a zero-rep completion performed and abandons every remaining occurrence on finish", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [exercise] = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));

    const saved = await logWorkoutSet(database.db, userId, {
      sessionExerciseId: exercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 0,
      clientKey: "zero-rep-occurrence",
    });
    expect(saved.outcome).toBe("saved");

    await database.db.update(workoutSessions).set({
      startedAt: new Date("2026-07-21T16:00:00.000Z"),
      localDate: "2026-07-21",
    }).where(eq(workoutSessions.id, started.sessionId));

    await completeWorkoutSession(
      database.db,
      {
        id: userId,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      },
      { sessionId: started.sessionId },
      { now: () => new Date("2026-07-21T17:00:00.000Z") },
    );

    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    expect(occurrences.map((occurrence) => occurrence.outcome)).toEqual([
      "completed",
      "abandoned",
      "abandoned",
    ]);
    expect(occurrences[0]).toMatchObject({
      completedSetId: saved.outcome === "saved" ? saved.setId : null,
      outcome: "completed",
    });
    const [performed] = await database.db
      .select()
      .from(completedSets)
      .where(eq(completedSets.id, saved.outcome === "saved" ? saved.setId : ""));
    expect(performed.reps).toBe(0);
    expect(
      await database.db
        .select()
        .from(sessionOccurrenceMutations),
    ).toHaveLength(3);
    const csv = await buildSetsCsv(database.db, userId, null);
    const csvHeader = csv.split("\n")[0];
    expect(csvHeader).toContain("started_at,finished_at,timezone");
    expect(csvHeader).toContain(
      "session_quality_flags,active_duration_semantics_version,active_duration_seconds,active_duration_basis,duration_excluded",
    );
    expect(csvHeader).toContain("occurrence_kind");
    expect(csvHeader).toContain(
      "metric_type,performed_semantics_version,performed_load_type,performed_load_semantics",
    );
    const exportedRows = parse(csv, {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    expect(exportedRows[0]).toMatchObject({
      active_duration_semantics_version: "1",
      active_duration_basis: "wall_clock_no_stale_signal",
    });
    expect(exportedRows[0].finished_at).not.toBe("");
    expect(csv).toContain(",weight_reps,1,dumbbell,total,");
    expect(csv.split("\n")).toHaveLength(4);
    expect(csv).not.toContain("day_warmup");
    expect(csv).toContain("working_set");
    expect(csv).toContain("abandoned");
    const digest = await buildTrainingDigest(
      database.db,
      userId,
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-22T00:00:00.000Z"),
    );
    const brief = renderCoachingBrief(digest);
    expect(brief).toContain("Occurrence outcomes");
    expect(brief).not.toContain("Five minutes easy, then ramp up");
    expect(brief).toContain("completed with a retained performed result");
  });

  it("keeps live observed completion distinct from the immutable server receipt across retries", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [exercise] = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const observedCompletedAtISO = new Date().toISOString();
    const input = {
      sessionExerciseId: exercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb" as const,
      reps: 8,
      clientKey: crypto.randomUUID(),
      observedCompletedAtISO,
    };

    const saved = await logWorkoutSet(database.db, userId, input);
    expect(saved.outcome).toBe("saved");
    await expect(logWorkoutSet(database.db, userId, input)).resolves.toEqual(saved);
    if (saved.outcome !== "saved") throw new Error("Set was not saved.");

    const set = await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, saved.setId),
    });
    expect(set).toMatchObject({
      observedCompletedAt: new Date(observedCompletedAtISO),
      observedCompletionProvenance: "live_client",
      observedCompletionQuality: "trustworthy",
    });
    expect(set?.loggedAt).toBeInstanceOf(Date);

    const skewedInput = {
      ...input,
      setNo: 2,
      clientKey: crypto.randomUUID(),
      observedCompletedAtISO: new Date(Date.now() + 60_000).toISOString(),
    };
    const skewed = await logWorkoutSet(database.db, userId, skewedInput);
    expect(skewed.outcome).toBe("saved");
    await expect(logWorkoutSet(database.db, userId, skewedInput)).resolves.toEqual(skewed);
    if (skewed.outcome !== "saved") throw new Error("Skewed set was not saved.");
    await expect(
      database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, skewed.setId),
      }),
    ).resolves.toMatchObject({
      observedCompletedAt: new Date(skewedInput.observedCompletedAtISO),
      observedCompletionProvenance: "live_client",
      observedCompletionQuality: "trustworthy",
    });

    await expect(logWorkoutSet(database.db, userId, {
      ...input,
      setNo: 3,
      clientKey: crypto.randomUUID(),
      observedCompletedAtISO: new Date(Date.now() + 301_000).toISOString(),
    })).resolves.toEqual({ outcome: "invalid_observed_completion" });
  });

  it("requires stale-session review and preserves source timestamps when active time is reported", async () => {
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      templateId,
    );
    await database.db
      .update(workoutSessions)
      .set({
        startedAt: new Date("2026-07-20T12:00:00.000Z"),
        localDate: "2026-07-20",
      })
      .where(eq(workoutSessions.id, sessionId));

    const rejected = await completeWorkoutSession(
      database.db,
      {
        id: userId,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      },
      { sessionId },
      { now: () => new Date("2026-07-20T16:00:00.000Z") },
    );
    expect(rejected).toMatchObject({
      outcome: "duration_review_required",
      wallClockElapsedSeconds: 14_400,
      reviewRequired: true,
    });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    })).resolves.toMatchObject({
      status: "in_progress",
      startedAt: new Date("2026-07-20T12:00:00.000Z"),
      finishedAt: null,
      activeDurationSemanticsVersion: null,
      activeDurationSeconds: null,
      activeDurationBasis: null,
    });

    const accepted = await completeWorkoutSession(
      database.db,
      {
        id: userId,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      },
      {
        sessionId,
        durationDecision: {
          basis: "owner_reported",
          activeDurationSeconds: 3_600,
        },
      },
      { now: () => new Date("2026-07-20T16:00:00.000Z") },
    );
    expect(accepted).toMatchObject({ outcome: "completed" });

    const completed = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    });
    expect(completed).toMatchObject({
      status: "completed",
      startedAt: new Date("2026-07-20T12:00:00.000Z"),
      finishedAt: new Date("2026-07-20T16:00:00.000Z"),
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 3_600,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: ["workout_elapsed_over_3h"],
    });
  });

  it("persists skip reasons and never reapplies an old skip after restore", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [occurrence] = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));

    const skipInput = {
      occurrenceId: occurrence.id,
      clientKey: "offline-skip-key",
      expectedRevision: 0,
      operation: "skip" as const,
      reason: "pain",
      note: "Left knee discomfort during setup",
    };
    const skipped = await mutateWorkoutOccurrence(
      database.db,
      userId,
      skipInput,
    );
    expect(skipped).toMatchObject({
      outcome: "saved",
      occurrence: {
        state: "skipped",
        reason: "pain",
        note: "Left knee discomfort during setup",
        revision: 1,
      },
    });

    const restored = await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: occurrence.id,
      clientKey: "restore-after-skip-key",
      expectedRevision: 1,
      operation: "restore",
    });
    expect(restored).toMatchObject({
      outcome: "saved",
      occurrence: {
        state: "pending",
        reason: null,
        note: "Left knee discomfort during setup",
        revision: 2,
      },
    });

    const staleReplay = await mutateWorkoutOccurrence(
      database.db,
      userId,
      skipInput,
    );
    expect(staleReplay).toMatchObject({
      outcome: "replayed",
      occurrence: { state: "pending", revision: 2 },
    });
    expect(
      await database.db
        .select()
        .from(sessionOccurrenceMutations),
    ).toHaveLength(2);
  });

  it("completes warm-ups directly but requires a performed set for working occurrences", async () => {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('workout_tracker.program_publish', 'authorized', true)`);
      await tx
        .update(workoutTemplates)
        .set({
          warmupItems: [{
            key: crypto.randomUUID(),
            label: "Shoulder circles",
            reps: 10,
            load: null,
            loadUnit: null,
            loadPercent: null,
            loadText: null,
            notes: null,
          }],
        })
        .where(eq(workoutTemplates.id, templateId));
    });
    const started = await startWorkoutSession(database.db, userId, templateId);
    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    const warmup = occurrences.find((occurrence) => occurrence.kind === "day_warmup");
    const working = occurrences.find((occurrence) => occurrence.kind === "working_set");
    expect(warmup).toBeDefined();
    expect(working).toBeDefined();

    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmup!.id,
      clientKey: "complete-warmup",
      expectedRevision: 0,
      operation: "complete",
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: { state: "completed", revision: 1 },
    });
    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmup!.id,
      clientKey: "note-completed-warmup",
      expectedRevision: 1,
      operation: "note",
      note: "Felt smooth after completion",
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: {
        state: "completed",
        note: "Felt smooth after completion",
        revision: 2,
      },
    });
    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmup!.id,
      clientKey: "clear-completed-warmup-note",
      expectedRevision: 2,
      operation: "note",
      note: "   ",
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: { state: "completed", note: null, revision: 3 },
    });
    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: working!.id,
      clientKey: "invalid-direct-working-completion",
      expectedRevision: 0,
      operation: "complete",
    })).resolves.toEqual({ outcome: "conflict" });
  });

  it("never saves a performed result unless its pending working occurrence can complete", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [exercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const [firstWorking] = (await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, exercise.id))
      .orderBy(asc(sessionOccurrences.sequenceIdx)))
      .filter((occurrence) => occurrence.kind === "working_set");

    await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: firstWorking.id,
      clientKey: "skip-before-late-log",
      expectedRevision: 0,
      operation: "skip",
      reason: "user_skipped",
    });

    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: exercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: "late-log-after-skip",
    })).resolves.toEqual({ outcome: "set_number_conflict" });
    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: exercise.id,
      setNo: 4,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: "out-of-plan-set",
    })).resolves.toEqual({ outcome: "set_number_conflict" });
    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: exercise.id,
      setNo: 2,
      weight: 45,
      weightUnit: "lb",
      reps: 10,
      isWarmup: true,
      clientKey: "warmup-through-working-path",
    })).resolves.toEqual({ outcome: "set_number_conflict" });

    expect(await database.db.select().from(completedSets)).toHaveLength(0);
  });

  it("creates one completed ad-hoc occurrence for the next extra set", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [exercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));

    for (const setNo of [1, 2, 3]) {
      await expect(logWorkoutSet(database.db, userId, {
        sessionExerciseId: exercise.id,
        setNo,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        clientKey: `planned-set-${setNo}`,
      })).resolves.toMatchObject({ outcome: "saved" });
    }

    const extra = await logWorkoutSet(database.db, userId, {
      sessionExerciseId: exercise.id,
      setNo: 4,
      weight: 105,
      weightUnit: "lb",
      reps: 8,
      clientKey: "ad-hoc-extra-set",
    });
    expect(extra).toMatchObject({ outcome: "saved" });

    const working = (await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, exercise.id))
      .orderBy(asc(sessionOccurrences.kindOrdinal)))
      .filter((occurrence) => occurrence.kind === "working_set");
    expect(working).toHaveLength(4);
    expect(working[3]).toMatchObject({
      origin: "ad_hoc",
      kindOrdinal: 3,
      outcome: "completed",
      completedSetId: extra.outcome === "saved" ? extra.setId : null,
    });
  });

  it("refuses later same-exercise work while another exercise can still save and exact retry stays idempotent", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [plannedExercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const [addedDefinition] = await database.db
      .insert(exercises)
      .values({
        name: "Independent Workout Row",
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "bodyweight",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    const added = await addWorkoutExercise(database.db, userId, {
      sessionId: started.sessionId,
      exerciseId: addedDefinition.id,
      mutationId: crypto.randomUUID(),
      expectedSessionRevision: 0,
      initialSetCount: 1,
      insertion: "end",
    });
    if (added.outcome !== "added") {
      throw new Error("The independent exercise fixture was not added.");
    }

    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: plannedExercise.id,
      setNo: 2,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: "out-of-order-set-2",
    })).resolves.toEqual({ outcome: "set_order_conflict" });
    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: added.sessionExerciseId,
      setNo: 1,
      weight: null,
      weightUnit: null,
      reps: 12,
      clientKey: "other-exercise-set-1",
    })).resolves.toMatchObject({ outcome: "saved" });

    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: plannedExercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: "ordered-set-1",
    })).resolves.toMatchObject({ outcome: "saved" });
    const saved = await logWorkoutSet(database.db, userId, {
      sessionExerciseId: plannedExercise.id,
      setNo: 2,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: "stable-ordered-set-2",
    });
    expect(saved).toMatchObject({ outcome: "saved" });
    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: plannedExercise.id,
      setNo: 2,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: "stable-ordered-set-2",
    })).resolves.toEqual(saved);
    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: plannedExercise.id,
      setNo: 2,
      weight: 100,
      weightUnit: "lb",
      reps: 7,
      clientKey: "stable-ordered-set-2",
    })).resolves.toEqual({ outcome: "retry_identity_conflict" });

    expect(
      await database.db
        .select()
        .from(completedSets)
        .where(eq(completedSets.sessionExerciseId, plannedExercise.id)),
    ).toHaveLength(2);
  });

  it("atomically adds a workout-only exercise without changing Program intent", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [addedDefinition] = await database.db
      .insert(exercises)
      .values({
        name: "Workout-only Row",
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "bodyweight",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    const mutationId = crypto.randomUUID();
    const input = {
      sessionId: started.sessionId,
      exerciseId: addedDefinition.id,
      mutationId,
      expectedSessionRevision: 0,
      initialSetCount: 2,
      insertion: "end" as const,
    };

    const [unavailableDefinition] = await database.db
      .insert(exercises)
      .values({
        name: "Unavailable Cable Row",
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "cable",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    await database.db.insert(exerciseEquipmentRequirements).values({
      exerciseId: unavailableDefinition.id,
      equipmentType: "cable",
    });
    await expect(
      addWorkoutExercise(database.db, userId, {
        ...input,
        exerciseId: unavailableDefinition.id,
        mutationId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: "exercise_unavailable" });

    const added = await addWorkoutExercise(database.db, userId, input);
    expect(added).toMatchObject({
      outcome: "added",
      sessionRevision: 1,
    });
    if (added.outcome !== "added") {
      throw new Error("The workout-only exercise was not added.");
    }
    expect(added.sessionExerciseId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(added.occurrenceIds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      ]),
    );

    const [sessionExercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.id, added.sessionExerciseId));
    expect(sessionExercise).toMatchObject({
      sessionId: started.sessionId,
      exerciseId: addedDefinition.id,
      modificationType: "added",
      orderIdx: 1,
      restSec: 90,
      plannedFromTemplateExerciseId: null,
      sourceSlotLineageId: null,
      substitutedForExerciseId: null,
      groupSnapshotId: null,
      targetSets: null,
      targetRepsMin: null,
      targetRepsMax: null,
      targetLoad: null,
      targetLoadUnit: null,
      notes: null,
      warmupSets: [],
      setNotes: [],
      currentEquipmentSnapshotId: null,
    });
    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, added.sessionExerciseId))
      .orderBy(asc(sessionOccurrences.kindOrdinal));
    expect(occurrences).toHaveLength(2);
    expect(occurrences).toEqual([
      expect.objectContaining({
        id: added.occurrenceIds[0],
        kind: "working_set",
        origin: "ad_hoc",
        kindOrdinal: 0,
        plannedExerciseId: addedDefinition.id,
        plannedRepsMin: null,
        plannedRepsMax: null,
        plannedLoad: null,
        plannedLoadUnit: null,
        plannedRestSec: 90,
        outcome: "pending",
      }),
      expect.objectContaining({
        id: added.occurrenceIds[1],
        kind: "working_set",
        origin: "ad_hoc",
        kindOrdinal: 1,
        plannedExerciseId: addedDefinition.id,
        outcome: "pending",
      }),
    ]);
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, started.sessionId),
        columns: { historyRevision: true },
      }),
    ).toEqual({ historyRevision: 1 });
    expect(
      await database.db
        .select({ id: workoutTemplateExercises.id })
        .from(workoutTemplateExercises),
    ).toHaveLength(1);
    expect(
      await database.db
        .select({ id: exercisePrescriptions.id })
        .from(exercisePrescriptions),
    ).toHaveLength(1);

    await expect(
      addWorkoutExercise(database.db, userId, input),
    ).resolves.toEqual({
      ...added,
      outcome: "replayed",
    });
    await expect(
      addWorkoutExercise(database.db, userId, {
        ...input,
        exerciseId,
      }),
    ).resolves.toMatchObject({ outcome: "conflict" });
    await expect(
      addWorkoutExercise(database.db, userId, {
        ...input,
        mutationId: crypto.randomUUID(),
      }),
    ).resolves.toEqual({ outcome: "stale" });
    expect(
      await database.db
        .select({ id: sessionExercises.id })
        .from(sessionExercises)
        .where(eq(sessionExercises.sessionId, started.sessionId)),
    ).toHaveLength(2);

    const [{ id: otherUserId }] = await database.db
      .insert(users)
      .values({ email: `other-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId: otherUserId });
    await expect(
      addWorkoutExercise(database.db, otherUserId, {
        ...input,
        mutationId: crypto.randomUUID(),
        expectedSessionRevision: 1,
      }),
    ).resolves.toEqual({ outcome: "not_found" });

    await abandonWorkoutSession(database.db, userId, started.sessionId);
    await expect(
      addWorkoutExercise(database.db, userId, {
        ...input,
        mutationId: crypto.randomUUID(),
        expectedSessionRevision: 1,
      }),
    ).resolves.toEqual({ outcome: "workout_not_active" });
  });

  it("rolls back every added-exercise child when the final write gate fails", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [addedDefinition] = await database.db
      .insert(exercises)
      .values({
        name: "Atomic Addition Failure",
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "bodyweight",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    const exerciseCountBefore = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const occurrenceCountBefore = await database.db
      .select({ id: sessionOccurrences.id })
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId));

    await expect(
      addWorkoutExercise(
        database.db,
        userId,
        {
          sessionId: started.sessionId,
          exerciseId: addedDefinition.id,
          mutationId: crypto.randomUUID(),
          expectedSessionRevision: 0,
          initialSetCount: 3,
          insertion: "end",
        },
        { failureAt: "audit" },
      ),
    ).resolves.toEqual({ outcome: "failed" });
    expect(
      await database.db
        .select({ id: sessionExercises.id })
        .from(sessionExercises)
        .where(eq(sessionExercises.sessionId, started.sessionId)),
    ).toHaveLength(exerciseCountBefore.length);
    expect(
      await database.db
        .select({ id: sessionOccurrences.id })
        .from(sessionOccurrences)
        .where(eq(sessionOccurrences.sessionId, started.sessionId)),
    ).toHaveLength(occurrenceCountBefore.length);
    expect(
      await database.db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.action, "session_exercise.add")),
    ).toHaveLength(0);
  });

  it("durably appends one fresh pending set and replays rapid duplicate delivery", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [exercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const before = (await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, exercise.id))
      .orderBy(asc(sessionOccurrences.kindOrdinal)))
      .filter((occurrence) => occurrence.kind === "working_set");
    const preceding = before.at(-1);
    expect(preceding).toBeDefined();

    const occurrenceId = crypto.randomUUID();
    const appended = await appendWorkoutSetOccurrence(database.db, userId, {
      sessionExerciseId: exercise.id,
      occurrenceId,
      expectedSetNo: 4,
    });
    expect(appended).toMatchObject({
      outcome: "appended",
      occurrence: {
        id: occurrenceId,
        sessionExerciseId: exercise.id,
        kindOrdinal: 3,
        plannedExerciseId: exerciseId,
        plannedRepsMin: preceding?.plannedRepsMin,
        plannedRepsMax: preceding?.plannedRepsMax,
        plannedLoad: preceding?.plannedLoad,
        plannedLoadUnit: preceding?.plannedLoadUnit,
        plannedRestSec: preceding?.plannedRestSec,
        plannedNote: "Added during this workout",
      },
    });
    for (const setNo of [1, 2, 3]) {
      await expect(logWorkoutSet(database.db, userId, {
        sessionExerciseId: exercise.id,
        setNo,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        clientKey: `resolve-before-append-${setNo}`,
      })).resolves.toMatchObject({ outcome: "saved" });
    }
    await expect(
      appendWorkoutSetOccurrence(database.db, userId, {
        sessionExerciseId: exercise.id,
        occurrenceId,
        expectedSetNo: 4,
      }),
    ).resolves.toMatchObject({ outcome: "replayed" });
    await expect(
      appendWorkoutSetOccurrence(database.db, userId, {
        sessionExerciseId: exercise.id,
        occurrenceId: crypto.randomUUID(),
        expectedSetNo: 4,
      }),
    ).resolves.toEqual({ outcome: "stale" });

    const afterRefresh = (await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, exercise.id))
      .orderBy(asc(sessionOccurrences.kindOrdinal)))
      .filter((occurrence) => occurrence.kind === "working_set");
    expect(afterRefresh).toHaveLength(4);
    expect(afterRefresh[3]).toMatchObject({
      id: occurrenceId,
      origin: "ad_hoc",
      outcome: "pending",
      revision: 0,
      completedSetId: null,
      resolvedAt: null,
    });

    const performed = await logWorkoutSet(database.db, userId, {
      sessionExerciseId: exercise.id,
      setNo: 4,
      weight: 105,
      weightUnit: "lb",
      reps: 8,
      rpe: 8.5,
      clientKey: "durably-appended-set-result",
    });
    expect(performed).toMatchObject({
      outcome: "saved",
      occurrenceId,
    });
    if (performed.outcome !== "saved") {
      throw new Error("The appended set result was not saved.");
    }
    expect(performed.setId).not.toBe(occurrenceId);
    const [resolved] = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.id, occurrenceId));
    expect(resolved).toMatchObject({
      outcome: "completed",
      revision: 1,
      completedSetId: performed.setId,
    });
    await completeWorkoutSession(
      database.db,
      {
        id: userId,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      },
      { sessionId: started.sessionId },
    );
    const exportedSets = parse(await buildSetsCsv(database.db, userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    expect(
      exportedSets.find(
        (row) => row.completed_set_id === performed.setId,
      ),
    ).toMatchObject({
      occurrence_id: occurrenceId,
      occurrence_kind: "working_set",
      occurrence_origin: "ad_hoc",
      occurrence_kind_ordinal: "3",
      occurrence_display_label: "Extra set 1",
      occurrence_planned_note: "Added during this workout",
    });
  });

  it("initializes an added set from the immediately preceding performed set", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [exercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    for (const [index, weight] of [105, 115, 125].entries()) {
      await expect(
        logWorkoutSet(database.db, userId, {
          sessionExerciseId: exercise.id,
          setNo: index + 1,
          weight,
          weightUnit: "lb",
          reps: 8 - index,
          clientKey: `preceding-performed-set-${index + 1}`,
        }),
      ).resolves.toMatchObject({ outcome: "saved" });
    }

    await expect(
      appendWorkoutSetOccurrence(database.db, userId, {
        sessionExerciseId: exercise.id,
        occurrenceId: crypto.randomUUID(),
        expectedSetNo: 4,
      }),
    ).resolves.toMatchObject({
      outcome: "appended",
      occurrence: {
        kindOrdinal: 3,
        plannedLoad: 125,
        plannedLoadUnit: "lb",
        plannedLoadPercent: null,
        plannedLoadText: null,
        plannedRepsMin: 6,
        plannedRepsMax: 6,
      },
    });
  });

  it("skips and restores an exercise's pending occurrences without reviving an individually skipped set", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [exercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const working = (await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, exercise.id))
      .orderBy(asc(sessionOccurrences.sequenceIdx)))
      .filter((occurrence) => occurrence.kind === "working_set");

    await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: working[0].id,
      clientKey: "individual-working-skip",
      expectedRevision: 0,
      operation: "skip",
      reason: "user_skipped",
    });
    await expect(updateSessionExerciseWithVersion(
      database.db,
      userId,
      exercise.id,
      { modificationType: "skipped", skipReason: "time" },
      "session_exercise.skip",
      { activeOnly: true },
    )).resolves.toMatchObject({ ok: true, changed: true });

    let outcomes = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, exercise.id))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    expect(outcomes.map((occurrence) => occurrence.outcome)).toEqual([
      "skipped", "skipped", "skipped",
    ]);
    expect(outcomes.map((occurrence) => occurrence.outcomeReason)).toEqual([
      "user_skipped", "exercise:time", "exercise:time",
    ]);

    await expect(updateSessionExerciseWithVersion(
      database.db,
      userId,
      exercise.id,
      { modificationType: "as_planned", skipReason: null },
      "session_exercise.unskip",
      { activeOnly: true },
    )).resolves.toMatchObject({ ok: true, changed: true });
    outcomes = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, exercise.id))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    expect(outcomes.map((occurrence) => occurrence.outcome)).toEqual([
      "skipped", "pending", "pending",
    ]);
    expect(
      (await database.db.select().from(sessionOccurrenceMutations)).length,
    ).toBe(5);
  });

  it("converges many simultaneous starts on one complete active session", async () => {
    const ready = createStartBarrier(8);
    const results = await runSimultaneously(8, () =>
      startWorkoutSession(database.db, userId, templateId, undefined, {
        checkpoint: async (boundary) => {
          if (boundary === "before-start-statement") await ready();
        },
      })
    );

    expect(new Set(results.map(({ sessionId }) => sessionId))).toHaveLength(1);
    expect(results.filter(({ existing }) => !existing)).toHaveLength(1);
    const integrity = await getWorkoutIntegrity(database.db, userId);
    expect(integrity).toMatchObject({
      sessions: 1,
      session_exercises: 1,
      orphan_exercises: 0,
    });
  });

  it("rolls back the session when any snapshotted exercise insert fails", async () => {
    await database.client.exec(`
      ALTER TABLE session_exercises
      ADD CONSTRAINT injected_start_failure CHECK (false)
    `);
    await expect(
      startWorkoutSession(database.db, userId, templateId)
    ).rejects.toThrow();

    expect(await getWorkoutIntegrity(database.db, userId)).toMatchObject({
      sessions: 0,
      session_exercises: 0,
      completed_sets: 0,
    });
  });

  it("removes only an owned incomplete shell and refuses one that has a completed set", async () => {
    const [brokenSession] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateId,
        templateName: "Broken shell",
        timezone: "UTC",
        localDate: "2026-07-18",
        startedAt: new Date("2026-07-18T12:00:00.000Z"),
      })
      .returning({ id: workoutSessions.id });
    await database.db.insert(sessionExercises).values({
      sessionId: brokenSession.id,
      exerciseId,
      orderIdx: 0,
    });

    const [protectedSession] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateId,
        templateName: "Protected shell",
        timezone: "UTC",
        localDate: "2026-07-17",
        startedAt: new Date("2026-07-17T12:00:00.000Z"),
        archivedAt: new Date("2026-07-18T12:00:00.000Z"),
      })
      .returning({ id: workoutSessions.id });
    const [protectedExercise] = await database.db
      .insert(sessionExercises)
      .values({ sessionId: protectedSession.id, exerciseId, orderIdx: 0 })
      .returning({ id: sessionExercises.id });
    await database.db.insert(completedSets).values({
      sessionExerciseId: protectedExercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
    });

    await expect(
      cleanupIncompleteWorkoutCreation(database.db, userId, brokenSession.id)
    ).resolves.toEqual({ deletedExercises: 1, deletedSessions: 1 });
    await expect(
      cleanupIncompleteWorkoutCreation(database.db, userId, protectedSession.id)
    ).resolves.toEqual({ deletedExercises: 0, deletedSessions: 0 });

    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, brokenSession.id),
      })
    ).toBeUndefined();
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, protectedSession.id),
      })
    ).toBeDefined();
    expect(await database.db.select().from(completedSets)).toHaveLength(1);
  });

  it("cleans up an injected start mismatch and allows the next start", async () => {
    let logged = 0;
    const failure = startWorkoutSession(
      database.db,
      userId,
      templateId,
      undefined,
      {
        evaluateStartCounts: () => false,
        logStartIncomplete: () => {
          logged += 1;
        },
      }
    );
    await expect(failure).rejects.toEqual(
      expect.objectContaining({
        name: "IncompleteWorkoutCreationError",
        message:
          "The workout could not be created completely. Nothing was saved — try again.",
      })
    );
    await expect(failure).rejects.toBeInstanceOf(IncompleteWorkoutCreationError);
    expect(logged).toBe(1);
    expect(await database.db.select().from(workoutSessions)).toHaveLength(0);
    expect(await database.db.select().from(sessionExercises)).toHaveLength(0);
    expect(await database.db.select().from(auditLogs)).toHaveLength(0);

    await expect(
      startWorkoutSession(database.db, userId, templateId)
    ).resolves.toMatchObject({ existing: false });
    expect(await database.db.select().from(workoutSessions)).toHaveLength(1);
    expect(await database.db.select().from(sessionExercises)).toHaveLength(1);
  });

  it.each([4, 601, 5.5])(
    "rejects an invalid session time budget before writing: %s",
    async (timeBudgetMin) => {
      await expect(
        startWorkoutSession(database.db, userId, templateId, timeBudgetMin)
      ).rejects.toThrow();
      expect(await database.db.select().from(workoutSessions)).toHaveLength(0);
    }
  );

  it("enforces session time budgets in the database", async () => {
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      templateId,
      45
    );
    await expect(
      database.db
        .update(workoutSessions)
        .set({ timeBudgetMin: -5 })
        .where(eq(workoutSessions.id, sessionId))
    ).rejects.toThrow();
    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    });
    expect(session?.timeBudgetMin).toBe(45);
  });

  it("makes simultaneous delivery of one client identity idempotent", async () => {
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      templateId
    );
    const [sessionExercise] = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, sessionId));
    const ready = createStartBarrier(8);
    const results = await runSimultaneously(8, () =>
      logWorkoutSet(
        database.db,
        userId,
        {
          sessionExerciseId: sessionExercise.id,
          setNo: 1,
          weight: 100,
          weightUnit: "lb",
          reps: 8,
          clientKey: "same-delivery",
        },
        {
          checkpoint: async (boundary) => {
            if (boundary === "before-set-statement") await ready();
          },
        }
      )
    );

    expect(results.every(({ outcome }) => outcome === "saved")).toBe(true);
    expect(
      new Set(
        results.flatMap((result) =>
          result.outcome === "saved" ? [result.setId] : []
        )
      )
    ).toHaveLength(1);
    expect(
      new Set(
        results.flatMap((result) =>
          result.outcome === "saved" ? [result.occurrenceId] : []
        )
      )
    ).toHaveLength(1);
    const [savedSet] = await database.db.select().from(completedSets);
    const [savedOccurrence] = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.completedSetId, savedSet.id));
    expect(results[0]).toMatchObject({
      outcome: "saved",
      setId: savedSet.id,
      occurrenceId: savedOccurrence.id,
    });
  });

  it("stores a typed barbell load as the assembled total without adding the empty bar", async () => {
    const { sessionId } = await startWorkoutSession(database.db, userId, templateId);
    const [sessionExercise] = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, sessionId));
    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: sessionExercise.id,
      setNo: 1,
      weight: 95,
      weightUnit: "lb",
      reps: 8,
      clientKey: "assembled-total-95",
    })).resolves.toMatchObject({ outcome: "saved" });
    const [saved] = await database.db.select().from(completedSets);
    expect(saved).toMatchObject({ weight: 95, weightUnit: "lb" });
  });

  it("rejects active set logging after the workout completes", async () => {
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      templateId
    );
    const [sessionExercise] = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, sessionId));
    await database.db
      .update(workoutSessions)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(workoutSessions.id, sessionId));

    await expect(logWorkoutSet(database.db, userId, {
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        clientKey: "after-finish",
      })).resolves.toEqual({ outcome: "workout_not_active" });
    expect(await database.db.select().from(completedSets)).toHaveLength(0);
  });

  it("keeps one complete closing result when the response fails after commit", async () => {
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      templateId
    );
    const user = {
      id: userId,
      coachingPrefs: {
        aggressiveness: "conservative" as const,
        deloadSuggestions: true,
        substitutionSuggestions: true,
        weeklyReview: true,
      },
    };
    await expect(
      completeWorkoutSession(
        database.db,
        user,
        { sessionId, note: "Must survive", fatigue: 3 },
        {
          checkpoint: failAfterBoundary("after-completion-statement"),
        }
      )
    ).rejects.toThrow("Injected failure after after-completion-statement");

    const retry = await completeWorkoutSession(
      database.db,
      user,
      { sessionId, note: "Must survive", fatigue: 3 }
    );
    expect(retry.alreadyFinished).toBe(true);
    expect(await database.db.select().from(sessionNotes)).toHaveLength(1);
    expect(await database.db.select().from(fatigueLogs)).toHaveLength(1);
    expect(await database.db.select().from(auditLogs)).toHaveLength(1);
    expect(await database.db.select().from(progressionJobs)).toHaveLength(1);
  });

  it("converges simultaneous completion on one transition and one closing record set", async () => {
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      templateId
    );
    const ready = createStartBarrier(8);
    const user = {
      id: userId,
      coachingPrefs: {
        aggressiveness: "conservative" as const,
        deloadSuggestions: true,
        substitutionSuggestions: true,
        weeklyReview: true,
      },
    };
    const results = await runSimultaneously(8, () =>
      completeWorkoutSession(
        database.db,
        user,
        { sessionId, note: "One note", fatigue: 3 },
        {
          checkpoint: async (boundary) => {
            if (boundary === "before-completion-statement") await ready();
          },
        }
      )
    );

    expect(results.filter(({ alreadyFinished }) => !alreadyFinished)).toHaveLength(1);
    expect(await database.db.select().from(sessionNotes)).toHaveLength(1);
    expect(await database.db.select().from(fatigueLogs)).toHaveLength(1);
    expect(await database.db.select().from(auditLogs)).toHaveLength(1);
    expect(await database.db.select().from(progressionJobs)).toHaveLength(1);
  });

  it("rolls back every completion write when an internal boundary rejects", async () => {
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      templateId
    );
    await database.client.exec(`
      ALTER TABLE audit_logs
      ADD CONSTRAINT injected_completion_failure
      CHECK (action <> 'session.complete')
    `);
    const user = {
      id: userId,
      coachingPrefs: {
        aggressiveness: "conservative" as const,
        deloadSuggestions: true,
        substitutionSuggestions: true,
        weeklyReview: true,
      },
    };

    await expect(
      completeWorkoutSession(database.db, user, {
        sessionId,
        note: "Must roll back",
        fatigue: 4,
      })
    ).rejects.toThrow();

    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    });
    expect(session).toMatchObject({ status: "in_progress", finishedAt: null });
    expect(await database.db.select().from(sessionNotes)).toHaveLength(0);
    expect(await database.db.select().from(fatigueLogs)).toHaveLength(0);
    expect(await database.db.select().from(auditLogs)).toHaveLength(0);
    expect(await database.db.select().from(progressionJobs)).toHaveLength(0);
  });

  it("allows only one visible set number even with different retry identities", async () => {
    const { sessionId } = await startWorkoutSession(database.db, userId, templateId);
    const [sessionExercise] = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, sessionId));
    const ready = createStartBarrier(2);
    const results = await Promise.allSettled(
      ["first-delivery", "second-delivery"].map((clientKey) =>
        logWorkoutSet(
          database.db,
          userId,
          {
            sessionExerciseId: sessionExercise.id,
            setNo: 1,
            weight: 100,
            weightUnit: "lb",
            reps: 8,
            clientKey,
          },
          {
            checkpoint: async (boundary) => {
              if (boundary === "before-set-statement") await ready();
            },
          }
        )
      )
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    expect(
      results.some(
        (result) =>
          result.status === "fulfilled" && result.value.outcome === "saved"
      )
    ).toBe(true);
    expect(
      results.some(
        (result) =>
          result.status === "fulfilled" &&
          result.value.outcome === "set_number_conflict"
      )
    ).toBe(true);
    expect(await database.db.select().from(completedSets)).toHaveLength(1);
  });

  it("persists the actual performed metric and refuses unsafe set shapes before mutation", async () => {
    const { sessionId } = await startWorkoutSession(
      database.db,
      userId,
      templateId,
    );
    const [planned] = await database.db
      .select({
        id: sessionExercises.id,
        exerciseId: sessionExercises.exerciseId,
      })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, sessionId));
    const weighted = await logWorkoutSet(database.db, userId, {
      sessionExerciseId: planned.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: "explicit-weight-metric",
    });
    expect(weighted).toMatchObject({ outcome: "saved" });

    const definitions = await database.db
      .insert(exercises)
      .values([
        {
          name: `Lifecycle reps ${crypto.randomUUID()}`,
          movementPattern: "vertical_pull" as const,
          primaryMuscles: ["back"],
          loadType: "bodyweight",
          metricType: "reps" as const,
          loadSemantics: "bodyweight" as const,
          variantAttributes: { assistance: "none" as const },
        },
        {
          name: `Lifecycle assisted ${crypto.randomUUID()}`,
          movementPattern: "vertical_pull" as const,
          primaryMuscles: ["back"],
          loadType: "external",
          metricType: "assisted_reps" as const,
          loadSemantics: "assistance" as const,
          variantAttributes: { assistance: "assisted" as const },
        },
        {
          name: `Lifecycle band ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull" as const,
          primaryMuscles: ["back"],
          loadType: "band",
          metricType: "weight_reps" as const,
          loadSemantics: "resistance_band" as const,
          variantAttributes: {},
        },
        {
          name: `Lifecycle duration ${crypto.randomUUID()}`,
          movementPattern: "core" as const,
          primaryMuscles: ["core"],
          loadType: "bodyweight",
          metricType: "duration" as const,
          loadSemantics: "none" as const,
          variantAttributes: {},
        },
      ])
      .returning({ id: exercises.id, metricType: exercises.metricType });
    const addedExercises = await database.db
      .insert(sessionExercises)
      .values(
        definitions.map((definition, index) => ({
          sessionId,
          exerciseId: definition.id,
          modificationType:
            definition.metricType === "reps"
              ? ("substituted" as const)
              : ("added" as const),
          substitutedForExerciseId:
            definition.metricType === "reps" ? planned.exerciseId : null,
          orderIdx: index + 1,
        })),
      )
      .returning({
        id: sessionExercises.id,
        exerciseId: sessionExercises.exerciseId,
      });
    await database.db.insert(sessionOccurrences).values(
      addedExercises.map((exercise, index) => ({
        sessionId,
        sessionExerciseId: exercise.id,
        kind: "working_set" as const,
        origin: "ad_hoc" as const,
        sequenceIdx: 10 + index,
        kindOrdinal: 0,
        plannedExerciseId:
          definitions[index]?.metricType === "reps"
            ? planned.exerciseId
            : exercise.exerciseId,
      })),
    );
    const byMetric = new Map(
      definitions.map((definition) => [
        definition.metricType,
        addedExercises.find(
          (exercise) => exercise.exerciseId === definition.id,
        )!,
      ]),
    );

    await expect(
      logWorkoutSet(database.db, userId, {
        sessionExerciseId: byMetric.get("reps")!.id,
        setNo: 1,
        weight: null,
        weightUnit: null,
        reps: 10,
        clientKey: "explicit-reps-metric",
      }),
    ).resolves.toMatchObject({ outcome: "saved" });
    const assistedInput = {
      sessionExerciseId: byMetric.get("assisted_reps")!.id,
      setNo: 1,
      weight: 80,
      weightUnit: "lb" as const,
      reps: 10,
      clientKey: "explicit-assisted-metric",
    };
    const assisted = await logWorkoutSet(
      database.db,
      userId,
      assistedInput,
    );
    expect(assisted).toMatchObject({ outcome: "saved" });
    await expect(
      logWorkoutSet(database.db, userId, assistedInput),
    ).resolves.toEqual(assisted);
    const bandInput = {
      sessionExerciseId: byMetric.get("weight_reps")!.id,
      setNo: 1,
      weight: null,
      weightUnit: null,
      reps: 15,
      clientKey: "explicit-band-repetitions",
    };
    const band = await logWorkoutSet(database.db, userId, bandInput);
    expect(band).toMatchObject({ outcome: "saved" });
    await expect(
      logWorkoutSet(database.db, userId, bandInput),
    ).resolves.toEqual(band);

    const [malformedAssistance] = await database.db
      .insert(exercises)
      .values({
        name: `Lifecycle malformed assistance ${crypto.randomUUID()}`,
        movementPattern: "vertical_pull",
        primaryMuscles: ["back"],
        loadType: "external",
        metricType: "reps",
        loadSemantics: "assistance",
        variantAttributes: { assistance: "assisted" },
      })
      .returning({ id: exercises.id });
    const [malformedSessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId: malformedAssistance.id,
        modificationType: "added",
        orderIdx: 20,
      })
      .returning({ id: sessionExercises.id });
    await database.db.insert(sessionOccurrences).values({
      sessionId,
      sessionExerciseId: malformedSessionExercise.id,
      kind: "working_set",
      origin: "ad_hoc",
      sequenceIdx: 20,
      kindOrdinal: 0,
      plannedExerciseId: malformedAssistance.id,
    });

    const beforeRefusals = {
      sets: (await database.db.select().from(completedSets)).length,
      receipts: (
        await database.db.select().from(sessionOccurrenceMutations)
      ).length,
    };
    await expect(
      logWorkoutSet(database.db, userId, {
        sessionExerciseId: malformedSessionExercise.id,
        setNo: 1,
        weight: null,
        weightUnit: null,
        reps: 10,
        clientKey: "malformed-assistance-definition",
      }),
    ).resolves.toEqual({
      outcome: "unsupported_set_shape",
      metricType: "reps",
      reason: "metric_semantics_conflict",
    });
    await expect(
      logWorkoutSet(database.db, userId, {
        sessionExerciseId: byMetric.get("duration")!.id,
        setNo: 1,
        weight: null,
        weightUnit: null,
        reps: 1,
        clientKey: "unsupported-duration",
      }),
    ).resolves.toEqual({
      outcome: "unsupported_set_shape",
      metricType: "duration",
      reason: "duration_requires_time",
    });
    await expect(
      logWorkoutSet(database.db, userId, {
        sessionExerciseId: byMetric.get("assisted_reps")!.id,
        setNo: 1,
        weight: null,
        weightUnit: null,
        reps: 10,
        clientKey: "missing-assistance",
      }),
    ).resolves.toEqual({
      outcome: "unsupported_set_shape",
      metricType: "assisted_reps",
      reason: "assisted_reps_requires_numeric_assistance",
    });
    await expect(
      logWorkoutSet(database.db, userId, {
        sessionExerciseId: byMetric.get("reps")!.id,
        setNo: 1,
        weight: 25,
        weightUnit: "lb",
        reps: 10,
        clientKey: "loaded-repetition-shape",
      }),
    ).resolves.toEqual({
      outcome: "unsupported_set_shape",
      metricType: "reps",
      reason: "reps_cannot_include_load",
    });
    expect({
      sets: (await database.db.select().from(completedSets)).length,
      receipts: (
        await database.db.select().from(sessionOccurrenceMutations)
      ).length,
    }).toEqual(beforeRefusals);

    const savedMetrics = await database.db
      .select({
        metricType: completedSets.metricType,
        performedSemanticsVersion: completedSets.performedSemanticsVersion,
        performedLoadType: completedSets.performedLoadType,
        performedLoadSemantics: completedSets.performedLoadSemantics,
        targetMet: completedSets.targetMet,
      })
      .from(completedSets);
    expect(savedMetrics.map((set) => set.metricType).sort()).toEqual([
      "assisted_reps",
      "reps",
      "reps",
      "weight_reps",
    ]);
    expect(
      savedMetrics.find((set) => set.metricType === "assisted_reps")?.targetMet,
    ).toBeNull();
    expect(savedMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          performedSemanticsVersion: 1,
          performedLoadType: "external",
          performedLoadSemantics: "assistance",
        }),
        expect.objectContaining({
          performedSemanticsVersion: 1,
          performedLoadType: "band",
          performedLoadSemantics: "resistance_band",
        }),
      ]),
    );
  });

  it("makes abandonment conditional and idempotent under concurrency", async () => {
    const { sessionId } = await startWorkoutSession(database.db, userId, templateId);
    const ready = createStartBarrier(8);
    const results = await runSimultaneously(8, () =>
      abandonWorkoutSession(database.db, userId, sessionId, {
        checkpoint: async (boundary) => {
          if (boundary === "before-abandon-statement") await ready();
        },
      })
    );
    expect(results.filter(({ alreadyFinished }) => !alreadyFinished)).toHaveLength(1);
    const audits = await database.db.select().from(auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("session.abandon");
  });
});
