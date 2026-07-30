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
  rejectRecommendationDecision,
  type RecommendationCheckpoint,
} from "@/services/recommendation-decisions";
import { publishRecommendationProgramVersion } from "@/services/program-publication";
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
    return { program, slot, prescription };
  }

  async function createRecommendation(
    payload: RecommendationPayload,
    evidence: {
      signals: Record<string, unknown>;
      sessionIds?: string[];
      setIds?: string[];
    } = { signals: {} },
  ) {
    const { slot } = await currentState();
    const [recommendation] = await database.db.insert(recommendations).values({
      userId,
      source: "rule",
      ruleId: "double_progression",
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
    const { slot, prescription } = await currentState();
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
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

  async function createSubstitutionRecommendation(targetId = targetExerciseId) {
    const { slot } = await currentState();
    return createRecommendation({
      kind: "substitution",
      templateExerciseId: slot.id,
      fromExerciseId: slot.exerciseId,
      toExerciseId: targetId,
    });
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

  it("rejects a stale load baseline and a recent same-pattern pain increase", async () => {
    const staleId = await createLoadRecommendation({ fromLoad: 90 });
    await expect(approve(staleId)).resolves.toMatchObject({ ok: false });

    const painId = await createLoadRecommendation();
    await database.db.insert(painLogs).values({
      userId,
      exerciseId: currentExerciseId,
      bodyPart: "knee",
      severity: 3,
      source: "set_flag",
    });
    await expect(approve(painId)).resolves.toMatchObject({ ok: false });
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    expect((await currentState()).prescription.targetLoad).toBe(100);
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
