import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  exercisePrescriptions,
  exercises,
  programSchedules,
  programScheduleVersions,
  programs,
  programVersions,
  scheduledProgramEvents,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  getOrCreateProgramDraft,
  reviewProgramDraft,
  saveProgramDraft,
} from "@/services/program-drafts";
import { publishProgramDraft } from "@/services/program-publication";
import {
  abandonWorkoutSession,
  buildWorkoutStartRequestHash,
  cleanupIncompleteWorkoutCreation,
  completeWorkoutSession,
  IncompleteWorkoutCreationError,
  StaleWorkoutTemplateError,
  startWorkoutSession,
  type ScheduledWorkoutStartIdentity,
} from "@/services/session-lifecycle";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

const STARTED_AT = new Date("2026-08-10T16:00:00.000Z");

describe("scheduled Program workout lifecycle", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;
  let programId: string;
  let sourceProgramVersionId: string;
  let scheduledTemplateId: string;
  let scheduledRoutineLineageId: string;
  let otherTemplateId: string;
  let otherRoutineLineageId: string;
  let scheduleId: string;
  let scheduleVersionId: string;
  let scheduleVersionHash: string;
  let scheduledEventId: string;
  let sourcePhaseId: string;
  let sourceEventId: string;
  let scheduleDocument: Record<string, unknown>;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    userId = crypto.randomUUID();
    await database.db.insert(users).values({
      id: userId,
      email: `scheduled-start-${userId}@example.com`,
    });
    await database.db.insert(userProfiles).values({
      userId,
      timezone: "America/Toronto",
      unit: "lb",
    });
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: `Scheduled press ${crypto.randomUUID()}`,
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "dumbbell",
        metricType: "weight_reps",
        loadSemantics: "per_implement",
      })
      .returning({ id: exercises.id });

    const activated = await activateProgramAtomically(database.db, {
      userId,
      loadUnit: "lb",
      programName: "Scheduled lifecycle Program",
      days: [
        {
          name: "Scheduled Strength A",
          exercises: [
            {
              exerciseId,
              sets: 2,
              repMin: 8,
              repMax: 10,
              targetLoad: 30,
              targetLoadUnit: "lb",
              restSec: 90,
              supersetKey: null,
              notes: null,
            },
          ],
        },
        {
          name: "Other Strength B",
          exercises: [
            {
              exerciseId,
              sets: 1,
              repMin: 10,
              repMax: 12,
              targetLoad: 20,
              targetLoadUnit: "lb",
              restSec: 60,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Create scheduled lifecycle fixture",
      auditAction: "program.activate",
      auditSummary: "Activated scheduled lifecycle fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    programId = activated.programId;
    sourceProgramVersionId = activated.programVersionId;

    const templates = await database.db.query.workoutTemplates.findMany({
      where: eq(workoutTemplates.programVersionId, sourceProgramVersionId),
    });
    const scheduledTemplate = templates.find(
      (template) => template.name === "Scheduled Strength A",
    );
    const otherTemplate = templates.find(
      (template) => template.name === "Other Strength B",
    );
    if (!scheduledTemplate || !otherTemplate) {
      throw new Error("Program fixture templates are missing.");
    }
    scheduledTemplateId = scheduledTemplate.id;
    scheduledRoutineLineageId = scheduledTemplate.lineageId;
    otherTemplateId = otherTemplate.id;
    otherRoutineLineageId = otherTemplate.lineageId;

    scheduleId = crypto.randomUUID();
    scheduleVersionId = crypto.randomUUID();
    scheduledEventId = crypto.randomUUID();
    sourcePhaseId = crypto.randomUUID();
    sourceEventId = crypto.randomUUID();
    const resistanceIntent = {
      id: sourceEventId,
      kind: "resistance" as const,
      routineLineageId: scheduledRoutineLineageId,
    };
    scheduleDocument = {
      schemaVersion: "program-schedule/1",
      startsOn: "2026-08-10",
      targetEndsOn: "2026-08-16",
      phases: [
        {
          id: sourcePhaseId,
          name: "Base",
          order: 1,
          boundary: {
            kind: "program_week_range",
            startWeek: 1,
            endWeek: 1,
          },
          schedule: {
            kind: "fixed_7_day",
            days: Array.from({ length: 7 }, (_, index) => ({
              isoWeekday: index + 1,
              event:
                index === 0
                  ? resistanceIntent
                  : {
                      id: crypto.randomUUID(),
                      kind: "rest" as const,
                    },
            })),
          },
        },
      ],
    };
    scheduleVersionHash = sha256Hex(
      Buffer.from(canonicalJson(scheduleDocument), "utf8"),
    );
    await database.db.insert(programSchedules).values({
      id: scheduleId,
      userId,
      programId,
    });
    await database.db.insert(programScheduleVersions).values({
      id: scheduleVersionId,
      userId,
      programId,
      scheduleId,
      versionNo: 1,
      sourceProgramVersionId,
      document: scheduleDocument as never,
      contentHash: scheduleVersionHash,
    });
    await database.db
      .update(programSchedules)
      .set({ currentVersionId: scheduleVersionId })
      .where(eq(programSchedules.id, scheduleId));
    await database.db.insert(scheduledProgramEvents).values({
      id: scheduledEventId,
      userId,
      programId,
      scheduleId,
      scheduleVersionId,
      sourceProgramVersionId,
      sourcePhaseId,
      sourcePhaseName: "Base",
      sourceEventId,
      kind: "resistance",
      scheduleKind: "fixed_7_day",
      routineLineageId: scheduledRoutineLineageId,
      intentSnapshot: resistanceIntent,
      sequenceNo: 1,
      cyclePosition: 1,
      programWeek: 1,
      originalLocalDate: "2026-08-10",
      currentLocalDate: "2026-08-10",
      timezone: "America/Toronto",
    });
  }, 30_000);

  afterEach(async () => database.close());

  function scheduledIdentity(
    overrides: Partial<ScheduledWorkoutStartIdentity> = {},
  ): ScheduledWorkoutStartIdentity {
    return {
      scheduledProgramEventId: scheduledEventId,
      expectedEventRevision: 0,
      programScheduleVersionId: scheduleVersionId,
      programScheduleVersionHash: scheduleVersionHash,
      ...overrides,
    };
  }

  async function scheduledStart(
    overrides: Partial<ScheduledWorkoutStartIdentity> = {},
    options: {
      requestKey?: string;
      evaluateStartCounts?: () => boolean;
      templateId?: string;
    } = {},
  ) {
    return startWorkoutSession(
      database.db,
      userId,
      options.templateId ?? scheduledTemplateId,
      45,
      {
        startRequestKey: options.requestKey ?? crypto.randomUUID(),
        timezone: "America/Toronto",
        now: () => STARTED_AT,
        scheduledStart: scheduledIdentity(overrides),
        ...(options.evaluateStartCounts == null
          ? {}
          : { evaluateStartCounts: options.evaluateStartCounts }),
        logStartIncomplete: () => undefined,
      },
    );
  }

  async function advanceProgramWithRoutine(lineageId: string) {
    const nextProgramVersionId = crypto.randomUUID();
    const nextTemplateId = crypto.randomUUID();
    const nextSlotId = crypto.randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT set_config('workout_tracker.program_publish', 'authorized', true)
      `);
      await tx.insert(programVersions).values({
        id: nextProgramVersionId,
        programId,
        versionNo: 2,
        parentVersionId: sourceProgramVersionId,
        name: "Edited Program",
        publicationSource: "editor",
        activatedAt: new Date("2026-08-10T15:00:00.000Z"),
        changeSummary: "Synthetic later Program version",
      });
      await tx.insert(workoutTemplates).values({
        id: nextTemplateId,
        programVersionId: nextProgramVersionId,
        lineageId,
        name: "Resolved current routine",
        orderIdx: 0,
      });
      await tx.insert(workoutTemplateExercises).values({
        id: nextSlotId,
        workoutTemplateId: nextTemplateId,
        exerciseId,
        orderIdx: 0,
      });
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: nextSlotId,
        sets: 3,
        repRangeMin: 6,
        repRangeMax: 8,
        targetLoad: 35,
        targetLoadUnit: "lb",
      });
      await tx
        .update(programs)
        .set({ currentVersionId: nextProgramVersionId, name: "Edited Program" })
        .where(eq(programs.id, programId));
    });
    return { nextProgramVersionId, nextTemplateId };
  }

  async function advanceScheduleVersion() {
    const nextScheduleVersionId = crypto.randomUUID();
    await database.db.insert(programScheduleVersions).values({
      id: nextScheduleVersionId,
      userId,
      programId,
      scheduleId,
      versionNo: 2,
      parentVersionId: scheduleVersionId,
      sourceProgramVersionId,
      document: scheduleDocument as never,
      contentHash: scheduleVersionHash,
    });
    await database.db
      .update(programSchedules)
      .set({ currentVersionId: nextScheduleVersionId })
      .where(eq(programSchedules.id, scheduleId));
    return nextScheduleVersionId;
  }

  async function reviewedRemovalDraft() {
    const state = await getOrCreateProgramDraft(database.db, userId);
    if (!state) throw new Error("Program draft missing.");
    const document = structuredClone(state.draft.document);
    document.name = "Program without scheduled routine";
    document.days = document.days.filter(
      (day) => day.lineageId !== scheduledRoutineLineageId,
    );
    const saved = await saveProgramDraft(database.db, userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      mutationId: crypto.randomUUID(),
      document,
    });
    if (saved.status !== "saved") throw new Error("Program draft did not save.");
    const review = await reviewProgramDraft(
      database.db,
      userId,
      state.draft.id,
      saved.revision,
    );
    if (!review || review.status !== "publishable") {
      throw new Error("Program removal review is not publishable.");
    }
    return {
      draftId: state.draft.id,
      expectedRevision: saved.revision,
      reviewHash: review.hash,
    };
  }

  it("keeps routine-only Start and its request hash unchanged", async () => {
    const startRequestKey = crypto.randomUUID();
    const expectedHash = sha256Hex(
      Buffer.from(
        JSON.stringify({
          templateId: otherTemplateId,
          timezone: "America/Toronto",
          timeBudgetMin: 45,
        }),
        "utf8",
      ),
    );
    expect(
      buildWorkoutStartRequestHash({
        templateId: otherTemplateId,
        timezone: "America/Toronto",
        timeBudgetMin: 45,
      }),
    ).toBe(expectedHash);

    const started = await startWorkoutSession(
      database.db,
      userId,
      otherTemplateId,
      45,
      {
        startRequestKey,
        timezone: "America/Toronto",
        now: () => STARTED_AT,
      },
    );
    expect(started).toMatchObject({ outcome: "created", existing: false });
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, started.sessionId),
      }),
    ).toMatchObject({
      templateId: otherTemplateId,
      startRequestHash: expectedHash,
      programScheduleSnapshot: null,
    });
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: eq(scheduledProgramEvents.id, scheduledEventId),
      }),
    ).toMatchObject({ status: "scheduled", revision: 0 });
  });

  it("atomically claims a scheduled event and retains a full immutable snapshot", async () => {
    const started = await scheduledStart();
    expect(started).toMatchObject({ outcome: "created", existing: false });
    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    });
    expect(session).toMatchObject({
      templateId: scheduledTemplateId,
      sourceProgramId: programId,
      sourceProgramVersionId,
      sourceDayLineageId: scheduledRoutineLineageId,
      programScheduleSnapshot: {
        schemaVersion: 1,
        scheduledProgramEventId: scheduledEventId,
        programScheduleId: scheduleId,
        programScheduleVersionId: scheduleVersionId,
        programScheduleVersionHash: scheduleVersionHash,
        scheduleSourceProgramVersionId: sourceProgramVersionId,
        resolvedProgramVersionId: sourceProgramVersionId,
        sourcePhaseId,
        sourcePhaseName: "Base",
        scheduleKind: "fixed_7_day",
        eventKind: "resistance",
        sourceEventId,
        eventRevision: 0,
        originalLocalDate: "2026-08-10",
        currentLocalDate: "2026-08-10",
        timezone: "America/Toronto",
        nominalProgramWeek: 1,
        cyclePosition: 1,
        routineLineageId: scheduledRoutineLineageId,
      },
    });
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: eq(scheduledProgramEvents.id, scheduledEventId),
      }),
    ).toMatchObject({ status: "started", revision: 1, resolvedAt: null });
  });

  it("rejects a scheduled Start paired with a different submitted routine", async () => {
    await expect(startWorkoutSession(
      database.db,
      userId,
      otherTemplateId,
      45,
      {
        startRequestKey: crypto.randomUUID(),
        timezone: "America/Toronto",
        now: () => STARTED_AT,
        scheduledStart: scheduledIdentity(),
      },
    )).rejects.toBeInstanceOf(StaleWorkoutTemplateError);
    expect(await database.db.query.workoutSessions.findMany()).toHaveLength(0);
    expect(await database.db.query.scheduledProgramEvents.findFirst({
      where: eq(scheduledProgramEvents.id, scheduledEventId),
    })).toMatchObject({ status: "scheduled", revision: 0 });
  });

  it("does not let later Program or schedule versions reinterpret Start history", async () => {
    const started = await scheduledStart();
    const before = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    });
    await advanceProgramWithRoutine(scheduledRoutineLineageId);
    await advanceScheduleVersion();
    const after = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    });
    expect(after).toEqual(before);
    expect(after?.programScheduleSnapshot).toMatchObject({
      programScheduleVersionId: scheduleVersionId,
      scheduleSourceProgramVersionId: sourceProgramVersionId,
      resolvedProgramVersionId: sourceProgramVersionId,
      routineLineageId: scheduledRoutineLineageId,
    });
  });

  it("replays only the exact full scheduled Start hash", async () => {
    const requestKey = crypto.randomUUID();
    const canonicalScheduledHash = buildWorkoutStartRequestHash({
      templateId: scheduledTemplateId,
      timezone: "America/Toronto",
      timeBudgetMin: 45,
      scheduledStart: scheduledIdentity(),
    });
    expect(
      buildWorkoutStartRequestHash({
        templateId: scheduledTemplateId,
        timezone: "America/Toronto",
        timeBudgetMin: 45,
        scheduledStart: {
          programScheduleVersionHash: scheduleVersionHash,
          programScheduleVersionId: scheduleVersionId,
          expectedEventRevision: 0,
          scheduledProgramEventId: scheduledEventId,
        },
      }),
    ).toBe(canonicalScheduledHash);
    const first = await scheduledStart({}, { requestKey });
    await expect(scheduledStart({}, { requestKey })).resolves.toMatchObject({
      outcome: "replayed",
      sessionId: first.sessionId,
      existing: true,
    });
    await expect(
      scheduledStart({ expectedEventRevision: 1 }, { requestKey }),
    ).resolves.toMatchObject({
      outcome: "request_conflict",
      sessionId: first.sessionId,
      existing: true,
    });
    await expect(
      scheduledStart(
        { programScheduleVersionHash: "f".repeat(64) },
        { requestKey },
      ),
    ).resolves.toMatchObject({
      outcome: "request_conflict",
      sessionId: first.sessionId,
      existing: true,
    });
    expect(await database.db.select().from(workoutSessions)).toHaveLength(1);
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: eq(scheduledProgramEvents.id, scheduledEventId),
      }),
    ).toMatchObject({ status: "started", revision: 1 });
  });

  it("does not claim a scheduled event when another workout is active", async () => {
    const active = await startWorkoutSession(
      database.db,
      userId,
      otherTemplateId,
    );
    await expect(scheduledStart()).resolves.toMatchObject({
      outcome: "active_workout_exists",
      activeSessionId: active.sessionId,
      existing: true,
    });
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: eq(scheduledProgramEvents.id, scheduledEventId),
      }),
    ).toMatchObject({ status: "scheduled", revision: 0 });
  });

  it("rejects stale event revisions, versions, and hashes without a claim", async () => {
    await expect(
      scheduledStart({ expectedEventRevision: 1 }),
    ).rejects.toBeInstanceOf(StaleWorkoutTemplateError);
    await expect(
      scheduledStart({ programScheduleVersionId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(StaleWorkoutTemplateError);
    await expect(
      scheduledStart({ programScheduleVersionHash: "f".repeat(64) }),
    ).rejects.toBeInstanceOf(StaleWorkoutTemplateError);
    expect(await database.db.select().from(workoutSessions)).toHaveLength(0);
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: eq(scheduledProgramEvents.id, scheduledEventId),
      }),
    ).toMatchObject({ status: "scheduled", revision: 0 });
  });

  it("resolves the scheduled routine lineage against the current Program version", async () => {
    const { nextProgramVersionId, nextTemplateId } =
      await advanceProgramWithRoutine(scheduledRoutineLineageId);
    const started = await scheduledStart({}, { templateId: nextTemplateId });
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, started.sessionId),
      }),
    ).toMatchObject({
      templateId: nextTemplateId,
      sourceProgramVersionId: nextProgramVersionId,
      sourceDayLineageId: scheduledRoutineLineageId,
      programScheduleSnapshot: {
        scheduleSourceProgramVersionId: sourceProgramVersionId,
        resolvedProgramVersionId: nextProgramVersionId,
        routineLineageId: scheduledRoutineLineageId,
      },
    });
  });

  it("never falls back to another routine when the scheduled lineage is absent", async () => {
    await advanceProgramWithRoutine(otherRoutineLineageId);
    await expect(scheduledStart()).rejects.toBeInstanceOf(
      StaleWorkoutTemplateError,
    );
    expect(await database.db.select().from(workoutSessions)).toHaveLength(0);
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: eq(scheduledProgramEvents.id, scheduledEventId),
      }),
    ).toMatchObject({ status: "scheduled", revision: 0 });
  });

  it.each(["completed", "abandoned"] as const)(
    "transitions the exact started event when the workout becomes %s",
    async (terminalStatus) => {
      const started = await scheduledStart();
      if (terminalStatus === "completed") {
        await completeWorkoutSession(
          database.db,
          {
            id: userId,
            coachingPrefs: {
              aggressiveness: "conservative",
              deloadSuggestions: true,
              substitutionSuggestions: true,
              weeklyReview: true,
            },
          },
          { sessionId: started.sessionId },
          { now: () => new Date("2026-08-10T17:00:00.000Z") },
        );
      } else {
        await abandonWorkoutSession(database.db, userId, started.sessionId, {
          now: () => new Date("2026-08-10T17:00:00.000Z"),
        });
      }
      expect(
        await database.db.query.workoutSessions.findFirst({
          where: eq(workoutSessions.id, started.sessionId),
        }),
      ).toMatchObject({ status: terminalStatus });
      expect(
        await database.db.query.scheduledProgramEvents.findFirst({
          where: eq(scheduledProgramEvents.id, scheduledEventId),
        }),
      ).toMatchObject({
        status: terminalStatus,
        revision: 2,
        resolvedAt: expect.any(Date),
      });
    },
  );

  it("keeps completed workout history authoritative when the event cannot transition", async () => {
    const started = await scheduledStart();
    await database.db
      .update(scheduledProgramEvents)
      .set({ revision: 2 })
      .where(eq(scheduledProgramEvents.id, scheduledEventId));
    await completeWorkoutSession(
      database.db,
      {
        id: userId,
        coachingPrefs: {
          aggressiveness: "conservative",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      },
      { sessionId: started.sessionId },
      { now: () => new Date("2026-08-10T17:00:00.000Z") },
    );
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, started.sessionId),
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: eq(scheduledProgramEvents.id, scheduledEventId),
      }),
    ).toMatchObject({ status: "started", revision: 2, resolvedAt: null });
  });

  it("reopens the exact event when an incomplete scheduled Start is removed", async () => {
    await expect(
      scheduledStart({}, { evaluateStartCounts: () => false }),
    ).rejects.toBeInstanceOf(IncompleteWorkoutCreationError);
    expect(await database.db.select().from(workoutSessions)).toHaveLength(0);
    expect(await database.db.select().from(sessionExercises)).toHaveLength(0);
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: eq(scheduledProgramEvents.id, scheduledEventId),
      }),
    ).toMatchObject({ status: "scheduled", revision: 2, resolvedAt: null });

    await expect(
      scheduledStart({ expectedEventRevision: 2 }),
    ).resolves.toMatchObject({ outcome: "created", existing: false });
  });

  it("preserves an incomplete session when its exact event cannot be reopened", async () => {
    const started = await scheduledStart();
    await database.db
      .update(scheduledProgramEvents)
      .set({ revision: 2 })
      .where(eq(scheduledProgramEvents.id, scheduledEventId));
    const beforeExercises = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    await expect(
      cleanupIncompleteWorkoutCreation(database.db, userId, started.sessionId),
    ).resolves.toEqual({ deletedExercises: 0, deletedSessions: 0 });
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, started.sessionId),
      }),
    ).toBeDefined();
    expect(
      await database.db
        .select()
        .from(sessionExercises)
        .where(eq(sessionExercises.sessionId, started.sessionId)),
    ).toHaveLength(beforeExercises.length);
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: eq(scheduledProgramEvents.id, scheduledEventId),
      }),
    ).toMatchObject({ status: "started", revision: 2 });
  });

  it("blocks publication that removes a currently scheduled routine lineage", async () => {
    const current = await database.db.query.programs.findFirst({
      where: eq(programs.id, programId),
    });
    const removal = await reviewedRemovalDraft();
    await expect(
      publishProgramDraft(database.db, userId, removal),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(
      await database.db.query.programs.findFirst({
        where: eq(programs.id, programId),
      }),
    ).toMatchObject({ currentVersionId: current?.currentVersionId });
  });

  it.each(["started", "completed"] as const)(
    "does not let a %s schedule event block future Program publication",
    async (status) => {
      await database.db
        .update(scheduledProgramEvents)
        .set({
          status,
          revision: 1,
          resolvedAt:
            status === "completed"
              ? new Date("2026-08-10T17:00:00.000Z")
              : null,
        })
        .where(
          and(
            eq(scheduledProgramEvents.id, scheduledEventId),
            eq(scheduledProgramEvents.status, "scheduled"),
          ),
        );
      const removal = await reviewedRemovalDraft();
      await expect(
        publishProgramDraft(database.db, userId, removal),
      ).resolves.toMatchObject({ ok: true, versionNo: 2 });
    },
  );
});
