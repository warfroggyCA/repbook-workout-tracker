import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  completedSets,
  constraints,
  exercises,
  painLogs,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import { workoutLocalDate } from "@/lib/workout-calendar";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  getHistoryCalendarRecords,
  getHistoryReport,
} from "@/services/history-report";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("History lens database evidence", () => {
  let database: TestDatabase;
  let ownerId: string;
  let otherOwnerId: string;
  let benchId: string;
  let overheadPressId: string;
  let landminePressId: string;
  let rowId: string;
  let assistedPullupId: string;
  let benchName: string;
  let assistedPullupName: string;
  let templateId: string;
  let slotByExerciseId: Map<string, string>;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: ownerId }, { id: otherOwnerId }] = await database.db
      .insert(users)
      .values([
        { email: `history-lens-owner-${crypto.randomUUID()}@example.com` },
        { email: `history-lens-other-${crypto.randomUUID()}@example.com` },
      ])
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values([
      { userId: ownerId, unit: "lb", timezone: "America/Toronto" },
      { userId: otherOwnerId, unit: "lb", timezone: "America/Toronto" },
    ]);

    const exerciseRows = await database.db
      .insert(exercises)
      .values([
        {
          name: `Lens Bench ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push" as const,
          primaryMuscles: ["chest"],
          loadType: "barbell",
          metricType: "weight_reps" as const,
          loadSemantics: "total" as const,
        },
        {
          name: `Lens Overhead Press ${crypto.randomUUID()}`,
          movementPattern: "vertical_push" as const,
          primaryMuscles: ["shoulders"],
          loadType: "barbell",
          metricType: "weight_reps" as const,
          loadSemantics: "total" as const,
        },
        {
          name: `Lens Landmine Press ${crypto.randomUUID()}`,
          movementPattern: "vertical_push" as const,
          primaryMuscles: ["shoulders"],
          loadType: "external",
          metricType: "weight_reps" as const,
          loadSemantics: "total" as const,
        },
        {
          name: `Lens Row ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull" as const,
          primaryMuscles: ["back"],
          loadType: "external",
          metricType: "weight_reps" as const,
          loadSemantics: "total" as const,
        },
        {
          name: `Lens Assisted Pull-up ${crypto.randomUUID()}`,
          movementPattern: "vertical_pull" as const,
          primaryMuscles: ["back"],
          loadType: "machine",
          metricType: "assisted_reps" as const,
          loadSemantics: "assistance" as const,
        },
      ])
      .returning({ id: exercises.id, name: exercises.name });
    [
      benchId,
      overheadPressId,
      landminePressId,
      rowId,
      assistedPullupId,
    ] = exerciseRows.map((exercise) => exercise.id);
    benchName = exerciseRows[0].name;
    assistedPullupName = exerciseRows[4].name;

    const activated = await activateProgramAtomically(database.db, {
      userId: ownerId,
      loadUnit: "lb",
      programName: "History lens Program",
      days: [
        {
          name: "Lens day",
          exercises: [benchId, overheadPressId, rowId].map((exerciseId) => ({
            exerciseId,
            sets: 1,
            repMin: 5,
            repMax: 10,
            targetLoad: 100,
            restSec: 90,
            supersetKey: null,
            notes: null,
          })),
        },
      ],
      changeSummary: "History lens fixture",
      auditAction: "program.activate",
      auditSummary: "Activated History lens fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    const template = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, activated.programVersionId),
    });
    if (!template) throw new Error("History lens template missing.");
    templateId = template.id;
    const slots = await database.db.query.workoutTemplateExercises.findMany({
      where: eq(workoutTemplateExercises.workoutTemplateId, template.id),
    });
    slotByExerciseId = new Map(
      slots.map((slot) => [slot.exerciseId, slot.id]),
    );
  }, 30_000);

  afterEach(async () => database.close());

  async function createSession(input: {
    ownerId: string;
    startedAt: Date;
    templateId?: string | null;
    name: string;
  }) {
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId: input.ownerId,
        templateId: input.templateId ?? null,
        templateName: input.name,
        status: "completed",
        startedAt: input.startedAt,
        finishedAt: new Date(input.startedAt.getTime() + 45 * 60_000),
        timezone: "America/Toronto",
        localDate: workoutLocalDate(input.startedAt, "America/Toronto"),
      })
      .returning({ id: workoutSessions.id });
    return session.id;
  }

  it("keeps Program, pain, record, owner, and archive boundaries honest in one report read", async () => {
    const firstSessionId = await createSession({
      ownerId,
      templateId,
      name: "Lens linked day",
      startedAt: new Date("2026-06-01T14:00:00.000Z"),
    });
    const linkedOccurrences = await database.db
      .insert(sessionExercises)
      .values([
        {
          sessionId: firstSessionId,
          exerciseId: benchId,
          plannedFromTemplateExerciseId: slotByExerciseId.get(benchId),
          modificationType: "as_planned" as const,
          orderIdx: 0,
        },
        {
          sessionId: firstSessionId,
          exerciseId: landminePressId,
          plannedFromTemplateExerciseId: slotByExerciseId.get(overheadPressId),
          modificationType: "substituted" as const,
          substitutedForExerciseId: overheadPressId,
          substitutionReason: "discomfort" as const,
          orderIdx: 1,
        },
        {
          sessionId: firstSessionId,
          exerciseId: rowId,
          plannedFromTemplateExerciseId: slotByExerciseId.get(rowId),
          modificationType: "skipped" as const,
          skipReason: "pain" as const,
          orderIdx: 2,
        },
        {
          sessionId: firstSessionId,
          exerciseId: assistedPullupId,
          modificationType: "added" as const,
          orderIdx: 3,
        },
      ])
      .returning({ id: sessionExercises.id, exerciseId: sessionExercises.exerciseId });
    const firstOccurrenceByExercise = new Map(
      linkedOccurrences.map((occurrence) => [occurrence.exerciseId, occurrence.id]),
    );
    const firstBenchSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId: ownerId,
        sessionId: firstSessionId,
        sessionExerciseId: firstOccurrenceByExercise.get(benchId)!,
        unit: "lb",
      },
    );
    const assistedSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId: ownerId,
        sessionId: firstSessionId,
        sessionExerciseId: firstOccurrenceByExercise.get(assistedPullupId)!,
        unit: "lb",
        label: "Test assistance machine",
      },
    );
    await database.db.insert(completedSets).values([
      {
        sessionExerciseId: firstOccurrenceByExercise.get(benchId)!,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 10,
        equipmentSnapshotId: firstBenchSnapshotId,
        loadEntryMeaning: "total_system",
      },
      {
        sessionExerciseId: firstOccurrenceByExercise.get(benchId)!,
        setNo: 2,
        weight: 500,
        weightUnit: "lb",
        reps: 10,
        isWarmup: true,
        equipmentSnapshotId: firstBenchSnapshotId,
        loadEntryMeaning: "total_system",
      },
      {
        sessionExerciseId: firstOccurrenceByExercise.get(benchId)!,
        setNo: 3,
        weight: 400,
        weightUnit: "lb",
        reps: 10,
        excludeFromAnalytics: true,
        equipmentSnapshotId: firstBenchSnapshotId,
        loadEntryMeaning: "total_system",
      },
      {
        sessionExerciseId: firstOccurrenceByExercise.get(landminePressId)!,
        setNo: 1,
        weight: 45,
        weightUnit: "lb",
        reps: 8,
      },
      {
        sessionExerciseId: firstOccurrenceByExercise.get(assistedPullupId)!,
        setNo: 1,
        weight: 150,
        weightUnit: "lb",
        reps: 10,
        metricType: "assisted_reps",
        equipmentSnapshotId: assistedSnapshotId,
        loadEntryMeaning: "displayed_stack",
        targetMet: true,
      },
    ]);

    const secondSessionId = await createSession({
      ownerId,
      templateId,
      name: "Lens linked follow-up",
      startedAt: new Date("2026-06-08T14:00:00.000Z"),
    });
    const [secondBench] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: secondSessionId,
        exerciseId: benchId,
        plannedFromTemplateExerciseId: slotByExerciseId.get(benchId),
        modificationType: "as_planned",
        orderIdx: 0,
      })
      .returning({ id: sessionExercises.id });
    const secondBenchSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId: ownerId,
        sessionId: secondSessionId,
        sessionExerciseId: secondBench.id,
        unit: "lb",
      },
    );
    await database.db.insert(completedSets).values({
      sessionExerciseId: secondBench.id,
      setNo: 1,
      weight: 105,
      weightUnit: "lb",
      reps: 10,
      equipmentSnapshotId: secondBenchSnapshotId,
      loadEntryMeaning: "total_system",
    });

    const importedSessionId = await createSession({
      ownerId,
      templateId: null,
      name: "Imported strength history",
      startedAt: new Date("2026-06-15T14:00:00.000Z"),
    });
    const [importedBench] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: importedSessionId,
        exerciseId: benchId,
        modificationType: "added",
        orderIdx: 0,
      })
      .returning({ id: sessionExercises.id });
    const importedBenchSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId: ownerId,
        sessionId: importedSessionId,
        sessionExerciseId: importedBench.id,
        unit: "lb",
      },
    );
    const [importedRecordSet] = await database.db
      .insert(completedSets)
      .values({
        sessionExerciseId: importedBench.id,
        setNo: 1,
        weight: 200,
        weightUnit: "lb",
        reps: 1,
        equipmentSnapshotId: importedBenchSnapshotId,
        loadEntryMeaning: "total_system",
      })
      .returning({ id: completedSets.id });

    const [firstPain, secondPain, sessionOnlyPain] = await database.db
      .insert(painLogs)
      .values([
        {
          userId: ownerId,
          sessionId: firstSessionId,
          exerciseId: benchId,
          bodyPart: "shoulder",
          severity: 4,
        },
        {
          userId: ownerId,
          sessionId: secondSessionId,
          exerciseId: benchId,
          bodyPart: "shoulder",
          severity: 3,
        },
        {
          userId: ownerId,
          sessionId: firstSessionId,
          exerciseId: null,
          bodyPart: "knee",
          severity: 2,
        },
      ])
      .returning({ id: painLogs.id });
    expect(firstPain.id).toBeTruthy();
    expect(secondPain.id).toBeTruthy();
    await database.db.insert(constraints).values({
      userId: ownerId,
      bodyPart: "shoulder",
      affectedPatterns: ["vertical_push"],
      cautious: true,
    });

    const otherSessionId = await createSession({
      ownerId: otherOwnerId,
      templateId: null,
      name: "Other owner history",
      startedAt: new Date("2026-06-20T14:00:00.000Z"),
    });
    const [otherOccurrence] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: otherSessionId,
        exerciseId: benchId,
        modificationType: "added",
        orderIdx: 0,
      })
      .returning({ id: sessionExercises.id });
    await database.db.insert(completedSets).values({
      sessionExerciseId: otherOccurrence.id,
      setNo: 1,
      weight: 999,
      weightUnit: "lb",
      reps: 10,
    });
    await database.db.insert(painLogs).values({
      userId: otherOwnerId,
      sessionId: otherSessionId,
      exerciseId: benchId,
      bodyPart: "shoulder",
      severity: 10,
    });

    await database.db.execute(sql`
      INSERT INTO session_occurrences (
        session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, resolved_at, completed_set_id,
        equipment_snapshot_id
      )
      SELECT
        exercise.session_id,
        result.session_exercise_id,
        'working_set',
        'legacy',
        row_number() OVER (
          PARTITION BY exercise.session_id ORDER BY exercise.order_idx, result.set_no, result.id
        )::integer - 1,
        row_number() OVER (
          PARTITION BY result.session_exercise_id ORDER BY result.set_no, result.id
        )::integer - 1,
        exercise.exercise_id,
        'completed',
        coalesce(session.finished_at, session.started_at),
        result.id,
        result.equipment_snapshot_id
      FROM completed_sets result
      JOIN session_exercises exercise ON exercise.id = result.session_exercise_id
      JOIN workout_sessions session ON session.id = exercise.session_id
      WHERE result.archived_at IS NULL AND NOT result.is_warmup
    `);

    const now = new Date("2026-07-17T12:00:00.000Z");
    const report = await getHistoryReport(database.db, ownerId, "all", 3, now, {
      timezone: "America/Toronto",
      unit: "lb",
    });
    const programFit = report.lenses.find((lens) => lens.key === "program-fit")!;
    const pain = report.lenses.find((lens) => lens.key === "pain-constraints")!;
    const records = report.lenses.find((lens) => lens.key === "records")!;
    const benchProgress = report.exerciseProgress.find(
      (exercise) => exercise.exerciseId === benchId,
    );
    const benchRecord = report.records.find(
      (record) => record.exerciseId === benchId,
    );
    const assistedProgress = report.exerciseProgress.find(
      (exercise) => exercise.exerciseId === assistedPullupId,
    );

    expect(programFit.answer).toContain("2 Program workouts completed");
    expect(programFit.answer).toContain("2 exercise changes");
    expect(programFit.evidence.some((item) => item.value.includes("2 as planned"))).toBe(
      true,
    );
    expect(programFit.evidence.some((item) => item.value === "1 workout")).toBe(
      true,
    );
    expect(programFit.limitation).toContain("Deferred workouts are not recorded");

    expect(pain.answer).toContain(benchName);
    expect(pain.answer).toContain("Shoulder");
    expect(pain.limitation).toContain("2 of 3 pain flags name an exercise");
    expect(pain.evidence.some((item) => item.label === "Session-level · Knee")).toBe(
      true,
    );
    expect(JSON.stringify(pain)).not.toContain("10/10");

    expect(records.evidence[0]).toMatchObject({
      label: benchName,
      value: "200 lb × 1",
    });
    // Scoped to the reported values: labels embed generated exercise names
    // whose UUID suffix can itself contain "999" and fail this by chance.
    expect(
      records.evidence.map((item) => `${item.value} ${item.detail}`).join(" ")
    ).not.toContain("999");
    expect(JSON.stringify(records)).not.toContain(assistedPullupName);
    expect(assistedProgress).toMatchObject({
      first: { weight: 150, reps: 10, estimatedStrength: null },
      latest: { weight: 150, reps: 10, estimatedStrength: null },
      changePercent: null,
      exclusionReason: "assistance_not_comparable",
      volume: 0,
    });
    expect(report.overview.semanticExclusions).toContainEqual({
      reason: "assistance_not_comparable",
      count: 1,
    });
    expect(report.overview.targetHitRate).toBeNull();
    const calendar = await getHistoryCalendarRecords(
      database.db,
      ownerId,
      "lb",
      { view: "month", date: "2026-06-15" },
    );
    expect(
      calendar.find((record) => record.id === firstSessionId),
    ).toMatchObject({
      recordType: "workout",
      volume: 1000,
      targetHitRate: null,
    });
    expect(benchProgress).toMatchObject({
      exerciseId: benchId,
      first: { sourceSessionId: firstSessionId },
      latest: { sourceSessionId: importedSessionId },
    });
    expect(benchRecord).toMatchObject({
      exerciseId: benchId,
      sourceSessionId: importedSessionId,
    });
    expect(
      report.families.some(
        (family) => family.familyKey === `exercise:${benchId}`,
      ),
    ).toBe(true);

    const archivedAt = new Date("2026-07-17T13:00:00.000Z");
    await database.db
      .update(completedSets)
      .set({ archivedAt })
      .where(eq(completedSets.id, importedRecordSet.id));
    await database.db
      .update(painLogs)
      .set({ archivedAt })
      .where(eq(painLogs.id, sessionOnlyPain.id));
    const archived = await getHistoryReport(database.db, ownerId, "all", 3, now, {
      timezone: "America/Toronto",
      unit: "lb",
    });
    const archivedRecords = archived.lenses.find((lens) => lens.key === "records")!;
    const archivedPain = archived.lenses.find(
      (lens) => lens.key === "pain-constraints",
    )!;
    expect(archivedRecords.evidence[0].value).toBe("105 lb × 10");
    expect(archivedPain.limitation).toContain("2 of 2 pain flags name an exercise");

    await database.db
      .update(completedSets)
      .set({ archivedAt: null })
      .where(eq(completedSets.id, importedRecordSet.id));
    await database.db
      .update(painLogs)
      .set({ archivedAt: null })
      .where(eq(painLogs.id, sessionOnlyPain.id));
    const restored = await getHistoryReport(database.db, ownerId, "all", 3, now, {
      timezone: "America/Toronto",
      unit: "lb",
    });
    expect(
      restored.lenses.find((lens) => lens.key === "records")!.evidence[0].value,
    ).toBe("200 lb × 1");
    expect(
      restored.lenses.find((lens) => lens.key === "pain-constraints")!.limitation,
    ).toContain("2 of 3 pain flags name an exercise");
  }, 30_000);
});
