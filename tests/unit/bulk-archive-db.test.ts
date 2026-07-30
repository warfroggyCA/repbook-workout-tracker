import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import {
  completedSets,
  exercises,
  fatigueLogs,
  healthActivities,
  painLogs,
  recommendations,
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
  archiveAllManualActivityRecords,
  archiveSampleHistoryRecords,
  getArchiveList,
  getBulkActivityArchivePreview,
  getSampleHistoryArchivePreview,
  restoreArchiveOperation,
} from "@/services/archive";
import { getActivityReport } from "@/services/activity-report";
import { activateProgramAtomically } from "@/services/program-activation";
import { getHistoryReport } from "@/services/history-report";
import { buildActivitiesCsv, buildSetsCsv } from "@/services/export";
import { TEST_DATA_PREFIX } from "@/services/workout-test-data";

const NOW = new Date("2026-07-08T00:00:00.000Z");

function manualActivity(startedAtISO: string, title: string, notes: string) {
  return normalizeActivityInput(
    {
      activityType: "walk",
      title,
      startedAtISO,
      timezone: "America/Toronto",
      durationMinutes: 30,
      distanceValue: 2,
      distanceUnit: "km",
      intensity: null,
      elevationValue: null,
      elevationUnit: "m",
      averageHeartRateBpm: null,
      energyKcal: null,
      notes,
    },
    NOW
  );
}

describe("bulk archive database lifecycle", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let manualIds: string[];
  let importedActivityId: string;
  let preArchivedActivityId: string;
  let preArchivedOperationId: string;
  let sampleSessionIds: string[];
  let realSessionId: string;
  let sampleRecommendationId: string;
  let realRecommendationId: string;
  let currentProgramSlotId: string;
  let currentProgramSlotLineageId: string;

  async function insertWorkout(templateName: string, note: string) {
    const [exercise] = await db
      .insert(exercises)
      .values({
        name: `Bulk Archive Row ${crypto.randomUUID()}`,
        movementPattern: "horizontal_pull",
        primaryMuscles: ["lats"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    const [session] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName,
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
        sessionId: session.id,
        exerciseId: exercise.id,
        orderIdx: 0,
      })
      .returning({ id: sessionExercises.id });
    const [completedSet] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: 95,
        weightUnit: "lb",
        reps: 8,
        note,
      })
      .returning({ id: completedSets.id });
    await db.insert(sessionExerciseGroups).values({
      sessionId: session.id,
      provenance: "legacy",
      name: "Bulk archive fixture group",
      orderIdx: 0,
    });
    const [occurrence] = await db
      .insert(sessionOccurrences)
      .values({
        sessionId: session.id,
        sessionExerciseId: sessionExercise.id,
        kind: "working_set",
        origin: "legacy",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
        outcome: "completed",
        revision: 1,
        resolvedAt: new Date("2026-07-01T14:30:00.000Z"),
        completedSetId: completedSet.id,
      })
      .returning({ id: sessionOccurrences.id });
    await db.insert(sessionOccurrenceMutations).values({
      occurrenceId: occurrence.id,
      clientKey: crypto.randomUUID(),
      operation: "complete",
      canonicalPayloadHash: "b".repeat(64),
      expectedRevision: 0,
      resultingRevision: 1,
      resultCode: "applied",
    });
    await db.insert(sessionNotes).values({ sessionId: session.id, text: note });
    await db.insert(painLogs).values({
      userId,
      sessionId: session.id,
      bodyPart: "elbow",
      severity: 2,
    });
    await db.insert(fatigueLogs).values({
      userId,
      sessionId: session.id,
      severity: 3,
    });
    return session.id;
  }

  async function insertRecommendation(sessionId: string, reason: string) {
    const [row] = await db
      .insert(recommendations)
      .values({
        userId,
        status: "pending",
        source: "rule",
        ruleId: "bulk-archive-test",
        sourceTemplateExerciseId: currentProgramSlotId,
        sourceSlotLineageId: currentProgramSlotLineageId,
        payload: {
          kind: "hold",
          templateExerciseId: currentProgramSlotId,
          reason: "test",
        },
        reason,
        evidence: { signals: {}, sessionIds: [sessionId], setIds: [] },
      })
      .returning({ id: recommendations.id });
    return row.id;
  }

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });

    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `bulk-archive-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values({ userId });
    const [programExercise] = await db
      .insert(exercises)
      .values({
        name: `Bulk archive Program exercise ${crypto.randomUUID()}`,
        movementPattern: "horizontal_pull",
        primaryMuscles: ["lats"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    const activated = await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Bulk archive fixture Program",
      days: [{
        name: "Bulk archive day",
        exercises: [{
          exerciseId: programExercise.id,
          sets: 3,
          repMin: 6,
          repMax: 8,
          targetLoad: 95,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Bulk archive fixture",
      auditAction: "program.activate",
      auditSummary: "Activated bulk archive fixture",
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

    manualIds = [];
    for (const [index, startedAt] of [
      "2026-07-02T14:00:00.000Z",
      "2026-07-03T14:00:00.000Z",
    ].entries()) {
      const [row] = await db
        .insert(healthActivities)
        .values({
          userId,
          ...manualActivity(startedAt, `Bulk walk ${index}`, `bulk-activity-marker-${index}`),
        })
        .returning({ id: healthActivities.id });
      manualIds.push(row.id);
    }
    [{ id: importedActivityId }] = await db
      .insert(healthActivities)
      .values({
        userId,
        ...manualActivity(
          "2026-07-04T14:00:00.000Z",
          "Imported ride",
          "imported-activity-marker"
        ),
        source: "hevy",
        fingerprint: `imported-${crypto.randomUUID()}`,
      })
      .returning({ id: healthActivities.id });
    [{ id: preArchivedActivityId }] = await db
      .insert(healthActivities)
      .values({
        userId,
        ...manualActivity(
          "2026-07-05T14:00:00.000Z",
          "Earlier archived walk",
          "pre-archived-activity-marker"
        ),
        fingerprint: `pre-archived-${crypto.randomUUID()}`,
      })
      .returning({ id: healthActivities.id });
    const preArchived = await archiveActivityRecord(
      db,
      userId,
      preArchivedActivityId
    );
    if (!preArchived.ok) throw new Error(preArchived.reason);
    preArchivedOperationId = preArchived.operationId;

    sampleSessionIds = [
      await insertWorkout(`${TEST_DATA_PREFIX}Day 1 — Sample`, "sample-set-marker-1"),
      await insertWorkout(`${TEST_DATA_PREFIX}Day 2 — Sample`, "sample-set-marker-2"),
    ];
    realSessionId = await insertWorkout("Real training day", "real-set-marker");
    sampleRecommendationId = await insertRecommendation(
      sampleSessionIds[0],
      "sample-recommendation-marker"
    );
    realRecommendationId = await insertRecommendation(
      realSessionId,
      "real-recommendation-marker"
    );
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("bulk-archives every active manual activity atomically and restores them once", async () => {
    const preview = await getBulkActivityArchivePreview(db, userId);
    expect(preview).toMatchObject({ activities: 2 });
    expect(preview.earliest).toBeTruthy();
    expect(preview.latest).toBeTruthy();

    const archived = await archiveAllManualActivityRecords(
      db,
      userId,
      preview.activities
    );
    expect(archived).toMatchObject({ ok: true, counts: { activities: 2 } });
    if (!archived.ok) throw new Error(archived.reason);

    // Every row is retained with the operation stamped on it.
    for (const id of manualIds) {
      const stored = await db.query.healthActivities.findFirst({
        where: (table, { eq }) => eq(table.id, id),
      });
      expect(stored?.archivedAt).toBeInstanceOf(Date);
      expect(stored?.archiveOperationId).toBe(archived.operationId);
    }
    // Imported and previously archived activities are not claimed.
    const imported = await db.query.healthActivities.findFirst({
      where: (table, { eq }) => eq(table.id, importedActivityId),
    });
    expect(imported?.archivedAt).toBeNull();
    const preArchived = await db.query.healthActivities.findFirst({
      where: (table, { eq }) => eq(table.id, preArchivedActivityId),
    });
    expect(preArchived?.archiveOperationId).toBe(preArchivedOperationId);

    const [report, csv, archiveList, combinedList] = await Promise.all([
      getActivityReport(db, userId, "all", NOW),
      buildActivitiesCsv(db, userId, null),
      getArchiveList(db, userId, ["activity_history"]),
      getArchiveList(db, userId, ["health_activity", "activity_history"]),
    ]);
    // Only the imported activity stays visible in ordinary reports.
    expect(report.overview.totalActivities).toBe(1);
    expect(csv).not.toContain("bulk-activity-marker");
    expect(archiveList).toHaveLength(1);
    expect(archiveList[0].summary).toContain("Archived all 2 manual activities");
    // The Activities filter shows the earlier single archive and the bulk one.
    expect(combinedList).toHaveLength(2);

    // Archived fingerprints stay reserved.
    const stored = await db.query.healthActivities.findFirst({
      where: (table, { eq }) => eq(table.id, manualIds[0]),
    });
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
      (await getActivityReport(db, userId, "all", NOW)).overview.totalActivities
    ).toBe(3);
    // The activity archived by the earlier operation stays archived.
    const stillArchived = await db.query.healthActivities.findFirst({
      where: (table, { eq }) => eq(table.id, preArchivedActivityId),
    });
    expect(stillArchived?.archivedAt).toBeInstanceOf(Date);
    // The bulk operation cannot be restored twice.
    expect(
      (await restoreArchiveOperation(db, userId, archived.operationId)).ok
    ).toBe(false);
  });

  it("refuses a stale activity confirmation and an empty scope without changes", async () => {
    const stale = await archiveAllManualActivityRecords(db, userId, 3);
    expect(stale.ok).toBe(false);
    const zero = await archiveAllManualActivityRecords(db, userId, 0);
    expect(zero.ok).toBe(false);
    const report = await getActivityReport(db, userId, "all", NOW);
    expect(report.overview.totalActivities).toBe(3);
    expect(await getArchiveList(db, userId, ["activity_history"])).toHaveLength(0);
  });

  it("bulk-archives the sample history exactly and leaves real records alone", async () => {
    const preview = await getSampleHistoryArchivePreview(db, userId);
    expect(preview).toEqual({
      workouts: 2,
      sessionExerciseGroups: 2,
      exerciseOccurrences: 2,
      sessionOccurrences: 2,
      sessionOccurrenceMutations: 2,
      sets: 2,
      notes: 2,
      contextualNotes: 0,
      painLogs: 2,
      fatigueLogs: 2,
      coachingMessages: 0,
      recommendations: 1,
      progressionJobs: 0,
      progressionJobInputSessions: 0,
      recordVersions: 0,
    });

    // A stale confirmation makes no changes.
    const stale = await archiveSampleHistoryRecords(db, userId, {
      ...preview,
      sets: preview.sets + 1,
    });
    expect(stale.ok).toBe(false);
    expect(await getArchiveList(db, userId, ["sample_history"])).toHaveLength(0);

    const archived = await archiveSampleHistoryRecords(db, userId, preview);
    expect(archived).toMatchObject({
      ok: true,
      counts: {
        workouts: 2,
        sessionExerciseGroups: 2,
        sessionOccurrences: 2,
        sessionOccurrenceMutations: 2,
        sets: 2,
        recommendations: 1,
      },
    });
    if (!archived.ok) throw new Error(archived.reason);

    const sampleMemberTypes = (
      await db.query.archiveOperationRecords.findMany({
        where: (table, { eq }) => eq(table.operationId, archived.operationId),
      })
    ).map((member) => member.entityType);
    expect(sampleMemberTypes).toEqual(
      expect.arrayContaining([
        "session_exercise_group",
        "session_occurrence",
        "session_occurrence_mutation",
      ])
    );

    for (const id of sampleSessionIds) {
      const stored = await db.query.workoutSessions.findFirst({
        where: (table, { eq }) => eq(table.id, id),
      });
      expect(stored?.archivedAt).toBeInstanceOf(Date);
      expect(stored?.archiveOperationId).toBe(archived.operationId);
    }
    const realSession = await db.query.workoutSessions.findFirst({
      where: (table, { eq }) => eq(table.id, realSessionId),
    });
    expect(realSession?.archivedAt).toBeNull();
    const sampleRecommendation = await db.query.recommendations.findFirst({
      where: (table, { eq }) => eq(table.id, sampleRecommendationId),
    });
    expect(sampleRecommendation?.archivedAt).toBeInstanceOf(Date);
    const realRecommendation = await db.query.recommendations.findFirst({
      where: (table, { eq }) => eq(table.id, realRecommendationId),
    });
    expect(realRecommendation?.archivedAt).toBeNull();

    const [report, csv] = await Promise.all([
      getHistoryReport(db, userId, "all", 3),
      buildSetsCsv(db, userId, null),
    ]);
    expect(report.overview.completedSessions).toBe(1);
    expect(csv).not.toContain("sample-set-marker");
    expect(csv).toContain("real-set-marker");

    const restored = await restoreArchiveOperation(db, userId, archived.operationId);
    expect(restored.ok).toBe(true);
    expect(
      (await getHistoryReport(db, userId, "all", 3)).overview.completedSessions
    ).toBe(3);
    expect(
      (await getSampleHistoryArchivePreview(db, userId)).workouts
    ).toBe(2);
  });
});
