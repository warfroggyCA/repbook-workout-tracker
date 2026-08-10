import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completedSets,
  exercises,
  recommendations,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { evaluateSessionProgression } from "@/services/progression";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("progression load units", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("evaluates kilogram history in kilograms and records the recommendation unit", async () => {
    const [user] = await database.db
      .insert(users)
      .values({ email: `progression-units-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId: user.id, unit: "kg" });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Kilogram progression squat",
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id, name: exercises.name });
    const activated = await activateProgramAtomically(database.db, {
      userId: user.id,
      loadUnit: "kg",
      programName: "Kilogram program",
      days: [{
        name: "Day A",
        exercises: [{
          exerciseId: exercise.id,
          sets: 3,
          repMin: 6,
          repMax: 8,
          targetLoad: 50,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Kilogram progression fixture",
      auditAction: "program.activate",
      auditSummary: "Activated kilogram progression fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    const [template] = await database.db.query.workoutTemplates.findMany({
      where: (table, { eq }) => eq(table.programVersionId, activated.programVersionId),
    });
    const [slot] = await database.db.query.workoutTemplateExercises.findMany({
      where: (table, { eq }) => eq(table.workoutTemplateId, template.id),
    });
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId: user.id,
        templateId: template.id,
        sourceProgramId: activated.programId,
        sourceProgramVersionId: activated.programVersionId,
        sourceDayLineageId: template.lineageId,
        status: "completed",
        startedAt: new Date("2026-07-12T14:00:00.000Z"),
        finishedAt: new Date("2026-07-12T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-12",
      })
      .returning({ id: workoutSessions.id });
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId: exercise.id,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: exercise.name,
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        plannedFromTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        targetSets: 3,
        targetRepsMin: 6,
        targetRepsMax: 8,
        targetLoad: 50,
        targetLoadUnit: "kg",
      })
      .returning({ id: sessionExercises.id });
    const equipmentSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId: user.id,
        sessionId: session.id,
        sessionExerciseId: sessionExercise.id,
        unit: "kg",
      },
    );
    const savedSets = await database.db.insert(completedSets).values(
      [1, 2, 3].map((setNo) => ({
        sessionExerciseId: sessionExercise.id,
        setNo,
        weight: 50,
        weightUnit: "kg" as const,
        reps: 8,
        rpe: 7,
        metricType: "weight_reps" as const,
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total" as const,
        equipmentSnapshotId,
        loadEntryMeaning: "total_system",
      }))
    ).returning({ id: completedSets.id, setNo: completedSets.setNo });
    await database.db.insert(sessionOccurrences).values(
      savedSets.map((set) => ({
        sessionId: session.id,
        sessionExerciseId: sessionExercise.id,
        kind: "working_set" as const,
        origin: "planned" as const,
        sequenceIdx: set.setNo - 1,
        kindOrdinal: set.setNo - 1,
        plannedExerciseId: exercise.id,
        outcome: "completed" as const,
        resolvedAt: new Date("2026-01-02T13:00:00.000Z"),
        completedSetId: set.id,
        equipmentSnapshotId,
      }))
    );
    await database.db.insert(completedSets).values({
      sessionExerciseId: sessionExercise.id,
      setNo: 4,
      weight: 500,
      weightUnit: "kg",
      reps: 1,
      rpe: 10,
    });

    await evaluateSessionProgression(database.db, user.id, session.id, {
      aggressiveness: "aggressive",
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    });

    expect(await database.db.select().from(recommendations)).toEqual([
      expect.objectContaining({
        payload: {
          kind: "load_change",
          templateExerciseId: slot.id,
          fromLoad: 50,
          toLoad: 55,
          loadUnit: "kg",
        },
      }),
    ]);
  });
});
