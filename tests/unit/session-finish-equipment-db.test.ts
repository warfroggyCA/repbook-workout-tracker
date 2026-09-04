// Finish must not turn incomplete equipment setup into a historical cause.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLogs,
  completedSets,
  equipmentItems,
  exerciseEquipmentRequirements,
  exerciseExecutionRequirements,
  exercises,
  fatigueLogs,
  plateLoadedMachineProfiles,
  progressionJobs,
  sessionExercises,
  sessionNotes,
  sessionOccurrenceMutations,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { completeWorkoutSession } from "@/services/session-lifecycle";
import { resolveSessionEquipmentAvailability } from "@/services/session-equipment-selection";
import { createMigratedTestDatabase, type TestDatabase } from "../helpers/database";

const finishTime = new Date("2026-09-01T13:00:00.000Z");

describe("equipment reasons at workout Finish", () => {
  let database: TestDatabase;
  let userId: string;
  let sessionId: string;
  let equipmentId: string;
  let sessionExerciseId: string;

  const owner = () => ({
    id: userId,
    coachingPrefs: {
      aggressiveness: "conservative" as const,
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    },
  });
  const input = () => ({
    sessionId,
    completionReason: "equipment_unavailable_incompatible" as const,
    note: "Retain this finish note",
    fatigue: 2,
  });
  const finish = () => completeWorkoutSession(
    database.db, owner(), input(), { now: () => finishTime },
  );

  async function addExercise(orderIdx: number) {
    const [exercise] = await database.db.insert(exercises).values({
      name: `Synthetic machine ${orderIdx}`,
      movementPattern: "vertical_pull",
      primaryMuscles: ["back"],
      loadType: "external",
      metricType: "weight_reps",
      loadSemantics: "machine_stack",
    }).returning();
    const [broad] = await database.db.insert(exerciseEquipmentRequirements).values({
      exerciseId: exercise.id,
      equipmentType: "machine",
    }).returning();
    const [exact] = await database.db.insert(exerciseExecutionRequirements).values({
      exerciseId: exercise.id,
      requiredProfileKind: "plate_loaded_machine",
      requiresKnownGeometry: true,
      reviewedAt: finishTime,
    }).returning();
    const [row] = await database.db.insert(sessionExercises).values({
      sessionId,
      exerciseId: exercise.id,
      orderIdx,
      targetSets: 2,
      equipmentRequirementsSemanticsVersion: 1,
      equipmentRequirementsSnapshot: {
        sourceExerciseId: exercise.id,
        broad: [{
          sourceRequirementId: broad.id,
          equipmentType: "machine",
          equipmentDefinition: null,
          minWeight: null,
        }],
        exact: {
          sourceRequirementId: exact.id,
          requiredProfileKind: "plate_loaded_machine",
          requiredEquipmentDefinition: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinition: null,
          requiresKnownGeometry: true,
        },
      },
    }).returning();
    await database.db.insert(sessionOccurrences).values([0, 1].map((ordinal) => ({
      sessionId,
      sessionExerciseId: row.id,
      plannedExerciseId: exercise.id,
      kind: "working_set" as const,
      origin: "planned" as const,
      outcome: "pending" as const,
      sequenceIdx: orderIdx * 2 + ordinal,
      kindOrdinal: ordinal,
    })));
    return row.id;
  }

  async function protectedState() {
    return Promise.all([
      database.db.select().from(workoutSessions),
      database.db.select().from(sessionExercises),
      database.db.select().from(sessionOccurrences),
      database.db.select().from(completedSets),
      database.db.select().from(sessionOccurrenceMutations),
      database.db.select().from(sessionNotes),
      database.db.select().from(fatigueLogs),
      database.db.select().from(progressionJobs),
      database.db.select().from(auditLogs),
    ]);
  }

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db.insert(users).values({
      email: `finish-equipment-${crypto.randomUUID()}@example.com`,
    }).returning();
    await database.db.insert(userProfiles).values({ userId });
    [{ id: sessionId }] = await database.db.insert(workoutSessions).values({
      userId,
      templateName: "Synthetic equipment workout",
      status: "in_progress",
      startedAt: new Date("2026-09-01T12:00:00.000Z"),
      timezone: "America/Toronto",
      localDate: "2026-09-01",
    }).returning();
    [{ id: equipmentId }] = await database.db.insert(equipmentItems).values({
      userId,
      type: "machine",
      label: "Synthetic machine",
      available: false,
    }).returning();
    await database.db.insert(plateLoadedMachineProfiles).values({
      userId,
      equipmentItemId: equipmentId,
      geometryCertainty: "partial",
      startingResistance: 10,
      startingResistanceUnit: "lb",
    });
    sessionExerciseId = await addExercise(0);
  }, 30_000);

  afterEach(async () => database.close());

  it("rejects incomplete geometry without a completion or cause write, and permits another explicit reason", async () => {
    await database.db.update(equipmentItems).set({ available: true })
      .where(eq(equipmentItems.id, equipmentId));
    await expect(resolveSessionEquipmentAvailability(
      database.db, userId, sessionExerciseId,
    )).resolves.toMatchObject({ decisionState: "configuration_incomplete" });
    const before = await protectedState();
    await expect(finish()).resolves.toMatchObject({
      outcome: "equipment_reason_unverified", alreadyFinished: false,
    });
    expect(await protectedState()).toEqual(before);
    await expect(completeWorkoutSession(database.db, owner(), {
      ...input(), completionReason: "time_limit_reached",
    }, { now: () => finishTime })).resolves.toMatchObject({ outcome: "completed" });
  });

  it("accepts verified conflicts across distinct exercises and preserves exact retry after inventory changes", async () => {
    await addExercise(1);
    const [savedSet] = await database.db.insert(completedSets).values({
      sessionExerciseId, setNo: 1, weight: 25, weightUnit: "lb", reps: 8,
      clientKey: crypto.randomUUID(),
    }).returning();
    const [first] = await database.db.select().from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, sessionExerciseId));
    await database.db.update(sessionOccurrences).set({
      outcome: "completed", completedSetId: savedSet.id,
      resolvedAt: finishTime, revision: 1,
    }).where(eq(sessionOccurrences.id, first.id));
    const completedOccurrence = await database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, first.id),
    });
    await expect(finish()).resolves.toMatchObject({ outcome: "completed" });
    const occurrences = await database.db.select().from(sessionOccurrences);
    expect(occurrences).toHaveLength(4);
    for (const occurrence of occurrences) {
      if (occurrence.id === first.id) {
        expect(occurrence).toEqual(completedOccurrence);
        continue;
      }
      expect(occurrence).toMatchObject({
        outcome: "abandoned",
        resolutionReasonCode: "equipment_unavailable_incompatible",
        revision: 1,
      });
    }
    expect(await database.db.select().from(completedSets)).toEqual([savedSet]);
    const saved = await protectedState();
    await database.db.update(equipmentItems).set({ available: true })
      .where(eq(equipmentItems.id, equipmentId));
    await expect(finish()).resolves.toMatchObject({ outcome: "already_finished" });
    await expect(completeWorkoutSession(database.db, owner(), {
      ...input(), note: "Different retained note",
    }, { now: () => finishTime })).resolves.toMatchObject({
      outcome: "finish_payload_conflict",
    });
    expect(await protectedState()).toEqual(saved);
  });

  it.each(["planned", "ad_hoc"] as const)(
    "rejects an unanchored %s pending item instead of assigning it another exercise's cause",
    async (origin) => {
      await database.db.insert(sessionOccurrences).values({
        sessionId, kind: "day_warmup", origin, sequenceIdx: 100,
        kindOrdinal: 0, outcome: "pending", label: "General preparation",
      });
      const before = await protectedState();
      await expect(finish()).resolves.toMatchObject({
        outcome: "equipment_reason_unverified",
      });
      expect(await protectedState()).toEqual(before);
    },
  );

  it("rejects inventory changed after preflight without writing any completion evidence", async () => {
    let before: Awaited<ReturnType<typeof protectedState>>;
    const result = await completeWorkoutSession(database.db, owner(), input(), {
      now: () => finishTime,
      checkpoint: async (boundary) => {
        if (boundary !== "before-completion-statement") return;
        await database.db.update(equipmentItems).set({ label: "Changed inventory" })
          .where(eq(equipmentItems.id, equipmentId));
        before = await protectedState();
      },
    });
    expect(result).toMatchObject({ outcome: "equipment_reason_unverified" });
    expect(await protectedState()).toEqual(before!);
  });

  it("rejects pending work added after preflight", async () => {
    let before: Awaited<ReturnType<typeof protectedState>>;
    const result = await completeWorkoutSession(database.db, owner(), input(), {
      now: () => finishTime,
      checkpoint: async (boundary) => {
        if (boundary !== "before-completion-statement") return;
        await addExercise(1);
        before = await protectedState();
      },
    });
    expect(result).toMatchObject({ outcome: "equipment_reason_unverified" });
    expect(await protectedState()).toEqual(before!);
  });

  it("does not let another owner's equipment or session supply the cause", async () => {
    const [other] = await database.db.insert(users).values({
      email: `other-finish-${crypto.randomUUID()}@example.com`,
    }).returning();
    const before = await protectedState();
    await expect(completeWorkoutSession(database.db, {
      ...owner(), id: other.id,
    }, input(), { now: () => finishTime })).rejects.toThrow("Session not found");
    expect(await protectedState()).toEqual(before);
  });
});
