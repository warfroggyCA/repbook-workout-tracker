import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  exercises,
  painLogs,
  recommendations,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { evaluateSessionProgression } from "@/services/progression";
import { reconcilePendingPainRecommendations } from "@/services/recommendation-evidence-eligibility";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("progression pain hold integration", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("records a visible exact-exercise hold with linked evidence and no Program write", async () => {
    const [user] = await database.db
      .insert(users)
      .values({ email: `progression-pain-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId: user.id, unit: "lb" });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Pain hold press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    const [alternative] = await database.db
      .insert(exercises)
      .values({
        name: "Pain hold bodyweight alternative",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "bodyweight",
      })
      .returning({ id: exercises.id, name: exercises.name });
    const activated = await activateProgramAtomically(database.db, {
      userId: user.id,
      loadUnit: "lb",
      programName: "Pain hold program",
      days: [{
        name: "Day A",
        exercises: [{
          exerciseId: exercise.id,
          sets: 1,
          repMin: 6,
          repMax: 8,
          targetLoad: 100,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Pain hold fixture",
      auditAction: "program.activate",
      auditSummary: "Activated pain hold fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    const [template] = await database.db.query.workoutTemplates.findMany({
      where: (table, { eq }) =>
        eq(table.programVersionId, activated.programVersionId),
    });
    const [slot] = await database.db.query.workoutTemplateExercises.findMany({
      where: (table, { eq }) => eq(table.workoutTemplateId, template.id),
    });
    const startedAt = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId: user.id,
        templateId: template.id,
        sourceProgramId: activated.programId,
        sourceProgramVersionId: activated.programVersionId,
        sourceDayLineageId: template.lineageId,
        status: "completed",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 45 * 60_000),
        timezone: "UTC",
        localDate: startedAt.toISOString().slice(0, 10),
      })
      .returning({ id: workoutSessions.id });
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId: exercise.id,
        plannedFromTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        targetSets: 1,
        targetRepsMin: 6,
        targetRepsMax: 8,
        targetLoad: 100,
        targetLoadUnit: "lb",
      })
      .returning({ id: sessionExercises.id });
    const snapshotId = await createTotalSystemTestSnapshot(database.db, {
      userId: user.id,
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      unit: "lb",
    });
    const [set] = await database.db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        rpe: 7,
        metricType: "weight_reps",
        equipmentSnapshotId: snapshotId,
        loadEntryMeaning: "total_system",
      })
      .returning({ id: completedSets.id });
    await database.db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exercise.id,
      outcome: "completed",
      resolvedAt: startedAt,
      completedSetId: set.id,
      equipmentSnapshotId: snapshotId,
    });
    const [pain] = await database.db
      .insert(painLogs)
      .values({
        userId: user.id,
        sessionId: session.id,
        exerciseId: exercise.id,
        completedSetId: set.id,
        bodyPart: "shoulder",
        severity: 3,
        source: "set_flag",
        createdAt: new Date(startedAt.getTime() + 45 * 60_000),
      })
      .returning({ id: painLogs.id });

    await evaluateSessionProgression(database.db, user.id, session.id, {
      aggressiveness: "aggressive",
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    });

    expect(await database.db.select().from(recommendations)).toEqual([
      expect.objectContaining({
        ruleId: "pain_freeze",
        payload: expect.objectContaining({ kind: "hold" }),
        reason: expect.stringContaining(
          "A workout with no pain entry doesn't shorten that time."
        ),
        evidence: expect.objectContaining({
          painLogIds: [pain.id],
          sessionIds: [session.id],
        }),
      }),
    ]);
    const program = await database.db.query.programs.findFirst({
      where: (table, { eq }) => eq(table.id, activated.programId),
    });
    expect(program?.currentVersionId).toBe(activated.programVersionId);

    const [firstHold] = await database.db.select().from(recommendations);
    await database.db
      .update(painLogs)
      .set({ archivedAt: new Date() })
      .where(eq(painLogs.id, pain.id));
    let concurrentlyRestoredPainId: string | null = null;
    await expect(
      reconcilePendingPainRecommendations(database.db, user.id, {
        checkpoint: async (boundary) => {
          if (boundary !== "pain-recommendations-reviewed") return;
          const [restoredPain] = await database.db
            .insert(painLogs)
            .values({
              userId: user.id,
              sessionId: session.id,
              exerciseId: exercise.id,
              completedSetId: set.id,
              bodyPart: "shoulder",
              severity: 4,
              source: "set_flag",
              createdAt: new Date(),
            })
            .returning({ id: painLogs.id });
          concurrentlyRestoredPainId = restoredPain.id;
          await reconcilePendingPainRecommendations(database.db, user.id);
        },
      }),
    ).resolves.toBe(0);
    expect(
      await database.db.query.recommendations.findFirst({
        where: (table, { eq }) => eq(table.id, firstHold.id),
      }),
    ).toMatchObject({
      status: "pending",
      reason: expect.stringContaining("a 4/10 positive pain report"),
      evidence: expect.objectContaining({
        painLogIds: [concurrentlyRestoredPainId],
      }),
    });
    await database.db
      .update(painLogs)
      .set({ archivedAt: new Date() })
      .where(eq(painLogs.id, concurrentlyRestoredPainId!));
    await database.db
      .update(painLogs)
      .set({ archivedAt: null })
      .where(eq(painLogs.id, pain.id));
    await reconcilePendingPainRecommendations(database.db, user.id);

    await database.db
      .update(recommendations)
      .set({
        payload: {
          kind: "load_change",
          templateExerciseId: slot.id,
          fromLoad: 100,
          toLoad: 105,
          loadUnit: "lb",
        },
      })
      .where(eq(recommendations.id, firstHold.id));
    const secondStartedAt = new Date(Date.now() - 60 * 60_000);
    const [secondSession] = await database.db
      .insert(workoutSessions)
      .values({
        userId: user.id,
        templateId: template.id,
        sourceProgramId: activated.programId,
        sourceProgramVersionId: activated.programVersionId,
        sourceDayLineageId: template.lineageId,
        status: "completed",
        startedAt: secondStartedAt,
        finishedAt: new Date(secondStartedAt.getTime() + 45 * 60_000),
        timezone: "UTC",
        localDate: secondStartedAt.toISOString().slice(0, 10),
      })
      .returning({ id: workoutSessions.id });
    await database.db.insert(sessionExercises).values({
      sessionId: secondSession.id,
      exerciseId: exercise.id,
      plannedFromTemplateExerciseId: slot.id,
      sourceSlotLineageId: slot.lineageId,
      targetSets: 1,
      targetRepsMin: 6,
      targetRepsMax: 8,
      targetLoad: 100,
      targetLoadUnit: "lb",
    });
    const secondPainAt = new Date(secondStartedAt.getTime() + 30 * 60_000);
    const [secondPain] = await database.db
      .insert(painLogs)
      .values({
        userId: user.id,
        sessionId: secondSession.id,
        exerciseId: exercise.id,
        bodyPart: "shoulder",
        severity: 4,
        source: "session_note",
        createdAt: secondPainAt,
      })
      .returning({ id: painLogs.id });

    await evaluateSessionProgression(database.db, user.id, secondSession.id, {
      aggressiveness: "aggressive",
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    });

    expect(await database.db.select().from(recommendations)).toEqual([
      expect.objectContaining({
        id: firstHold.id,
        ruleId: "pain_freeze",
        payload: expect.objectContaining({
          kind: "hold",
          templateExerciseId: slot.id,
        }),
        reason: expect.stringContaining("a 4/10 positive pain report"),
        evidence: expect.objectContaining({
          painLogIds: [secondPain.id, pain.id],
          sessionIds: [secondSession.id, session.id],
          signals: expect.objectContaining({
            releaseAt: new Date(
              secondPainAt.getTime() + 14 * 24 * 60 * 60_000,
            ).toISOString(),
          }),
        }),
      }),
    ]);
    const refreshedHold =
      await database.db.query.recommendations.findFirst({
        where: (table, { eq }) => eq(table.id, firstHold.id),
      });
    expect(refreshedHold?.reconciledAt).not.toBeNull();
    expect(
      await reconcilePendingPainRecommendations(database.db, user.id),
    ).toBe(0);

    await evaluateSessionProgression(database.db, user.id, secondSession.id, {
      aggressiveness: "aggressive",
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    });
    expect(
      await database.db.query.recommendations.findFirst({
        where: (table, { eq }) => eq(table.id, firstHold.id),
      }),
    ).toMatchObject({
      reconciledAt: refreshedHold?.reconciledAt,
      evidence: refreshedHold?.evidence,
    });

    await database.db
      .update(painLogs)
      .set({ archivedAt: new Date() })
      .where(eq(painLogs.id, secondPain.id));
    await evaluateSessionProgression(database.db, user.id, session.id, {
      aggressiveness: "aggressive",
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    });
    expect(
      await database.db.query.recommendations.findFirst({
        where: (table, { eq }) => eq(table.id, firstHold.id),
      }),
    ).toMatchObject({
      reason: expect.stringContaining("a 3/10 positive pain report"),
      evidence: expect.objectContaining({
        painLogIds: [pain.id],
        sessionIds: [session.id],
      }),
    });

    await database.db
      .update(painLogs)
      .set({ archivedAt: null })
      .where(eq(painLogs.id, secondPain.id));
    await evaluateSessionProgression(database.db, user.id, secondSession.id, {
      aggressiveness: "aggressive",
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    });
    expect(
      await database.db.query.recommendations.findFirst({
        where: (table, { eq }) => eq(table.id, firstHold.id),
      }),
    ).toMatchObject({
      reason: expect.stringContaining("a 4/10 positive pain report"),
      evidence: expect.objectContaining({
        painLogIds: [secondPain.id, pain.id],
        sessionIds: [secondSession.id, session.id],
      }),
    });

    await database.db
      .update(recommendations)
      .set({ archivedAt: new Date() })
      .where(eq(recommendations.id, firstHold.id));
    await database.db
      .update(painLogs)
      .set({ severity: 5 })
      .where(eq(painLogs.id, pain.id));
    await evaluateSessionProgression(database.db, user.id, session.id, {
      aggressiveness: "aggressive",
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    });
    const substitute =
      await database.db.query.recommendations.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.ruleId, "pain_substitute"),
            isNull(table.archivedAt),
          ),
      });
    expect(substitute).toMatchObject({
      payload: {
        kind: "substitution",
        templateExerciseId: slot.id,
        fromExerciseId: exercise.id,
        toExerciseId: alternative.id,
      },
      reason: expect.stringContaining("needs an alternative review"),
      evidence: expect.objectContaining({
        signals: expect.objectContaining({
          suggestedExercise: alternative.name,
          alternatives: [],
        }),
      }),
    });

    const [followupPain] = await database.db
      .insert(painLogs)
      .values({
        userId: user.id,
        sessionId: secondSession.id,
        exerciseId: exercise.id,
        bodyPart: "shoulder",
        severity: 4,
        source: "session_note",
        createdAt: new Date(Date.now() - 5 * 60_000),
      })
      .returning({ id: painLogs.id });
    await reconcilePendingPainRecommendations(database.db, user.id);
    expect(
      await database.db.query.recommendations.findFirst({
        where: (table, { eq }) => eq(table.id, substitute!.id),
      }),
    ).toMatchObject({
      payload: substitute?.payload,
      evidence: expect.objectContaining({
        painLogIds: [pain.id, followupPain.id, secondPain.id],
        signals: expect.objectContaining({
          suggestedExercise: alternative.name,
          alternatives: [],
        }),
      }),
    });
  });
});
