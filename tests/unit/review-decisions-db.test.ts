import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  adaptationEvents,
  completedSets,
  exercises,
  painLogs,
  programs,
  recommendations,
  sessionExercises,
  sessionOccurrences,
  userDecisions,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
  type RecommendationPayload,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { approveRecommendationDecision } from "@/services/recommendation-decisions";
import { publishRecommendationProgramVersion } from "@/services/program-publication";
import {
  buildReviewEvidenceItems,
  getReviewDecisionData,
  reviewDecisionStatus,
  summarizeRecommendationChange,
} from "@/services/review-decisions";
import { workoutLocalDate } from "@/lib/workout-calendar";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("Review and decisions presentation contracts", () => {
  it("presents stored evidence without inventing confidence or hidden signals", () => {
    expect(
      buildReviewEvidenceItems(
        {
          sessionIds: [crypto.randomUUID(), crypto.randomUUID()],
          setIds: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
          painLogIds: [crypto.randomUUID()],
          signals: {
            cleanExposures: 2,
            fromLoad: 100,
            toLoad: 105,
            suggestedExercise: "A separately presented exercise",
            alternatives: ["One", "Two"],
          },
        },
        "lb"
      )
    ).toEqual([
      { label: "Linked completed workouts", value: "2" },
      { label: "Linked working sets", value: "3" },
      { label: "Linked pain flags", value: "1" },
      { label: "Clean completed workouts", value: "2" },
      { label: "Previous target", value: "100 lb" },
      { label: "Suggested target", value: "105 lb" },
    ]);
    expect(buildReviewEvidenceItems({ signals: {} }, null)).toEqual([]);
  });

  it("keeps accepted, edited, rejected, expired, and undone history distinct", () => {
    expect(reviewDecisionStatus({ status: "approved", adaptations: [] })).toBe(
      "Accepted"
    );
    expect(reviewDecisionStatus({ status: "edited", adaptations: [] })).toBe(
      "Edited"
    );
    expect(reviewDecisionStatus({ status: "rejected", adaptations: [] })).toBe(
      "Rejected"
    );
    expect(reviewDecisionStatus({ status: "expired", adaptations: [] })).toBe(
      "Expired"
    );
    expect(
      reviewDecisionStatus({
        status: "approved",
        adaptations: [{ undoneAt: new Date("2026-01-05T12:00:00.000Z") }],
      })
    ).toBe("Undone");
    expect(
      summarizeRecommendationChange({
        kind: "load_change",
        templateExerciseId: crypto.randomUUID(),
        fromLoad: 100,
        toLoad: 105,
        loadUnit: "lb",
      })
    ).toBe("100 → 105 lb");
    expect(
      summarizeRecommendationChange({
        kind: "load_change",
        templateExerciseId: crypto.randomUUID(),
        fromLoad: null,
        toLoad: 45,
        loadUnit: "lb",
      })
    ).toBe("No target → 45 lb");
  });
});

describe("Review outcome readiness", () => {
  let database: TestDatabase;
  let userId: string;
  let otherUserId: string;
  let exerciseId: string;
  let programId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }, { id: otherUserId }] = await database.db
      .insert(users)
      .values([
        { email: `review-owner-${crypto.randomUUID()}@example.com` },
        { email: `review-other-${crypto.randomUUID()}@example.com` },
      ])
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values([
      { userId, unit: "lb", timezone: "America/Toronto" },
      { userId: otherUserId, unit: "lb", timezone: "America/Toronto" },
    ]);
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: `Review Squat ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    const activated = await activateProgramAtomically(database.db, {
      userId,
      loadUnit: "lb",
      programName: "Review Program",
      days: [
        {
          name: "Review Day",
          exercises: [
            {
              exerciseId,
              sets: 3,
              repMin: 6,
              repMax: 8,
              targetLoad: 100,
              restSec: 90,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Review outcome fixture",
      auditAction: "program.activate",
      auditSummary: "Activated review outcome fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    programId = activated.programId;
  }, 30_000);

  afterEach(async () => database.close());

  async function currentSlot() {
    const program = await database.db.query.programs.findFirst({
      where: and(eq(programs.id, programId), eq(programs.userId, userId)),
    });
    if (!program?.currentVersionId) throw new Error("Current Program missing.");
    const template = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, program.currentVersionId),
    });
    if (!template) throw new Error("Current template missing.");
    const slot = await database.db.query.workoutTemplateExercises.findFirst({
      where: eq(workoutTemplateExercises.workoutTemplateId, template.id),
    });
    if (!slot) throw new Error("Current slot missing.");
    return { template, slot };
  }

  async function approveLoad(fromLoad: number, toLoad: number) {
    const { slot, template } = await currentSlot();
    const evidenceSessionId = await seedFollowup({
      ownerId: userId,
      slotId: slot.id,
      templateId: template.id,
      startedAt: new Date("2025-12-31T12:00:00.000Z"),
      targetLoad: fromLoad,
      performedLoad: fromLoad,
      sets: [{ targetMet: true, rpe: 7 }],
    });
    const evidenceSets = await database.db
      .select({ id: completedSets.id })
      .from(completedSets)
      .innerJoin(
        sessionExercises,
        eq(sessionExercises.id, completedSets.sessionExerciseId),
      )
      .where(eq(sessionExercises.sessionId, evidenceSessionId));
    const payload: RecommendationPayload = {
      kind: "load_change",
      templateExerciseId: slot.id,
      fromLoad,
      toLoad,
      loadUnit: "lb",
    };
    const [recommendation] = await database.db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "pending",
        ruleId: "double_progression",
        exerciseId,
        sourceTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        payload,
        reason: "Exact follow-up fixture",
        evidence: {
          signals: { cleanExposures: 2, fromLoad, toLoad },
          sessionIds: [evidenceSessionId],
          setIds: evidenceSets.map((set) => set.id),
        },
      })
      .returning({ id: recommendations.id });
    const approved = await approveRecommendationDecision(
      database.db,
      userId,
      { recommendationId: recommendation.id },
      { publishProgramVersion: publishRecommendationProgramVersion }
    );
    if (!approved.ok) throw new Error(approved.reason);
    return recommendation.id;
  }

  async function seedFollowup(input: {
    ownerId: string;
    slotId: string;
    templateId: string;
    startedAt: Date;
    targetLoad: number;
    performedLoad?: number;
    performedLoadUnit?: "lb" | "kg";
    recordedMetricType?: "weight_reps" | "assisted_reps";
    performedExerciseId?: string;
    modificationType?: "as_planned" | "substituted";
    sets: Array<{ targetMet: boolean | null; rpe: number | null }>;
    painSeverity?: number;
    painLinkedToDuplicate?: boolean;
  }) {
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId: input.ownerId,
        templateId: input.templateId,
        templateName: "Review follow-up",
        status: "completed",
        timezone: "America/Toronto",
        localDate: workoutLocalDate(input.startedAt, "America/Toronto"),
        startedAt: input.startedAt,
        finishedAt: new Date(input.startedAt.getTime() + 45 * 60_000),
      })
      .returning({ id: workoutSessions.id });
    const sourceSlot = await database.db.query.workoutTemplateExercises.findFirst({
      where: eq(workoutTemplateExercises.id, input.slotId),
      columns: { lineageId: true },
    });
    if (!sourceSlot) throw new Error("Review fixture source slot missing");
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId: input.performedExerciseId ?? exerciseId,
        plannedFromTemplateExerciseId: input.slotId,
        sourceSlotLineageId: sourceSlot.lineageId,
        modificationType: input.modificationType ?? "as_planned",
        substitutedForExerciseId:
          input.modificationType === "substituted" ? exerciseId : null,
        targetSets: 3,
        targetRepsMin: 6,
        targetRepsMax: 8,
        targetLoad: input.targetLoad,
        targetLoadUnit: "lb",
      })
      .returning({ id: sessionExercises.id });
    if (input.sets.length > 0) {
      const equipmentSnapshotId = await createTotalSystemTestSnapshot(
        database.db,
        {
          userId: input.ownerId,
          sessionId: session.id,
          sessionExerciseId: sessionExercise.id,
          unit: "lb",
        },
      );
      const savedSets = await database.db.insert(completedSets).values(
        input.sets.map((set, index) => ({
          sessionExerciseId: sessionExercise.id,
          setNo: index + 1,
          weight: input.performedLoad ?? input.targetLoad,
          weightUnit: input.performedLoadUnit ?? ("lb" as const),
          reps: 8,
          targetMet: set.targetMet,
          rpe: set.rpe,
          metricType: input.recordedMetricType ?? ("weight_reps" as const),
          equipmentSnapshotId,
          loadEntryMeaning: "total_system",
        }))
      ).returning({ id: completedSets.id });
      await database.db.insert(sessionOccurrences).values(
        savedSets.map((set, index) => ({
          sessionId: session.id,
          sessionExerciseId: sessionExercise.id,
          kind: "working_set" as const,
          origin: "planned" as const,
          sequenceIdx: index,
          kindOrdinal: index,
          plannedExerciseId: exerciseId,
          outcome: "completed" as const,
          resolvedAt: input.startedAt,
          completedSetId: set.id,
          equipmentSnapshotId,
        }))
      );
    }
    if (input.painSeverity != null) {
      let completedSetId: string | null = null;
      if (input.painLinkedToDuplicate) {
        const [duplicateExercise] = await database.db
          .insert(sessionExercises)
          .values({
            sessionId: session.id,
            exerciseId,
            orderIdx: 1,
            targetSets: 1,
            targetRepsMin: 6,
            targetRepsMax: 8,
            targetLoad: input.targetLoad,
            targetLoadUnit: "lb",
          })
          .returning({ id: sessionExercises.id });
        const duplicateEquipmentSnapshotId =
          await createTotalSystemTestSnapshot(database.db, {
            userId: input.ownerId,
            sessionId: session.id,
            sessionExerciseId: duplicateExercise.id,
            unit: "lb",
          });
        const [duplicateSet] = await database.db
          .insert(completedSets)
          .values({
            sessionExerciseId: duplicateExercise.id,
            setNo: 1,
            weight: input.targetLoad,
            weightUnit: "lb",
            reps: 8,
            targetMet: true,
            rpe: 7,
            metricType: "weight_reps",
            equipmentSnapshotId: duplicateEquipmentSnapshotId,
            loadEntryMeaning: "total_system",
          })
          .returning({
            id: completedSets.id,
            equipmentSnapshotId: completedSets.equipmentSnapshotId,
          });
        completedSetId = duplicateSet.id;
        await database.db.insert(sessionOccurrences).values({
          sessionId: session.id,
          sessionExerciseId: duplicateExercise.id,
          kind: "working_set",
          origin: "planned",
          sequenceIdx: input.sets.length,
          kindOrdinal: 0,
          plannedExerciseId: exerciseId,
          outcome: "completed",
          resolvedAt: input.startedAt,
          completedSetId: duplicateSet.id,
          equipmentSnapshotId: duplicateEquipmentSnapshotId,
        });
      }
      await database.db.insert(painLogs).values({
        userId: input.ownerId,
        sessionId: session.id,
        exerciseId,
        completedSetId,
        bodyPart: "knee",
        severity: input.painSeverity,
      });
    }
    return session.id;
  }

  it("requires owned, exact post-decision training and reports only recorded outcome evidence", async () => {
    const firstRecommendationId = await approveLoad(100, 105);
    const firstAppliedAt = new Date("2026-01-01T12:00:00.000Z");
    await database.db
      .update(adaptationEvents)
      .set({ appliedAt: firstAppliedAt })
      .where(eq(adaptationEvents.recommendationId, firstRecommendationId));

    const firstProgramState = await currentSlot();
    const readySessionId = await seedFollowup({
      ownerId: userId,
      slotId: firstProgramState.slot.id,
      templateId: firstProgramState.template.id,
      startedAt: new Date("2026-01-02T12:00:00.000Z"),
      targetLoad: 105,
      sets: [
        { targetMet: true, rpe: 7 },
        { targetMet: true, rpe: 8 },
        { targetMet: false, rpe: 9 },
      ],
      painSeverity: 3,
  });
    const readyExercise = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, readySessionId),
    });
    if (!readyExercise) throw new Error("Review fixture exercise missing");
    await database.db.insert(completedSets).values({
      sessionExerciseId: readyExercise.id,
      setNo: 4,
      weight: 105,
      weightUnit: "lb",
      reps: 8,
      targetMet: true,
      rpe: 10,
    });
    await seedFollowup({
      ownerId: otherUserId,
      slotId: firstProgramState.slot.id,
      templateId: firstProgramState.template.id,
      startedAt: new Date("2026-01-02T13:00:00.000Z"),
      targetLoad: 105,
      sets: [{ targetMet: true, rpe: 6 }],
    });
    await seedFollowup({
      ownerId: userId,
      slotId: firstProgramState.slot.id,
      templateId: firstProgramState.template.id,
      startedAt: new Date("2026-01-02T14:00:00.000Z"),
      targetLoad: 110,
      sets: [{ targetMet: true, rpe: 6 }],
    });
    await seedFollowup({
      ownerId: userId,
      slotId: firstProgramState.slot.id,
      templateId: firstProgramState.template.id,
      startedAt: new Date("2026-01-02T14:30:00.000Z"),
      targetLoad: 105,
      performedLoad: 100,
      sets: [{ targetMet: true, rpe: 6 }],
    });
    await seedFollowup({
      ownerId: userId,
      slotId: firstProgramState.slot.id,
      templateId: firstProgramState.template.id,
      startedAt: new Date("2026-01-02T15:00:00.000Z"),
      targetLoad: 105,
      sets: [],
    });

    const secondAppliedAt = new Date("2026-01-03T12:00:00.000Z");
    const [secondRecommendation] = await database.db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "approved",
        ruleId: "double_progression",
        exerciseId,
        sourceTemplateExerciseId: firstProgramState.slot.id,
        sourceSlotLineageId: firstProgramState.slot.lineageId,
        payload: {
          kind: "load_change",
          templateExerciseId: firstProgramState.slot.id,
          fromLoad: 105,
          toLoad: 110,
          loadUnit: "lb",
        },
        reason: "Later undone fixture",
        evidence: { signals: { fromLoad: 105, toLoad: 110 } },
        decidedAt: secondAppliedAt,
        reconciledAt: secondAppliedAt,
      })
      .returning({ id: recommendations.id });
    await database.db.insert(userDecisions).values({
      recommendationId: secondRecommendation.id,
      decision: "approve",
      decidedAt: secondAppliedAt,
    });
    await database.db.insert(adaptationEvents).values({
      userId,
      recommendationId: secondRecommendation.id,
      beforeSnapshot: {
        payload: {
          kind: "load_change",
          templateExerciseId: firstProgramState.slot.id,
          fromLoad: 100,
          toLoad: 105,
          loadUnit: "lb",
        },
      },
      afterSnapshot: {
        payload: {
          kind: "load_change",
          templateExerciseId: firstProgramState.slot.id,
          fromLoad: 105,
          toLoad: 110,
          loadUnit: "lb",
        },
      },
      appliedAt: secondAppliedAt,
      undoneAt: new Date("2026-02-01T12:00:00.000Z"),
    });
    const secondRecommendationId = secondRecommendation.id;
    await seedFollowup({
      ownerId: userId,
      slotId: firstProgramState.slot.id,
      templateId: firstProgramState.template.id,
      startedAt: new Date("2026-01-04T12:00:00.000Z"),
      targetLoad: 105,
      sets: [{ targetMet: true, rpe: 6 }],
    });
    const recentRejected = await database.db
      .insert(recommendations)
      .values(
        Array.from({ length: 21 }, (_, index) => {
          const decidedAt = new Date(
            `2026-01-${String(index + 6).padStart(2, "0")}T12:00:00.000Z`
          );
          return {
            userId,
            source: "rule" as const,
            status: "rejected" as const,
            ruleId: "double_progression",
            exerciseId,
            sourceTemplateExerciseId: firstProgramState.slot.id,
            sourceSlotLineageId: firstProgramState.slot.lineageId,
            payload: {
              kind: "load_change" as const,
              templateExerciseId: firstProgramState.slot.id,
              fromLoad: 105,
              toLoad: 110,
              loadUnit: "lb" as const,
            },
            reason: `Recent rejected fixture ${index}`,
            evidence: { signals: {} },
            createdAt: decidedAt,
            decidedAt,
            reconciledAt: decidedAt,
          };
        })
      )
      .returning({ id: recommendations.id, decidedAt: recommendations.decidedAt });
    await database.db.insert(userDecisions).values(
      recentRejected.map((recommendation) => ({
        recommendationId: recommendation.id,
        decision: "reject" as const,
        decidedAt: recommendation.decidedAt!,
      }))
    );

    const review = await getReviewDecisionData(database.db, userId);
    expect(review.acceptedDecisionCount).toBe(1);
    expect(review.outcomes).toEqual([
      expect.objectContaining({
        recommendationId: firstRecommendationId,
        latestSessionId: readySessionId,
        followupSessions: 1,
        workingSets: 3,
        measurableSets: 3,
        targetsMet: 2,
        rpeCount: 3,
        averageRpe: 8,
        painFlags: 1,
        maxPainSeverity: 3,
        evidenceLimited: false,
      }),
    ]);
    const undone = review.recent.find(
      (recommendation) => recommendation.id === secondRecommendationId
    );
    expect(undone && reviewDecisionStatus(undone)).toBe("Undone");
    expect(review.recent).toHaveLength(20);
    expect(review.recent[0]?.id).toBe(secondRecommendationId);
  }, 30_000);

  it("preserves assisted follow-up facts without claiming a load-change outcome", async () => {
    const recommendationId = await approveLoad(100, 105);
    const appliedAt = new Date("2026-01-01T12:00:00.000Z");
    await database.db
      .update(adaptationEvents)
      .set({ appliedAt })
      .where(eq(adaptationEvents.recommendationId, recommendationId));
    await database.db
      .update(exercises)
      .set({
        metricType: "assisted_reps",
        loadSemantics: "assistance",
      })
      .where(eq(exercises.id, exerciseId));
    const current = await currentSlot();
    await seedFollowup({
      ownerId: userId,
      slotId: current.slot.id,
      templateId: current.template.id,
      startedAt: new Date("2026-01-02T12:00:00.000Z"),
      targetLoad: 105,
      performedLoad: 105,
      recordedMetricType: "assisted_reps",
      sets: [{ targetMet: true, rpe: 7 }],
    });

    const review = await getReviewDecisionData(database.db, userId);
    expect(review.acceptedDecisionCount).toBe(1);
    expect(review.outcomeSupportedDecisionCount).toBe(1);
    expect(review.outcomes).toEqual([]);
    expect(await database.db.select().from(completedSets)).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        metricType: "assisted_reps",
        weight: 105,
        reps: 8,
      }),
      ]),
    );
  });

  it("hides and refuses a pending load change backed by assisted evidence", async () => {
    const current = await currentSlot();
    await database.db
      .update(exercises)
      .set({
        metricType: "assisted_reps",
        loadSemantics: "assistance",
      })
      .where(eq(exercises.id, exerciseId));
    const sessionId = await seedFollowup({
      ownerId: userId,
      slotId: current.slot.id,
      templateId: current.template.id,
      startedAt: new Date("2026-01-01T12:00:00.000Z"),
      targetLoad: 100,
      performedLoad: 100,
      recordedMetricType: "assisted_reps",
      sets: [{ targetMet: true, rpe: 7 }],
    });
    const [evidenceSet] = await database.db
      .select({ id: completedSets.id })
      .from(completedSets)
      .innerJoin(
        sessionExercises,
        eq(sessionExercises.id, completedSets.sessionExerciseId),
      )
      .where(eq(sessionExercises.sessionId, sessionId));
    const payload: RecommendationPayload = {
      kind: "load_change",
      templateExerciseId: current.slot.id,
      fromLoad: 100,
      toLoad: 105,
      loadUnit: "lb",
    };
    const [recommendation] = await database.db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "pending",
        ruleId: "double_progression",
        exerciseId,
        sourceTemplateExerciseId: current.slot.id,
        sourceSlotLineageId: current.slot.lineageId,
        payload,
        reason: "Unsafe assisted fixture",
        evidence: {
          sessionIds: [sessionId],
          setIds: [evidenceSet.id],
          signals: {},
        },
      })
      .returning({ id: recommendations.id });

    expect((await getReviewDecisionData(database.db, userId)).pending).toEqual([]);
    let publicationCalled = false;
    await expect(
      approveRecommendationDecision(
        database.db,
        userId,
        { recommendationId: recommendation.id },
        {
          publishProgramVersion: async () => {
            publicationCalled = true;
            return { ok: true, programVersionId: crypto.randomUUID() };
          },
        },
      ),
    ).resolves.toEqual({
      ok: false,
      reason:
        "This load recommendation no longer has comparable completed-set evidence and cannot be applied.",
    });
    expect(publicationCalled).toBe(false);
  });

  it("does not credit a substituted exercise as proof of the original load change", async () => {
    const recommendationId = await approveLoad(100, 105);
    await database.db
      .update(adaptationEvents)
      .set({ appliedAt: new Date("2026-01-01T12:00:00.000Z") })
      .where(eq(adaptationEvents.recommendationId, recommendationId));
    const [substitute] = await database.db
      .insert(exercises)
      .values({
        name: `Review substitute ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    const current = await currentSlot();
    await seedFollowup({
      ownerId: userId,
      slotId: current.slot.id,
      templateId: current.template.id,
      startedAt: new Date("2026-01-02T12:00:00.000Z"),
      targetLoad: 105,
      performedLoad: 105,
      performedExerciseId: substitute.id,
      modificationType: "substituted",
      sets: [{ targetMet: true, rpe: 7 }],
    });

    expect((await getReviewDecisionData(database.db, userId)).outcomes).toEqual([]);
  });

  it("marks a matching follow-up as limited when target and effort evidence are absent", async () => {
    const recommendationId = await approveLoad(100, 105);
    await database.db
      .update(adaptationEvents)
      .set({ appliedAt: new Date("2026-02-01T12:00:00.000Z") })
      .where(eq(adaptationEvents.recommendationId, recommendationId));
    const programState = await currentSlot();
    await seedFollowup({
      ownerId: userId,
      slotId: programState.slot.id,
      templateId: programState.template.id,
      startedAt: new Date("2026-02-02T12:00:00.000Z"),
      targetLoad: 105,
      sets: [
        { targetMet: null, rpe: null },
        { targetMet: null, rpe: null },
      ],
    });

    const review = await getReviewDecisionData(database.db, userId);
    expect(review.outcomes).toEqual([
      expect.objectContaining({
        recommendationId,
        workingSets: 2,
        measurableSets: 0,
        rpeCount: 0,
        averageRpe: null,
        evidenceLimited: true,
      }),
    ]);
  }, 30_000);

  it("marks partially recorded target and effort evidence as limited", async () => {
    const recommendationId = await approveLoad(100, 105);
    await database.db
      .update(adaptationEvents)
      .set({ appliedAt: new Date("2026-02-10T12:00:00.000Z") })
      .where(eq(adaptationEvents.recommendationId, recommendationId));
    const programState = await currentSlot();
    await seedFollowup({
      ownerId: userId,
      slotId: programState.slot.id,
      templateId: programState.template.id,
      startedAt: new Date("2026-02-11T12:00:00.000Z"),
      targetLoad: 105,
      sets: [
        { targetMet: true, rpe: 7 },
        { targetMet: null, rpe: null },
      ],
    });

    const review = await getReviewDecisionData(database.db, userId);
    expect(review.outcomes).toEqual([
      expect.objectContaining({
        recommendationId,
        workingSets: 2,
        measurableSets: 1,
        rpeCount: 1,
        averageRpe: 7,
        evidenceLimited: true,
      }),
    ]);
  }, 30_000);

  it("accepts an equivalent performed load recorded in another unit", async () => {
    const recommendationId = await approveLoad(100, 105);
    await database.db
      .update(adaptationEvents)
      .set({ appliedAt: new Date("2026-02-20T12:00:00.000Z") })
      .where(eq(adaptationEvents.recommendationId, recommendationId));
    const programState = await currentSlot();
    await seedFollowup({
      ownerId: userId,
      slotId: programState.slot.id,
      templateId: programState.template.id,
      startedAt: new Date("2026-02-21T12:00:00.000Z"),
      targetLoad: 105,
      performedLoad: 47.63,
      performedLoadUnit: "kg",
      sets: [{ targetMet: true, rpe: 7 }],
    });

    const review = await getReviewDecisionData(database.db, userId);
    expect(review.outcomes).toEqual([
      expect.objectContaining({
        recommendationId,
        workingSets: 1,
        measurableSets: 1,
        rpeCount: 1,
        evidenceLimited: false,
      }),
    ]);
  }, 30_000);

  it("distinguishes accepted decisions that cannot be assessed automatically", async () => {
    const { slot } = await currentSlot();
    const decidedAt = new Date("2026-02-25T12:00:00.000Z");
    const payload: RecommendationPayload = {
      kind: "hold",
      templateExerciseId: slot.id,
      reason: "Keep the current target while symptoms settle.",
    };
    const [recommendation] = await database.db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "approved",
        ruleId: "pain_freeze",
        exerciseId,
        sourceTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        payload,
        reason: "Accepted hold fixture",
        evidence: { signals: { worstPainSeverity: 4 } },
        decidedAt,
        reconciledAt: decidedAt,
      })
      .returning({ id: recommendations.id });
    await database.db.insert(userDecisions).values({
      recommendationId: recommendation.id,
      decision: "approve",
      decidedAt,
    });
    await database.db.insert(adaptationEvents).values({
      userId,
      recommendationId: recommendation.id,
      beforeSnapshot: { payload },
      afterSnapshot: { payload },
      appliedAt: decidedAt,
    });

    const review = await getReviewDecisionData(database.db, userId);
    expect(review.acceptedDecisionCount).toBe(1);
    expect(review.outcomeSupportedDecisionCount).toBe(0);
    expect(review.outcomes).toEqual([]);
  }, 30_000);

  it("does not borrow set-linked pain from a duplicate exercise occurrence", async () => {
    const recommendationId = await approveLoad(100, 105);
    await database.db
      .update(adaptationEvents)
      .set({ appliedAt: new Date("2026-03-01T12:00:00.000Z") })
      .where(eq(adaptationEvents.recommendationId, recommendationId));
    const programState = await currentSlot();
    await seedFollowup({
      ownerId: userId,
      slotId: programState.slot.id,
      templateId: programState.template.id,
      startedAt: new Date("2026-03-02T12:00:00.000Z"),
      targetLoad: 105,
      sets: [{ targetMet: true, rpe: 7 }],
      painSeverity: 8,
      painLinkedToDuplicate: true,
    });

    const review = await getReviewDecisionData(database.db, userId);
    expect(review.outcomes).toEqual([
      expect.objectContaining({
        recommendationId,
        workingSets: 1,
        painFlags: 0,
        maxPainSeverity: null,
      }),
    ]);
  }, 30_000);

  it("ignores an adaptation whose separate owner does not match", async () => {
    const recommendationId = await approveLoad(100, 105);
    await database.db
      .update(adaptationEvents)
      .set({ userId: otherUserId })
      .where(eq(adaptationEvents.recommendationId, recommendationId));

    const review = await getReviewDecisionData(database.db, userId);
    expect(review.acceptedDecisionCount).toBe(0);
    expect(review.outcomes).toEqual([]);
    const acceptedRecommendation = review.recent.find(
      (recommendation) => recommendation.id === recommendationId
    );
    expect(acceptedRecommendation?.adaptations).toEqual([]);
    expect(
      acceptedRecommendation && reviewDecisionStatus(acceptedRecommendation)
    ).toBe("Accepted");
  }, 30_000);
});
