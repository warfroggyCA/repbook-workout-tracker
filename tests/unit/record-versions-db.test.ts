import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  completedSets,
  exercises,
  healthActivities,
  recordVersions,
  sessionExercises,
  sessionOccurrenceMutations,
  sessionOccurrences,
  users,
  workoutSessions,
} from "@/db/schema";
import { normalizeActivityInput } from "@/services/activities";
import { buildJsonBackup } from "@/services/export";
import {
  restoreRecordVersion,
  updateActivityWithVersion,
  updateSessionExerciseWithVersion,
  updateSetWithVersion,
} from "@/services/record-versions";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("immutable record version history", () => {
  const completedCorrectionEvidence = {
    category: "measurement_entry",
    reasonNote: null,
    source: "workout_history",
  } as const;
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let activityId: string;
  let setId: string;
  let sessionId: string;
  let sessionExerciseId: string;
  let exerciseId: string;
  let alternateExerciseId: string;

  async function removeLoggedSetForFixture() {
    await db.execute(sql`
      WITH authorized AS (
        SELECT set_config(
          'workout_tracker.authorized_delete',
          'snapshot_restore',
          true
        )
      ), removed_occurrence AS (
        DELETE FROM session_occurrences
        WHERE completed_set_id = ${setId}::uuid
          AND EXISTS (SELECT 1 FROM authorized)
        RETURNING id
      )
      DELETE FROM completed_sets
      WHERE id = ${setId}::uuid
        AND EXISTS (SELECT 1 FROM authorized)
        AND (SELECT count(*) FROM removed_occurrence) >= 0
    `);
  }

  const originalActivity = () =>
    normalizeActivityInput(
      {
        activityType: "walk",
        title: "Original walk",
        startedAtISO: "2026-07-01T14:00:00.000Z",
        timezone: "America/Toronto",
        durationMinutes: 40,
        distanceValue: 3.5,
        distanceUnit: "km",
        intensity: "moderate",
        elevationValue: 20,
        elevationUnit: "m",
        averageHeartRateBpm: 112,
        energyKcal: 240,
        notes: "Original activity note",
      },
      new Date("2026-07-03T00:00:00.000Z")
    );

  const editedActivity = () =>
    normalizeActivityInput(
      {
        activityType: "walk",
        title: "Edited walk",
        startedAtISO: "2026-07-01T14:00:00.000Z",
        timezone: "America/Toronto",
        durationMinutes: 45,
        distanceValue: 4,
        distanceUnit: "km",
        intensity: "vigorous",
        elevationValue: 35,
        elevationUnit: "m",
        averageHeartRateBpm: 118,
        energyKcal: 285,
        notes: "Edited activity note",
      },
      new Date("2026-07-03T00:00:00.000Z")
    );

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });

    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `versions-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    const [exercise, alternateExercise] = await db
      .insert(exercises)
      .values([
        {
          name: `Versioned squat ${crypto.randomUUID()}`,
          movementPattern: "squat",
          primaryMuscles: ["quadriceps"],
          loadType: "barbell",
        },
        {
          name: `Versioned goblet squat ${crypto.randomUUID()}`,
          movementPattern: "squat",
          primaryMuscles: ["quadriceps"],
          loadType: "dumbbell",
        },
      ])
      .returning({ id: exercises.id, name: exercises.name });
    exerciseId = exercise.id;
    alternateExerciseId = alternateExercise.id;
    const [session] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Version test workout",
        status: "completed",
        startedAt: new Date("2026-07-02T14:00:00.000Z"),
        finishedAt: new Date("2026-07-02T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-02",
      })
      .returning({ id: workoutSessions.id });
    sessionId = session.id;
    const [sessionExercise] = await db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId: exercise.id,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: exercise.name,
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        targetRepsMin: 5,
        targetLoad: 100,
        targetLoadUnit: "lb",
      })
      .returning({ id: sessionExercises.id });
    sessionExerciseId = sessionExercise.id;
    const equipmentSnapshotId = await createTotalSystemTestSnapshot(db, {
      userId,
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      unit: "lb",
    });
    [{ id: setId }] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        rpe: 8,
        targetMet: true,
        note: "Original set note",
        metricType: "weight_reps",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
        equipmentSnapshotId,
        loadEntryMeaning: "total_system",
      })
      .returning({ id: completedSets.id });
    await db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exercise.id,
      plannedRepsMin: 5,
      plannedRepsMax: 8,
      plannedLoad: 100,
      plannedLoadUnit: "lb",
      outcome: "completed",
      revision: 1,
      resolvedAt: new Date("2026-07-02T14:10:00.000Z"),
      completedSetId: setId,
      equipmentSnapshotId,
    });
    [{ id: activityId }] = await db
      .insert(healthActivities)
      .values({ userId, ...originalActivity() })
      .returning({ id: healthActivities.id });
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("versions meaningful activity edits, ignores identical saves, and restores either state", async () => {
    const edited = await updateActivityWithVersion(
      db,
      userId,
      activityId,
      editedActivity()
    );
    expect(edited).toMatchObject({ ok: true, changed: true });
    if (!edited.ok || !edited.versionId) throw new Error("Missing activity version");

    const [version] = await db.query.recordVersions.findMany({
      where: eq(recordVersions.entityId, activityId),
    });
    expect(version.action).toBe("activity.update");
    expect(version.beforeData).toMatchObject({
      id: activityId,
      title: "Original walk",
      duration_seconds: 2400,
    });
    expect(version.afterData).toMatchObject({
      id: activityId,
      title: "Edited walk",
      duration_seconds: 2700,
    });
    expect(version.changedFields).toEqual(
      expect.arrayContaining(["title", "duration_seconds", "fingerprint"])
    );

    const identical = await updateActivityWithVersion(
      db,
      userId,
      activityId,
      editedActivity()
    );
    expect(identical).toMatchObject({ ok: true, changed: false, versionId: null });
    expect(await db.query.recordVersions.findMany()).toHaveLength(1);

    const rollbackVersionId = crypto.randomUUID();
    const restored = await restoreRecordVersion(db, userId, edited.versionId, {
      clientMutationId: rollbackVersionId,
    });
    expect(restored).toMatchObject({
      ok: true,
      changed: true,
      versionId: rollbackVersionId,
    });
    if (!restored.ok || !restored.versionId) throw new Error("Missing rollback version");
    const activity = await db.query.healthActivities.findFirst({
      where: eq(healthActivities.id, activityId),
    });
    expect(activity).toMatchObject({
      title: "Original walk",
      durationSeconds: 2400,
      notes: "Original activity note",
    });
    const versions = await db.query.recordVersions.findMany({
      where: eq(recordVersions.entityId, activityId),
    });
    expect(versions).toHaveLength(2);
    expect(versions.find((item) => item.action === "activity.version_restore")).toMatchObject({
      sourceVersionId: edited.versionId,
    });

    const returnedToEdited = await restoreRecordVersion(
      db,
      userId,
      restored.versionId
    );
    expect(returnedToEdited.ok).toBe(true);
    expect(
      await db.query.healthActivities.findFirst({
        where: eq(healthActivities.id, activityId),
        columns: { title: true },
      })
    ).toEqual({ title: "Edited walk" });
  });

  it("fails activity rollback closed when its old fingerprint belongs to another record", async () => {
    const edited = await updateActivityWithVersion(
      db,
      userId,
      activityId,
      editedActivity()
    );
    if (!edited.ok || !edited.versionId) throw new Error("Missing activity version");
    await db.insert(healthActivities).values({
      userId,
      ...originalActivity(),
      id: crypto.randomUUID(),
    });

    const beforeVersions = await db.query.recordVersions.findMany();
    const restored = await restoreRecordVersion(db, userId, edited.versionId);
    expect(restored).toEqual({
      ok: false,
      reason: "Those earlier activity details now match another record. Nothing was changed.",
    });
    expect(
      await db.query.healthActivities.findFirst({
        where: eq(healthActivities.id, activityId),
        columns: { title: true },
      })
    ).toEqual({ title: "Edited walk" });
    expect(await db.query.recordVersions.findMany()).toHaveLength(beforeVersions.length);
  });

  it("versions set edits and retry changes, recalculates targets, and restores exact values", async () => {
    await db
      .update(workoutSessions)
      .set({ status: "in_progress", finishedAt: null })
      .where(eq(workoutSessions.id, sessionId));
    const edited = await updateSetWithVersion(db, userId, setId, {
      weight: 90,
      reps: 4,
      rpe: 9,
      note: "Edited set note",
    });
    expect(edited).toMatchObject({ ok: true, changed: true });
    if (!edited.ok || !edited.versionId) throw new Error("Missing set version");
    expect(
      await db.query.completedSets.findFirst({
        where: eq(completedSets.id, setId),
        columns: { weight: true, reps: true, targetMet: true },
      })
    ).toEqual({ weight: 90, reps: 4, targetMet: false });

    const identicalRetry = await updateSetWithVersion(
      db,
      userId,
      setId,
      { weight: 90, reps: 4, rpe: 9, note: "Edited set note" },
      "set.retry_update"
    );
    expect(identicalRetry).toMatchObject({ ok: true, changed: false });
    expect(await db.query.recordVersions.findMany()).toHaveLength(1);

    const retryChange = await updateSetWithVersion(
      db,
      userId,
      setId,
      { weight: 95, reps: 6, rpe: 8.5, note: "Retry corrected" },
      "set.retry_update"
    );
    expect(retryChange).toMatchObject({ ok: true, changed: true });
    expect(await db.query.recordVersions.findMany()).toHaveLength(2);

    const restored = await restoreRecordVersion(db, userId, edited.versionId, {
      expectedHistoryRevision: 0,
      clientMutationId: crypto.randomUUID(),
    });
    expect(restored.ok).toBe(true);
    expect(
      await db.query.completedSets.findFirst({
        where: eq(completedSets.id, setId),
        columns: { weight: true, reps: true, rpe: true, note: true, targetMet: true },
      })
    ).toEqual({
      weight: 100,
      reps: 8,
      rpe: 8,
      note: "Original set note",
      targetMet: true,
    });
  });

  it("refuses active edits that would contradict the persisted set metric", async () => {
    await db
      .update(workoutSessions)
      .set({ status: "in_progress", finishedAt: null })
      .where(eq(workoutSessions.id, sessionId));
    const [repsExercise, assistedExercise] = await db
      .insert(exercises)
      .values([
        {
          name: `Versioned reps ${crypto.randomUUID()}`,
          movementPattern: "vertical_pull",
          primaryMuscles: ["back"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
          variantAttributes: { assistance: "none" },
        },
        {
          name: `Versioned assisted ${crypto.randomUUID()}`,
          movementPattern: "vertical_pull",
          primaryMuscles: ["back"],
          loadType: "external",
          metricType: "assisted_reps",
          loadSemantics: "assistance",
          variantAttributes: { assistance: "assisted" },
        },
      ])
      .returning({ id: exercises.id });
    const [repsSessionExercise, assistedSessionExercise] = await db
      .insert(sessionExercises)
      .values([
        {
          sessionId,
          exerciseId: repsExercise.id,
          orderIdx: 1,
          targetRepsMin: 8,
        },
        {
          sessionId,
          exerciseId: assistedExercise.id,
          orderIdx: 2,
          targetRepsMin: 8,
        },
      ])
      .returning({ id: sessionExercises.id });
    const [repsSet, assistedSet] = await db
      .insert(completedSets)
      .values([
        {
          sessionExerciseId: repsSessionExercise.id,
          setNo: 1,
          weight: null,
          weightUnit: null,
          reps: 10,
          metricType: "reps",
          targetMet: true,
        },
        {
          sessionExerciseId: assistedSessionExercise.id,
          setNo: 1,
          weight: 80,
          weightUnit: "lb",
          reps: 8,
          metricType: "assisted_reps",
          targetMet: null,
        },
      ])
      .returning({ id: completedSets.id });

    await expect(
      updateSetWithVersion(db, userId, repsSet.id, {
        weight: 20,
        weightUnit: "lb",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("recorded metric"),
    });
    await expect(
      updateSetWithVersion(db, userId, assistedSet.id, { weight: null }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("recorded metric"),
    });
    expect(await db.query.recordVersions.findMany()).toHaveLength(0);
    expect(
      await db.query.completedSets.findFirst({
        where: eq(completedSets.id, repsSet.id),
        columns: { weight: true, weightUnit: true, reps: true, targetMet: true },
      }),
    ).toEqual({
      weight: null,
      weightUnit: null,
      reps: 10,
      targetMet: true,
    });
    expect(
      await updateSetWithVersion(db, userId, assistedSet.id, {
        weight: 70,
        reps: 9,
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      await db.query.completedSets.findFirst({
        where: eq(completedSets.id, assistedSet.id),
        columns: { weight: true, reps: true, targetMet: true },
      }),
    ).toEqual({ weight: 70, reps: 9, targetMet: null });
  });

  it("refuses a generic set edit against a completed parent", async () => {
    await expect(
      updateSetWithVersion(db, userId, setId, { reps: 9 }),
    ).resolves.toEqual({
      ok: false,
      reason: "Set not found.",
    });
    expect(
      await db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
        columns: { historyRevision: true },
      }),
    ).toEqual({ historyRevision: 0 });
    expect(
      await db.query.completedSets.findFirst({
        where: eq(completedSets.id, setId),
        columns: { reps: true },
      }),
    ).toEqual({ reps: 8 });
    expect(await db.query.recordVersions.findMany()).toHaveLength(0);
  });

  it("records reviewed completed-set corrections, rejects a stale review, and restores the original", async () => {
    const expected = {
      weight: 100,
      weightUnit: "lb" as const,
      reps: 8,
      distanceKm: null,
      durationSeconds: null,
      rpe: 8,
      note: "Original set note",
    };
    const correctionMutationId = crypto.randomUUID();
    const correctedValues = {
      weight: 50,
      weightUnit: "lb" as const,
      reps: 3,
      distanceKm: null,
      durationSeconds: null,
      rpe: 8.5,
      note: "Reviewed correction",
    };
    const corrected = await updateSetWithVersion(
      db,
      userId,
      setId,
      correctedValues,
      "set.completed_correction",
      {
        expected,
        expectedHistoryRevision: 0,
        clientMutationId: correctionMutationId,
        correctionEvidence: completedCorrectionEvidence,
      },
    );
    expect(corrected).toMatchObject({ ok: true, changed: true });
    if (!corrected.ok || !corrected.versionId) throw new Error("Missing correction version");

    const [evidence] = await db.query.recordVersions.findMany({
      where: eq(recordVersions.entityId, setId),
    });
    expect(evidence).toMatchObject({
      action: "set.completed_correction",
      beforeData: {
        weight: 100,
        weight_unit: "lb",
        reps: 8,
        rpe: 8,
        note: "Original set note",
      },
      afterData: {
        weight: 50,
        weight_unit: "lb",
        reps: 3,
        rpe: 8.5,
        note: "Reviewed correction",
        target_met: false,
      },
    });
    expect(
      await db.query.completedSets.findFirst({
        where: eq(completedSets.id, setId),
        columns: { targetMet: true },
      }),
    ).toEqual({ targetMet: false });
    await expect(updateSetWithVersion(
      db,
      userId,
      setId,
      correctedValues,
      "set.completed_correction",
      {
        expected,
        expectedHistoryRevision: 0,
        clientMutationId: correctionMutationId,
        correctionEvidence: completedCorrectionEvidence,
      },
    )).resolves.toMatchObject({
      ok: true,
      changed: false,
      versionId: correctionMutationId,
    });

    expect(
      await updateSetWithVersion(
        db,
        userId,
        setId,
        { ...correctedValues, reps: 9 },
        "set.completed_correction",
        {
          expected,
          expectedHistoryRevision: 0,
          clientMutationId: crypto.randomUUID(),
          correctionEvidence: completedCorrectionEvidence,
        },
      ),
    ).toEqual({
      ok: false,
      reason: "This set changed after the correction form opened. Reload the workout and review the latest values before trying again.",
    });
    expect(await db.query.recordVersions.findMany()).toHaveLength(1);

    await db
      .update(recordVersions)
      .set({
        beforeData: {
          ...(evidence.beforeData as Record<string, unknown>),
          target_met: false,
        },
      })
      .where(eq(recordVersions.id, corrected.versionId));

    const restoreMutationId = crypto.randomUUID();
    expect(await restoreRecordVersion(db, userId, corrected.versionId, {
      expectedHistoryRevision: 1,
      clientMutationId: restoreMutationId,
    })).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await restoreRecordVersion(db, userId, corrected.versionId, {
      expectedHistoryRevision: 1,
      clientMutationId: restoreMutationId,
    })).toMatchObject({
      ok: true,
      changed: false,
      versionId: restoreMutationId,
    });
    expect(
      await db.query.completedSets.findFirst({
        where: eq(completedSets.id, setId),
        columns: {
          weight: true,
          weightUnit: true,
          reps: true,
          distanceKm: true,
          durationSeconds: true,
          rpe: true,
          note: true,
          targetMet: true,
          performedSemanticsVersion: true,
          performedLoadType: true,
          performedLoadSemantics: true,
        },
      }),
    ).toEqual({
      ...expected,
      targetMet: true,
      performedSemanticsVersion: 1,
      performedLoadType: "barbell",
      performedLoadSemantics: "total",
    });
  });

  it("invalidates a legacy target outcome during version restore while retaining raw facts", async () => {
    const [legacySet] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId,
        setNo: 2,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        rpe: 8,
        targetMet: true,
        note: "Legacy set note",
        metricType: "weight_reps",
        loadEntryMeaning: "legacy_unknown",
      })
      .returning({ id: completedSets.id });
    await db.insert(sessionOccurrences).values({
      sessionId,
      sessionExerciseId,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 1,
      kindOrdinal: 1,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      revision: 1,
      resolvedAt: new Date("2026-07-02T14:20:00.000Z"),
      completedSetId: legacySet.id,
    });
    const corrected = await updateSetWithVersion(
      db,
      userId,
      legacySet.id,
      {
        weight: 50,
        weightUnit: "lb",
        reps: 3,
        distanceKm: null,
        durationSeconds: null,
        rpe: 8,
        note: "Legacy set note",
      },
      "set.completed_correction",
      {
        expected: {
          weight: 100,
          weightUnit: "lb",
          reps: 8,
          distanceKm: null,
          durationSeconds: null,
          rpe: 8,
          note: "Legacy set note",
        },
        expectedHistoryRevision: 0,
        clientMutationId: crypto.randomUUID(),
        correctionEvidence: completedCorrectionEvidence,
      },
    );
    expect(corrected).toMatchObject({ ok: true });
    if (!corrected.ok || !corrected.versionId) {
      throw new Error("Missing correction version");
    }

    expect(
      await restoreRecordVersion(db, userId, corrected.versionId, {
        expectedHistoryRevision: 1,
        clientMutationId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      await db.query.completedSets.findFirst({
        where: eq(completedSets.id, legacySet.id),
        columns: {
          weight: true,
          reps: true,
          targetMet: true,
          performedSemanticsVersion: true,
          performedLoadType: true,
          performedLoadSemantics: true,
        },
      }),
    ).toEqual({
      weight: 100,
      reps: 8,
      targetMet: null,
      performedSemanticsVersion: null,
      performedLoadType: null,
      performedLoadSemantics: null,
    });
  });

  it("versions exercise notes without noise and restores the exact earlier note", async () => {
    const edited = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      { notes: "Keep the knees tracking over the toes." },
      "session_exercise.note_update"
    );
    expect(edited).toMatchObject({ ok: true, changed: true });
    if (!edited.ok || !edited.versionId) throw new Error("Missing exercise-note version");

    const identical = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      { notes: "Keep the knees tracking over the toes." },
      "session_exercise.note_update"
    );
    expect(identical).toMatchObject({ ok: true, changed: false, versionId: null });
    expect(await db.query.recordVersions.findMany()).toHaveLength(1);

    const [version] = await db.query.recordVersions.findMany();
    expect(version).toMatchObject({
      entityType: "session_exercise",
      action: "session_exercise.note_update",
      changedFields: ["notes"],
      beforeData: { id: sessionExerciseId, notes: null },
      afterData: {
        id: sessionExerciseId,
        notes: "Keep the knees tracking over the toes.",
      },
    });

    const rollbackVersionId = crypto.randomUUID();
    const restored = await restoreRecordVersion(db, userId, edited.versionId, {
      clientMutationId: rollbackVersionId,
    });
    expect(restored).toMatchObject({
      ok: true,
      changed: true,
      versionId: rollbackVersionId,
    });
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, sessionExerciseId),
        columns: { notes: true },
      })
    ).toEqual({ notes: null });
    expect(await db.query.recordVersions.findMany()).toHaveLength(2);
  });

  it("refuses an active-workout rollback after the workout is completed", async () => {
    await db
      .update(workoutSessions)
      .set({ status: "in_progress", finishedAt: null })
      .where(eq(workoutSessions.id, sessionId));
    const edited = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      { notes: "Active workout note" },
      "session_exercise.note_update",
      { activeOnly: true }
    );
    if (!edited.ok || !edited.versionId) throw new Error("Missing exercise version");

    await db
      .update(workoutSessions)
      .set({
        status: "completed",
        finishedAt: new Date("2026-07-13T12:00:00.000Z"),
      })
      .where(eq(workoutSessions.id, sessionId));

    expect(
      await restoreRecordVersion(db, userId, edited.versionId, {
        activeOnly: true,
      })
    ).toEqual({
      ok: false,
      reason:
        "Restore the workout from Archive before restoring an earlier exercise change.",
    });
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, sessionExerciseId),
        columns: { notes: true },
      })
    ).toEqual({ notes: "Active workout note" });
    expect(await db.query.recordVersions.findMany()).toHaveLength(1);
  });

  it("retains skip and substitution states and can restore either side exactly", async () => {
    await removeLoggedSetForFixture();
    const skipped = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      { modificationType: "skipped", skipReason: "fatigue" },
      "session_exercise.skip"
    );
    expect(skipped).toMatchObject({ ok: true, changed: true });

    const unskipped = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      { modificationType: "as_planned", skipReason: null },
      "session_exercise.unskip"
    );
    expect(unskipped).toMatchObject({ ok: true, changed: true });

    const substituted = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      {
        exerciseId: alternateExerciseId,
        modificationType: "substituted",
        skipReason: null,
        substitutedForExerciseId: exerciseId,
        substitutionReason: "variety",
        substitutedAt: new Date("2026-07-02T14:20:00.000Z"),
        targetLoad: null,
      },
      "session_exercise.substitute"
    );
    expect(substituted).toMatchObject({ ok: true, changed: true });
    if (!substituted.ok || !substituted.versionId) {
      throw new Error("Missing substitution version");
    }
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, sessionExerciseId),
        columns: {
          exerciseId: true,
          modificationType: true,
          skipReason: true,
          substitutedForExerciseId: true,
          substitutionReason: true,
          substitutedAt: true,
          targetLoad: true,
        },
      })
    ).toEqual({
      exerciseId: alternateExerciseId,
      modificationType: "substituted",
      skipReason: null,
      substitutedForExerciseId: exerciseId,
      substitutionReason: "variety",
      substitutedAt: new Date("2026-07-02T14:20:00.000Z"),
      targetLoad: null,
    });

    const restoredOriginal = await restoreRecordVersion(
      db,
      userId,
      substituted.versionId
    );
    expect(restoredOriginal).toMatchObject({ ok: true, changed: true });
    if (!restoredOriginal.ok || !restoredOriginal.versionId) {
      throw new Error("Missing reverse substitution version");
    }
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, sessionExerciseId),
        columns: {
          exerciseId: true,
          modificationType: true,
          skipReason: true,
          substitutedForExerciseId: true,
          substitutionReason: true,
          substitutedAt: true,
          targetLoad: true,
        },
      })
    ).toEqual({
      exerciseId,
      modificationType: "as_planned",
      skipReason: null,
      substitutedForExerciseId: null,
      substitutionReason: null,
      substitutedAt: null,
      targetLoad: 100,
    });

    expect(
      await restoreRecordVersion(db, userId, restoredOriginal.versionId)
    ).toMatchObject({ ok: true, changed: true });
  });

  it("restores skipped working actions when the owner replaces that exercise", async () => {
    await removeLoggedSetForFixture();
    await db
      .update(workoutSessions)
      .set({ status: "in_progress", finishedAt: null })
      .where(eq(workoutSessions.id, sessionId));
    const [warmup, working] = await db
      .insert(sessionOccurrences)
      .values([
        {
          sessionId,
          sessionExerciseId,
          kind: "exercise_warmup",
          origin: "planned",
          sequenceIdx: 0,
          kindOrdinal: 0,
          label: "Replacement warm-up",
          plannedExerciseId: exerciseId,
          outcome: "pending",
          revision: 0,
        },
        {
          sessionId,
          sessionExerciseId,
          kind: "working_set",
          origin: "planned",
          sequenceIdx: 1,
          kindOrdinal: 0,
          plannedExerciseId: exerciseId,
          plannedRepsMin: 5,
          plannedRepsMax: 8,
          plannedLoad: 100,
          plannedLoadUnit: "lb",
          outcome: "pending",
          revision: 0,
        },
      ])
      .returning({ id: sessionOccurrences.id });

    await expect(updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      { modificationType: "skipped", skipReason: "equipment" },
      "session_exercise.skip",
      { activeOnly: true },
    )).resolves.toMatchObject({ ok: true, changed: true });
    expect(await db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, working.id),
    })).toMatchObject({
      outcome: "skipped",
      outcomeReason: "exercise:equipment",
    });

    const versionId = crypto.randomUUID();
    await expect(updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      {
        exerciseId: alternateExerciseId,
        modificationType: "substituted",
        skipReason: null,
        substitutedForExerciseId: exerciseId,
        substitutionReason: "equipment_busy",
        substitutedAt: new Date("2026-07-02T14:20:00.000Z"),
        targetLoad: null,
        targetLoadUnit: null,
        notes: null,
        warmupNotes: null,
        warmupSets: [],
        setNotes: [],
      },
      "session_exercise.substitute",
      { activeOnly: true, versionId },
    )).resolves.toMatchObject({ ok: true, changed: true, versionId });

    expect(await db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, working.id),
    })).toMatchObject({
      outcome: "pending",
      outcomeReason: null,
      equipmentSnapshotId: null,
      revision: 2,
    });
    expect(await db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, warmup.id),
    })).toMatchObject({
      outcome: "skipped",
      outcomeReason: "exercise:equipment",
      revision: 1,
    });
    expect((await db.select({ operation: sessionOccurrenceMutations.operation })
      .from(sessionOccurrenceMutations))
      .map((receipt) => receipt.operation)
      .sort()).toEqual(["restore", "skip", "skip"]);
  });

  it("replaces only the prospective identity, clears stale guidance, and replays one mutation identity", async () => {
    await removeLoggedSetForFixture();
    await db
      .update(workoutSessions)
      .set({ status: "in_progress", finishedAt: null })
      .where(eq(workoutSessions.id, sessionId));
    await db
      .update(sessionExercises)
      .set({
        targetSets: 3,
        targetRepsMin: 5,
        targetRepsMax: 8,
        notes: "Old exercise cue",
        warmupNotes: "Old warm-up cue",
        warmupSets: [{
          label: "Old ramp",
          reps: 5,
          load: 45,
          loadUnit: "lb",
          loadPercent: null,
          loadText: null,
          notes: null,
        }],
        setNotes: ["Old set cue"],
      })
      .where(eq(sessionExercises.id, sessionExerciseId));
    const versionId = crypto.randomUUID();
    const replaced = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      {
        exerciseId: alternateExerciseId,
        modificationType: "substituted",
        substitutedForExerciseId: exerciseId,
        substitutionReason: "other",
        substitutedAt: new Date("2026-07-24T14:00:00.000Z"),
        targetLoad: null,
        targetLoadUnit: null,
        notes: null,
        warmupNotes: null,
        warmupSets: [],
        setNotes: [],
      },
      "session_exercise.substitute",
      {
        activeOnly: true,
        expectedExerciseId: exerciseId,
        versionId,
      },
    );
    expect(replaced).toMatchObject({
      ok: true,
      changed: true,
      versionId,
    });
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, sessionExerciseId),
        columns: {
          exerciseId: true,
          targetSets: true,
          targetRepsMin: true,
          targetRepsMax: true,
          targetLoad: true,
          targetLoadUnit: true,
          notes: true,
          warmupNotes: true,
          warmupSets: true,
          setNotes: true,
        },
      }),
    ).toEqual({
      exerciseId: alternateExerciseId,
      targetSets: 3,
      targetRepsMin: 5,
      targetRepsMax: 8,
      targetLoad: null,
      targetLoadUnit: null,
      notes: null,
      warmupNotes: null,
      warmupSets: [],
      setNotes: [],
    });

    const replay = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      {
        exerciseId: alternateExerciseId,
        modificationType: "substituted",
        substitutedForExerciseId: exerciseId,
        substitutionReason: "other",
        substitutedAt: new Date("2026-07-24T14:01:00.000Z"),
        targetLoad: null,
      },
      "session_exercise.substitute",
      {
        activeOnly: true,
        expectedExerciseId: exerciseId,
        versionId,
      },
    );
    expect(replay).toMatchObject({
      ok: true,
      changed: false,
      versionId,
    });
    expect(
      await db.query.recordVersions.findMany({
        where: eq(recordVersions.entityId, sessionExerciseId),
      }),
    ).toHaveLength(1);

    expect(
      await updateSessionExerciseWithVersion(
        db,
        userId,
        sessionExerciseId,
        {
          exerciseId,
          modificationType: "substituted",
          substitutedForExerciseId: exerciseId,
          substitutionReason: "other",
          targetLoad: null,
        },
        "session_exercise.substitute",
        {
          activeOnly: true,
          expectedExerciseId: exerciseId,
          versionId: crypto.randomUUID(),
        },
      ),
    ).toEqual({
      ok: false,
      reason:
        "This exercise changed after replacement opened. Review the current exercise before trying again.",
    });

    const laterVersionId = crypto.randomUUID();
    expect(
      await updateSessionExerciseWithVersion(
        db,
        userId,
        sessionExerciseId,
        {
          exerciseId,
          modificationType: "substituted",
          substitutedForExerciseId: exerciseId,
          substitutionReason: "variety",
          targetLoad: null,
        },
        "session_exercise.substitute",
        {
          activeOnly: true,
          expectedExerciseId: alternateExerciseId,
          versionId: laterVersionId,
        },
      ),
    ).toMatchObject({ ok: true, changed: true, versionId: laterVersionId });

    expect(
      await updateSessionExerciseWithVersion(
        db,
        userId,
        sessionExerciseId,
        {
          exerciseId: alternateExerciseId,
          modificationType: "substituted",
          substitutedForExerciseId: exerciseId,
          substitutionReason: "other",
          targetLoad: null,
        },
        "session_exercise.substitute",
        {
          activeOnly: true,
          expectedExerciseId: exerciseId,
          versionId,
        },
      ),
    ).toEqual({
      ok: false,
      reason:
        "This exercise changed after replacement opened. Review the current exercise before trying again.",
    });

    expect(
      await restoreRecordVersion(db, userId, laterVersionId, {
        activeOnly: true,
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      await restoreRecordVersion(db, userId, versionId, { activeOnly: true }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, sessionExerciseId),
        columns: {
          exerciseId: true,
          notes: true,
          warmupNotes: true,
          warmupSets: true,
          setNotes: true,
        },
      }),
    ).toEqual({
      exerciseId,
      notes: "Old exercise cue",
      warmupNotes: "Old warm-up cue",
      warmupSets: [{
        label: "Old ramp",
        reps: 5,
        load: 45,
        loadUnit: "lb",
        loadPercent: null,
        loadText: null,
        notes: null,
      }],
      setNotes: ["Old set cue"],
    });
  });

  it("refuses to relabel logged sets through substitution or substitution rollback", async () => {
    const blocked = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      {
        exerciseId: alternateExerciseId,
        modificationType: "substituted",
        substitutedForExerciseId: exerciseId,
        targetLoad: null,
      },
      "session_exercise.substitute"
    );
    expect(blocked).toEqual({
      ok: false,
      reason: "This exercise already has logged sets and cannot be substituted.",
    });
    expect(await db.query.recordVersions.findMany()).toHaveLength(0);

    await removeLoggedSetForFixture();
    const substituted = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      {
        exerciseId: alternateExerciseId,
        modificationType: "substituted",
        substitutedForExerciseId: exerciseId,
        targetLoad: null,
      },
      "session_exercise.substitute"
    );
    if (!substituted.ok || !substituted.versionId) {
      throw new Error("Missing substitution version");
    }
    await db.insert(completedSets).values({
      sessionExerciseId,
      setNo: 1,
      weight: 35,
      weightUnit: "lb",
      reps: 8,
    });

    expect(await restoreRecordVersion(db, userId, substituted.versionId)).toEqual({
      ok: false,
      reason:
        "The workout exercise structure or provenance has changed. Nothing was restored.",
    });
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, sessionExerciseId),
        columns: { exerciseId: true },
      })
    ).toEqual({ exerciseId: alternateExerciseId });
    expect(await db.query.recordVersions.findMany()).toHaveLength(1);
  });

  it("fails exercise rollback closed for archived parents or incompatible provenance", async () => {
    const edited = await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      { notes: "Version to protect" },
      "session_exercise.note_update"
    );
    if (!edited.ok || !edited.versionId) throw new Error("Missing exercise version");

    await db
      .update(workoutSessions)
      .set({ archivedAt: new Date("2026-07-11T12:00:00.000Z") })
      .where(eq(workoutSessions.id, sessionId));
    expect(await restoreRecordVersion(db, userId, edited.versionId)).toEqual({
      ok: false,
      reason:
        "Restore the workout from Archive before restoring an earlier exercise change.",
    });

    await db
      .update(workoutSessions)
      .set({ archivedAt: null })
      .where(eq(workoutSessions.id, sessionId));
    await db
      .update(sessionExercises)
      .set({ sourceExerciseKey: "changed-provenance" })
      .where(eq(sessionExercises.id, sessionExerciseId));
    expect(await restoreRecordVersion(db, userId, edited.versionId)).toEqual({
      ok: false,
      reason:
        "The workout exercise structure or provenance has changed. Nothing was restored.",
    });
    expect(await db.query.recordVersions.findMany()).toHaveLength(1);
  });

  it("rolls back the exercise update when its audit event cannot be written", async () => {
    await db.execute(sql`
      ALTER TABLE audit_logs
      ADD CONSTRAINT audit_reject_session_skip
      CHECK (action <> 'session_exercise.skip')
    `);

    await expect(
      updateSessionExerciseWithVersion(
        db,
        userId,
        sessionExerciseId,
        { modificationType: "skipped", skipReason: "time" },
        "session_exercise.skip"
      )
    ).rejects.toThrow();
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, sessionExerciseId),
        columns: { modificationType: true, skipReason: true },
      })
    ).toEqual({ modificationType: "as_planned", skipReason: null });
    expect(await db.query.recordVersions.findMany()).toHaveLength(0);
  });

  it("includes edit history in complete backups and consistent snapshots", async () => {
    await db
      .update(workoutSessions)
      .set({ status: "in_progress", finishedAt: null })
      .where(eq(workoutSessions.id, sessionId));
    await updateSetWithVersion(db, userId, setId, { note: "Protected edit" });
    await updateSessionExerciseWithVersion(
      db,
      userId,
      sessionExerciseId,
      { notes: "Protected exercise note" },
      "session_exercise.note_update"
    );
    const [backup, snapshot] = await Promise.all([
      buildJsonBackup(db, userId),
      captureUserSnapshot(
        db,
        userId,
        new Date("2026-07-11T12:00:00.000Z"),
        "version-test"
      ),
    ]);
    expect(backup.canonical.tables.record_versions).toHaveLength(2);
    expect(snapshot.tables.record_versions).toHaveLength(2);
    expect(
      backup.canonical.tables.record_versions
        .map((version) => (version as { entity_type: string }).entity_type)
        .sort()
    ).toEqual(["completed_set", "session_exercise"]);
  });
});
