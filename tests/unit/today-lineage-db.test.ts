import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  exercisePrescriptions,
  exercises,
  programs,
  programVersions,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import {
  getLastPerformances,
  getTodayData,
  getTodayPageData,
} from "@/services/today";
import budgets from "../../docs/production-performance-budgets.json";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("Program lineage in Today and last performance", () => {
  let database: TestDatabase;
  let userId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `today-lineage-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db
      .insert(userProfiles)
      .values({ userId, timezone: "America/Toronto" });
  }, 30_000);

  afterEach(async () => database.close());

  it("keeps renamed and reordered days and duplicate exercise slots separate while replacements reset", async () => {
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Lineage Row",
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "cable",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });

    const dayALineage = crypto.randomUUID();
    const dayBLineage = crypto.randomUUID();
    const firstSlotLineage = crypto.randomUUID();
    const duplicateSlotLineage = crypto.randomUUID();
    let programId = "";
    let v1Id = "";
    let oldDayAId = "";
    let oldFirstSlotId = "";
    let oldDuplicateSlotId = "";

    await database.db.transaction(async (tx) => {
      const [program] = await tx
        .insert(programs)
        .values({
          userId,
          name: "Lineage Program",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      programId = program.id;
      const [version] = await tx
        .insert(programVersions)
        .values({ programId, name: "Lineage Program" })
        .returning({ id: programVersions.id });
      v1Id = version.id;
      const [dayA, dayB] = await tx
        .insert(workoutTemplates)
        .values([
          {
            programVersionId: v1Id,
            lineageId: dayALineage,
            name: "Day A",
            orderIdx: 0,
          },
          {
            programVersionId: v1Id,
            lineageId: dayBLineage,
            name: "Day B",
            orderIdx: 1,
          },
        ])
        .returning({ id: workoutTemplates.id });
      oldDayAId = dayA.id;
      const [firstSlot, duplicateSlot, dayBSlot] = await tx
        .insert(workoutTemplateExercises)
        .values([
          {
            workoutTemplateId: dayA.id,
            exerciseId: exercise.id,
            lineageId: firstSlotLineage,
            orderIdx: 0,
          },
          {
            workoutTemplateId: dayA.id,
            exerciseId: exercise.id,
            lineageId: duplicateSlotLineage,
            orderIdx: 1,
          },
          {
            workoutTemplateId: dayB.id,
            exerciseId: exercise.id,
            orderIdx: 0,
          },
        ])
        .returning({ id: workoutTemplateExercises.id });
      oldFirstSlotId = firstSlot.id;
      oldDuplicateSlotId = duplicateSlot.id;
      await tx.insert(exercisePrescriptions).values(
        [firstSlot, duplicateSlot, dayBSlot].map((slot) => ({
          templateExerciseId: slot.id,
          sets: 1,
          repRangeMin: 8,
          repRangeMax: 10,
          targetLoad: 100,
          targetLoadUnit: "lb" as const,
        }))
      );
      await tx
        .update(programs)
        .set({ status: "active", archivedAt: null, currentVersionId: v1Id })
        .where(eq(programs.id, programId));
    });

    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateId: oldDayAId,
        templateName: "Day A",
        status: "completed",
        startedAt: new Date("2026-07-12T14:00:00.000Z"),
        finishedAt: new Date("2026-07-12T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-12",
      })
      .returning({ id: workoutSessions.id });
    const [firstExecution, duplicateExecution] = await database.db
      .insert(sessionExercises)
      .values([
        {
          sessionId: session.id,
          exerciseId: exercise.id,
          plannedFromTemplateExerciseId: oldFirstSlotId,
          orderIdx: 0,
        },
        {
          sessionId: session.id,
          exerciseId: exercise.id,
          plannedFromTemplateExerciseId: oldDuplicateSlotId,
          orderIdx: 1,
        },
      ])
      .returning({ id: sessionExercises.id });
    const oldSets = await database.db.insert(completedSets).values([
      {
        sessionExerciseId: firstExecution.id,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 10,
      },
      {
        sessionExerciseId: duplicateExecution.id,
        setNo: 1,
        weight: 55,
        weightUnit: "lb",
        reps: 9,
      },
    ]).returning({ id: completedSets.id, sessionExerciseId: completedSets.sessionExerciseId });
    await database.db.insert(sessionOccurrences).values(
      oldSets.map((set, index) => ({
        sessionId: session.id,
        sessionExerciseId: set.sessionExerciseId,
        kind: "working_set" as const,
        origin: "legacy" as const,
        sequenceIdx: index,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
        outcome: "completed" as const,
        resolvedAt: new Date("2026-07-12T15:00:00.000Z"),
        completedSetId: set.id,
      }))
    );

    let currentDayAId = "";
    let currentDayBId = "";
    let currentFirstSlotId = "";
    let currentDuplicateSlotId = "";
    let replacementSlotId = "";
    await database.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(programVersions)
        .values({
          programId,
          versionNo: 2,
          parentVersionId: v1Id,
          publicationSource: "editor",
          name: "Renamed Lineage Program",
        })
        .returning({ id: programVersions.id });
      const [dayB, dayA] = await tx
        .insert(workoutTemplates)
        .values([
          {
            programVersionId: version.id,
            lineageId: dayBLineage,
            name: "Pull First",
            orderIdx: 0,
          },
          {
            programVersionId: version.id,
            lineageId: dayALineage,
            name: "Pull Later",
            orderIdx: 1,
          },
        ])
        .returning({ id: workoutTemplates.id });
      currentDayAId = dayA.id;
      currentDayBId = dayB.id;
      const [duplicateSlot, firstSlot, replacementSlot, dayBSlot] = await tx
        .insert(workoutTemplateExercises)
        .values([
          {
            workoutTemplateId: dayA.id,
            exerciseId: exercise.id,
            lineageId: duplicateSlotLineage,
            orderIdx: 0,
          },
          {
            workoutTemplateId: dayA.id,
            exerciseId: exercise.id,
            lineageId: firstSlotLineage,
            orderIdx: 1,
          },
          {
            workoutTemplateId: dayA.id,
            exerciseId: exercise.id,
            lineageId: crypto.randomUUID(),
            orderIdx: 2,
          },
          {
            workoutTemplateId: dayB.id,
            exerciseId: exercise.id,
            orderIdx: 0,
          },
        ])
        .returning({ id: workoutTemplateExercises.id });
      currentDuplicateSlotId = duplicateSlot.id;
      currentFirstSlotId = firstSlot.id;
      replacementSlotId = replacementSlot.id;
      await tx.insert(exercisePrescriptions).values(
        [duplicateSlot, firstSlot, replacementSlot, dayBSlot].map((slot) => ({
          templateExerciseId: slot.id,
          sets: 1,
          repRangeMin: 8,
          repRangeMax: 10,
          targetLoad: 100,
          targetLoadUnit: "lb" as const,
        }))
      );
      await tx
        .update(programs)
        .set({ currentVersionId: version.id })
        .where(eq(programs.id, programId));
    });

    const [alternative] = await database.db
      .insert(exercises)
      .values({
        name: "Lineage substitution",
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "cable",
      })
      .returning({ id: exercises.id });
    const [substitutionSession, warmupOnlySession, latestValidSession] =
      await database.db
        .insert(workoutSessions)
        .values([
          {
            userId,
            templateId: currentDayAId,
            templateName: "Substituted exposure",
            status: "completed",
            startedAt: new Date("2026-07-14T14:00:00.000Z"),
            finishedAt: new Date("2026-07-14T15:00:00.000Z"),
            timezone: "America/Toronto",
            localDate: "2026-07-14",
          },
          {
            userId,
            templateId: currentDayAId,
            templateName: "Warm-up-only exposure",
            status: "completed",
            startedAt: new Date("2026-07-15T14:00:00.000Z"),
            finishedAt: new Date("2026-07-15T15:00:00.000Z"),
            timezone: "America/Toronto",
            localDate: "2026-07-15",
          },
          {
            userId,
            templateId: currentDayAId,
            templateName: "Latest valid exposure",
            status: "completed",
            startedAt: new Date("2026-07-16T14:00:00.000Z"),
            finishedAt: new Date("2026-07-16T15:00:00.000Z"),
            timezone: "America/Toronto",
            localDate: "2026-07-16",
          },
        ])
        .returning({ id: workoutSessions.id });
    const [substitution, warmupOnly, latestValid] = await database.db
      .insert(sessionExercises)
      .values([
        {
          sessionId: substitutionSession.id,
          exerciseId: alternative.id,
          plannedFromTemplateExerciseId: currentFirstSlotId,
          modificationType: "substituted",
          substitutedForExerciseId: exercise.id,
          substitutionReason: "variety",
          substitutedAt: new Date("2026-07-14T14:00:00.000Z"),
          orderIdx: 0,
        },
        {
          sessionId: warmupOnlySession.id,
          exerciseId: exercise.id,
          plannedFromTemplateExerciseId: currentFirstSlotId,
          orderIdx: 0,
        },
        {
          sessionId: latestValidSession.id,
          exerciseId: exercise.id,
          plannedFromTemplateExerciseId: currentDuplicateSlotId,
          orderIdx: 0,
        },
      ])
      .returning({ id: sessionExercises.id });
    const laterSets = await database.db.insert(completedSets).values([
      {
        sessionExerciseId: substitution.id,
        setNo: 1,
        weight: 999,
        weightUnit: "lb",
        reps: 1,
      },
      {
        sessionExerciseId: warmupOnly.id,
        setNo: 1,
        weight: 888,
        weightUnit: "lb",
        reps: 2,
        isWarmup: true,
      },
      {
        sessionExerciseId: latestValid.id,
        setNo: 1,
        weight: 65,
        weightUnit: "lb",
        reps: 8,
      },
      {
        sessionExerciseId: latestValid.id,
        setNo: 2,
        weight: 999,
        weightUnit: "lb",
        reps: 1,
        archivedAt: new Date("2026-07-17T00:00:00.000Z"),
      },
    ]).returning({ id: completedSets.id, sessionExerciseId: completedSets.sessionExerciseId, isWarmup: completedSets.isWarmup, archivedAt: completedSets.archivedAt });
    const canonicalLaterSets = laterSets.filter((set) => !set.isWarmup && set.archivedAt == null);
    await database.db.insert(sessionOccurrences).values(
      canonicalLaterSets.map((set) => {
        const sessionId = set.sessionExerciseId === substitution.id
          ? substitutionSession.id
          : latestValidSession.id;
        return {
          sessionId,
          sessionExerciseId: set.sessionExerciseId,
          kind: "working_set" as const,
          origin: "legacy" as const,
          sequenceIdx: 0,
          kindOrdinal: 0,
          plannedExerciseId: exercise.id,
          outcome: "completed" as const,
          resolvedAt: new Date("2026-07-16T15:00:00.000Z"),
          completedSetId: set.id,
        };
      })
    );

    const [activeSession] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateId: currentDayBId,
        templateName: "Pull First",
        status: "in_progress",
        startedAt: new Date("2026-07-17T14:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-17",
      })
      .returning({ id: workoutSessions.id });

    const statementSpy = vi.spyOn(database.client, "query");
    const pageData = await getTodayPageData(
      database.db,
      userId,
      "America/Toronto"
    );
    const today = pageData.today;
    expect(statementSpy).toHaveBeenCalledTimes(
      budgets.finalBudgets.todayPage.maxQueries
    );
    statementSpy.mockRestore();
    expect(today?.nextTemplate?.template.id).toBe(currentDayBId);
    expect(today?.nextTemplateReason).toEqual({
      kind: "after_completed_program_day",
      previousTemplateName: "Pull Later",
      // The latest completed Program day in this fixture is the 2026-07-16
      // exposure, not the original 2026-07-12 one.
      previousLocalDate: "2026-07-16",
    });
    expect(today?.lastDoneByTemplateId).toEqual({
      [currentDayAId]: "2026-07-16",
    });
    expect(today).toMatchObject({
      programName: "Lineage Program",
      allTemplates: [
        { template: { id: currentDayBId, name: "Pull First" } },
        { template: { id: currentDayAId, name: "Pull Later" } },
      ],
      lastDoneByTemplateId: { [currentDayAId]: "2026-07-16" },
      daysSinceLastSession: expect.any(Number),
    });
    expect(today?.inProgressSessionId).toBe(activeSession.id);
    expect(today?.inProgressSessionName).toBe("Pull First");
    const todayStatementSpy = vi.spyOn(database.client, "query");
    await getTodayData(database.db, userId, "America/Toronto");
    expect(todayStatementSpy).toHaveBeenCalledTimes(
      budgets.finalBudgets.todayData.maxQueries
    );
    todayStatementSpy.mockRestore();
    await expect(
      getTodayData(database.db, userId, "Not/A_Timezone")
    ).rejects.toThrow();

    await database.client.exec("SET enable_seqscan = off");
    const performanceStatementSpy = vi.spyOn(database.client, "query");
    const performances = await getLastPerformances(database.db, userId, [
      currentFirstSlotId,
      currentDuplicateSlotId,
      replacementSlotId,
    ]);
    expect(performanceStatementSpy).toHaveBeenCalledTimes(1);
    const [statement, parameters] = performanceStatementSpy.mock.calls[0];
    expect(statement).toMatch(/join lateral[\s\S]*limit 1/i);
    performanceStatementSpy.mockRestore();
    const explained = await database.client.query(
      `EXPLAIN ${statement}`,
      parameters
    );
    const plan = (explained.rows as Array<Record<string, unknown>>)
      .map((row) => String(row["QUERY PLAN"] ?? row["query plan"] ?? ""))
      .join("\n");
    expect(plan).toContain("Limit");
    if (process.env.PRINT_PERFORMANCE_EVIDENCE === "1") {
      process.stdout.write(`${JSON.stringify({ lastPerformancePlan: plan })}\n`);
    }
    expect(performances[currentFirstSlotId]?.sets[0]?.weight).toBe(100);
    expect(performances[currentDuplicateSlotId]).toMatchObject({
      date: new Date("2026-07-16T14:00:00.000Z"),
      sets: [{ weight: 65, weightUnit: "lb", reps: 8, rpe: null }],
    });
    expect(performances[currentFirstSlotId]).toMatchObject({
      date: new Date("2026-07-12T14:00:00.000Z"),
      sets: [{ weight: 100, weightUnit: "lb", reps: 10, rpe: null }],
    });
    expect(performances[replacementSlotId]).toBeUndefined();
  });

  it("explains that the first Program day is next when there is no completed Program history", async () => {
    let firstDayId = "";
    await database.db.transaction(async (tx) => {
      const [program] = await tx
        .insert(programs)
        .values({
          userId,
          name: "New Program",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      const [version] = await tx
        .insert(programVersions)
        .values({ programId: program.id, name: "New Program" })
        .returning({ id: programVersions.id });
      const [firstDay] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: version.id,
          lineageId: crypto.randomUUID(),
          name: "Day One",
          orderIdx: 0,
        })
        .returning({ id: workoutTemplates.id });
      firstDayId = firstDay.id;
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: version.id,
        })
        .where(eq(programs.id, program.id));
    });

    const today = await getTodayData(database.db, userId, "America/Toronto");
    expect(today?.nextTemplate?.template.id).toBe(firstDayId);
    expect(today?.nextTemplateReason).toEqual({
      kind: "no_completed_program_day",
    });
    expect(today?.inProgressSessionId).toBeNull();
    expect(today?.inProgressSessionName).toBeNull();
  });

  it("explains a reset to the first current day when the completed lineage is no longer in the Program", async () => {
    let programId = "";
    let firstVersionId = "";
    let completedDayId = "";
    await database.db.transaction(async (tx) => {
      const [program] = await tx
        .insert(programs)
        .values({
          userId,
          name: "Changed Program",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      programId = program.id;
      const [version] = await tx
        .insert(programVersions)
        .values({ programId, name: "Changed Program" })
        .returning({ id: programVersions.id });
      firstVersionId = version.id;
      const [completedDay] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: firstVersionId,
          lineageId: crypto.randomUUID(),
          name: "Retired Day",
          orderIdx: 0,
        })
        .returning({ id: workoutTemplates.id });
      completedDayId = completedDay.id;
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: firstVersionId,
        })
        .where(eq(programs.id, programId));
    });

    await database.db.insert(workoutSessions).values({
      userId,
      templateId: completedDayId,
      templateName: "Retired Day",
      status: "completed",
      startedAt: new Date("2026-07-12T14:00:00.000Z"),
      finishedAt: new Date("2026-07-12T15:00:00.000Z"),
      timezone: "America/Toronto",
      localDate: "2026-07-12",
    });

    let currentDayId = "";
    await database.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(programVersions)
        .values({
          programId,
          versionNo: 2,
          parentVersionId: firstVersionId,
          publicationSource: "editor",
          name: "Changed Program",
        })
        .returning({ id: programVersions.id });
      const [currentDay] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: version.id,
          lineageId: crypto.randomUUID(),
          name: "New First Day",
          orderIdx: 0,
        })
        .returning({ id: workoutTemplates.id });
      currentDayId = currentDay.id;
      await tx
        .update(programs)
        .set({ currentVersionId: version.id })
        .where(eq(programs.id, programId));
    });

    const today = await getTodayData(database.db, userId, "America/Toronto");
    expect(today?.nextTemplate?.template.id).toBe(currentDayId);
    expect(today?.nextTemplateReason).toEqual({ kind: "program_changed" });
  });

  it("uses durable source-day lineage when a historical physical template reference is absent", async () => {
    let programId = "";
    let versionId = "";
    let firstDayLineage = "";
    let secondDayId = "";
    await database.db.transaction(async (tx) => {
      const [program] = await tx
        .insert(programs)
        .values({
          userId,
          name: "Durable History Program",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      programId = program.id;
      const [version] = await tx
        .insert(programVersions)
        .values({ programId, name: "Durable History Program" })
        .returning({ id: programVersions.id });
      versionId = version.id;
      const [firstDay, secondDay] = await tx
        .insert(workoutTemplates)
        .values([
          {
            programVersionId: versionId,
            name: "First historical day",
            orderIdx: 0,
          },
          {
            programVersionId: versionId,
            name: "Second historical day",
            orderIdx: 1,
          },
        ])
        .returning({
          id: workoutTemplates.id,
          lineageId: workoutTemplates.lineageId,
        });
      firstDayLineage = firstDay.lineageId;
      secondDayId = secondDay.id;
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: versionId,
        })
        .where(eq(programs.id, programId));
    });
    await database.db.insert(workoutSessions).values({
      userId,
      templateId: null,
      templateName: "First historical day",
      source: "history_manual",
      sourceWorkoutKey: crypto.randomUUID(),
      sourceProgramId: programId,
      sourceProgramVersionId: versionId,
      sourceDayLineageId: firstDayLineage,
      status: "completed",
      startedAt: new Date("2026-07-20T13:00:00.000Z"),
      finishedAt: new Date("2026-07-20T14:00:00.000Z"),
      timezone: "America/Toronto",
      localDate: "2026-07-20",
    });

    const today = await getTodayData(database.db, userId, "America/Toronto");
    expect(today?.nextTemplate?.template.id).toBe(secondDayId);
    expect(today?.nextTemplateReason).toMatchObject({
      kind: "after_completed_program_day",
      previousTemplateName: "First historical day",
      previousLocalDate: "2026-07-20",
    });
  });
});
