import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  completedSets,
  equipmentItems,
  exerciseEquipmentRequirements,
  exerciseExecutionRequirements,
  exercises,
  plateLoadedMachineProfiles,
  recordVersions,
  sessionExercises,
  sessionOccurrenceMutations,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { createMigratedTestDatabase, type TestDatabase } from "../helpers/database";
import type { Db } from "@/db";
import { buildJsonBackup, buildSetsCsv } from "@/services/export";
import { buildCoachingContext } from "@/services/coaching";
import { getHistoryReport } from "@/services/history-report";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";
import { resolveSessionEquipmentAvailability } from "@/services/session-equipment-selection";

const actionContext = vi.hoisted(() => ({
  database: null as TestDatabase["db"] | null,
  user: null as {
    id: string;
    profile: {
      unit: "lb";
      timezone: "America/Toronto";
      coachingPrefs: Record<string, never>;
    };
  } | null,
}));

vi.mock("@/db", () => ({
  getDb: vi.fn(async () => {
    if (!actionContext.database) throw new Error("Test database is missing");
    return actionContext.database;
  }),
}));

vi.mock("@/lib/user", () => ({
  getCurrentUser: vi.fn(async () => {
    if (!actionContext.user) throw new Error("Test user is missing");
    return actionContext.user;
  }),
}));

vi.mock("@/lib/user-id-cache", () => ({
  getCurrentUserIdFast: vi.fn(async () => {
    if (!actionContext.user) throw new Error("Test user is missing");
    return actionContext.user.id;
  }),
  refreshCurrentUserIdFast: vi.fn(async () => {
    if (!actionContext.user) throw new Error("Test user is missing");
    return actionContext.user.id;
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));

import {
  confirmExerciseUnskipped,
  correctAcknowledgedSet,
  correctWorkoutActiveDuration,
  mutateOccurrence,
  replaceExercise,
  skipExercise,
} from "@/app/actions/sessions";

describe("session action named results", () => {
  let database: TestDatabase;
  let ownerId: string;
  let otherUserId: string;
  let activeExerciseId: string;
  let completedSessionId: string;
  let completedExerciseId: string;
  let activeSetId: string;
  let completedSetId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    actionContext.database = database.db;
    [{ id: ownerId }, { id: otherUserId }] = await database.db
      .insert(users)
      .values([
        { email: `action-owner-${crypto.randomUUID()}@example.com` },
        { email: `action-other-${crypto.randomUUID()}@example.com` },
      ])
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values([
      { userId: ownerId },
      { userId: otherUserId },
    ]);
    actionContext.user = {
      id: ownerId,
      profile: {
        unit: "lb",
        timezone: "America/Toronto",
        coachingPrefs: {},
      },
    };

    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Action Result Press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "dumbbell",
        metricType: "weight_reps",
        loadSemantics: "per_implement",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    const [activeSession, completedSession, otherSession] = await database.db
      .insert(workoutSessions)
      .values([
        {
          userId: ownerId,
          templateName: "Active action workout",
          status: "in_progress",
          startedAt: new Date("2026-07-18T12:00:00.000Z"),
          timezone: "America/Toronto",
          localDate: "2026-07-18",
        },
        {
          userId: ownerId,
          templateName: "Completed action workout",
          status: "completed",
          startedAt: new Date("2026-07-17T12:00:00.000Z"),
          finishedAt: new Date("2026-07-17T13:00:00.000Z"),
          timezone: "America/Toronto",
          localDate: "2026-07-17",
        },
        {
          userId: otherUserId,
          templateName: "Other owner workout",
          status: "in_progress",
          startedAt: new Date("2026-07-16T12:00:00.000Z"),
          timezone: "America/Toronto",
          localDate: "2026-07-16",
        },
      ])
      .returning({ id: workoutSessions.id });
    const insertedExercises = await database.db
      .insert(sessionExercises)
      .values([
        {
          sessionId: activeSession.id,
          exerciseId: exercise.id,
          prescribedSemanticsVersion: 1,
          prescribedExerciseName: "Action Result Press",
          prescribedMetricType: "weight_reps",
          prescribedLoadType: "dumbbell",
          prescribedLoadSemantics: "per_implement",
          orderIdx: 0,
        },
        {
          sessionId: completedSession.id,
          exerciseId: exercise.id,
          prescribedSemanticsVersion: 1,
          prescribedExerciseName: "Action Result Press",
          prescribedMetricType: "weight_reps",
          prescribedLoadType: "dumbbell",
          prescribedLoadSemantics: "per_implement",
          orderIdx: 0,
        },
        {
          sessionId: otherSession.id,
          exerciseId: exercise.id,
          prescribedSemanticsVersion: 1,
          prescribedExerciseName: "Action Result Press",
          prescribedMetricType: "weight_reps",
          prescribedLoadType: "dumbbell",
          prescribedLoadSemantics: "per_implement",
          orderIdx: 0,
        },
      ])
      .returning({ id: sessionExercises.id });
    activeExerciseId = insertedExercises[0].id;
    completedSessionId = completedSession.id;
    completedExerciseId = insertedExercises[1].id;
    const [activeSet, completedSet] = await database.db
      .insert(completedSets)
      .values([
        {
          sessionExerciseId: activeExerciseId,
          setNo: 1,
          weight: 40,
          weightUnit: "lb",
          reps: 8,
          metricType: "weight_reps",
          performedSemanticsVersion: 1,
          performedLoadType: "dumbbell",
          performedLoadSemantics: "per_implement",
          clientKey: `active-${crypto.randomUUID()}`,
        },
        {
          sessionExerciseId: completedExerciseId,
          setNo: 1,
          weight: 45,
          weightUnit: "lb",
          reps: 8,
          metricType: "weight_reps",
          performedSemanticsVersion: 1,
          performedLoadType: "dumbbell",
          performedLoadSemantics: "per_implement",
          clientKey: `completed-${crypto.randomUUID()}`,
        },
      ])
      .returning({ id: completedSets.id });
    activeSetId = activeSet.id;
    completedSetId = completedSet.id;
    await database.db.insert(sessionOccurrences).values([
      {
        sessionId: activeSession.id,
        sessionExerciseId: activeExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
        outcome: "completed",
        revision: 1,
        resolvedAt: new Date("2026-07-18T12:15:00.000Z"),
        completedSetId: activeSetId,
      },
      {
        sessionId: completedSession.id,
        sessionExerciseId: completedExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
        outcome: "completed",
        revision: 1,
        resolvedAt: new Date("2026-07-17T12:15:00.000Z"),
        completedSetId,
      },
    ]);
  }, 30_000);

  afterEach(async () => {
    actionContext.database = null;
    actionContext.user = null;
    await database.close();
  });

  it("returns a named failure instead of throwing for a completed workout", async () => {
    await expect(
      skipExercise({
        sessionExerciseId: completedExerciseId,
        reason: "time",
        expectedHistoryRevision: 0,
      })
    ).resolves.toEqual({
      ok: false,
      code: "not_active",
      message: "Only an active workout can be changed.",
    });
  });

  it("returns the same named failure when the exercise belongs to another owner", async () => {
    const rows = await database.db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
      .where(eq(workoutSessions.userId, otherUserId));
    expect(rows[0]).toBeTruthy();
    await expect(
      skipExercise({
        sessionExerciseId: rows[0].id,
        reason: "time",
        expectedHistoryRevision: 0,
      })
    ).resolves.toMatchObject({ ok: false, code: "not_active" });
  });

  it("rejects an equipment skip when exact saved machine geometry is incomplete", async () => {
    const active = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { sessionId: true },
    });
    if (!active) throw new Error("Missing active exercise fixture");
    const [machineExercise] = await database.db
      .insert(exercises)
      .values({
        name: `Incomplete geometry pulldown ${crypto.randomUUID()}`,
        movementPattern: "vertical_pull",
        primaryMuscles: ["back"],
        loadType: "external",
        metricType: "weight_reps",
        loadSemantics: "machine_stack",
      })
      .returning({ id: exercises.id });
    const [broadRequirement] = await database.db
      .insert(exerciseEquipmentRequirements)
      .values({
        exerciseId: machineExercise.id,
        equipmentType: "machine",
      })
      .returning({ id: exerciseEquipmentRequirements.id });
    const [exactRequirement] = await database.db
      .insert(exerciseExecutionRequirements)
      .values({
        exerciseId: machineExercise.id,
        requiredProfileKind: "plate_loaded_machine",
        requiresKnownGeometry: true,
        reviewedAt: new Date("2026-09-04T12:00:00.000Z"),
      })
      .returning({ id: exerciseExecutionRequirements.id });
    const [machine] = await database.db
      .insert(equipmentItems)
      .values({
        userId: ownerId,
        type: "machine",
        label: "Garage lat pulldown",
        available: false,
      })
      .returning({ id: equipmentItems.id });
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: active.sessionId,
        exerciseId: machineExercise.id,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: "Incomplete geometry pulldown",
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "external",
        prescribedLoadSemantics: "machine_stack",
        equipmentRequirementsSemanticsVersion: 1,
        equipmentRequirementsSnapshot: {
          sourceExerciseId: machineExercise.id,
          broad: [{
            sourceRequirementId: broadRequirement.id,
            equipmentType: "machine",
            equipmentDefinition: null,
            minWeight: null,
          }],
          exact: {
            sourceRequirementId: exactRequirement.id,
            requiredProfileKind: "plate_loaded_machine",
            requiredEquipmentDefinition: null,
            requiredAttachmentKind: null,
            requiredAttachmentDefinition: null,
            requiresKnownGeometry: true,
          },
        },
        orderIdx: 3,
      })
      .returning({ id: sessionExercises.id });
    const [occurrence] = await database.db
      .insert(sessionOccurrences)
      .values({
        sessionId: active.sessionId,
        sessionExerciseId: sessionExercise.id,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 99,
        kindOrdinal: 0,
        plannedExerciseId: machineExercise.id,
        outcome: "pending",
        revision: 0,
      })
      .returning({ id: sessionOccurrences.id });
    const racedClientKey = crypto.randomUUID();
    let equipmentExecuteCount = 0;
    const racingDb = {
      execute: async (...args: Parameters<Db["execute"]>) => {
        equipmentExecuteCount += 1;
        const result = await database.db.execute(...args);
        if (equipmentExecuteCount === 7) {
          await database.db
            .update(equipmentItems)
            .set({ label: "Changed after occurrence equipment preflight" })
            .where(eq(equipmentItems.id, machine.id));
        }
        return result;
      },
    } as unknown as TestDatabase["db"];
    actionContext.database = racingDb;
    await expect(mutateOccurrence({
      occurrenceId: occurrence.id,
      clientKey: racedClientKey,
      expectedRevision: 0,
      operation: "skip",
      reason: "equipment_unavailable_incompatible",
      reasonCode: "equipment_unavailable_incompatible",
      note: null,
    })).resolves.toEqual({ outcome: "equipment_source_conflict" });
    actionContext.database = database.db;
    await expect(database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, occurrence.id),
      columns: { outcome: true, revision: true },
    })).resolves.toEqual({ outcome: "pending", revision: 0 });
    await expect(database.db.query.sessionOccurrenceMutations.findMany({
      where: eq(sessionOccurrenceMutations.clientKey, racedClientKey),
    })).resolves.toHaveLength(0);

    const appliedClientKey = crypto.randomUUID();
    await expect(mutateOccurrence({
      occurrenceId: occurrence.id,
      clientKey: appliedClientKey,
      expectedRevision: 0,
      operation: "skip",
      reason: "equipment_unavailable_incompatible",
      reasonCode: "equipment_unavailable_incompatible",
      note: null,
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: {
        state: "skipped",
        resolutionReasonCode: "equipment_unavailable_incompatible",
        revision: 1,
      },
    });
    await expect(mutateOccurrence({
      occurrenceId: occurrence.id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 1,
      operation: "restore",
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: {
        state: "pending",
        resolutionReasonCode: null,
        revision: 2,
      },
    });
    const queuedClientKey = crypto.randomUUID();
    const queuedOccurrenceSkip = {
      occurrenceId: occurrence.id,
      clientKey: queuedClientKey,
      expectedRevision: 2,
      operation: "skip" as const,
      reason: "equipment_unavailable_incompatible",
      reasonCode: "equipment_unavailable_incompatible" as const,
      note: null,
    };

    await expect(
      resolveSessionEquipmentAvailability(
        database.db,
        ownerId,
        sessionExercise.id,
      ),
    ).resolves.toMatchObject({ decisionState: "unavailable" });
    await database.db
      .update(equipmentItems)
      .set({ available: true })
      .where(eq(equipmentItems.id, machine.id));
    await database.db.insert(plateLoadedMachineProfiles).values({
      userId: ownerId,
      equipmentItemId: machine.id,
      geometryCertainty: "partial",
      startingResistance: 10,
      startingResistanceUnit: "lb",
    });
    await expect(
      resolveSessionEquipmentAvailability(
        database.db,
        ownerId,
        sessionExercise.id,
      ),
    ).resolves.toMatchObject({ decisionState: "configuration_incomplete" });
    await expect(skipExercise({
      sessionExerciseId: sessionExercise.id,
      reason: "equipment_unavailable_incompatible",
      expectedHistoryRevision: 0,
    })).resolves.toEqual({
      ok: false,
      code: "equipment_reason_unverified",
      message:
        "Repbook could not verify an unavailable or incompatible equipment state. Review the current setup before skipping this exercise.",
    });
    await expect(mutateOccurrence({
      ...queuedOccurrenceSkip,
      clientKey: appliedClientKey,
      expectedRevision: 0,
    })).resolves.toMatchObject({
      outcome: "replayed",
      occurrence: {
        state: "pending",
        resolutionReasonCode: null,
        revision: 2,
      },
    });
    await expect(mutateOccurrence(queuedOccurrenceSkip)).resolves.toEqual({
      outcome: "equipment_reason_unverified",
    });
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, sessionExercise.id),
      columns: { modificationType: true, skipReason: true },
    })).resolves.toEqual({
      modificationType: "as_planned",
      skipReason: null,
    });
    await expect(database.db.query.recordVersions.findMany({
      where: eq(recordVersions.entityId, sessionExercise.id),
    })).resolves.toHaveLength(0);
    await expect(database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, occurrence.id),
      columns: {
        outcome: true,
        outcomeReason: true,
        resolutionReasonCode: true,
        revision: true,
      },
    })).resolves.toEqual({
      outcome: "pending",
      outcomeReason: null,
      resolutionReasonCode: null,
      revision: 2,
    });
    await expect(database.db.query.sessionOccurrenceMutations.findMany({
      where: and(
        eq(sessionOccurrenceMutations.occurrenceId, occurrence.id),
        eq(sessionOccurrenceMutations.clientKey, queuedClientKey),
      ),
    })).resolves.toHaveLength(0);
  });

  it("replays a committed equipment replacement before revalidating its new exercise", async () => {
    const active = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { sessionId: true },
    });
    if (!active) throw new Error("Missing active exercise fixture");
    const [source, target] = await database.db
      .insert(exercises)
      .values([
        {
          name: `Action Result Barbell Press ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "barbell",
          metricType: "weight_reps",
          loadSemantics: "total",
          variantAttributes: { assistance: "none" },
        },
        {
          name: `Action Result Push-Up ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
          variantAttributes: { assistance: "none" },
        },
      ])
      .returning({ id: exercises.id });
    const [replacementSource] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: active.sessionId,
        exerciseId: source.id,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: "Action Result Barbell Press",
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        orderIdx: 1,
      })
      .returning({ id: sessionExercises.id });
    await createTotalSystemTestSnapshot(database.db, {
      userId: ownerId,
      sessionId: active.sessionId,
      sessionExerciseId: replacementSource.id,
      unit: "lb",
    });
    await database.db
      .update(equipmentItems)
      .set({ available: false })
      .where(eq(equipmentItems.userId, ownerId));
    const clientMutationId = crypto.randomUUID();
    const request = {
      sessionExerciseId: replacementSource.id,
      expectedExerciseId: source.id,
      newExerciseId: target.id,
      reason: "equipment_unavailable_incompatible" as const,
      clientMutationId,
    };

    const first = await replaceExercise(request);
    if (!first.ok) {
      throw new Error(`${first.code}: ${first.message}`);
    }
    expect(first).toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      versionId: clientMutationId,
    });
    await expect(replaceExercise(request)).resolves.toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
      versionId: clientMutationId,
    });
    await expect(replaceExercise({
      ...request,
      reason: "other",
    })).resolves.toMatchObject({
      ok: false,
      code: "replacement_key_conflict",
    });
    expect(await database.db.query.recordVersions.findMany()).toHaveLength(1);
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, replacementSource.id),
      columns: { exerciseId: true, substitutionReason: true },
    })).resolves.toEqual({
      exerciseId: target.id,
      substitutionReason: "equipment_unavailable_incompatible",
    });
  });

  it("rejects a forced equipment replacement that has only a broad machine match", async () => {
    const active = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { sessionId: true },
    });
    if (!active) throw new Error("Missing active exercise fixture");
    const [source, target] = await database.db
      .insert(exercises)
      .values([
        {
          name: `Unavailable source press ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "barbell",
          metricType: "weight_reps",
          loadSemantics: "total",
        },
        {
          name: `Plate-Loaded Lat Pulldown ${crypto.randomUUID()}`,
          movementPattern: "vertical_pull",
          primaryMuscles: ["back"],
          loadType: "external",
          metricType: "weight_reps",
          loadSemantics: "machine_stack",
        },
      ])
      .returning({ id: exercises.id });
    await database.db.insert(exerciseEquipmentRequirements).values({
      exerciseId: target.id,
      equipmentType: "machine",
    });
    await database.db.insert(exerciseExecutionRequirements).values({
      exerciseId: target.id,
      requiredProfileKind: "plate_loaded_machine",
      requiresKnownGeometry: true,
      reviewedAt: new Date("2026-09-03T12:00:00.000Z"),
    });
    const [{ id: replacementSourceId }] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: active.sessionId,
        exerciseId: source.id,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: "Unavailable source press",
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        orderIdx: 2,
      })
      .returning({ id: sessionExercises.id });
    await createTotalSystemTestSnapshot(database.db, {
      userId: ownerId,
      sessionId: active.sessionId,
      sessionExerciseId: replacementSourceId,
      unit: "lb",
    });
    await database.db
      .update(equipmentItems)
      .set({ available: false })
      .where(eq(equipmentItems.userId, ownerId));
    await database.db.insert(equipmentItems).values({
      userId: ownerId,
      type: "machine",
      label: "Generic machine without reviewed geometry",
      available: true,
    });

    await expect(replaceExercise({
      sessionExerciseId: replacementSourceId,
      expectedExerciseId: source.id,
      newExerciseId: target.id,
      reason: "equipment_unavailable_incompatible",
      clientMutationId: crypto.randomUUID(),
    })).resolves.toEqual({
      ok: false,
      code: "replacement_unavailable",
      message:
        "Needs a compatible plate-loaded machine with confirmed geometry.",
    });
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, replacementSourceId),
      columns: { exerciseId: true, modificationType: true },
    })).resolves.toEqual({
      exerciseId: source.id,
      modificationType: "as_planned",
    });
    expect(await database.db.query.recordVersions.findMany()).toHaveLength(0);
  });

  it("rejects a delayed skip after a newer return-to-workout fence", async () => {
    await expect(confirmExerciseUnskipped({
      sessionExerciseId: activeExerciseId,
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: true, historyRevision: 1 });

    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "equipment",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: false, code: "skip_stale" });

    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { modificationType: true, skipReason: true },
    })).resolves.toEqual({
      modificationType: "as_planned",
      skipReason: null,
    });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.userId, ownerId),
      columns: { historyRevision: true },
      orderBy: (session, { desc }) => desc(session.startedAt),
    })).resolves.toEqual({ historyRevision: 1 });
  });

  it("rejects a stale replay after the original skip fence wins", async () => {
    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "equipment",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: true, historyRevision: 1 });

    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "equipment",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: false, code: "skip_stale" });

    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { modificationType: true, skipReason: true },
    })).resolves.toEqual({
      modificationType: "skipped",
      skipReason: "equipment",
    });
  });

  it("restores a workout-added exercise as workout-only after remove and Undo", async () => {
    await database.db
      .update(sessionExercises)
      .set({ modificationType: "added" })
      .where(eq(sessionExercises.id, activeExerciseId));

    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "user_choice",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: true, historyRevision: 1 });
    await expect(confirmExerciseUnskipped({
      sessionExerciseId: activeExerciseId,
      expectedHistoryRevision: 1,
    })).resolves.toMatchObject({
      ok: true,
      historyRevision: 2,
      modificationType: "added",
    });
    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { modificationType: true, skipReason: true },
    })).resolves.toEqual({
      modificationType: "added",
      skipReason: null,
    });
  });

  it("rejects a delayed un-skip after a newer skip choice wins", async () => {
    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "equipment",
      expectedHistoryRevision: 0,
    })).resolves.toMatchObject({ ok: true, historyRevision: 1 });
    await expect(skipExercise({
      sessionExerciseId: activeExerciseId,
      reason: "pain",
      expectedHistoryRevision: 1,
    })).resolves.toMatchObject({ ok: true, historyRevision: 2 });

    await expect(confirmExerciseUnskipped({
      sessionExerciseId: activeExerciseId,
      expectedHistoryRevision: 1,
    })).resolves.toMatchObject({ ok: false, code: "unskip_stale" });

    await expect(database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, activeExerciseId),
      columns: { modificationType: true, skipReason: true },
    })).resolves.toEqual({
      modificationType: "skipped",
      skipReason: "pain",
    });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.userId, ownerId),
      columns: { historyRevision: true },
      orderBy: (session, { desc }) => desc(session.startedAt),
    })).resolves.toEqual({ historyRevision: 2 });
  });

  it("routes a date-only reviewed active-duration correction through the owner action", async () => {
    await database.db.update(workoutSessions).set({
      finishedAt: null,
      performedTimePrecision: "date_only",
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: ["unknown_time"],
    }).where(eq(workoutSessions.id, completedSessionId));

    await expect(correctWorkoutActiveDuration({
      sessionId: completedSessionId,
      clientMutationId: crypto.randomUUID(),
      expectedHistoryRevision: 0,
      expected: {
        activeDurationSemanticsVersion: 1,
        activeDurationSeconds: 2_700,
        activeDurationBasis: "owner_reported",
      },
      decision: { basis: "interruption_unknown" },
    })).resolves.toMatchObject({
      ok: true,
      outcome: "corrected",
      sessionId: completedSessionId,
      historyRevision: 1,
    });
    await expect(database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, completedSessionId),
    })).resolves.toMatchObject({
      finishedAt: null,
      performedTimePrecision: "date_only",
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
      excludeDurationFromAnalytics: true,
      historyRevision: 1,
    });
  });

  it("corrects an acknowledged active-workout set only after review", async () => {
    await expect(correctAcknowledgedSet({
      setId: activeSetId,
      values: {
        weight: 40,
        weightUnit: "lb",
        reps: 10,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      expected: {
        weight: 40,
        weightUnit: "lb",
        reps: 8,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      expectedHistoryRevision: 0,
      clientMutationId: crypto.randomUUID(),
      category: "measurement_entry",
      reasonNote: null,
      source: "active_workout",
      reviewed: true,
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      historyRevision: 1,
    });
    const [saved] = await database.db
      .select({ reps: completedSets.reps })
      .from(completedSets)
      .where(eq(completedSets.id, activeSetId));
    expect(saved.reps).toBe(10);
  });

  it("corrects only a reviewed completed working set and records immutable evidence", async () => {
    const expected = {
      weight: 45,
      weightUnit: "lb" as const,
      reps: 8,
      distanceKm: null,
      durationSeconds: null,
      rpe: null,
      note: null,
    };
    await expect(correctAcknowledgedSet({
      setId: completedSetId,
      values: {
        weight: 47.5,
        weightUnit: "lb",
        reps: 9,
        distanceKm: null,
        durationSeconds: null,
        rpe: 8.5,
        note: "Reviewed after the workout",
      },
      expected,
      expectedHistoryRevision: 0,
      clientMutationId: crypto.randomUUID(),
      category: "measurement_entry",
      reasonNote: "Checked the training log",
      source: "workout_history",
      reviewed: true,
    })).resolves.toMatchObject({ ok: true, changed: true });

    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, completedSetId),
        columns: { weight: true, reps: true, rpe: true, note: true },
      }),
    ).toEqual({
      weight: 47.5,
      reps: 9,
      rpe: 8.5,
      note: "Reviewed after the workout",
    });
    expect(await database.db.query.recordVersions.findMany()).toEqual([
      expect.objectContaining({
        entityType: "completed_set",
        entityId: completedSetId,
        action: "set.completed_correction",
      }),
    ]);

    const [csv, backup, coachContext, history] = await Promise.all([
      buildSetsCsv(database.db, ownerId, null),
      buildJsonBackup(database.db, ownerId),
      buildCoachingContext(
        database.db,
        ownerId,
        {
          aggressiveness: "conservative",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: false,
        },
        new Date("2026-07-22T12:00:00.000Z"),
      ),
      getHistoryReport(
        database.db,
        ownerId,
        "all",
        3,
        new Date("2026-07-22T12:00:00.000Z"),
      ),
    ]);
    expect(csv).toContain("47.5");
    expect(csv).toContain("Reviewed after the workout");
    expect(JSON.stringify(backup.canonical)).toContain("set.completed_correction");
    expect(JSON.stringify(backup.canonical)).toContain("Reviewed after the workout");
    expect(JSON.stringify(coachContext.trainingDigest)).toContain("47.5");
    expect(JSON.stringify(coachContext.trainingDigest)).toContain(
      "exclude from conclusions",
    );
    expect(coachContext.trainingDigest.dataGaps).toContain(
      "1 set metric has limited calculation eligibility and is preserved but excluded from unsupported conclusions."
    );
    expect(history.overview.semanticExclusions).toContainEqual({
      reason: "per_implement_not_aggregatable",
      count: 1,
    });

    await expect(correctAcknowledgedSet({
      setId: completedSetId,
      values: {
        weight: 50,
        weightUnit: "lb",
        reps: 10,
        distanceKm: null,
        durationSeconds: null,
        rpe: 9,
        note: null,
      },
      expected,
      expectedHistoryRevision: 0,
      clientMutationId: crypto.randomUUID(),
      category: "measurement_entry",
      reasonNote: null,
      source: "workout_history",
      reviewed: true,
    })).resolves.toMatchObject({
      ok: false,
      code: "correction_rejected",
    });
    expect(await database.db.query.recordVersions.findMany()).toHaveLength(1);
  });

  it("rejects a stale correction surface when the workout phase changed", async () => {
    await expect(correctAcknowledgedSet({
      setId: activeSetId,
      values: {
        weight: 40,
        weightUnit: "lb",
        reps: 9,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      expected: {
        weight: 40,
        weightUnit: "lb",
        reps: 8,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      expectedHistoryRevision: 0,
      clientMutationId: crypto.randomUUID(),
      category: "measurement_entry",
      reasonNote: null,
      source: "workout_history",
      reviewed: true,
    })).resolves.toMatchObject({ ok: false, code: "correction_stale_context" });
    expect(await database.db.query.recordVersions.findMany()).toHaveLength(0);
  });
});
