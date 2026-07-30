import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  adaptationEvents,
  auditLogs,
  completedSets,
  constraints,
  equipmentItems,
  exerciseEquipmentRequirements,
  exercisePrescriptions,
  exercises,
  painLogs,
  programs,
  programVersions,
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
import {
  approveRecommendationDecision,
  dismissAutomaticHoldNotice,
  rejectRecommendationDecision,
  type RecommendationCheckpoint,
} from "@/services/recommendation-decisions";
import { publishRecommendationProgramVersion } from "@/services/program-publication";
import { evaluateSessionProgression } from "@/services/progression";
import { getReviewDecisionData } from "@/services/review-decisions";
import {
  createMigratedTestDatabase,
  createStartBarrier,
  runSimultaneously,
  type TestDatabase,
} from "../helpers/database";
import { KG_TO_LB, type LoadUnit } from "@/lib/units";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("recommendation decisions publish immutable Program versions", () => {
  let database: TestDatabase;
  let userId: string;
  let programId: string;
  let initialSlotId: string;
  let currentExerciseId: string;
  let targetExerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `recommendation-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId, unit: "lb" });
    [{ id: currentExerciseId }, { id: targetExerciseId }] = await database.db
      .insert(exercises)
      .values([
        {
          name: `Recommendation Squat ${crypto.randomUUID()}`,
          movementPattern: "squat",
          primaryMuscles: ["quadriceps"],
          loadType: "barbell",
          metricType: "weight_reps",
          loadSemantics: "total",
          variantAttributes: { assistance: "none" },
        },
        {
          name: `Recommendation Band Squat ${crypto.randomUUID()}`,
          movementPattern: "squat",
          primaryMuscles: ["quadriceps"],
          loadType: "band",
          metricType: "weight_reps",
          loadSemantics: "total",
          variantAttributes: { assistance: "none" },
        },
      ])
      .returning({ id: exercises.id });
    const activated = await activateProgramAtomically(database.db, {
      userId,
      loadUnit: "lb",
      programName: "Recommendation Program",
      days: [{
        name: "Recommendation Day",
        exercises: [{
          exerciseId: currentExerciseId,
          sets: 3,
          repMin: 6,
          repMax: 8,
          targetLoad: 100,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Recommendation fixture",
      auditAction: "program.activate",
      auditSummary: "Activated recommendation fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    programId = activated.programId;
    initialSlotId = (await currentState()).slot.id;
  }, 30_000);

  afterEach(async () => database.close());

  async function currentState() {
    const program = await database.db.query.programs.findFirst({
      where: and(eq(programs.id, programId), eq(programs.userId, userId)),
    });
    if (!program?.currentVersionId) throw new Error("Current Program missing.");
    const template = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, program.currentVersionId),
    });
    if (!template) throw new Error("Current day missing.");
    const slot = await database.db.query.workoutTemplateExercises.findFirst({
      where: eq(workoutTemplateExercises.workoutTemplateId, template.id),
    });
    if (!slot) throw new Error("Current slot missing.");
    const prescription = await database.db.query.exercisePrescriptions.findFirst({
      where: and(
        eq(exercisePrescriptions.templateExerciseId, slot.id),
        isNull(exercisePrescriptions.supersededById)
      ),
    });
    if (!prescription) throw new Error("Current target missing.");
    return { program, template, slot, prescription };
  }

  async function createRecommendation(
    payload: RecommendationPayload,
    evidence: {
      signals: Record<string, unknown>;
      sessionIds?: string[];
      setIds?: string[];
    } = { signals: {} },
    options: {
      source?: "rule" | "ai";
      ruleId?: string;
    } = {},
  ) {
    const { slot } = await currentState();
    const [recommendation] = await database.db.insert(recommendations).values({
      userId,
      source: options.source ?? "rule",
      ruleId: options.ruleId ?? "double_progression",
      exerciseId: slot.exerciseId,
      sourceTemplateExerciseId: slot.id,
      sourceSlotLineageId: slot.lineageId,
      payload,
      reason: "Reviewed recommendation",
      evidence,
    }).returning({ id: recommendations.id });
    return recommendation.id;
  }

  async function createLoadRecommendation(options: {
    fromLoad?: number;
    toLoad?: number;
    loadUnit?: LoadUnit;
  } = {}) {
    const { program, template, slot, prescription } = await currentState();
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateId: template.id,
        sourceProgramId: program.id,
        sourceProgramVersionId: program.currentVersionId,
        sourceDayLineageId: template.lineageId,
        templateName: "Recommendation evidence",
        status: "completed",
        startedAt: new Date("2025-12-31T12:00:00.000Z"),
        finishedAt: new Date("2025-12-31T13:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2025-12-31",
      })
      .returning({ id: workoutSessions.id });
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId: slot.exerciseId,
        plannedFromTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        modificationType: "as_planned",
        targetRepsMin: 6,
        targetRepsMax: 8,
        targetLoad: prescription.targetLoad,
        targetLoadUnit: prescription.targetLoadUnit,
      })
      .returning({ id: sessionExercises.id });
    const snapshotId = await createTotalSystemTestSnapshot(database.db, {
      userId,
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      unit: options.loadUnit ?? prescription.targetLoadUnit ?? "lb",
      equipmentUnit: "lb",
    });
    const [set] = await database.db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: options.fromLoad ?? prescription.targetLoad ?? 100,
        weightUnit: options.loadUnit ?? prescription.targetLoadUnit ?? "lb",
        reps: 8,
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
      plannedExerciseId: slot.exerciseId,
      outcome: "completed",
      resolvedAt: new Date("2025-12-31T12:30:00.000Z"),
      completedSetId: set.id,
      equipmentSnapshotId: snapshotId,
    });
    return createRecommendation({
      kind: "load_change",
      templateExerciseId: slot.id,
      fromLoad: options.fromLoad ?? prescription.targetLoad,
      toLoad: options.toLoad ?? (prescription.targetLoad ?? 0) + 5,
      loadUnit: options.loadUnit ?? prescription.targetLoadUnit ?? "lb",
    }, {
      signals: {},
      sessionIds: [session.id],
      setIds: [set.id],
    });
  }

  async function createPainObservation(input: {
    exerciseId?: string;
    severity: number;
    daysAgo?: number;
  }) {
    const startedAt = new Date(
      Date.now() - (input.daysAgo ?? 0) * 24 * 60 * 60 * 1000
    );
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Pain evidence",
        status: "completed",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 45 * 60_000),
        timezone: "UTC",
        localDate: startedAt.toISOString().slice(0, 10),
      })
      .returning({ id: workoutSessions.id });
    const [pain] = await database.db
      .insert(painLogs)
      .values({
        userId,
        sessionId: session.id,
        exerciseId: input.exerciseId ?? currentExerciseId,
        bodyPart: "knee",
        severity: input.severity,
        source: "set_flag",
        createdAt: startedAt,
      })
      .returning({ id: painLogs.id });
    return { sessionId: session.id, painId: pain.id };
  }

  async function createSubstitutionRecommendation(targetId = targetExerciseId) {
    const { slot } = await currentState();
    return createRecommendation({
      kind: "substitution",
      templateExerciseId: slot.id,
      fromExerciseId: slot.exerciseId,
      toExerciseId: targetId,
    });
  }

  async function createHoldRecommendation() {
    const { slot } = await currentState();
    return createRecommendation(
      {
        kind: "hold",
        templateExerciseId: slot.id,
        reason:
          "A recent pain flag is keeping the load from going up until the evidence window clears.",
      },
      { signals: {} },
      { ruleId: "pain_freeze" }
    );
  }

  async function approve(
    recommendationId: string,
    options: {
      editedToLoad?: number;
      failureAt?: string;
      checkpoint?: RecommendationCheckpoint;
    } = {}
  ) {
    return approveRecommendationDecision(
      database.db,
      userId,
      { recommendationId, editedToLoad: options.editedToLoad },
      {
        checkpoint: options.checkpoint,
        publishProgramVersion: (publicationDb, publicationUserId, input) =>
          publishRecommendationProgramVersion(publicationDb, publicationUserId, {
            ...input,
            failureAt: options.failureAt,
          }),
      }
    );
  }

  async function decisionCounts() {
    const [prescriptions, versions, decisions, adaptations, audits] = await Promise.all([
      database.db.select().from(exercisePrescriptions),
      database.db.select().from(programVersions).where(eq(programVersions.programId, programId)),
      database.db.select().from(userDecisions),
      database.db.select().from(adaptationEvents),
      database.db.select().from(auditLogs).where(inArray(auditLogs.action, [
        "recommendation.approve",
        "recommendation.reject",
      ])),
    ]);
    return {
      prescriptions: prescriptions.length,
      versions: versions.length,
      decisions: decisions.length,
      adaptations: adaptations.length,
      audits: audits.length,
    };
  }

  it("converges simultaneous approval on one decision and one immutable v2", async () => {
    const recommendationId = await createLoadRecommendation();
    const ready = createStartBarrier(8);
    const results = await runSimultaneously(8, () => approve(recommendationId, {
      checkpoint: async (boundary) => {
        if (boundary === "recommendation-ready") await ready();
      },
    }));

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ ok: true })));
    expect((await currentState()).prescription).toMatchObject({
      targetLoad: 105,
      targetLoadUnit: "lb",
    });
    expect(await decisionCounts()).toEqual({
      prescriptions: 2,
      versions: 2,
      decisions: 1,
      adaptations: 1,
      audits: 1,
    });
  });

  it("allows exactly one winner in an approve/reject race", async () => {
    const recommendationId = await createLoadRecommendation();
    const ready = createStartBarrier(2);
    const [approved, rejected] = await Promise.all([
      approve(recommendationId, {
        checkpoint: async (boundary) => {
          if (boundary === "recommendation-ready") await ready();
        },
      }),
      rejectRecommendationDecision(
        database.db,
        userId,
        { recommendationId, reason: "Not now" },
        { checkpoint: async (boundary) => {
          if (boundary === "recommendation-ready") await ready();
        } }
      ),
    ]);
    expect([approved.ok, rejected.ok].filter(Boolean)).toHaveLength(1);
    const [decision] = await database.db.select().from(userDecisions);
    expect(["approve", "reject"]).toContain(decision.decision);
    expect(await database.db.select().from(userDecisions)).toHaveLength(1);
    if (decision.decision === "approve") {
      expect((await currentState()).prescription.targetLoad).toBe(105);
      expect(await database.db.select().from(adaptationEvents)).toHaveLength(1);
    } else {
      expect((await currentState()).prescription.targetLoad).toBe(100);
      expect(await database.db.select().from(adaptationEvents)).toHaveLength(0);
    }
  });

  it("converges repeated rejection on one durable decision", async () => {
    const recommendationId = await createLoadRecommendation();
    const ready = createStartBarrier(6);
    const results = await runSimultaneously(6, () =>
      rejectRecommendationDecision(
        database.db,
        userId,
        { recommendationId, reason: "Not today" },
        { checkpoint: async (boundary) => {
          if (boundary === "recommendation-ready") await ready();
        } }
      )
    );
    expect(results).toEqual(Array.from({ length: 6 }, () => ({ ok: true })));
    expect(await database.db.select().from(userDecisions)).toEqual([
      expect.objectContaining({ decision: "reject", reason: "Not today" }),
    ]);
    expect((await currentState()).program.currentVersionId).toBeTruthy();
    expect(await database.db.select().from(programVersions).where(
      eq(programVersions.programId, programId)
    )).toHaveLength(1);
  });

  it("dismisses an automatic hold without recording a rejection or snoozing later notices", async () => {
    const firstNoticeId = await createHoldRecommendation();
    const ready = createStartBarrier(6);
    const results = await runSimultaneously(6, () =>
      dismissAutomaticHoldNotice(
        database.db,
        userId,
        { recommendationId: firstNoticeId },
        {
          checkpoint: async (boundary) => {
            if (boundary === "hold-notice-ready") await ready();
          },
        }
      )
    );
    expect(results).toEqual(Array.from({ length: 6 }, () => ({ ok: true })));
    await expect(
      dismissAutomaticHoldNotice(database.db, userId, {
        recommendationId: firstNoticeId,
      })
    ).resolves.toEqual({ ok: true });

    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, firstNoticeId),
      })
    ).toMatchObject({
      status: "expired",
      decidedAt: null,
      reconciliationReason:
        "You dismissed this notice. The recorded pain flags still count, and your Program wasn’t changed.",
    });
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "recommendation.notice_dismiss"))
    ).toHaveLength(1);

    const laterNoticeId = await createHoldRecommendation();
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, laterNoticeId),
      })
    ).toMatchObject({ status: "pending" });
    expect(
      await database.db
        .select()
        .from(recommendations)
        .where(eq(recommendations.status, "rejected"))
    ).toHaveLength(0);
    expect((await currentState()).prescription.targetLoad).toBe(100);
  });

  it("refuses to dismiss a Program proposal as an informational notice", async () => {
    const recommendationId = await createLoadRecommendation();

    await expect(
      dismissAutomaticHoldNotice(database.db, userId, { recommendationId })
    ).resolves.toEqual({
      ok: false,
      reason: "Only an automatic hold notice can be dismissed.",
    });
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, recommendationId),
      })
    ).toMatchObject({ status: "pending" });
  });

  it("keeps dismissal owner-scoped and limited to pending automatic pain holds", async () => {
    const recommendationId = await createHoldRecommendation();

    await expect(
      dismissAutomaticHoldNotice(database.db, crypto.randomUUID(), {
        recommendationId,
      })
    ).resolves.toEqual({ ok: false, reason: "Notice not found." });
    await database.db
      .update(recommendations)
      .set({ ruleId: "double_progression" })
      .where(eq(recommendations.id, recommendationId));
    await expect(
      dismissAutomaticHoldNotice(database.db, userId, { recommendationId })
    ).resolves.toEqual({
      ok: false,
      reason: "Only an automatic hold notice can be dismissed.",
    });
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, recommendationId),
      })
    ).toMatchObject({ status: "pending" });
  });

  it("rechecks the automatic pain-hold identity in the atomic dismissal", async () => {
    const recommendationId = await createHoldRecommendation();

    await expect(
      dismissAutomaticHoldNotice(
        database.db,
        userId,
        { recommendationId },
        {
          checkpoint: async (boundary) => {
            if (boundary !== "hold-notice-ready") return;
            await database.db
              .update(recommendations)
              .set({ ruleId: "double_progression" })
              .where(eq(recommendations.id, recommendationId));
          },
        }
      )
    ).resolves.toEqual({
      ok: false,
      reason: "Only an automatic hold notice can be dismissed.",
    });
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, recommendationId),
      })
    ).toMatchObject({
      status: "pending",
      ruleId: "double_progression",
      reconciledAt: null,
    });
    expect(
      await database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "recommendation.notice_dismiss"))
    ).toHaveLength(0);
  });

  it("keeps a concurrently refreshed pain notice pending for review", async () => {
    const recommendationId = await createHoldRecommendation();
    const refreshedReason =
      "A newer 4/10 pain flag is keeping the load held until its evidence window clears.";

    await expect(
      dismissAutomaticHoldNotice(
        database.db,
        userId,
        { recommendationId },
        {
          checkpoint: async (boundary) => {
            if (boundary !== "hold-notice-ready") return;
            await database.db
              .update(recommendations)
              .set({ reason: refreshedReason })
              .where(eq(recommendations.id, recommendationId));
          },
        }
      )
    ).resolves.toEqual({
      ok: false,
      reason:
        "This notice changed while you were dismissing it. Review the current notice and try again.",
    });
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, recommendationId),
      })
    ).toMatchObject({
      status: "pending",
      reason: refreshedReason,
      reconciledAt: null,
    });
    expect(
      await database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "recommendation.notice_dismiss"))
    ).toHaveLength(0);
  });

  it("lets a later progression evaluation surface the same active hold again", async () => {
    await createLoadRecommendation();
    const evidenceSession = await database.db.query.workoutSessions.findFirst({
      where: and(
        eq(workoutSessions.userId, userId),
        eq(workoutSessions.templateName, "Recommendation evidence")
      ),
    });
    if (!evidenceSession) throw new Error("Evidence session missing.");
    await createPainObservation({
      exerciseId: currentExerciseId,
      severity: 4,
    });

    const preferences = {
      aggressiveness: "aggressive" as const,
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    };
    await evaluateSessionProgression(
      database.db,
      userId,
      evidenceSession.id,
      preferences
    );
    const firstHold = await database.db.query.recommendations.findFirst({
      where: and(
        eq(recommendations.userId, userId),
        eq(recommendations.ruleId, "pain_freeze"),
        eq(recommendations.status, "pending")
      ),
    });
    if (!firstHold) throw new Error("First pain hold missing.");
    await dismissAutomaticHoldNotice(database.db, userId, {
      recommendationId: firstHold.id,
    });

    await evaluateSessionProgression(
      database.db,
      userId,
      evidenceSession.id,
      preferences
    );
    const holds = await database.db.query.recommendations.findMany({
      where: and(
        eq(recommendations.userId, userId),
        eq(recommendations.ruleId, "pain_freeze")
      ),
    });
    expect(holds).toHaveLength(2);
    expect(holds.map((hold) => hold.status).sort()).toEqual([
      "expired",
      "pending",
    ]);
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
  });

  it("rolls back a hold dismissal when its audit cannot be recorded", async () => {
    const recommendationId = await createHoldRecommendation();

    await expect(
      dismissAutomaticHoldNotice(
        database.db,
        userId,
        { recommendationId },
        { failureAt: "before-audit" }
      )
    ).rejects.toThrow();
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, recommendationId),
      })
    ).toMatchObject({
      status: "pending",
      reconciledAt: null,
      reconciliationReason: null,
    });
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
  });

  it("rolls back a rejected decision when its statement is forced to fail", async () => {
    const recommendationId = await createLoadRecommendation();
    await expect(rejectRecommendationDecision(
      database.db,
      userId,
      { recommendationId, reason: "Not now" },
      { failureAt: "before-audit" }
    )).rejects.toThrow();
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, recommendationId),
    })).toMatchObject({ status: "pending" });
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    await expect(rejectRecommendationDecision(database.db, userId, {
      recommendationId,
      reason: "Not now",
    })).resolves.toEqual({ ok: true });
  });

  it("rolls back every Program and decision row on an injected publication failure", async () => {
    const recommendationId = await createLoadRecommendation();
    const before = await decisionCounts();
    await expect(approve(recommendationId, { failureAt: "before-new-version" }))
      .resolves.toMatchObject({ ok: false });
    expect(await decisionCounts()).toEqual(before);
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, recommendationId),
    })).toMatchObject({ status: "pending" });
    await expect(approve(recommendationId)).resolves.toEqual({ ok: true });
  });

  it("returns a committed approval after a lost acknowledgement without duplication", async () => {
    const recommendationId = await createLoadRecommendation();
    await expect(approve(recommendationId, {
      checkpoint: (boundary) => {
        if (boundary === "recommendation-applied") {
          throw new Error("lost recommendation acknowledgement");
        }
      },
    })).rejects.toThrow("lost recommendation acknowledgement");
    const beforeRetry = await decisionCounts();
    await expect(approve(recommendationId)).resolves.toEqual({ ok: true });
    expect(await decisionCounts()).toEqual(beforeRetry);
  });

  it("does not turn a float32-near load into an edited approval", async () => {
    const recommendationId = await createLoadRecommendation({ toLoad: 32.3 });
    const nearLoad = Math.fround(32.3);

    await expect(approve(recommendationId, { editedToLoad: nearLoad }))
      .resolves.toEqual({ ok: true });
    expect(await database.db.query.userDecisions.findFirst({
      where: eq(userDecisions.recommendationId, recommendationId),
    })).toMatchObject({ decision: "approve", editedPayload: null });
    expect((await currentState()).prescription).toMatchObject({
      targetLoad: 32.3,
      targetLoadUnit: "lb",
    });

    const beforeRetry = await decisionCounts();
    await expect(approve(recommendationId, { editedToLoad: nearLoad }))
      .resolves.toEqual({ ok: true });
    expect(await decisionCounts()).toEqual(beforeRetry);
  });

  it("matches a raw recommendation payload and applies its canonical load", async () => {
    const recommendationId = await createLoadRecommendation({ toLoad: 10.075 });

    await expect(approve(recommendationId)).resolves.toEqual({ ok: true });
    expect(await database.db.query.userDecisions.findFirst({
      where: eq(userDecisions.recommendationId, recommendationId),
    })).toMatchObject({ decision: "approve", editedPayload: null });
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, recommendationId),
    })).toMatchObject({
      payload: expect.objectContaining({ toLoad: 10.075 }),
      status: "approved",
    });
    expect((await currentState()).prescription).toMatchObject({
      targetLoad: 10.08,
      targetLoadUnit: "lb",
    });
  });

  it("records a load change outside the epsilon as an edited approval", async () => {
    const recommendationId = await createLoadRecommendation({ toLoad: 32.3 });

    await expect(approve(recommendationId, { editedToLoad: 10.075 }))
      .resolves.toEqual({ ok: true });
    expect(await database.db.query.userDecisions.findFirst({
      where: eq(userDecisions.recommendationId, recommendationId),
    })).toMatchObject({
      decision: "edit",
      editedPayload: expect.objectContaining({ toLoad: 10.08 }),
    });
    expect((await currentState()).prescription).toMatchObject({
      targetLoad: 10.08,
      targetLoadUnit: "lb",
    });

    const beforeRetry = await decisionCounts();
    await expect(approve(recommendationId, {
      editedToLoad: Math.fround(10.08),
    })).resolves.toEqual({ ok: true });
    expect(await decisionCounts()).toEqual(beforeRetry);
  });

  it("accepts conversion noise when revalidating a stored real load", async () => {
    const toKilograms = await createLoadRecommendation({
      fromLoad: 100 / KG_TO_LB,
      toLoad: 32.3,
      loadUnit: "kg",
    });
    await expect(approve(toKilograms)).resolves.toEqual({ ok: true });
    expect((await currentState()).prescription).toMatchObject({
      targetLoad: 32.3,
      targetLoadUnit: "kg",
    });

    const toPounds = await createLoadRecommendation({
      fromLoad: 32.3 * KG_TO_LB,
      toLoad: 75,
      loadUnit: "lb",
    });
    await expect(approve(toPounds)).resolves.toEqual({ ok: true });
    expect((await currentState()).prescription).toMatchObject({
      targetLoad: 75,
      targetLoadUnit: "lb",
    });
  });

  it("rejects a stale load baseline and explains a recent exact-exercise pain hold", async () => {
    const staleId = await createLoadRecommendation({ fromLoad: 90 });
    await expect(approve(staleId)).resolves.toMatchObject({ ok: false });

    const painId = await createLoadRecommendation();
    await createPainObservation({ severity: 3 });
    await expect(approve(painId)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        "comes off hold 14 days after the latest 3/10 or higher flag"
      ),
    });
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    expect((await currentState()).prescription.targetLoad).toBe(100);
  });

  it("blocks repeated mild exact-exercise flags but not another exercise with the same pattern", async () => {
    const otherExerciseRecommendation = await createLoadRecommendation();
    await createPainObservation({
      exerciseId: targetExerciseId,
      severity: 5,
    });
    await expect(approve(otherExerciseRecommendation)).resolves.toEqual({
      ok: true,
    });

    const repeatedRecommendation = await createLoadRecommendation();
    await createPainObservation({ severity: 1, daysAgo: 4 });
    await createPainObservation({ severity: 2, daysAgo: 2 });
    await createPainObservation({ severity: 1, daysAgo: 1 });
    await expect(approve(repeatedRecommendation)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        "pain was flagged in 3 workouts in the last 14 days"
      ),
    });
  });

  it("keeps the atomic pain gate when evidence arrives after the approval read", async () => {
    const recommendationId = await createLoadRecommendation();
    let inserted = false;
    const attempt = () =>
      approve(recommendationId, {
        checkpoint: async (boundary) => {
          if (boundary === "recommendation-ready" && !inserted) {
            inserted = true;
            await createPainObservation({ severity: 4 });
          }
        },
      });

    await expect(attempt()).resolves.toMatchObject({ ok: false });
    await expect(attempt()).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        "comes off hold 14 days after the latest 3/10 or higher flag"
      ),
    });
    expect((await currentState()).prescription.targetLoad).toBe(100);
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
  });

  it("expires a pending hold when its recording window clears", async () => {
    const { slot } = await currentState();
    const { painId, sessionId } = await createPainObservation({
      severity: 4,
      daysAgo: 15,
    });
    const [hold] = await database.db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "pending",
        ruleId: "pain_freeze",
        exerciseId: currentExerciseId,
        sourceTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        payload: {
          kind: "hold",
          templateExerciseId: slot.id,
          reason: "Pain hold fixture",
        },
        reason: "Pain hold fixture",
        evidence: {
          signals: { windowDays: 14 },
          painLogIds: [painId],
          sessionIds: [sessionId],
        },
      })
      .returning({ id: recommendations.id });

    expect((await getReviewDecisionData(database.db, userId)).pending).toEqual([]);
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, hold.id),
      })
    ).toMatchObject({
      status: "expired",
      reconciliationReason:
        "The pain evidence window or exact Program exercise changed, so this older status expired.",
    });
  });

  it("expires an exact-exercise hold when a reviewed substitution changes the slot", async () => {
    const { slot } = await currentState();
    const { painId, sessionId } = await createPainObservation({ severity: 4 });
    const [hold] = await database.db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "pending",
        ruleId: "pain_freeze",
        exerciseId: currentExerciseId,
        sourceTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        payload: {
          kind: "hold",
          templateExerciseId: slot.id,
          reason: "Pain hold fixture",
        },
        reason: "Pain hold fixture",
        evidence: {
          signals: { windowDays: 14 },
          painLogIds: [painId],
          sessionIds: [sessionId],
        },
      })
      .returning({ id: recommendations.id });
    const substitution = await createSubstitutionRecommendation();

    await expect(approve(substitution)).resolves.toEqual({ ok: true });
    expect((await currentState()).slot.exerciseId).toBe(targetExerciseId);
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, hold.id),
      })
    ).toMatchObject({
      status: "expired",
      reconciliationReason:
        "The source exercise was removed from the new Program version.",
    });
  });

  it("refreshes an alternative-review notice when live evidence downgrades to an ordinary hold", async () => {
    const { slot } = await currentState();
    const { painId, sessionId } = await createPainObservation({
      severity: 4,
      daysAgo: 1,
    });
    const [hold] = await database.db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "pending",
        ruleId: "pain_substitute",
        exerciseId: currentExerciseId,
        sourceTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        payload: {
          kind: "hold",
          templateExerciseId: slot.id,
          reason: "Alternative review hold fixture",
        },
        reason: "Alternative review hold fixture",
        evidence: {
          signals: { highSeverityReview: true, windowDays: 14 },
          painLogIds: [painId],
          sessionIds: [sessionId],
        },
      })
      .returning({ id: recommendations.id });
    const review = await getReviewDecisionData(database.db, userId);
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, hold.id),
      })
    ).toMatchObject({
      status: "pending",
      ruleId: "pain_freeze",
      payload: {
        kind: "hold",
        templateExerciseId: slot.id,
      },
      reconciliationReason:
        "Live pain evidence changed, so this automatic status was refreshed without changing the Program.",
    });
    expect(review.pending).toEqual([
      expect.objectContaining({
        id: hold.id,
        ruleId: "pain_freeze",
        payload: expect.objectContaining({ kind: "hold" }),
        reason: expect.stringContaining("comes off hold 14 days"),
      }),
    ]);
  });

  it("rejects invalid edits and blocks detaching a pending source from its lineage", async () => {
    const recommendationId = await createLoadRecommendation();
    await expect(approve(recommendationId, { editedToLoad: -1 }))
      .resolves.toMatchObject({ ok: false });
    await expect(approve(recommendationId, { editedToLoad: Number.POSITIVE_INFINITY }))
      .resolves.toMatchObject({ ok: false });
    await expect(database.db.update(recommendations).set({
      sourceSlotLineageId: crypto.randomUUID(),
    }).where(eq(recommendations.id, recommendationId))).rejects.toThrow();
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
  });

  it("revalidates substitution ownership, equipment, and avoid constraints", async () => {
    const [privateOwner] = await database.db.insert(users).values({
      email: `private-${crypto.randomUUID()}@example.com`,
    }).returning({ id: users.id });
    const [privateTarget] = await database.db.insert(exercises).values({
      userId: privateOwner.id,
      name: `Private target ${crypto.randomUUID()}`,
      movementPattern: "squat",
      primaryMuscles: ["quadriceps"],
      loadType: "dumbbell",
      metricType: "weight_reps",
      loadSemantics: "total",
      variantAttributes: {},
    }).returning({ id: exercises.id });
    await expect(approve(await createSubstitutionRecommendation(privateTarget.id)))
      .resolves.toMatchObject({ ok: false });

    await database.db.insert(exerciseEquipmentRequirements).values({
      exerciseId: targetExerciseId,
      equipmentType: "bands",
    });
    const equipmentRecommendation = await createSubstitutionRecommendation();
    await expect(approve(equipmentRecommendation)).resolves.toMatchObject({ ok: false });
    await database.db.insert(equipmentItems).values({
      userId,
      type: "bands",
      label: "Bands",
      available: true,
    });
    await database.db.insert(constraints).values({
      userId,
      bodyPart: "knee",
      affectedPatterns: ["squat"],
      avoid: true,
    });
    await expect(approve(equipmentRecommendation)).resolves.toMatchObject({ ok: false });
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
  });

  it("publishes a legal substitution with new lineage and a reset load", async () => {
    const before = await currentState();
    const recommendationId = await createSubstitutionRecommendation();
    await expect(approve(recommendationId)).resolves.toEqual({ ok: true });
    const after = await currentState();
    expect(after.slot).toMatchObject({ exerciseId: targetExerciseId });
    expect(after.slot.lineageId).not.toBe(before.slot.lineageId);
    expect(after.prescription).toMatchObject({ targetLoad: null, targetLoadUnit: null });
    expect(await database.db.query.workoutTemplateExercises.findFirst({
      where: eq(workoutTemplateExercises.id, initialSlotId),
    })).toMatchObject({ exerciseId: currentExerciseId });
    expect(await decisionCounts()).toEqual({
      prescriptions: 2,
      versions: 2,
      decisions: 1,
      adaptations: 1,
      audits: 1,
    });
  });

  it("rolls back a substitution when publication is forced to fail", async () => {
    const recommendationId = await createSubstitutionRecommendation();
    await expect(approve(recommendationId, { failureAt: "before-new-version" }))
      .resolves.toMatchObject({ ok: false });
    expect((await currentState()).slot).toMatchObject({ exerciseId: currentExerciseId });
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, recommendationId),
    })).toMatchObject({ status: "pending" });
    await expect(approve(recommendationId)).resolves.toEqual({ ok: true });
  });

  it("rejects a recommendation whose target exercise was removed", async () => {
    const recommendationId = await createSubstitutionRecommendation();
    await database.db.delete(exercises).where(eq(exercises.id, targetExerciseId));
    await expect(approve(recommendationId)).resolves.toMatchObject({ ok: false });
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    expect((await currentState()).slot).toMatchObject({ exerciseId: currentExerciseId });
  });

  it("database rules reject duplicate decision, adaptation, and active target evidence", async () => {
    const recommendationId = await createLoadRecommendation();
    await approve(recommendationId);
    await expect(database.db.insert(userDecisions).values({
      recommendationId,
      decision: "reject",
    })).rejects.toThrow();
    await expect(database.db.insert(adaptationEvents).values({
      userId,
      recommendationId,
      beforeSnapshot: {},
      afterSnapshot: {},
    })).rejects.toThrow();
    const { slot } = await currentState();
    await expect(database.db.insert(exercisePrescriptions).values({
      templateExerciseId: slot.id,
      sets: 3,
      repRangeMin: 6,
      repRangeMax: 8,
      targetLoad: 110,
      targetLoadUnit: "lb",
    })).rejects.toThrow();
  });
});
