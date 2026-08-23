import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  completedSets,
  exercisePrescriptions,
  exercises,
  programs,
  recommendations,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { evaluateSessionProgression } from "@/services/progression";
import { approveRecommendationDecision } from "@/services/recommendation-decisions";
import { publishRecommendationProgramVersion } from "@/services/program-publication";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("progression performed baseline", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("files a future-only load proposal from two exact comparable RIR workouts when the Program target is blank", async () => {
    const [user] = await database.db
      .insert(users)
      .values({ email: `performed-baseline-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId: user.id,
      unit: "lb",
    });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Synthetic performed-baseline press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id, name: exercises.name });
    const activated = await activateProgramAtomically(database.db, {
      userId: user.id,
      loadUnit: "lb",
      programName: "Synthetic performed-baseline program",
      days: [{
        name: "Day A",
        exercises: [{
          exerciseId: exercise.id,
          sets: 3,
          repMin: 6,
          repMax: 8,
          targetLoad: null,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Synthetic performed-baseline fixture",
      auditAction: "program.activate",
      auditSummary: "Activated synthetic performed-baseline fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    const programId = activated.programId;
    const programVersionId = activated.programVersionId;
    const [template] = await database.db.query.workoutTemplates.findMany({
      where: (table, { eq }) =>
        eq(table.programVersionId, programVersionId),
    });
    const [slot] = await database.db.query.workoutTemplateExercises.findMany({
      where: (table, { eq }) => eq(table.workoutTemplateId, template.id),
    });

    async function saveCleanWorkout(startedAt: Date) {
      const [session] = await database.db
        .insert(workoutSessions)
        .values({
          userId: user.id,
          templateId: template.id,
          sourceProgramId: programId,
          sourceProgramVersionId: programVersionId,
          sourceDayLineageId: template.lineageId,
          status: "completed",
          startedAt,
          finishedAt: new Date(startedAt.getTime() + 45 * 60 * 1_000),
          timezone: "America/Toronto",
          localDate: startedAt.toISOString().slice(0, 10),
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
          targetLoad: null,
          targetLoadUnit: null,
        })
        .returning({ id: sessionExercises.id });
      const equipmentSnapshotId = await createTotalSystemTestSnapshot(
        database.db,
        {
          userId: user.id,
          sessionId: session.id,
          sessionExerciseId: sessionExercise.id,
          unit: "lb",
        },
      );
      const sets = await database.db
        .insert(completedSets)
        .values(
          [1, 2, 3].map((setNo) => ({
            sessionExerciseId: sessionExercise.id,
            setNo,
            weight: 50,
            weightUnit: "lb" as const,
            reps: 8,
            rir: 2,
            metricType: "weight_reps" as const,
            performedSemanticsVersion: 1,
            performedLoadType: "barbell",
            performedLoadSemantics: "total" as const,
            equipmentSnapshotId,
            loadEntryMeaning: "total_system",
          })),
        )
        .returning({ id: completedSets.id, setNo: completedSets.setNo });
      await database.db.insert(sessionOccurrences).values(
        sets.map((set) => ({
          sessionId: session.id,
          sessionExerciseId: sessionExercise.id,
          kind: "working_set" as const,
          origin: "planned" as const,
          sequenceIdx: set.setNo - 1,
          kindOrdinal: set.setNo - 1,
          plannedExerciseId: exercise.id,
          outcome: "completed" as const,
          resolvedAt: startedAt,
          completedSetId: set.id,
          equipmentSnapshotId,
        })),
      );
      const [adHocSet] = await database.db
        .insert(completedSets)
        .values({
          sessionExerciseId: sessionExercise.id,
          setNo: 4,
          weight: 75,
          weightUnit: "lb",
          reps: 5,
          rpe: 10,
          metricType: "weight_reps",
          performedSemanticsVersion: 1,
          performedLoadType: "barbell",
          performedLoadSemantics: "total",
          equipmentSnapshotId,
          loadEntryMeaning: "total_system",
        })
        .returning({ id: completedSets.id });
      await database.db.insert(sessionOccurrences).values({
        sessionId: session.id,
        sessionExerciseId: sessionExercise.id,
        kind: "working_set",
        origin: "ad_hoc",
        sequenceIdx: 3,
        kindOrdinal: 3,
        plannedExerciseId: exercise.id,
        outcome: "completed",
        resolvedAt: startedAt,
        completedSetId: adHocSet.id,
        equipmentSnapshotId,
      });
      return session;
    }

    const first = await saveCleanWorkout(
      new Date("2026-07-01T14:00:00.000Z"),
    );
    const preferences = {
      aggressiveness: "conservative" as const,
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    };
    await evaluateSessionProgression(
      database.db,
      user.id,
      first.id,
      preferences,
    );
    expect(await database.db.select().from(recommendations)).toEqual([]);

    const latest = await saveCleanWorkout(
      new Date("2026-07-08T14:00:00.000Z"),
    );

    await evaluateSessionProgression(
      database.db,
      user.id,
      latest.id,
      preferences,
    );

    const savedRecommendations = await database.db.select().from(recommendations);
    expect(savedRecommendations).toEqual([
      expect.objectContaining({
        ruleId: "double_progression",
        payload: {
          kind: "load_change",
          templateExerciseId: slot.id,
          fromLoad: null,
          toLoad: 55,
          loadUnit: "lb",
        },
        evidence: expect.objectContaining({
          signals: expect.objectContaining({
            baselineLoad: 50,
            baselineSource: "Comparable performed sets",
            cleanExposures: 2,
          }),
        }),
      }),
    ]);

    const [recommendation] = savedRecommendations;
    expect(recommendation.evidence.setIds).toHaveLength(6);
    await expect(
      approveRecommendationDecision(
        database.db,
        user.id,
        {
          recommendationId: recommendation.id,
          expectedReviewRevision: recommendation.reviewRevision,
          expectedDeferRevision: recommendation.deferRevision,
          editedToLoad: 100,
        },
        { publishProgramVersion: publishRecommendationProgramVersion },
      ),
    ).resolves.toEqual({
      ok: false,
      reason:
        "This proposal no longer has a valid comparable performed baseline within the progression safety limit.",
    });

    const citedSetId = recommendation.evidence.setIds?.[0];
    if (!citedSetId) throw new Error("Expected cited performed-set evidence");

    await database.db
      .update(completedSets)
      .set({ weight: 40 })
      .where(eq(completedSets.id, citedSetId));
    await expect(
      approveRecommendationDecision(
        database.db,
        user.id,
        {
          recommendationId: recommendation.id,
          expectedReviewRevision: recommendation.reviewRevision,
          expectedDeferRevision: recommendation.deferRevision,
        },
        { publishProgramVersion: publishRecommendationProgramVersion },
      ),
    ).resolves.toEqual({
      ok: false,
      reason:
        "The recommendation was not applied because the Program, safety information, equipment, or exercise availability changed. Review the current plan and try again.",
    });

    await database.db
      .update(completedSets)
      .set({ weight: 50, reps: 7 })
      .where(eq(completedSets.id, citedSetId));
    await expect(
      approveRecommendationDecision(
        database.db,
        user.id,
        {
          recommendationId: recommendation.id,
          expectedReviewRevision: recommendation.reviewRevision,
          expectedDeferRevision: recommendation.deferRevision,
        },
        { publishProgramVersion: publishRecommendationProgramVersion },
      ),
    ).resolves.toEqual({
      ok: false,
      reason:
        "The recommendation was not applied because the Program, safety information, equipment, or exercise availability changed. Review the current plan and try again.",
    });

    await database.db
      .update(completedSets)
      .set({ reps: 8, rir: 1 })
      .where(eq(completedSets.id, citedSetId));
    await expect(
      approveRecommendationDecision(
        database.db,
        user.id,
        {
          recommendationId: recommendation.id,
          expectedReviewRevision: recommendation.reviewRevision,
          expectedDeferRevision: recommendation.deferRevision,
        },
        { publishProgramVersion: publishRecommendationProgramVersion },
      ),
    ).resolves.toEqual({
      ok: false,
      reason:
        "The recommendation was not applied because the Program, safety information, equipment, or exercise availability changed. Review the current plan and try again.",
    });

    await database.db
      .update(completedSets)
      .set({ rir: 2 })
      .where(eq(completedSets.id, citedSetId));

    await expect(
      approveRecommendationDecision(
        database.db,
        user.id,
        {
          recommendationId: recommendation.id,
          expectedReviewRevision: recommendation.reviewRevision,
          expectedDeferRevision: recommendation.deferRevision,
        },
        { publishProgramVersion: publishRecommendationProgramVersion },
      ),
    ).resolves.toEqual({ ok: true });

    const [activeProgram] = await database.db
      .select({ currentVersionId: programs.currentVersionId })
      .from(programs)
      .where(eq(programs.id, programId));
    const [currentTemplate] = await database.db
      .select({ id: workoutTemplates.id })
      .from(workoutTemplates)
      .where(eq(workoutTemplates.programVersionId, activeProgram.currentVersionId!));
    const [currentSlot] = await database.db
      .select({ id: workoutTemplateExercises.id })
      .from(workoutTemplateExercises)
      .where(eq(workoutTemplateExercises.workoutTemplateId, currentTemplate.id));
    const [currentTarget] = await database.db
      .select({
        targetLoad: exercisePrescriptions.targetLoad,
        targetLoadUnit: exercisePrescriptions.targetLoadUnit,
      })
      .from(exercisePrescriptions)
      .where(and(
        eq(exercisePrescriptions.templateExerciseId, currentSlot.id),
        isNull(exercisePrescriptions.supersededById),
      ));
    expect(currentTarget).toEqual({ targetLoad: 55, targetLoadUnit: "lb" });
    expect(
      await database.db
        .select({ targetLoad: sessionExercises.targetLoad })
        .from(sessionExercises),
    ).toEqual([{ targetLoad: null }, { targetLoad: null }]);
  });
});
