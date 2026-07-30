import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  completedSets,
  exercises,
  externalExerciseMappings,
  fatigueLogs,
  healthActivities,
  historyImportBatches,
  importEvents,
  painLogs,
  progressionJobInputSessions,
  progressionJobs,
  recommendations,
  recordVersions,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrenceMutations,
  sessionOccurrences,
  sessionNotes,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { normalizeActivityInput } from "@/services/activities";
import {
  archiveActivityRecord,
  archiveCompletedSetRecord,
  archiveImportBatchRecord,
  archiveWorkoutRecord,
  getArchiveList,
  getImportBatchArchivePreview,
  getWorkoutArchivePreview,
  restoreArchiveOperation,
} from "@/services/archive";
import { getActivityReport } from "@/services/activity-report";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  getHistoryCalendarRecords,
  getHistoryReport,
} from "@/services/history-report";
import { buildTrainingDigest } from "@/services/digest";
import { getCompletedHistoryContextualNotes } from "@/services/history-page";
import { createContextualNote } from "@/services/contextual-notes";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import {
  buildActivitiesCsv,
  buildJsonBackup,
  buildPainFatigueCsv,
  buildContextualNotesCsv,
  buildSetsCsv,
} from "@/services/export";

describe("archive database lifecycle", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let sessionId: string;
  let sessionExerciseId: string;
  let setId: string;
  let activityId: string;
  let recommendationId: string;
  let exerciseId: string;
  let exerciseName: string;
  let currentProgramSlotId: string;
  let currentProgramSlotLineageId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });

    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `archive-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values({ userId });
    exerciseName = `Archive Test Squat ${crypto.randomUUID()}`;
    const [exercise] = await db
      .insert(exercises)
      .values({
        name: exerciseName,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        secondaryMuscles: ["glutes"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    exerciseId = exercise.id;
    const activated = await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Archive fixture Program",
      days: [{
        name: "Archive day",
        exercises: [{
          exerciseId,
          sets: 1,
          repMin: 5,
          repMax: 8,
          targetLoad: 100,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Archive lifecycle fixture",
      auditAction: "program.activate",
      auditSummary: "Activated archive lifecycle fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    const [programTemplate] = await db.query.workoutTemplates.findMany({
      where: (table, { eq }) =>
        eq(table.programVersionId, activated.programVersionId),
    });
    const [programSlot] = await db.query.workoutTemplateExercises.findMany({
      where: (table, { eq }) => eq(table.workoutTemplateId, programTemplate.id),
    });
    currentProgramSlotId = programSlot.id;
    currentProgramSlotLineageId = programSlot.lineageId;
    [{ id: sessionId }] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Archive test workout",
        status: "completed",
        startedAt: new Date("2026-07-01T14:00:00.000Z"),
        finishedAt: new Date("2026-07-01T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-01",
      })
      .returning({ id: workoutSessions.id });
    const [sessionExercise] = await db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId: exercise.id,
        sourceExerciseKey: "archive-test-squat",
        sourceExerciseName: exerciseName,
        orderIdx: 0,
        targetSets: 1,
        targetRepsMin: 5,
        targetRepsMax: 8,
      })
      .returning({ id: sessionExercises.id });
    sessionExerciseId = sessionExercise.id;
    [{ id: setId }] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        targetMet: true,
        note: "archive-set-marker",
      })
      .returning({ id: completedSets.id });
    await db.insert(sessionExerciseGroups).values({
      sessionId,
      provenance: "legacy",
      name: "Archive fixture group",
      orderIdx: 0,
    });
    const [occurrence] = await db
      .insert(sessionOccurrences)
      .values({
        sessionId,
        sessionExerciseId: sessionExercise.id,
        kind: "working_set",
        origin: "legacy",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
        outcome: "completed",
        revision: 1,
        resolvedAt: new Date("2026-07-01T14:30:00.000Z"),
        completedSetId: setId,
      })
      .returning({ id: sessionOccurrences.id });
    await db.insert(sessionOccurrenceMutations).values({
      occurrenceId: occurrence.id,
      clientKey: crypto.randomUUID(),
      operation: "complete",
      canonicalPayloadHash: "a".repeat(64),
      expectedRevision: 0,
      resultingRevision: 1,
      resultCode: "applied",
    });
    const contextualNote = await createContextualNote(db, userId, {
      clientKey: crypto.randomUUID(),
      body: "archive-contextual-note-marker",
      coachVisible: false,
      inputMode: "typed",
      attachmentKind: "set",
      sessionId,
      sessionExerciseId,
      occurrenceId: occurrence.id,
      completedSetId: setId,
      capturedContext: {
        schemaVersion: 1,
        destination: "workout",
        workflow: "archive fixture",
        workoutPhase: "working",
        originatedFromSimulation: false,
        programDay: null,
        plannedExercise: null,
        performedExercise: null,
        occurrence: null,
        loadRepetitions: null,
        restContext: null,
        reviewContext: null,
      },
      recordedAt: "2026-07-01T14:30:00.000Z",
    });
    if (contextualNote.outcome !== "saved") throw new Error("Contextual note fixture failed.");
    expect(await evaluateApplicationIntegrity(db, userId)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkKey: expect.stringContaining("contextual_note") }),
      ])
    );
    await db.insert(sessionNotes).values({
      sessionId,
      text: "archive-note-marker",
    });
    await db.insert(painLogs).values({
      userId,
      sessionId,
      exerciseId: exercise.id,
      bodyPart: "knee",
      severity: 2,
      note: "archive-pain-marker",
    });
    await db.insert(fatigueLogs).values({
      userId,
      sessionId,
      severity: 3,
      note: "archive-fatigue-marker",
    });
    [{ id: recommendationId }] = await db
      .insert(recommendations)
      .values({
        userId,
        status: "pending",
        source: "rule",
        ruleId: "archive-test",
        sourceTemplateExerciseId: currentProgramSlotId,
        sourceSlotLineageId: currentProgramSlotLineageId,
        payload: {
          kind: "hold",
          templateExerciseId: currentProgramSlotId,
          reason: "test",
        },
        reason: "archive-recommendation-marker",
        evidence: { signals: {}, sessionIds: [sessionId], setIds: [setId] },
      })
      .returning({ id: recommendations.id });

    const activity = normalizeActivityInput(
      {
        activityType: "walk",
        title: "Archive test walk",
        startedAtISO: "2026-07-02T14:00:00.000Z",
        timezone: "America/Toronto",
        durationMinutes: 30,
        distanceValue: 2.5,
        distanceUnit: "km",
        intensity: null,
        elevationValue: null,
        elevationUnit: "m",
        averageHeartRateBpm: null,
        energyKcal: null,
        notes: "archive-activity-marker",
      },
      new Date("2026-07-03T00:00:00.000Z")
    );
    [{ id: activityId }] = await db
      .insert(healthActivities)
      .values({ userId, ...activity })
      .returning({ id: healthActivities.id });
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("archives an activity without releasing its identity and restores it once", async () => {
    const archived = await archiveActivityRecord(db, userId, activityId);
    expect(archived).toMatchObject({ ok: true, counts: { activities: 1 } });
    if (!archived.ok) throw new Error(archived.reason);

    const stored = await db.query.healthActivities.findFirst({
      where: (table, { eq }) => eq(table.id, activityId),
    });
    expect(stored?.archivedAt).toBeInstanceOf(Date);
    expect(stored?.archiveOperationId).toBe(archived.operationId);

    const [calendar, activityReport, digest, csv, backup, archiveList] =
      await Promise.all([
        getHistoryCalendarRecords(db, userId),
        getActivityReport(db, userId, "all", new Date("2026-07-04T00:00:00.000Z")),
        buildTrainingDigest(
          db,
          userId,
          new Date("2026-07-01T00:00:00.000Z"),
          new Date("2026-07-04T00:00:00.000Z")
        ),
        buildActivitiesCsv(db, userId, null),
        buildJsonBackup(db, userId),
        getArchiveList(db, userId, ["health_activity"]),
      ]);
    expect(calendar.filter((record) => record.recordType === "activity")).toHaveLength(0);
    expect(activityReport.overview.totalActivities).toBe(0);
    expect(digest.independentActivities.overview.totalActivities).toBe(0);
    expect(csv).not.toContain("archive-activity-marker");
    expect(backup.canonical.tables.health_activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: activityId,
          archive_operation_id: archived.operationId,
        }),
      ])
    );
    expect(archiveList).toHaveLength(1);

    await expect(
      db.insert(healthActivities).values({
        ...stored!,
        id: crypto.randomUUID(),
        archivedAt: null,
        archiveOperationId: null,
      })
    ).rejects.toThrow();

    const restored = await restoreArchiveOperation(db, userId, archived.operationId);
    expect(restored.ok).toBe(true);
    expect(
      (await getActivityReport(db, userId, "all")).overview.totalActivities
    ).toBe(1);
    expect((await restoreArchiveOperation(db, userId, archived.operationId)).ok).toBe(false);
  });

  it("archives one set while retaining the workout and restores the original set", async () => {
    const occurrence = await db.query.sessionOccurrences.findFirst({
      where: (table, { eq }) => eq(table.completedSetId, setId),
    });
    if (!occurrence) throw new Error("Set occurrence fixture missing.");
    for (const input of [
      {
        attachmentKind: "set" as const,
        body: "Pre-completion set note",
        completedSetId: null,
      },
      {
        attachmentKind: "occurrence" as const,
        body: "Occurrence-linked set observation",
      },
    ]) {
      const saved = await createContextualNote(db, userId, {
        clientKey: crypto.randomUUID(),
        body: input.body,
        coachVisible: true,
        inputMode: "typed",
        ...(input.attachmentKind === "set"
          ? {
              attachmentKind: "set" as const,
              sessionId,
              sessionExerciseId,
              occurrenceId: occurrence.id,
              completedSetId: input.completedSetId,
            }
          : {
              attachmentKind: "occurrence" as const,
              sessionId,
              occurrenceId: occurrence.id,
            }),
        capturedContext: {
          schemaVersion: 1,
          destination: "workout",
          workflow: "set archive dependency fixture",
          workoutPhase: "working",
          originatedFromSimulation: false,
          programDay: null,
          plannedExercise: null,
          performedExercise: null,
          occurrence: null,
          loadRepetitions: null,
          restContext: null,
          reviewContext: null,
        },
        recordedAt: "2026-07-01T14:31:00.000Z",
      });
      expect(saved.outcome).toBe("saved");
    }
    const archived = await archiveCompletedSetRecord(db, userId, setId);
    expect(archived).toMatchObject({
      ok: true,
      counts: {
        sets: 1,
        contextualNotes: 3,
        sessionOccurrences: 1,
        sessionOccurrenceMutations: 1,
        recordVersions: 0,
      },
    });
    if (!archived.ok) throw new Error(archived.reason);

    const setMembers = await db.query.archiveOperationRecords.findMany({
      where: (table, { eq }) => eq(table.operationId, archived.operationId),
    });
    expect(setMembers.map((member) => member.entityType).sort()).toEqual([
      "completed_set",
      "contextual_note",
      "contextual_note",
      "contextual_note",
      "session_occurrence",
      "session_occurrence_mutation",
    ]);

    const storedSet = await db.query.completedSets.findFirst({
      where: (table, { eq }) => eq(table.id, setId),
    });
    expect(storedSet?.archivedAt).toBeInstanceOf(Date);
    const [report, calendar, csv] = await Promise.all([
      getHistoryReport(db, userId, "all", 3),
      getHistoryCalendarRecords(db, userId),
      buildSetsCsv(db, userId, null),
    ]);
    expect(report.overview.completedSessions).toBe(1);
    expect(report.overview.workingSets).toBe(0);
    expect(calendar.filter((record) => record.recordType === "workout")).toHaveLength(1);
    expect(csv).not.toContain("archive-set-marker");

    expect((await restoreArchiveOperation(db, userId, archived.operationId)).ok).toBe(true);
    expect((await getHistoryReport(db, userId, "all", 3)).overview.workingSets).toBe(1);
    expect(await db.query.contextualNotes.findMany({
      where: (table, { eq }) => eq(table.occurrenceId, occurrence.id),
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: "archive-contextual-note-marker", archivedAt: null, archiveOperationId: null }),
      expect.objectContaining({ body: "Pre-completion set note", archivedAt: null, archiveOperationId: null }),
      expect.objectContaining({ body: "Occurrence-linked set observation", archivedAt: null, archiveOperationId: null }),
    ]));
  });

  it("archives a workout and all linked evidence without deleting any rows", async () => {
    const [progressionJob] = await db
      .insert(progressionJobs)
      .values({
        userId,
        sessionId,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      })
      .returning({ id: progressionJobs.id });
    await db.insert(progressionJobInputSessions).values({
      jobId: progressionJob.id,
      userId,
      sourceSlotLineageId: crypto.randomUUID(),
      sessionId,
      historyRevision: 0,
    });
    await db.insert(recordVersions).values([
      {
        userId,
        entityType: "workout_session",
        entityId: sessionId,
        action: "history.correct",
        beforeData: { status: "completed" },
        afterData: { status: "completed" },
      },
      {
        userId,
        entityType: "session_exercise",
        entityId: sessionExerciseId,
        action: "history.correct",
        beforeData: { target_reps_min: 5 },
        afterData: { target_reps_min: 5 },
      },
      {
        userId,
        entityType: "completed_set",
        entityId: setId,
        action: "history.correct",
        beforeData: { reps: 5 },
        afterData: { reps: 5 },
      },
    ]);
    const preview = await getWorkoutArchivePreview(db, userId, sessionId);
    expect(preview).toEqual({
      workouts: 1,
      sessionExerciseGroups: 1,
      exerciseOccurrences: 1,
      sessionOccurrences: 1,
      sessionOccurrenceMutations: 1,
      sets: 1,
      notes: 1,
      contextualNotes: 1,
      painLogs: 1,
      fatigueLogs: 1,
      coachingMessages: 0,
      recommendations: 1,
      progressionJobs: 1,
      progressionJobInputSessions: 1,
      recordVersions: 3,
    });

    const archived = await archiveWorkoutRecord(db, userId, sessionId);
    expect(archived).toMatchObject({ ok: true, counts: preview });
    if (!archived.ok) throw new Error(archived.reason);

    const workoutMemberTypes = (
      await db.query.archiveOperationRecords.findMany({
        where: (table, { eq }) => eq(table.operationId, archived.operationId),
      })
    ).map((member) => member.entityType);
    expect(workoutMemberTypes).toEqual(
      expect.arrayContaining([
        "session_exercise_group",
        "session_occurrence",
        "session_occurrence_mutation",
        "contextual_note",
        "record_version",
      ])
    );

    const [storedWorkout, storedSet, storedPain, storedFatigue, storedNote, storedRec] =
      await Promise.all([
        db.query.workoutSessions.findFirst({
          where: (table, { eq }) => eq(table.id, sessionId),
        }),
        db.query.completedSets.findFirst({
          where: (table, { eq }) => eq(table.id, setId),
        }),
        db.query.painLogs.findFirst({
          where: (table, { eq }) => eq(table.sessionId, sessionId),
        }),
        db.query.fatigueLogs.findFirst({
          where: (table, { eq }) => eq(table.sessionId, sessionId),
        }),
        db.query.sessionNotes.findFirst({
          where: (table, { eq }) => eq(table.sessionId, sessionId),
        }),
        db.query.recommendations.findFirst({
          where: (table, { eq }) => eq(table.id, recommendationId),
        }),
      ]);
    expect(storedWorkout?.archiveOperationId).toBe(archived.operationId);
    expect(storedSet).toBeTruthy();
    expect(storedPain).toBeTruthy();
    expect(storedFatigue).toBeTruthy();
    expect(storedNote).toBeTruthy();
    expect(storedRec?.archiveOperationId).toBe(archived.operationId);

    const [report, calendar, digest, setsCsv, recoveryCsv, contextualNotesCsv, backup] =
      await Promise.all([
        getHistoryReport(db, userId, "all", 3),
        getHistoryCalendarRecords(db, userId),
        buildTrainingDigest(
          db,
          userId,
          new Date("2026-07-01T00:00:00.000Z"),
          new Date("2026-07-04T00:00:00.000Z")
        ),
        buildSetsCsv(db, userId, null),
        buildPainFatigueCsv(db, userId, null),
        buildContextualNotesCsv(db, userId, null),
        buildJsonBackup(db, userId),
      ]);
    expect(report.overview.completedSessions).toBe(0);
    expect(calendar.filter((record) => record.recordType === "workout")).toHaveLength(0);
    expect(digest.sessions).toHaveLength(0);
    expect(digest.pain).toHaveLength(0);
    expect(digest.fatigue).toHaveLength(0);
    expect(digest.recommendations).toHaveLength(0);
    expect(setsCsv).not.toContain("archive-set-marker");
    expect(recoveryCsv).not.toContain("archive-pain-marker");
    expect(recoveryCsv).not.toContain("archive-fatigue-marker");
    expect(contextualNotesCsv).not.toContain("archive-contextual-note-marker");
    expect(backup.canonical.tables.workout_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sessionId,
          archive_operation_id: archived.operationId,
        }),
      ])
    );

    expect((await restoreArchiveOperation(db, userId, archived.operationId)).ok).toBe(true);
    const restoredReport = await getHistoryReport(db, userId, "all", 3);
    expect(restoredReport.overview.completedSessions).toBe(1);
    expect(restoredReport.overview.workingSets).toBe(1);
    expect(await getCompletedHistoryContextualNotes(db, userId, sessionId)).toEqual([
      expect.objectContaining({
        body: "archive-contextual-note-marker",
        attachmentKind: "set",
        coachVisible: false,
      }),
    ]);
    expect(
      await db.query.recommendations.findFirst({
        where: (table, { eq }) => eq(table.id, recommendationId),
      })
    ).toMatchObject({ archivedAt: null, archiveOperationId: null });
  });

  it("exports and archives immutable workout equipment evidence with its workout", async () => {
    const [equipmentSnapshot] = await db
      .insert(schema.sessionEquipmentSnapshots)
      .values({
        userId,
        sessionId,
        sessionExerciseId,
        equipmentLabel: "Bodyweight setup",
        profileKind: "bodyweight",
        geometryCertainty: "known",
        selectionProvenance: "user_selected",
        configurationRevision: 1,
        configurationHash: "b".repeat(64),
        geometryVersion: 1,
        geometrySnapshot: { version: 1, kind: "bodyweight" },
      })
      .returning({ id: schema.sessionEquipmentSnapshots.id });
    await db.insert(schema.sessionEquipmentSelectionReceipts).values({
      userId,
      sessionId,
      sessionExerciseId,
      clientKey: crypto.randomUUID(),
      operation: "select",
      canonicalPayloadHash: "c".repeat(64),
      resultingSnapshotId: equipmentSnapshot.id,
      resultCode: "applied",
    });
    await client.exec(
      "SELECT set_config('workout_tracker.authorized_delete', 'snapshot_restore', false)"
    );
    await db
      .update(completedSets)
      .set({
        equipmentSnapshotId: equipmentSnapshot.id,
        loadEntryMeaning: "total_system",
        observedCompletedAt: new Date("2026-07-13T14:42:00.000Z"),
        observedCompletionProvenance: "live_client",
        observedCompletionQuality: "trustworthy",
      })
      .where(eq(completedSets.id, setId));
    await db
      .update(sessionOccurrences)
      .set({ equipmentSnapshotId: equipmentSnapshot.id })
      .where(eq(sessionOccurrences.completedSetId, setId));
    await client.exec(
      "SELECT set_config('workout_tracker.authorized_delete', '', false)"
    );

    const csv = await buildSetsCsv(db, userId, null);
    expect(csv).toContain("equipment_snapshot_id");
    expect(csv).toContain("load_entry_meaning");
    expect(csv).toContain("history_revision");
    expect(csv).toContain("performed_time_precision");
    expect(csv).toContain("source_slot_lineage_id");
    expect(csv).toContain("logged_at");
    expect(csv).toContain("observed_completed_at");
    expect(csv).toContain("observed_completion_provenance");
    expect(csv).toContain("observed_completion_quality");
    expect(csv).toContain("2026-07-13T14:42:00.000Z");
    expect(csv).toContain("live_client");
    expect(csv).toContain("trustworthy");
    expect(csv).toContain("Bodyweight setup");
    expect(csv).toContain("total_system");

    const archived = await archiveWorkoutRecord(db, userId, sessionId);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error(archived.reason);
    expect(
      await db.query.archiveOperations.findFirst({
        where: (table, { eq }) => eq(table.id, archived.operationId),
      })
    ).toMatchObject({
      recordCounts: {
        sessionEquipmentSnapshots: 1,
        sessionEquipmentSelectionReceipts: 1,
      },
    });
    const equipmentMembers = (
      await db.query.archiveOperationRecords.findMany({
        where: (table, { eq }) => eq(table.operationId, archived.operationId),
      })
    )
      .filter((member) => member.entityType.startsWith("session_equipment_"))
      .map((member) => member.entityType)
      .sort();
    expect(equipmentMembers).toEqual([
      "session_equipment_selection_receipt",
      "session_equipment_snapshot",
    ]);
  });

  it("archives and restores a complete import batch while preserving its recovery evidence", async () => {
    const [importEvent] = await db
      .insert(importEvents)
      .values({
        userId,
        source: "csv",
        rawPayload: "archive-import-file-marker",
        parsedPayload: {
          exercises: [{ key: "archive-test-squat", rawName: exerciseName }],
          warnings: [{ code: "test-warning" }],
        },
        status: "confirmed",
      })
      .returning({ id: importEvents.id });
    const fileHash = crypto.randomUUID().replaceAll("-", "");
    const [batch] = await db
      .insert(historyImportBatches)
      .values({
        userId,
        importEventId: importEvent.id,
        source: "hevy",
        originalFilename: "archive-import.csv",
        fileHash,
        timezone: "America/Toronto",
        status: "confirmed",
        summary: {
          workouts: 1,
          exerciseOccurrences: 1,
          sets: 1,
          warmupSets: 0,
          supersetGroups: 0,
          excludedExercises: 0,
          warnings: 2,
        },
      })
      .returning({ id: historyImportBatches.id });
    await Promise.all([
      db
        .update(workoutSessions)
        .set({
          importBatchId: batch.id,
          source: "hevy",
          sourceWorkoutKey: "archive-import-workout",
        })
        .where(eq(workoutSessions.id, sessionId)),
      db
        .update(exercises)
        .set({ createdFromImportEventId: importEvent.id, userId })
        .where(eq(exercises.id, exerciseId)),
      db.insert(externalExerciseMappings).values({
        userId,
        source: "hevy",
        sourceName: exerciseName,
        normalizedKey: "archive-test-squat",
        exerciseId,
      }),
    ]);

    const preview = await getImportBatchArchivePreview(db, userId, batch.id);
    expect(preview).toEqual({
      importBatches: 1,
      importFiles: 1,
      workouts: 1,
      previouslyArchivedWorkouts: 0,
      sessionExerciseGroups: 1,
      exerciseOccurrences: 1,
      sessionOccurrences: 1,
      sessionOccurrenceMutations: 1,
      sets: 1,
      notes: 1,
      contextualNotes: 1,
      painLogs: 1,
      fatigueLogs: 1,
      coachingMessages: 0,
      recommendations: 1,
      progressionJobs: 0,
      progressionJobInputSessions: 0,
      recordVersions: 0,
      reviewedMappings: 1,
      reviewDecisions: 1,
      customExercises: 1,
      warnings: 2,
    });

    const staleAttempt = await archiveImportBatchRecord(db, userId, batch.id, {
      ...preview!,
      sets: preview!.sets + 1,
    });
    expect(staleAttempt.ok).toBe(false);
    expect(
      (await db.query.historyImportBatches.findFirst({
        where: (table, { eq }) => eq(table.id, batch.id),
      }))?.archivedAt
    ).toBeNull();

    const archived = await archiveImportBatchRecord(db, userId, batch.id, preview!);
    expect(archived).toMatchObject({ ok: true, counts: preview });
    if (!archived.ok) throw new Error(archived.reason);

    const importMemberTypes = (
      await db.query.archiveOperationRecords.findMany({
        where: (table, { eq }) => eq(table.operationId, archived.operationId),
      })
    ).map((member) => member.entityType);
    expect(importMemberTypes).toEqual(
      expect.arrayContaining([
        "session_exercise_group",
        "session_occurrence",
        "session_occurrence_mutation",
        "contextual_note",
      ])
    );

    const [storedBatch, storedSession, storedImport, storedMapping, storedExercise] =
      await Promise.all([
        db.query.historyImportBatches.findFirst({
          where: (table, { eq }) => eq(table.id, batch.id),
        }),
        db.query.workoutSessions.findFirst({
          where: (table, { eq }) => eq(table.id, sessionId),
        }),
        db.query.importEvents.findFirst({
          where: (table, { eq }) => eq(table.id, importEvent.id),
        }),
        db.query.externalExerciseMappings.findFirst({
          where: (table, { eq }) => eq(table.normalizedKey, "archive-test-squat"),
        }),
        db.query.exercises.findFirst({
          where: (table, { eq }) => eq(table.id, exerciseId),
        }),
      ]);
    expect(storedBatch).toMatchObject({
      status: "confirmed",
      archiveOperationId: archived.operationId,
      fileHash,
    });
    expect(storedSession?.archiveOperationId).toBe(archived.operationId);
    expect(storedImport).toMatchObject({
      rawPayload: "archive-import-file-marker",
      status: "confirmed",
    });
    expect(storedMapping?.exerciseId).toBe(exerciseId);
    expect(storedExercise?.createdFromImportEventId).toBe(importEvent.id);

    const [report, backup, archiveList] = await Promise.all([
      getHistoryReport(db, userId, "all", 3),
      buildJsonBackup(db, userId),
      getArchiveList(db, userId, ["history_import_batch"]),
    ]);
    expect(report.overview.completedSessions).toBe(0);
    expect(backup.canonical.tables.history_import_batches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: batch.id,
          archive_operation_id: archived.operationId,
          file_hash: fileHash,
        }),
      ])
    );
    expect(backup.canonical.tables.import_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: importEvent.id,
          raw_payload: "",
          parsed_payload: null,
          payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ])
    );
    expect(backup.canonical.tables.external_exercise_mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalized_key: "archive-test-squat",
          exercise_id: exerciseId,
        }),
      ])
    );
    expect(archiveList).toHaveLength(1);

    await expect(
      db.insert(historyImportBatches).values({
        userId,
        importEventId: importEvent.id,
        source: "hevy",
        originalFilename: "duplicate.csv",
        fileHash,
        timezone: "America/Toronto",
        status: "confirmed",
        summary: storedBatch!.summary,
      })
    ).rejects.toThrow();

    expect((await restoreArchiveOperation(db, userId, archived.operationId)).ok).toBe(
      true
    );
    expect((await getHistoryReport(db, userId, "all", 3)).overview.completedSessions).toBe(
      1
    );
    expect(
      await db.query.historyImportBatches.findFirst({
        where: (table, { eq }) => eq(table.id, batch.id),
      })
    ).toMatchObject({
      status: "confirmed",
      archivedAt: null,
      archiveOperationId: null,
      fileHash,
    });
  });

  it("does not take ownership of workouts or sets archived before their import batch", async () => {
    const [importEvent] = await db
      .insert(importEvents)
      .values({
        userId,
        source: "csv",
        rawPayload: "nested-archive-file",
        parsedPayload: { exercises: [{ key: "archive-test-squat" }] },
        status: "confirmed",
      })
      .returning({ id: importEvents.id });
    const [batch] = await db
      .insert(historyImportBatches)
      .values({
        userId,
        importEventId: importEvent.id,
        source: "hevy",
        originalFilename: "nested-archive.csv",
        fileHash: crypto.randomUUID().replaceAll("-", ""),
        timezone: "America/Toronto",
        status: "confirmed",
        summary: {
          workouts: 1,
          exerciseOccurrences: 1,
          sets: 1,
          warmupSets: 0,
          supersetGroups: 0,
          excludedExercises: 0,
          warnings: 0,
        },
      })
      .returning({ id: historyImportBatches.id });
    await db
      .update(workoutSessions)
      .set({ importBatchId: batch.id, source: "hevy" })
      .where(eq(workoutSessions.id, sessionId));

    const setArchive = await archiveCompletedSetRecord(db, userId, setId);
    const workoutArchive = await archiveWorkoutRecord(db, userId, sessionId);
    if (!setArchive.ok || !workoutArchive.ok) {
      throw new Error("Nested archive setup failed.");
    }

    expect(await getImportBatchArchivePreview(db, userId, batch.id)).toMatchObject({
      workouts: 0,
      previouslyArchivedWorkouts: 1,
      sets: 0,
      recommendations: 0,
    });
    const batchArchive = await archiveImportBatchRecord(db, userId, batch.id);
    if (!batchArchive.ok) throw new Error(batchArchive.reason);
    expect(batchArchive.counts).toMatchObject({
      importBatches: 1,
      workouts: 0,
      previouslyArchivedWorkouts: 1,
    });

    expect((await restoreArchiveOperation(db, userId, batchArchive.operationId)).ok).toBe(
      true
    );
    expect(
      await db.query.workoutSessions.findFirst({
        where: (table, { eq }) => eq(table.id, sessionId),
      })
    ).toMatchObject({ archiveOperationId: workoutArchive.operationId });

    expect((await restoreArchiveOperation(db, userId, workoutArchive.operationId)).ok).toBe(
      true
    );
    expect(
      await db.query.completedSets.findFirst({
        where: (table, { eq }) => eq(table.id, setId),
      })
    ).toMatchObject({ archiveOperationId: setArchive.operationId });
    expect((await restoreArchiveOperation(db, userId, setArchive.operationId)).ok).toBe(
      true
    );
  });
});
