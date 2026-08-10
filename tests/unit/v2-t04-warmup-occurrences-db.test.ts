import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import {
  exercisePrescriptions,
  exercises,
  programs,
  programVersions,
  recordVersions,
  sessionEquipmentSnapshots,
  sessionExercises,
  sessionOccurrenceMutations,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import {
  abandonWorkoutSession,
  mutateWorkoutOccurrence,
  startWorkoutSession,
} from "@/services/session-lifecycle";
import {
  restoreRecordVersion,
  updateSessionExerciseWithVersion,
} from "@/services/record-versions";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("V2 T04 warm-up occurrence truth", () => {
  let database: TestDatabase;
  let userId: string;
  let programId: string;
  let templateId: string;
  let exerciseId: string;
  let alternateExerciseId: string;

  const overview =
    "Use an easy pace and controlled range. This overview is reference guidance, not another action to acknowledge.";
  const exerciseOverview =
    "Set the bench and rehearse the same stable shoulder position.";

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `t04-${crypto.randomUUID()}@example.test` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId,
      timezone: "America/Toronto",
    });
    const definitions = await database.db
      .insert(exercises)
      .values([
        {
          name: "T04 barbell press",
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "barbell",
          metricType: "weight_reps",
          loadSemantics: "total",
        },
        {
          name: "T04 dumbbell press alternative",
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "dumbbell",
          metricType: "weight_reps",
          loadSemantics: "per_implement",
        },
      ])
      .returning({ id: exercises.id });
    exerciseId = definitions[0].id;
    alternateExerciseId = definitions[1].id;

    await database.db.transaction(async (tx) => {
      const [program] = await tx
        .insert(programs)
        .values({
          userId,
          name: "T04 warm-up truth",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      programId = program.id;
      const [version] = await tx
        .insert(programVersions)
        .values({
          programId,
          documentSchemaVersion: 3,
          publicationSource: "editor",
          activatedAt: new Date(),
        })
        .returning({ id: programVersions.id });
      [{ id: templateId }] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: version.id,
          name: "T04 action day",
          warmupNotes: overview,
          warmupItems: [
            {
              key: crypto.randomUUID(),
              label: "Dynamic mobility",
              reps: 8,
              load: null,
              loadUnit: null,
              loadPercent: null,
              loadText: null,
              notes: "Comfortable range",
            },
          ],
        })
        .returning({ id: workoutTemplates.id });
      const [slot] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: templateId,
          exerciseId,
          orderIdx: 0,
          warmupNotes: exerciseOverview,
          warmupSets: [
            {
              label: "Empty bar rehearsal",
              reps: 10,
              load: null,
              loadUnit: null,
              loadPercent: null,
              loadText: "empty bar",
              notes: null,
            },
            {
              label: "Controlled ramp",
              reps: 5,
              load: null,
              loadUnit: null,
              loadPercent: 55,
              loadText: null,
              notes: "Match work-set grip",
            },
          ],
        })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 2,
        repRangeMin: 6,
        repRangeMax: 8,
        targetLoad: 100,
        targetLoadUnit: "lb",
      });
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: version.id,
        })
        .where(eq(programs.id, programId));
    });
  }, 30_000);

  afterEach(async () => database.close());

  it("creates each structured day and exercise action once while retaining overview guidance separately", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    });
    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));

    expect(session).toMatchObject({
      dayWarmupNotes: overview,
      dayWarmupItems: [expect.objectContaining({ label: "Dynamic mobility" })],
    });
    expect(
      occurrences.map((occurrence) => ({
        kind: occurrence.kind,
        label: occurrence.label,
        ordinal: occurrence.kindOrdinal,
      })),
    ).toEqual([
      { kind: "day_warmup", label: "Dynamic mobility", ordinal: 0 },
      {
        kind: "exercise_warmup",
        label: "Empty bar rehearsal",
        ordinal: 0,
      },
      {
        kind: "exercise_warmup",
        label: "Controlled ramp",
        ordinal: 1,
      },
      { kind: "working_set", label: null, ordinal: 0 },
      { kind: "working_set", label: null, ordinal: 1 },
    ]);
    expect(occurrences.some((occurrence) => occurrence.label === overview))
      .toBe(false);
    expect(
      occurrences.some((occurrence) => occurrence.label === exerciseOverview),
    ).toBe(false);

  });

  it("saves note, complete, retry, and undo against one stable occurrence without losing the note", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [warmup] = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    const noteKey = crypto.randomUUID();
    const completeKey = crypto.randomUUID();
    const restoreKey = crypto.randomUUID();

    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmup.id,
      clientKey: noteKey,
      expectedRevision: 0,
      operation: "note",
      note: "Synthetic mobility complete",
    })).resolves.toMatchObject({ outcome: "saved" });
    const completed = await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmup.id,
      clientKey: completeKey,
      expectedRevision: 1,
      operation: "complete",
    });
    expect(completed).toMatchObject({
      outcome: "saved",
      occurrence: {
        id: warmup.id,
        state: "completed",
        note: "Synthetic mobility complete",
        revision: 2,
      },
    });
    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmup.id,
      clientKey: completeKey,
      expectedRevision: 1,
      operation: "complete",
    })).resolves.toEqual({
      ...completed,
      outcome: "replayed",
    });
    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmup.id,
      clientKey: completeKey,
      expectedRevision: 2,
      operation: "restore",
    })).resolves.toEqual({ outcome: "conflict" });

    const restored = await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmup.id,
      clientKey: restoreKey,
      expectedRevision: 2,
      operation: "restore",
    });
    expect(restored).toMatchObject({
      outcome: "saved",
      occurrence: {
        id: warmup.id,
        state: "pending",
        note: "Synthetic mobility complete",
        revision: 3,
      },
    });
    const operations = (await database.db
        .select()
        .from(sessionOccurrenceMutations)
        .where(eq(sessionOccurrenceMutations.occurrenceId, warmup.id)))
        .map((receipt) => receipt.operation);
    expect(operations).toHaveLength(3);
    expect(operations).toEqual(
      expect.arrayContaining(["note", "complete", "restore"]),
    );
  });

  it("keeps substitution and whole-exercise decisions aggregate while preserving equipped completion reversal", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const [sessionExercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const warmups = (await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, sessionExercise.id))
      .orderBy(asc(sessionOccurrences.kindOrdinal)))
      .filter((occurrence) => occurrence.kind === "exercise_warmup");
    const [equipment] = await database.db
      .insert(sessionEquipmentSnapshots)
      .values({
        userId,
        sessionId: started.sessionId,
        sessionExerciseId: sessionExercise.id,
        equipmentLabel: "T04 retained setup",
        profileKind: "bodyweight",
        geometryCertainty: "known",
        selectionProvenance: "user_selected",
        configurationRevision: 1,
        configurationHash: "e".repeat(64),
        geometryVersion: 1,
        geometrySnapshot: { version: 1, kind: "bodyweight" },
      })
      .returning({ id: sessionEquipmentSnapshots.id });
    await database.db
      .update(sessionOccurrences)
      .set({ equipmentSnapshotId: equipment.id, revision: 1 })
      .where(inArray(sessionOccurrences.id, [warmups[0].id, warmups[1].id]));
    await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmups[0].id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 1,
      operation: "note",
      note: "Keep this note through correction",
    });
    await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmups[0].id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 2,
      operation: "complete",
    });

    const substitutionVersionId = crypto.randomUUID();
    await expect(updateSessionExerciseWithVersion(
      database.db,
      userId,
      sessionExercise.id,
      {
        exerciseId: alternateExerciseId,
        modificationType: "substituted",
        skipReason: null,
        substitutedForExerciseId: exerciseId,
        substitutionReason: "other",
        substitutedAt: new Date(),
        targetLoad: null,
        targetLoadUnit: null,
        notes: null,
        warmupNotes: null,
        warmupSets: [],
        setNotes: [],
      },
      "session_exercise.substitute",
      { activeOnly: true, versionId: substitutionVersionId },
    )).resolves.toMatchObject({ ok: true, changed: true });

    const afterSubstitution = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, sessionExercise.id))
      .orderBy(asc(sessionOccurrences.kindOrdinal));
    expect(afterSubstitution.find((row) => row.id === warmups[0].id))
      .toMatchObject({ outcome: "completed", plannedExerciseId: exerciseId });
    expect(afterSubstitution.find((row) => row.id === warmups[1].id))
      .toMatchObject({
        outcome: "skipped",
        outcomeReason: `exercise:substituted:${substitutionVersionId}`,
        plannedExerciseId: exerciseId,
        equipmentSnapshotId: null,
      });
    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmups[0].id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 3,
      operation: "restore",
    })).resolves.toEqual({ outcome: "conflict" });
    await expect(mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmups[1].id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 2,
      operation: "restore",
    })).resolves.toEqual({ outcome: "conflict" });

    await updateSessionExerciseWithVersion(
      database.db,
      userId,
      sessionExercise.id,
      { modificationType: "skipped", skipReason: "other" },
      "session_exercise.skip",
      { activeOnly: true },
    );
    await updateSessionExerciseWithVersion(
      database.db,
      userId,
      sessionExercise.id,
      { modificationType: "substituted", skipReason: null },
      "session_exercise.unskip",
      { activeOnly: true },
    );
    expect(await database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, warmups[1].id),
    })).toMatchObject({
      outcome: "skipped",
      outcomeReason: `exercise:substituted:${substitutionVersionId}`,
    });

    await expect(restoreRecordVersion(
      database.db,
      userId,
      substitutionVersionId,
      { activeOnly: true },
    )).resolves.toMatchObject({ ok: true, changed: true });
    const restoredPending = await database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, warmups[1].id),
    });
    expect(restoredPending).toMatchObject({
      outcome: "pending",
      outcomeReason: null,
      plannedExerciseId: exerciseId,
    });
    const completionUndo = await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmups[0].id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 3,
      operation: "restore",
    });
    expect(completionUndo).toMatchObject({
      outcome: "saved",
      occurrence: {
        id: warmups[0].id,
        state: "pending",
        note: "Keep this note through correction",
        revision: 4,
      },
    });
    expect(await database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.id, warmups[0].id),
    })).toMatchObject({ equipmentSnapshotId: equipment.id });
    expect(await database.db.query.recordVersions.findFirst({
      where: eq(recordVersions.id, substitutionVersionId),
    })).toMatchObject({ action: "session_exercise.substitute" });
  });

  it("retains acknowledged warm-up evidence and receipts while abandoning only unresolved actions", async () => {
    const started = await startWorkoutSession(database.db, userId, templateId);
    const warmups = (await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx)))
      .filter((occurrence) => occurrence.kind !== "working_set");
    await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmups[0].id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 0,
      operation: "note",
      note: "Retained before abandoning",
    });
    await mutateWorkoutOccurrence(database.db, userId, {
      occurrenceId: warmups[0].id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 1,
      operation: "complete",
    });
    await abandonWorkoutSession(database.db, userId, started.sessionId, {
      now: () => new Date("2026-08-02T16:00:00.000Z"),
    });

    const rows = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    expect(rows[0]).toMatchObject({
      outcome: "completed",
      outcomeNote: "Retained before abandoning",
    });
    expect(rows.slice(1).every((row) => row.outcome === "abandoned")).toBe(true);
    const receipts = await database.db
      .select()
      .from(sessionOccurrenceMutations);
    expect(receipts.filter((receipt) => receipt.operation === "abandon"))
      .toHaveLength(rows.length - 1);
    expect(receipts.filter((receipt) => receipt.operation === "complete"))
      .toHaveLength(1);
  });
});
