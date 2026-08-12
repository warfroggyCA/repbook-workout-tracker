import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLogs,
  completedSets,
  exerciseEquipmentFitAssertions,
  exercisePrescriptions,
  exercises,
  progressionJobs,
  programs,
  programVersions,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrences,
  supersetGroups,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import {
  archiveWorkoutRecord,
  restoreArchiveOperation,
} from "@/services/archive";
import { buildJsonBackup, buildSetsCsv } from "@/services/export";
import { buildTrainingDigest } from "@/services/digest";
import {
  getHistoryCalendarRecords,
  getHistoryReport,
} from "@/services/history-report";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import {
  normalizeRetrospectiveWorkout,
  resolveRetrospectiveWallTime,
  type RetrospectiveWorkoutInput,
} from "@/lib/retrospective-workout";
import { createRetrospectiveWorkout } from "@/services/retrospective-workouts";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

const now = new Date("2026-07-26T16:00:00.000Z");

function ids() {
  return {
    requestId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    progressionJobId: crypto.randomUUID(),
    sessionExerciseId: crypto.randomUUID(),
    occurrenceId: crypto.randomUUID(),
    setId: crypto.randomUUID(),
    clientKey: crypto.randomUUID(),
  };
}

describe("retrospective workout contract", () => {
  it("distinguishes nonexistent, unique, and duplicated Toronto wall times", () => {
    expect(
      resolveRetrospectiveWallTime({
        localDate: "2026-03-08",
        localTime: "02:30",
        timezone: "America/Toronto",
      }),
    ).toEqual({ outcome: "nonexistent" });
    expect(
      resolveRetrospectiveWallTime({
        localDate: "2026-07-20",
        localTime: "09:15",
        timezone: "America/Toronto",
      }),
    ).toMatchObject({
      outcome: "unique",
      instant: new Date("2026-07-20T13:15:00.000Z"),
    });
    const duplicated = resolveRetrospectiveWallTime({
      localDate: "2026-11-01",
      localTime: "01:30",
      timezone: "America/Toronto",
    });
    expect(duplicated).toMatchObject({
      outcome: "ambiguous",
      earlier: new Date("2026-11-01T05:30:00.000Z"),
      later: new Date("2026-11-01T06:30:00.000Z"),
    });
  });

  it("uses local noon only as a hidden date-only anchor", () => {
    const identity = ids();
    const normalized = normalizeRetrospectiveWorkout(
      {
        ...identity,
        localDate: "2026-07-20",
        timezone: "America/Toronto",
        timing: { precision: "date_only" },
        link: { kind: "unlinked" },
        exercises: [
          {
            id: identity.sessionExerciseId,
            exerciseId: crypto.randomUUID(),
            sourceTemplateExerciseId: null,
            outcomes: [
              {
                occurrenceId: identity.occurrenceId,
                ordinal: 0,
                outcome: "completed",
                completedSet: {
                  id: identity.setId,
                  clientKey: identity.clientKey,
                  setNo: 1,
                  weight: null,
                  weightUnit: null,
                  reps: 10,
                },
              },
            ],
          },
        ],
      },
      now,
    );
    expect(normalized.startedAt.toISOString()).toBe("2026-07-20T16:00:00.000Z");
    expect(normalized.finishedAt).toBeNull();
    expect(normalized.excludeDurationFromAnalytics).toBe(true);
  });

  it("refuses a noncontiguous reviewed set order", () => {
    const identity = ids();
    expect(() =>
      normalizeRetrospectiveWorkout(
        {
          ...identity,
          localDate: "2026-07-20",
          timezone: "America/Toronto",
          timing: { precision: "date_only" },
          link: { kind: "unlinked" },
          exercises: [{
            id: identity.sessionExerciseId,
            exerciseId: crypto.randomUUID(),
            sourceTemplateExerciseId: null,
            outcomes: [{
              occurrenceId: identity.occurrenceId,
              ordinal: 1,
              outcome: "legacy_unrecorded",
            }],
          }],
        },
        now,
      ),
    ).toThrow("Set order must be contiguous");
  });

  it("refuses a facts-free completed-workout shell", () => {
    const identity = ids();
    expect(() =>
      normalizeRetrospectiveWorkout(
        {
          ...identity,
          localDate: "2026-07-20",
          timezone: "America/Toronto",
          timing: { precision: "date_only" },
          link: { kind: "unlinked" },
          exercises: [{
            id: identity.sessionExerciseId,
            exerciseId: crypto.randomUUID(),
            sourceTemplateExerciseId: null,
            outcomes: [{
              occurrenceId: identity.occurrenceId,
              ordinal: 0,
              outcome: "legacy_unrecorded",
            }],
          }],
        },
        now,
      ),
    ).toThrow("Record at least one completed or intentionally skipped set");
  });
});

describe("retrospective workout service", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;
  let programId: string;
  let versionId: string;
  let templateId: string;
  let dayLineageId: string;
  let slotId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `history-manual-${crypto.randomUUID()}@example.test` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId });
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Triceps Pushdown",
        movementPattern: "isolation_arms",
        primaryMuscles: ["triceps"],
        metricType: "weight_reps",
      })
      .returning({ id: exercises.id });
    await database.db.transaction(async (tx) => {
      [{ id: programId }] = await tx
        .insert(programs)
        .values({
          userId,
          name: "History Program",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      [{ id: versionId }] = await tx
        .insert(programVersions)
        .values({ programId, name: "History Program" })
        .returning({ id: programVersions.id });
      [{ id: templateId, lineageId: dayLineageId }] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: versionId,
          name: "Day B",
          warmupItems: [{
            key: "general",
            label: "Easy warm-up",
            reps: null,
            load: null,
            loadUnit: null,
            loadPercent: null,
            loadText: null,
            notes: null,
          }],
        })
        .returning({
          id: workoutTemplates.id,
          lineageId: workoutTemplates.lineageId,
        });
      [{ id: slotId }] = await tx
        .insert(workoutTemplateExercises)
        .values({ workoutTemplateId: templateId, exerciseId, orderIdx: 0 })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slotId,
        sets: 1,
        repRangeMin: 8,
        repRangeMax: 10,
        targetLoad: 100,
        targetLoadUnit: "lb",
      });
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: versionId,
        })
        .where(eq(programs.id, programId));
    });
  }, 30_000);

  afterEach(async () => database.close());

  function input(overrides: Partial<RetrospectiveWorkoutInput> = {}) {
    const identity = ids();
    return {
      ...identity,
      localDate: "2026-07-20",
      timezone: "America/Toronto",
      timing: {
        precision: "instant" as const,
        startedAtISO: "2026-07-20T13:00:00.000Z",
        finishedAtISO: "2026-07-20T14:00:00.000Z",
      },
      link: { kind: "unlinked" as const },
      exercises: [
        {
          id: identity.sessionExerciseId,
          exerciseId,
          sourceTemplateExerciseId: null,
          outcomes: [
            {
              occurrenceId: identity.occurrenceId,
              ordinal: 0,
              outcome: "completed" as const,
              completedSet: {
                id: identity.setId,
                clientKey: identity.clientKey,
                setNo: 1,
                weight: 95,
                weightUnit: "lb" as const,
                reps: 9,
                observedCompletedAtISO: null,
              },
            },
          ],
        },
      ],
      ...overrides,
    } satisfies RetrospectiveWorkoutInput;
  }

  it("atomically creates an unlinked completed workout and reconciles exact retry", async () => {
    const reviewed = input();
    const first = await createRetrospectiveWorkout(
      database.db,
      userId,
      reviewed,
      { now: () => now },
    );
    expect(first).toEqual({
      ok: true,
      outcome: "created",
      sessionId: reviewed.sessionId,
    });
    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toEqual({
      ok: true,
      outcome: "replayed",
      sessionId: reviewed.sessionId,
    });

    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, reviewed.sessionId),
    });
    expect(session).toMatchObject({
      status: "completed",
      source: "history_manual",
      sourceWorkoutKey: reviewed.requestId,
      historyRevision: 0,
      sourceProgramId: null,
      performedTimePrecision: "instant",
    });
    const [set] = await database.db
      .select()
      .from(completedSets)
      .where(eq(completedSets.id, reviewed.setId));
    expect(set).toMatchObject({
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown",
      performedSemanticsVersion: 1,
      performedLoadType: "external",
      performedLoadSemantics: "total",
      observedCompletedAt: null,
      observedCompletionProvenance: "unknown",
      observedCompletionQuality: "unknown",
    });
    const [occurrence] = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, reviewed.sessionId));
    expect(occurrence.plannedRestSec).toBeNull();
    expect(await database.db.select().from(progressionJobs)).toHaveLength(0);
  });

  it("preserves linked Program intent while saving a substitution and an extra performed set", async () => {
    const [{ id: performedTricepsId }] = await database.db
      .insert(exercises)
      .values({
        name: "Overhead Cable Triceps Extension",
        movementPattern: "isolation_arms",
        primaryMuscles: ["triceps"],
        metricType: "weight_reps",
      })
      .returning({ id: exercises.id });
    const [{ id: lateralRaiseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Dumbbell Lateral Raise",
        movementPattern: "isolation_shoulders",
        primaryMuscles: ["shoulders"],
        metricType: "weight_reps",
      })
      .returning({ id: exercises.id });

    let dayThreeVersionId = "";
    let dayThreeTemplateId = "";
    let dayThreeLineageId = "";
    let tricepsSlotId = "";
    let lateralRaiseSlotId = "";
    await database.db.transaction(async (tx) => {
      [{ id: dayThreeVersionId }] = await tx
        .insert(programVersions)
        .values({
          programId,
          versionNo: 2,
          name: "History Program Day 3",
          parentVersionId: versionId,
        })
        .returning({ id: programVersions.id });
      [{ id: dayThreeTemplateId, lineageId: dayThreeLineageId }] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: dayThreeVersionId,
          name: "Day 3",
          orderIdx: 2,
        })
        .returning({
          id: workoutTemplates.id,
          lineageId: workoutTemplates.lineageId,
        });
      [{ id: tricepsSlotId }] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: dayThreeTemplateId,
          exerciseId,
          orderIdx: 0,
          restSec: 60,
        })
        .returning({ id: workoutTemplateExercises.id });
      [{ id: lateralRaiseSlotId }] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: dayThreeTemplateId,
          exerciseId: lateralRaiseId,
          orderIdx: 1,
          restSec: 45,
        })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values([
        {
          templateExerciseId: tricepsSlotId,
          sets: 3,
          repRangeMin: 10,
          repRangeMax: 15,
          targetLoad: 25,
          targetLoadUnit: "lb",
        },
        {
          templateExerciseId: lateralRaiseSlotId,
          sets: 2,
          repRangeMin: 15,
          repRangeMax: 25,
          targetLoad: 10,
          targetLoadUnit: "lb",
        },
      ]);
      await tx
        .update(programs)
        .set({ currentVersionId: dayThreeVersionId })
        .where(eq(programs.id, programId));
    });

    const identity = ids();
    const tricepsExerciseId = identity.sessionExerciseId;
    const lateralExerciseId = crypto.randomUUID();
    const completedOutcome = (
      ordinal: number,
      weight: number,
      reps: number,
    ) => ({
      occurrenceId: crypto.randomUUID(),
      ordinal,
      outcome: "completed" as const,
      completedSet: {
        id: crypto.randomUUID(),
        clientKey: crypto.randomUUID(),
        setNo: ordinal + 1,
        weight,
        weightUnit: "lb" as const,
        reps,
        observedCompletedAtISO: null,
      },
    });
    const reviewed: RetrospectiveWorkoutInput = {
      requestId: identity.requestId,
      sessionId: identity.sessionId,
      progressionJobId: identity.progressionJobId,
      localDate: "2026-07-22",
      timezone: "America/Toronto",
      timing: { precision: "date_only" },
      link: {
        kind: "program_day",
        programId,
        programVersionId: dayThreeVersionId,
        templateId: dayThreeTemplateId,
        dayLineageId: dayThreeLineageId,
      },
      exercises: [
        {
          id: tricepsExerciseId,
          exerciseId: performedTricepsId,
          sourceTemplateExerciseId: tricepsSlotId,
          substitutionReason: "other",
          outcomes: [
            completedOutcome(0, 20, 12),
            completedOutcome(1, 20, 11),
            completedOutcome(2, 20, 10),
          ],
        },
        {
          id: lateralExerciseId,
          exerciseId: lateralRaiseId,
          sourceTemplateExerciseId: lateralRaiseSlotId,
          substitutionReason: null,
          outcomes: [
            completedOutcome(0, 15, 20),
            completedOutcome(1, 15, 18),
            completedOutcome(2, 15, 16),
          ],
        },
      ],
    };

    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toEqual({
      ok: true,
      outcome: "created",
      sessionId: reviewed.sessionId,
    });
    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toEqual({
      ok: true,
      outcome: "replayed",
      sessionId: reviewed.sessionId,
    });

    const savedExercises = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, reviewed.sessionId))
      .orderBy(sessionExercises.orderIdx);
    expect(savedExercises[0]).toMatchObject({
      id: tricepsExerciseId,
      exerciseId: performedTricepsId,
      plannedFromTemplateExerciseId: tricepsSlotId,
      modificationType: "substituted",
      substitutedForExerciseId: exerciseId,
      substitutionReason: "other",
      targetSets: 3,
      targetLoad: null,
      targetLoadUnit: null,
    });
    expect(savedExercises[1]).toMatchObject({
      id: lateralExerciseId,
      exerciseId: lateralRaiseId,
      plannedFromTemplateExerciseId: lateralRaiseSlotId,
      modificationType: "as_planned",
      targetSets: 2,
    });

    const savedOccurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, reviewed.sessionId))
      .orderBy(sessionOccurrences.sequenceIdx);
    expect(savedOccurrences).toHaveLength(6);
    expect(
      savedOccurrences
        .filter(
          (occurrence) =>
            occurrence.sessionExerciseId === tricepsExerciseId,
        )
        .map((occurrence) => [
          occurrence.origin,
          occurrence.plannedExerciseId,
        ]),
    ).toEqual([
      ["planned", exerciseId],
      ["planned", exerciseId],
      ["planned", exerciseId],
    ]);
    expect(
      savedOccurrences.filter(
        (occurrence) => occurrence.sessionExerciseId === lateralExerciseId,
      ),
    ).toEqual([
      expect.objectContaining({
        kindOrdinal: 0,
        origin: "planned",
        plannedExerciseId: lateralRaiseId,
      }),
      expect.objectContaining({
        kindOrdinal: 1,
        origin: "planned",
        plannedExerciseId: lateralRaiseId,
      }),
      expect.objectContaining({
        kindOrdinal: 2,
        origin: "ad_hoc",
        plannedExerciseId: lateralRaiseId,
        plannedRepsMin: 18,
        plannedRepsMax: 18,
        plannedLoad: 15,
        plannedLoadUnit: "lb",
        plannedNote: "Added during this workout",
        groupSnapshotId: null,
      }),
    ]);

    const report = await getHistoryReport(database.db, userId, "all", 3, now, {
      timezone: "America/Toronto",
      unit: "lb",
    });
    expect(report.overview.workingSets).toBe(6);
    expect(
      report.lenses
        .find((lens) => lens.key === "program-fit")
        ?.evidence.some((evidence) =>
          evidence.value.includes("1 substituted"),
        ),
    ).toBe(true);
  });

  it("stores explicit manual set time as owner-reported and queues linked progression", async () => {
    const reviewed = input();
    reviewed.link = {
      kind: "program_day",
      programId,
      programVersionId: versionId,
      templateId,
      dayLineageId,
    };
    reviewed.exercises[0].sourceTemplateExerciseId = slotId;
    const firstOutcome = reviewed.exercises[0].outcomes[0];
    if (firstOutcome.outcome !== "completed") {
      throw new Error("Expected a completed fixture set.");
    }
    firstOutcome.completedSet.observedCompletedAtISO =
      "2026-07-20T13:42:00.000Z";
    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true, outcome: "created" });

    const [exercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.id, reviewed.sessionExerciseId));
    expect(exercise).toMatchObject({
      plannedFromTemplateExerciseId: slotId,
      sourceSlotLineageId: expect.any(String),
      modificationType: "as_planned",
    });
    const [set] = await database.db
      .select()
      .from(completedSets)
      .where(eq(completedSets.id, reviewed.setId));
    expect(set).toMatchObject({
      observedCompletedAt: new Date("2026-07-20T13:42:00.000Z"),
      observedCompletionProvenance: "manual_explicit",
      observedCompletionQuality: "owner_reported",
    });
    expect(await database.db.select().from(progressionJobs)).toHaveLength(1);
    expect(await database.db.select().from(sessionOccurrences)).toHaveLength(2);
  });

  it("preserves linked group rounds, rest, skipped sets, and unknown outcomes", async () => {
    const [{ id: secondExerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Retrospective press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        metricType: "weight_reps",
      })
      .returning({ id: exercises.id });
    let groupedVersionId = "";
    let groupedTemplateId = "";
    let groupedDayLineageId = "";
    let groupedFirstSlotId = "";
    let secondSlotId = "";
    let groupId = "";
    await database.db.transaction(async (tx) => {
      [{ id: groupedVersionId }] = await tx
        .insert(programVersions)
        .values({
          programId,
          versionNo: 2,
          name: "History Program grouped",
          parentVersionId: versionId,
        })
        .returning({ id: programVersions.id });
      [{ id: groupedTemplateId, lineageId: groupedDayLineageId }] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: groupedVersionId,
          name: "Day B grouped",
          warmupItems: [{
            key: "general",
            label: "Easy warm-up",
            reps: null,
            load: null,
            loadUnit: null,
            loadPercent: null,
            loadText: null,
            notes: null,
          }],
        })
        .returning({
          id: workoutTemplates.id,
          lineageId: workoutTemplates.lineageId,
        });
      [{ id: groupId }] = await tx
        .insert(supersetGroups)
        .values({
          workoutTemplateId: groupedTemplateId,
          name: "Reviewed pair",
          orderIdx: 0,
          plannedRounds: 2,
          restBetweenMembersSec: 15,
          restAfterRoundSec: 75,
        })
        .returning({ id: supersetGroups.id });
      [{ id: groupedFirstSlotId }] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: groupedTemplateId,
          exerciseId,
          orderIdx: 0,
          supersetGroupId: groupId,
          groupMemberOrderIdx: 0,
        })
        .returning({ id: workoutTemplateExercises.id });
      [{ id: secondSlotId }] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: groupedTemplateId,
          exerciseId: secondExerciseId,
          orderIdx: 1,
          supersetGroupId: groupId,
          groupMemberOrderIdx: 1,
        })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values([
        {
          templateExerciseId: groupedFirstSlotId,
          sets: 2,
          repRangeMin: 8,
          repRangeMax: 10,
          targetLoad: 100,
          targetLoadUnit: "lb",
        },
        {
          templateExerciseId: secondSlotId,
          sets: 2,
          repRangeMin: 8,
          repRangeMax: 10,
          targetLoad: 50,
          targetLoadUnit: "lb",
        },
      ]);
      await tx
        .update(programs)
        .set({ currentVersionId: groupedVersionId })
        .where(eq(programs.id, programId));
    });

    const reviewed: RetrospectiveWorkoutInput = input();
    reviewed.link = {
      kind: "program_day",
      programId,
      programVersionId: groupedVersionId,
      templateId: groupedTemplateId,
      dayLineageId: groupedDayLineageId,
    };
    reviewed.exercises[0].sourceTemplateExerciseId = groupedFirstSlotId;
    reviewed.exercises[0].outcomes.push({
      occurrenceId: crypto.randomUUID(),
      ordinal: 1,
      outcome: "skipped",
      reason: "fatigue",
      note: "Stopped after the first round.",
    });
    const second = ids();
    reviewed.exercises.push({
      id: second.sessionExerciseId,
      exerciseId: secondExerciseId,
      sourceTemplateExerciseId: secondSlotId,
      outcomes: [
        {
          occurrenceId: second.occurrenceId,
          ordinal: 0,
          outcome: "legacy_unrecorded",
        },
        {
          occurrenceId: crypto.randomUUID(),
          ordinal: 1,
          outcome: "completed",
          completedSet: {
            id: second.setId,
            clientKey: second.clientKey,
            setNo: 2,
            weight: 45,
            weightUnit: "lb",
            reps: 8,
          },
        },
      ],
    });
    reviewed.exercises.reverse();

    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true, outcome: "created" });
    expect(
      await database.db
        .select()
        .from(sessionExerciseGroups)
        .where(eq(sessionExerciseGroups.sessionId, reviewed.sessionId)),
    ).toEqual([
      expect.objectContaining({
        sourceGroupId: groupId,
        provenance: "program",
        plannedRounds: 2,
        memberCount: 2,
        restBetweenMembersSec: 15,
        restBetweenRoundsSec: 75,
      }),
    ]);
    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, reviewed.sessionId))
      .orderBy(sessionOccurrences.sequenceIdx);
    expect(occurrences.map((occurrence) => occurrence.kind)).toEqual([
      "day_warmup",
      "working_set",
      "working_set",
      "working_set",
      "working_set",
    ]);
    expect(
      occurrences.slice(1).map((occurrence) => [
        occurrence.groupRound,
        occurrence.groupMemberOrderIdx,
        occurrence.outcome,
        occurrence.plannedRestSec,
      ]),
    ).toEqual([
      [1, 0, "completed", 15],
      [1, 1, "legacy_unrecorded", 75],
      [2, 0, "skipped", 15],
      [2, 1, "completed", 0],
    ]);
    const report = await getHistoryReport(database.db, userId, "all", 3, now, {
      timezone: "America/Toronto",
      unit: "lb",
    });
    const programFit = report.lenses.find((lens) => lens.key === "program-fit")!;
    expect(
      programFit.evidence.some(
        (item) =>
          item.value.includes("2 as planned") &&
          item.value.includes("1 skipped"),
      ),
    ).toBe(true);
    expect(
      programFit.evidence.some(
        (item) =>
          item.label === "Recorded skip reasons" &&
          item.value.toLowerCase().includes("fatigue"),
      ),
    ).toBe(true);
  });

  it("uses authoritative exercise metrics and refuses contradictory set facts", async () => {
    const [{ id: durationExerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Retrospective hold",
        movementPattern: "core",
        primaryMuscles: ["core"],
        metricType: "duration",
        loadSemantics: "none",
      })
      .returning({ id: exercises.id });
    const invalid: RetrospectiveWorkoutInput = input();
    invalid.exercises[0].exerciseId = durationExerciseId;
    expect(
      await createRetrospectiveWorkout(database.db, userId, invalid, {
        now: () => now,
      }),
    ).toMatchObject({ ok: false, code: "invalid_reference" });
    expect(
      await database.db
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.id, invalid.sessionId)),
    ).toHaveLength(0);

    const valid: RetrospectiveWorkoutInput = input();
    valid.exercises[0].exerciseId = durationExerciseId;
    const completed = valid.exercises[0].outcomes[0];
    if (completed.outcome !== "completed") throw new Error("Fixture mismatch.");
    completed.completedSet.weight = null;
    completed.completedSet.weightUnit = null;
    completed.completedSet.reps = null;
    completed.completedSet.durationSeconds = 60;
    expect(
      await createRetrospectiveWorkout(database.db, userId, valid, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true, outcome: "created" });
    expect(
      await database.db
        .select()
        .from(completedSets)
        .where(eq(completedSets.id, completed.completedSet.id)),
    ).toEqual([
      expect.objectContaining({
        metricType: "duration",
        reps: null,
        durationSeconds: 60,
      }),
    ]);
  });

  it("rejects invalid linked substitution identities and unsupported performed exercises", async () => {
    const [{ id: supportedReplacementId }] = await database.db
      .insert(exercises)
      .values({
        name: "Supported cable extension",
        movementPattern: "isolation_arms",
        primaryMuscles: ["triceps"],
        metricType: "weight_reps",
      })
      .returning({ id: exercises.id });
    const [{ id: unsupportedReplacementId }] = await database.db
      .insert(exercises)
      .values({
        name: "Unsupported retrospective hold",
        movementPattern: "core",
        primaryMuscles: ["core"],
        metricType: "duration",
      })
      .returning({ id: exercises.id });

    const linkedInput = () => {
      const reviewed = input();
      reviewed.link = {
        kind: "program_day",
        programId,
        programVersionId: versionId,
        templateId,
        dayLineageId,
      };
      reviewed.exercises[0].sourceTemplateExerciseId = slotId;
      return reviewed;
    };

    const missingReason = linkedInput();
    missingReason.exercises[0].exerciseId = supportedReplacementId;
    expect(
      await createRetrospectiveWorkout(database.db, userId, missingReason, {
        now: () => now,
      }),
    ).toMatchObject({ ok: false, code: "invalid_reference" });

    const falseReason = linkedInput();
    falseReason.exercises[0].substitutionReason = "other";
    expect(
      await createRetrospectiveWorkout(database.db, userId, falseReason, {
        now: () => now,
      }),
    ).toMatchObject({ ok: false, code: "invalid_reference" });

    const unsupported = linkedInput();
    unsupported.exercises[0].exerciseId = unsupportedReplacementId;
    unsupported.exercises[0].substitutionReason = "other";
    expect(
      await createRetrospectiveWorkout(database.db, userId, unsupported, {
        now: () => now,
      }),
    ).toMatchObject({ ok: false, code: "invalid_reference" });

    for (const reviewed of [missingReason, falseReason, unsupported]) {
      expect(
        await database.db
          .select()
          .from(workoutSessions)
          .where(eq(workoutSessions.id, reviewed.sessionId)),
      ).toHaveLength(0);
    }
  });

  it("records a supported performed substitution when current equipment fit is unknown", async () => {
    const [{ id: performedExerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Remembered cable extension",
        movementPattern: "isolation_arms",
        primaryMuscles: ["triceps"],
        metricType: "weight_reps",
      })
      .returning({ id: exercises.id });
    const reviewed = input();
    reviewed.link = {
      kind: "program_day",
      programId,
      programVersionId: versionId,
      templateId,
      dayLineageId,
    };
    reviewed.exercises[0].sourceTemplateExerciseId = slotId;
    reviewed.exercises[0].exerciseId = performedExerciseId;
    reviewed.exercises[0].substitutionReason = "other";

    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true, outcome: "created" });
    expect(
      await database.db.select().from(exerciseEquipmentFitAssertions),
    ).toHaveLength(0);
    expect(
      await database.db
        .select({ exerciseId: sessionExercises.exerciseId })
        .from(sessionExercises)
        .where(eq(sessionExercises.sessionId, reviewed.sessionId)),
    ).toEqual([{ exerciseId: performedExerciseId }]);
  });

  it("atomically rejects an unlinked performed exercise with contradictory set semantics", async () => {
    const [{ id: malformedExerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Malformed assisted substitution",
        movementPattern: "isolation_arms",
        primaryMuscles: ["triceps"],
        metricType: "assisted_reps",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });
    const reviewed = input();
    reviewed.exercises[0].exerciseId = malformedExerciseId;

    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toMatchObject({ ok: false, code: "invalid_reference" });
    expect(
      await database.db
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.id, reviewed.sessionId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(completedSets)
        .where(eq(completedSets.id, reviewed.setId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, reviewed.requestId)),
    ).toHaveLength(0);
  });

  it("preserves an unsupported planned slot with unknown evidence while recording another slot", async () => {
    const [{ id: legacyPlannedExerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Legacy weighted hold",
        movementPattern: "core",
        primaryMuscles: ["core"],
        metricType: "duration",
        loadSemantics: "added_weight",
      })
      .returning({ id: exercises.id });
    let linkedProgramId = "";
    let linkedVersionId = "";
    let linkedTemplateId = "";
    let linkedDayLineageId = "";
    let recordedSlotId = "";
    let legacySlotId = "";
    await database.db.transaction(async (tx) => {
      [{ id: linkedProgramId }] = await tx
        .insert(programs)
        .values({
          userId,
          name: "Legacy History Program",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      [{ id: linkedVersionId }] = await tx
        .insert(programVersions)
        .values({ programId: linkedProgramId, name: "Legacy History Program" })
        .returning({ id: programVersions.id });
      [{ id: linkedTemplateId, lineageId: linkedDayLineageId }] = await tx
        .insert(workoutTemplates)
        .values({ programVersionId: linkedVersionId, name: "Legacy Day" })
        .returning({
          id: workoutTemplates.id,
          lineageId: workoutTemplates.lineageId,
        });
      [{ id: recordedSlotId }] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: linkedTemplateId,
          exerciseId,
          orderIdx: 0,
        })
        .returning({ id: workoutTemplateExercises.id });
      [{ id: legacySlotId }] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: linkedTemplateId,
          exerciseId: legacyPlannedExerciseId,
          orderIdx: 1,
        })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values([{
        templateExerciseId: recordedSlotId,
        sets: 1,
        repRangeMin: 8,
        repRangeMax: 10,
      }, {
        templateExerciseId: legacySlotId,
        sets: 1,
        repRangeMin: 1,
        repRangeMax: 1,
      }]);
      await tx
        .update(programs)
        .set({ status: "archived", archivedAt: new Date() })
        .where(eq(programs.id, programId));
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: linkedVersionId,
        })
        .where(eq(programs.id, linkedProgramId));
    });
    const reviewed = input();
    reviewed.link = {
      kind: "program_day",
      programId: linkedProgramId,
      programVersionId: linkedVersionId,
      templateId: linkedTemplateId,
      dayLineageId: linkedDayLineageId,
    };
    reviewed.exercises[0].sourceTemplateExerciseId = recordedSlotId;
    reviewed.exercises.push({
      id: crypto.randomUUID(),
      exerciseId: legacyPlannedExerciseId,
      sourceTemplateExerciseId: legacySlotId,
      outcomes: [{
        occurrenceId: crypto.randomUUID(),
        ordinal: 0,
        outcome: "legacy_unrecorded",
      }],
    });

    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true, outcome: "created" });
    expect(
      await database.db
        .select({ id: completedSets.id })
        .from(completedSets)
        .where(eq(completedSets.id, reviewed.setId)),
    ).toEqual([{ id: reviewed.setId }]);
  });

  it("reports a linked skipped-only exercise as skipped rather than as planned", async () => {
    const reviewed: RetrospectiveWorkoutInput = input();
    reviewed.link = {
      kind: "program_day",
      programId,
      programVersionId: versionId,
      templateId,
      dayLineageId,
    };
    reviewed.exercises[0].sourceTemplateExerciseId = slotId;
    reviewed.exercises[0].outcomes = [{
      occurrenceId: crypto.randomUUID(),
      ordinal: 0,
      outcome: "skipped",
      reason: "pain",
      note: "Remembered as skipped.",
    }];
    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true, outcome: "created" });

    const report = await getHistoryReport(database.db, userId, "all", 3, now, {
      timezone: "America/Toronto",
      unit: "lb",
    });
    const programFit = report.lenses.find((lens) => lens.key === "program-fit")!;
    expect(
      programFit.evidence.some((item) => item.value.includes("1 skipped")),
    ).toBe(true);
    expect(
      programFit.evidence.some((item) => item.value.includes("1 as planned")),
    ).toBe(false);
  });

  it("flows through export, canonical backup, Archive, and restore", async () => {
    const reviewed = input({ sessionNote: "Remembered after the workout." });
    const completed = reviewed.exercises[0].outcomes[0];
    if (completed.outcome !== "completed") {
      throw new Error("Expected a completed fixture set.");
    }
    completed.completedSet.observedCompletedAtISO =
      "2026-07-20T13:42:00.000Z";
    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true });

    const csv = await buildSetsCsv(database.db, userId, null);
    expect(csv).toContain("history_manual");
    expect(csv).toContain("manual_explicit");
    expect(csv).toContain("owner_reported");
    const backup = await buildJsonBackup(
      database.db,
      userId,
      () => undefined,
      { now, appVersion: "h3-test" },
    );
    const canonical = JSON.stringify(backup.canonical);
    expect(canonical).toContain(reviewed.requestId);
    expect(canonical).toContain("manual_explicit");
    const snapshot = await captureUserSnapshot(
      database.db,
      userId,
      now,
      "h3-test",
    );
    expect(snapshot.tables.workout_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: reviewed.sessionId,
          source: "history_manual",
          source_workout_key: reviewed.requestId,
        }),
      ]),
    );
    expect(snapshot.tables.completed_sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: completed.completedSet.id,
          observed_completion_provenance: "manual_explicit",
          observed_completion_quality: "owner_reported",
        }),
      ]),
    );
    expect(await evaluateApplicationIntegrity(database.db, userId)).toEqual([]);

    const archived = await archiveWorkoutRecord(
      database.db,
      userId,
      reviewed.sessionId,
    );
    expect(archived).toMatchObject({
      ok: true,
      counts: expect.objectContaining({
        workouts: 1,
        sets: 1,
        notes: 1,
      }),
    });
    if (!archived.ok) throw new Error(archived.reason);
    expect(
      await restoreArchiveOperation(database.db, userId, archived.operationId),
    ).toMatchObject({ ok: true });
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, reviewed.sessionId),
      }),
    ).toMatchObject({ archivedAt: null, source: "history_manual" });
  });

  it("keeps date-only timing unknown in Coach evidence and duration analytics", async () => {
    const reviewed = input({
      timing: { precision: "date_only" },
    });
    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true });
    const digest = await buildTrainingDigest(
      database.db,
      userId,
      new Date("2026-07-01T00:00:00.000Z"),
      now,
    );
    expect(digest.sessions).toContainEqual(
      expect.objectContaining({
        date: "2026-07-20",
        durationMin: null,
        source: "history_manual",
        performedTimePrecision: "date_only",
        dataQualityFlags: ["unknown_time"],
        programLinked: false,
      }),
    );
    expect(
      await getHistoryCalendarRecords(database.db, userId, "lb", {
        view: "month",
        date: "2026-07-20",
      }),
    ).toContainEqual(
      expect.objectContaining({
        id: reviewed.sessionId,
        source: "history_manual",
        performedTimePrecision: "date_only",
        calendarDateKey: "2026-07-20",
        durationMin: null,
      }),
    );
  });

  it("rolls back every child when the final write gate fails", async () => {
    const reviewed = input();
    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
        failureAt: "before-audit",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await database.db
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.id, reviewed.sessionId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(completedSets)
        .where(eq(completedSets.id, reviewed.setId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.idempotencyKey, `history-manual:${reviewed.requestId}`)),
    ).toHaveLength(0);
  });

  it("requires explicit confirmation before a second same-day workout", async () => {
    const first = input();
    expect(
      await createRetrospectiveWorkout(database.db, userId, first, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true });
    const second = input();
    expect(
      await createRetrospectiveWorkout(database.db, userId, second, {
        now: () => now,
      }),
    ).toMatchObject({ ok: false, code: "duplicate_warning_required" });
    second.recordAnotherWorkout = true;
    expect(
      await createRetrospectiveWorkout(database.db, userId, second, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true, outcome: "created" });
  });

  it("rejects conflicting retry content and wrong-owner exercise references", async () => {
    const reviewed = input();
    expect(
      await createRetrospectiveWorkout(database.db, userId, reviewed, {
        now: () => now,
      }),
    ).toMatchObject({ ok: true });
    const conflict = structuredClone(reviewed);
    const completed = conflict.exercises[0].outcomes[0];
    if (completed.outcome !== "completed") throw new Error("Fixture mismatch.");
    completed.completedSet.reps = 10;
    expect(
      await createRetrospectiveWorkout(database.db, userId, conflict, {
        now: () => now,
      }),
    ).toMatchObject({
      ok: false,
      code: "conflict",
      sessionId: reviewed.sessionId,
    });

    const [{ id: otherUserId }] = await database.db
      .insert(users)
      .values({ email: `other-${crypto.randomUUID()}@example.test` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId: otherUserId });
    const [{ id: privateExerciseId }] = await database.db
      .insert(exercises)
      .values({
        userId: otherUserId,
        name: "Private other-owner row",
        movementPattern: "hinge",
        primaryMuscles: ["other"],
      })
      .returning({ id: exercises.id });
    const wrongOwner = input({
      recordAnotherWorkout: true,
    });
    wrongOwner.exercises[0].exerciseId = privateExerciseId;
    expect(
      await createRetrospectiveWorkout(database.db, userId, wrongOwner, {
        now: () => now,
      }),
    ).toMatchObject({ ok: false, code: "invalid_reference" });
    expect(
      await database.db
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.id, wrongOwner.sessionId)),
    ).toHaveLength(0);
  });

  it("rejects stale Program evidence and incomplete linked occurrence counts", async () => {
    const stale = input();
    stale.link = {
      kind: "program_day",
      programId,
      programVersionId: versionId,
      templateId,
      dayLineageId,
    };
    stale.exercises[0].sourceTemplateExerciseId = slotId;
    await database.db
      .update(programs)
      .set({ status: "archived", archivedAt: new Date(), currentVersionId: null })
      .where(eq(programs.id, programId));
    expect(
      await createRetrospectiveWorkout(database.db, userId, stale, {
        now: () => now,
      }),
    ).toMatchObject({ ok: false, code: "stale_program" });

    await database.db
      .update(programs)
      .set({
        status: "active",
        archivedAt: null,
        currentVersionId: versionId,
      })
      .where(eq(programs.id, programId));
    const extra = structuredClone(stale.exercises[0]);
    extra.id = crypto.randomUUID();
    extra.outcomes[0].occurrenceId = crypto.randomUUID();
    if (extra.outcomes[0].outcome !== "completed") {
      throw new Error("Fixture mismatch.");
    }
    extra.outcomes[0].completedSet.id = crypto.randomUUID();
    extra.outcomes[0].completedSet.clientKey = crypto.randomUUID();
    stale.exercises.push(extra);
    expect(
      await createRetrospectiveWorkout(database.db, userId, stale, {
        now: () => now,
      }),
    ).toMatchObject({ ok: false, code: "count_mismatch" });
  });
});
