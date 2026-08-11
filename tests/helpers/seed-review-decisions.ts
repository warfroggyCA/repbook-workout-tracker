import { eq, inArray, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  adaptationEvents,
  barbellConfigs,
  coachingInsights,
  completedSets,
  equipmentItems,
  exercisePrescriptions,
  exercises,
  painLogs,
  plateInventory,
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
import { workoutLocalDate } from "@/lib/workout-calendar";
import { getReviewDecisionData } from "@/services/review-decisions";
import { mutateSessionEquipmentSelection } from "@/services/session-equipment-selection";
import {
  PROGRESSION_REVIEW_SOURCE_VERSION,
  withRecommendationReviewEvidence,
} from "@/lib/review-evidence";
import { PAIN_EVIDENCE_ALGORITHM_VERSION } from "@/lib/pain-evidence";
import { saveExerciseEquipmentFitAssertion } from "@/services/exercise-equipment-fit-management";
import { sessionEquipmentRequirementsSnapshotExpression } from "@/services/session-equipment-requirements";
import { sessionEquipmentRequirementsSnapshotSchema } from "@/lib/session-equipment-requirements";

export const REVIEW_DECISIONS_EMAIL = "review-decisions.e2e@example.com";

function daysAgo(days: number, hour = 14) {
  const value = new Date();
  value.setUTCHours(hour, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() - days);
  return value;
}

async function main() {
  if (!process.env.PGLITE_DIR || process.env.DATABASE_URL) {
    throw new Error(
      "Review decision fixtures require the disposable local PGlite harness."
    );
  }

  const db = await getDb();
  const existing = await db.query.users.findFirst({
    where: eq(users.email, REVIEW_DECISIONS_EMAIL),
    columns: { id: true },
  });
  if (existing) throw new Error("The Review decision fixture was already seeded.");

  const seededExercises = await db.query.exercises.findMany({
    where: inArray(exercises.name, ["Barbell Back Squat", "Barbell Bench Press"]),
  });
  const squat = seededExercises.find(
    (exercise) => exercise.name === "Barbell Back Squat"
  );
  const bench = seededExercises.find(
    (exercise) => exercise.name === "Barbell Bench Press"
  );
  if (!squat || !bench) {
    throw new Error("The Review decision exercises were not seeded.");
  }

  const localDb = db as Db & {
    transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  };
  const fixture = await localDb.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: REVIEW_DECISIONS_EMAIL, name: "Review Decisions" })
      .returning({ id: users.id });
    await tx.insert(userProfiles).values({
      userId: user.id,
      setupCompletedAt: new Date(),
      timezone: "America/Toronto",
      unit: "lb",
    });
    const seededEquipment = await tx
      .insert(equipmentItems)
      .values(
        ["barbell", "plates", "rack", "bench"].map((type) => ({
          userId: user.id,
          type: type as "barbell" | "plates" | "rack" | "bench",
          label: `Review ${type}`,
          available: true,
        })),
      )
      .returning({ id: equipmentItems.id, type: equipmentItems.type });
    const barbellItem = seededEquipment.find(
      (equipment) => equipment.type === "barbell",
    );
    if (!barbellItem) {
      throw new Error("The Review decision barbell was not seeded.");
    }
    await tx.insert(barbellConfigs).values({
      userId: user.id,
      barType: "olympic",
      equipmentItemId: barbellItem.id,
      unit: "lb",
      loadingKind: "olympic",
      sharedPlatePoolCompatible: true,
      barWeight: 45,
      collarWeight: 0,
      label: "Review bar",
    });
    await tx.insert(plateInventory).values(
      [45, 25, 10, 5, 2.5].map((denomination) => ({
        userId: user.id,
        denomination,
        quantity: 4,
      }))
    );
    const retainedRequirementRows = resultRows(await tx.execute(sql`
      SELECT
        ${sessionEquipmentRequirementsSnapshotExpression(sql`${squat.id}::uuid`)}
          AS squat_snapshot,
        ${sessionEquipmentRequirementsSnapshotExpression(sql`${bench.id}::uuid`)}
          AS bench_snapshot
    `));
    const retainedRequirements = retainedRequirementRows[0];
    if (!retainedRequirements) {
      throw new Error("The Review decision requirement evidence was not retained.");
    }
    const squatRequirements = sessionEquipmentRequirementsSnapshotSchema.parse(
      retainedRequirements.squat_snapshot,
    );
    const benchRequirements = sessionEquipmentRequirementsSnapshotSchema.parse(
      retainedRequirements.bench_snapshot,
    );
    const equipmentByType = new Map(
      seededEquipment.map((equipment) => [equipment.type, equipment]),
    );
    for (const [exercise, requirements] of [
      [squat, squatRequirements],
      [bench, benchRequirements],
    ] as const) {
      for (const requirement of requirements.broad) {
        if (
          requirement.equipmentType === "bodyweight" ||
          requirement.equipmentType === "plates"
        ) {
          continue;
        }
        const equipment = equipmentByType.get(requirement.equipmentType);
        if (!equipment) {
          throw new Error(
            `The Review decision ${requirement.equipmentType} was not seeded.`,
          );
        }
        const reviewedFit = await saveExerciseEquipmentFitAssertion(
          tx,
          user.id,
          {
            mutationId: crypto.randomUUID(),
            assertionId: null,
            exerciseId: exercise.id,
            equipmentItemId: equipment.id,
            verdict: "compatible",
            reasonCode: "owner_verified",
            reasonNote: "Synthetic Review fixture owner verified this exact setup.",
            expectedRevision: null,
          },
        );
        if (!reviewedFit.ok) {
          throw new Error(
            `The Review decision fit evidence was not retained (${reviewedFit.code}).`,
          );
        }
      }
    }

    const [program] = await tx
      .insert(programs)
      .values({
        userId: user.id,
        name: "Review Program",
        status: "archived",
        archivedAt: new Date(),
      })
      .returning({ id: programs.id });
    const [version] = await tx
      .insert(programVersions)
      .values({ programId: program.id, name: "Review Program" })
      .returning({ id: programVersions.id });
    const [template] = await tx
      .insert(workoutTemplates)
      .values({
        programVersionId: version.id,
        name: "Review Day",
        orderIdx: 0,
      })
      .returning({ id: workoutTemplates.id });
    const [squatSlot, benchSlot] = await tx
      .insert(workoutTemplateExercises)
      .values([
        {
          workoutTemplateId: template.id,
          exerciseId: squat.id,
          orderIdx: 0,
          restSec: 120,
        },
        {
          workoutTemplateId: template.id,
          exerciseId: bench.id,
          orderIdx: 1,
          restSec: 120,
        },
      ])
      .returning({
        id: workoutTemplateExercises.id,
        lineageId: workoutTemplateExercises.lineageId,
        exerciseId: workoutTemplateExercises.exerciseId,
      });
    await tx.insert(exercisePrescriptions).values([
      {
        templateExerciseId: squatSlot.id,
        sets: 3,
        repRangeMin: 6,
        repRangeMax: 8,
        targetLoad: 105,
        targetLoadUnit: "lb",
      },
      {
        templateExerciseId: benchSlot.id,
        sets: 2,
        repRangeMin: 6,
        repRangeMax: 8,
        targetLoad: 85,
        targetLoadUnit: "lb",
      },
    ]);
    await tx
      .update(programs)
      .set({
        status: "active",
        archivedAt: null,
        currentVersionId: version.id,
      })
      .where(eq(programs.id, program.id));

    const sessionDates = [daysAgo(2), daysAgo(1)];
    const sessionRecords: Array<{
      id: string;
      squatExerciseId: string;
      benchExerciseId: string;
      squatSetIds: string[];
      benchSetIds: string[];
    }> = [];
    for (const startedAt of sessionDates) {
      const finishedAt = new Date(startedAt.getTime() + 50 * 60_000);
      const [session] = await tx
        .insert(workoutSessions)
        .values({
          userId: user.id,
          templateId: template.id,
          templateName: "Review Day",
          status: "in_progress",
          timezone: "America/Toronto",
          localDate: workoutLocalDate(startedAt, "America/Toronto"),
          startedAt,
        })
        .returning({ id: workoutSessions.id });
      const [squatOccurrence, benchOccurrence] = await tx
        .insert(sessionExercises)
        .values([
          {
            sessionId: session.id,
            exerciseId: squat.id,
            prescribedSemanticsVersion: 1,
            prescribedExerciseName: squat.name,
            prescribedMetricType: squat.metricType,
            prescribedLoadType: squat.loadType,
            prescribedLoadSemantics: squat.loadSemantics,
            equipmentRequirementsSemanticsVersion: 1,
            equipmentRequirementsSnapshot: squatRequirements,
            plannedFromTemplateExerciseId: squatSlot.id,
            sourceSlotLineageId: squatSlot.lineageId,
            orderIdx: 0,
            targetSets: 3,
            targetRepsMin: 6,
            targetRepsMax: 8,
            targetLoad: 105,
            targetLoadUnit: "lb",
          },
          {
            sessionId: session.id,
            exerciseId: bench.id,
            prescribedSemanticsVersion: 1,
            prescribedExerciseName: bench.name,
            prescribedMetricType: bench.metricType,
            prescribedLoadType: bench.loadType,
            prescribedLoadSemantics: bench.loadSemantics,
            equipmentRequirementsSemanticsVersion: 1,
            equipmentRequirementsSnapshot: benchRequirements,
            plannedFromTemplateExerciseId: benchSlot.id,
            sourceSlotLineageId: benchSlot.lineageId,
            orderIdx: 1,
            targetSets: 2,
            targetRepsMin: 6,
            targetRepsMax: 8,
            targetLoad: 85,
            targetLoadUnit: "lb",
          },
        ])
        .returning({ id: sessionExercises.id, exerciseId: sessionExercises.exerciseId });
      const squatEquipment = await mutateSessionEquipmentSelection(tx, user.id, {
        operation: "select",
        sessionExerciseId: squatOccurrence.id,
        equipmentItemId: barbellItem.id,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: crypto.randomUUID(),
        provenance: "auto_unique",
      });
      const benchEquipment = await mutateSessionEquipmentSelection(tx, user.id, {
        operation: "select",
        sessionExerciseId: benchOccurrence.id,
        equipmentItemId: barbellItem.id,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: crypto.randomUUID(),
        provenance: "auto_unique",
      });
      if (
        !("snapshotId" in squatEquipment) ||
        !squatEquipment.snapshotId ||
        !("snapshotId" in benchEquipment) ||
        !benchEquipment.snapshotId
      ) {
        throw new Error(
          `The Review decision total-system equipment evidence was not created (${JSON.stringify({
            squat: squatEquipment,
            bench: benchEquipment,
          })}).`,
        );
      }
      const squatSets = await tx
        .insert(completedSets)
        .values(
          [7, 8, 8].map((rpe, setIndex) => ({
            sessionExerciseId: squatOccurrence.id,
            setNo: setIndex + 1,
            weight: 105,
            weightUnit: "lb" as const,
            reps: 8,
            metricType: "weight_reps" as const,
            performedSemanticsVersion: 1,
            performedLoadType: squat.loadType,
            performedLoadSemantics: squat.loadSemantics,
            equipmentSnapshotId: squatEquipment.snapshotId,
            loadEntryMeaning: "total_system" as const,
            targetMet: true,
            rpe,
          }))
        )
        .returning({ id: completedSets.id });
      const benchSets = await tx
        .insert(completedSets)
        .values(
          [0, 1].map((setIndex) => ({
            sessionExerciseId: benchOccurrence.id,
            setNo: setIndex + 1,
            weight: 85,
            weightUnit: "lb" as const,
            reps: 8,
            metricType: "weight_reps" as const,
            performedSemanticsVersion: 1,
            performedLoadType: bench.loadType,
            performedLoadSemantics: bench.loadSemantics,
            equipmentSnapshotId: benchEquipment.snapshotId,
            loadEntryMeaning: "total_system" as const,
            targetMet: null,
            rpe: null,
          }))
        )
        .returning({ id: completedSets.id });
      await tx.insert(sessionOccurrences).values([
        ...squatSets.map((set, setIndex) => ({
          sessionId: session.id,
          sessionExerciseId: squatOccurrence.id,
          kind: "working_set" as const,
          origin: "planned" as const,
          sequenceIdx: setIndex,
          kindOrdinal: setIndex,
          plannedExerciseId: squat.id,
          plannedRepsMin: 6,
          plannedRepsMax: 8,
          plannedLoad: 105,
          plannedLoadUnit: "lb" as const,
          plannedRestSec: 120,
          outcome: "completed" as const,
          revision: 1,
          resolvedAt: finishedAt,
          completedSetId: set.id,
          equipmentSnapshotId: squatEquipment.snapshotId,
        })),
        ...benchSets.map((set, setIndex) => ({
          sessionId: session.id,
          sessionExerciseId: benchOccurrence.id,
          kind: "working_set" as const,
          origin: "planned" as const,
          sequenceIdx: squatSets.length + setIndex,
          kindOrdinal: setIndex,
          plannedExerciseId: bench.id,
          plannedRepsMin: 6,
          plannedRepsMax: 8,
          plannedLoad: 85,
          plannedLoadUnit: "lb" as const,
          plannedRestSec: 120,
          outcome: "completed" as const,
          revision: 1,
          resolvedAt: finishedAt,
          completedSetId: set.id,
          equipmentSnapshotId: benchEquipment.snapshotId,
        })),
      ]);
      await tx
        .update(workoutSessions)
        .set({ status: "completed", finishedAt })
        .where(eq(workoutSessions.id, session.id));
      sessionRecords.push({
        id: session.id,
        squatExerciseId: squatOccurrence.id,
        benchExerciseId: benchOccurrence.id,
        squatSetIds: squatSets.map((set) => set.id),
        benchSetIds: benchSets.map((set) => set.id),
      });
    }
    const [pain] = await tx
      .insert(painLogs)
      .values({
        userId: user.id,
        sessionId: sessionRecords[1].id,
        exerciseId: bench.id,
        bodyPart: "shoulder",
        severity: 4,
        note: "Fixture pain evidence",
      })
      .returning({ id: painLogs.id });
    await tx.insert(coachingInsights).values({
      userId: user.id,
      kind: "live_user",
      contentMd: "Shoulder felt tight after the final bench set.",
      dataDigest: {
        sessionId: sessionRecords[1].id,
        sessionExerciseId: sessionRecords[1].benchExerciseId,
        inputMode: "text",
      },
      sessionId: sessionRecords[1].id,
      sessionExerciseId: sessionRecords[1].benchExerciseId,
      author: "user",
      messageKind: "observation",
      inputMode: "text",
      responseStatus: "saved",
      clientKey: "review-decisions-live-observation",
      createdAt: new Date(sessionDates[1].getTime() + 45 * 60_000),
    });

    async function addAccepted(input: {
      exerciseId: string;
      slotId: string;
      lineageId: string;
      payload: RecommendationPayload;
      reason: string;
      appliedAt: Date;
      edited?: boolean;
      undoneAt?: Date;
    }) {
      const [recommendation] = await tx
        .insert(recommendations)
        .values({
          userId: user.id,
          source: "rule",
          status: input.edited ? "edited" : "approved",
          ruleId: "double_progression",
          exerciseId: input.exerciseId,
          sourceTemplateExerciseId: input.slotId,
          sourceSlotLineageId: input.lineageId,
          payload: input.payload,
          reason: input.reason,
          evidence: { signals: {} },
          createdAt: new Date(input.appliedAt.getTime() - 60 * 60_000),
          decidedAt: input.appliedAt,
          reconciledAt: input.appliedAt,
          reconciliationReason:
            "Applied by publishing a new immutable Program version.",
        })
        .returning({ id: recommendations.id });
      await tx.insert(userDecisions).values({
        recommendationId: recommendation.id,
        decision: input.edited ? "edit" : "approve",
        editedPayload: input.edited ? input.payload : null,
        decidedAt: input.appliedAt,
      });
      await tx.insert(adaptationEvents).values({
        userId: user.id,
        recommendationId: recommendation.id,
        beforeSnapshot: { payload: input.payload },
        afterSnapshot: { payload: input.payload },
        appliedAt: input.appliedAt,
        undoneAt: input.undoneAt ?? null,
      });
      return recommendation.id;
    }

    await addAccepted({
      exerciseId: squat.id,
      slotId: squatSlot.id,
      lineageId: squatSlot.lineageId,
      payload: {
        kind: "load_change",
        templateExerciseId: squatSlot.id,
        fromLoad: 100,
        toLoad: 105,
        loadUnit: "lb",
      },
      reason: "Two clean squat workouts supported a cautious increase.",
      appliedAt: daysAgo(4),
    });
    await addAccepted({
      exerciseId: bench.id,
      slotId: benchSlot.id,
      lineageId: benchSlot.lineageId,
      payload: {
        kind: "load_change",
        templateExerciseId: benchSlot.id,
        fromLoad: 80,
        toLoad: 85,
        loadUnit: "lb",
      },
      reason: "Bench target was accepted before the follow-up workouts.",
      appliedAt: daysAgo(4, 15),
    });
    await addAccepted({
      exerciseId: squat.id,
      slotId: squatSlot.id,
      lineageId: squatSlot.lineageId,
      payload: {
        kind: "load_change",
        templateExerciseId: squatSlot.id,
        fromLoad: 95,
        toLoad: 100,
        loadUnit: "lb",
      },
      reason: "An older change was later undone.",
      appliedAt: daysAgo(8),
      undoneAt: daysAgo(7),
    });

    const rejectedAt = daysAgo(3);
    const [rejected] = await tx
      .insert(recommendations)
      .values({
        userId: user.id,
        source: "rule",
        status: "rejected",
        ruleId: "regression",
        exerciseId: squat.id,
        sourceTemplateExerciseId: squatSlot.id,
        sourceSlotLineageId: squatSlot.lineageId,
        payload: {
          kind: "load_change",
          templateExerciseId: squatSlot.id,
          fromLoad: 105,
          toLoad: 100,
          loadUnit: "lb",
        },
        reason: "A small reset had been proposed.",
        evidence: { signals: { hardMissExposures: 2 } },
        createdAt: new Date(rejectedAt.getTime() - 60 * 60_000),
        decidedAt: rejectedAt,
      })
      .returning({ id: recommendations.id });
    await tx.insert(userDecisions).values({
      recommendationId: rejected.id,
      decision: "reject",
      reason: "Keep the current target for one more workout.",
      decidedAt: rejectedAt,
    });

    const expiredAt = daysAgo(2, 12);
    await tx.insert(recommendations).values({
      userId: user.id,
      source: "rule",
      status: "expired",
      ruleId: "double_progression",
      exerciseId: bench.id,
      sourceTemplateExerciseId: benchSlot.id,
      sourceSlotLineageId: benchSlot.lineageId,
      payload: {
        kind: "load_change",
        templateExerciseId: benchSlot.id,
        fromLoad: 75,
        toLoad: 80,
        loadUnit: "lb",
      },
      reason: "An older bench target had been proposed.",
      evidence: { signals: { cleanExposures: 2 } },
      createdAt: daysAgo(6),
      reconciledAt: expiredAt,
      reconciliationReason:
        "The edited Program changed the same target, so the older recommendation expired.",
      reconciledByProgramVersionId: version.id,
    });

    const allSessionIds = sessionRecords.map((session) => session.id);
    const allSquatSetIds = sessionRecords.flatMap((session) => session.squatSetIds);
    const squatPayload: RecommendationPayload = {
      kind: "load_change",
      templateExerciseId: squatSlot.id,
      fromLoad: 105,
      toLoad: 110,
      loadUnit: "lb",
    };
    const benchHoldPayload: RecommendationPayload = {
      kind: "hold",
      templateExerciseId: benchSlot.id,
      reason:
        "A 4/10 pain flag for Barbell Bench Press is keeping the load from going up.",
    };
    const unsupportedPayload: RecommendationPayload = {
      kind: "load_change",
      templateExerciseId: squatSlot.id,
      fromLoad: 105,
      toLoad: 115,
      loadUnit: "lb",
    };
    await tx.insert(recommendations).values([
      {
        userId: user.id,
        source: "rule" as const,
        status: "pending" as const,
        ruleId: "double_progression",
        exerciseId: squat.id,
        sourceTemplateExerciseId: squatSlot.id,
        sourceSlotLineageId: squatSlot.lineageId,
        payload: squatPayload,
        reason:
          "Two completed squat workouts at 105 lb reached the planned work without repeated grinding.",
        evidence: withRecommendationReviewEvidence({
          signals: { cleanExposures: 2, fromLoad: 105, toLoad: 110 },
          sessionIds: allSessionIds,
          setIds: allSquatSetIds,
        }, {
          payload: squatPayload,
          producer: "progression_rules",
          sourceVersion: PROGRESSION_REVIEW_SOURCE_VERSION,
        }),
        createdAt: new Date(),
      },
      {
        userId: user.id,
        source: "rule" as const,
        status: "pending" as const,
        ruleId: "pain_freeze",
        exerciseId: bench.id,
        sourceTemplateExerciseId: benchSlot.id,
        sourceSlotLineageId: benchSlot.lineageId,
        payload: benchHoldPayload,
        reason:
          "A 4/10 pain flag for Barbell Bench Press is keeping the load from going up. The app will check again once there hasn’t been another 3/10-or-higher flag for this exercise for 14 days. A workout with no pain entry doesn’t shorten the wait.",
        evidence: withRecommendationReviewEvidence({
          signals: {
            worstPainSeverity: 4,
            painReports: 1,
            qualifyingPainReports: 1,
            painSessionCount: 1,
            windowDays: 14,
          },
          sessionIds: [sessionRecords[1].id],
          painLogIds: [pain.id],
          setIds: sessionRecords[1].benchSetIds,
        }, {
          payload: benchHoldPayload,
          producer: "pain_consistency",
          sourceVersion: PAIN_EVIDENCE_ALGORITHM_VERSION,
          limitations: [
            "Only explicit cited pain reports were evaluated. Missing pain fields remain unknown.",
            "This deterministic status has no confidence score and never diagnoses an injury.",
          ],
        }),
        createdAt: new Date(Date.now() - 1_000),
      },
      ...(process.env.V2_H05_REVIEW_FIXTURE === "1"
        ? [{
            userId: user.id,
            source: "rule" as const,
            status: "pending" as const,
            ruleId: "retained_unsupported",
            exerciseId: squat.id,
            sourceTemplateExerciseId: squatSlot.id,
            sourceSlotLineageId: squatSlot.lineageId,
            payload: unsupportedPayload,
            reason: "Retained proposal with explicitly unsupported evidence.",
            evidence: withRecommendationReviewEvidence({
              signals: { fromLoad: 105, toLoad: 115 },
              sessionIds: allSessionIds,
              setIds: allSquatSetIds,
            }, {
              payload: unsupportedPayload,
              producer: "progression_rules",
              sourceVersion: PROGRESSION_REVIEW_SOURCE_VERSION,
              quality: "unsupported",
              limitations: [
                "The retained source explicitly marks this proposal unsupported.",
              ],
            }),
            createdAt: new Date(Date.now() - 2_000),
          }]
        : []),
    ]);

    return {
      userId: user.id,
      templateId: template.id,
      sessionIds: allSessionIds,
    };
  });

  const review = await getReviewDecisionData(db, fixture.userId);
  const expectedPending = process.env.V2_H05_REVIEW_FIXTURE === "1" ? 3 : 2;
  if (review.pending.length !== expectedPending) {
    throw new Error(
      `Expected ${expectedPending} pending Review decisions, found ${review.pending.length}.`,
    );
  }

  const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
  await client?.close?.();
  console.log(JSON.stringify(fixture));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
