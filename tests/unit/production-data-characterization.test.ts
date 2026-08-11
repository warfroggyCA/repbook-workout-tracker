// Freeze guard: pins production-compatible unit, calendar, export, backup, and
// cross-service wire shapes while preserving one captured database state.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  exerciseEquipmentRequirements,
  exercises,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { workoutLocalDate } from "@/lib/workout-calendar";
import { buildJsonBackup, buildSetsCsv } from "@/services/export";
import {
  buildHistoryCalendarSessions,
  getHistoryReport,
} from "@/services/history-report";
import { getDashboardStats } from "@/services/dashboard";
import { buildTrainingDigest } from "@/services/digest";
import { getLastPerformances } from "@/services/today";
import { logWorkoutSet } from "../helpers/log-workout-set";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("unit, calendar, and backup production findings", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;
  let activeSlotId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({
        email: `data-characterization-${crypto.randomUUID()}@example.com`,
        name: "Before backup",
      })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId,
      unit: "kg",
      timezone: "America/Toronto",
    });
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Kilogram Squat",
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        // Unit conversion is characterized on the explicitly supported
        // ordinary total-system barbell path.
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    await database.db.insert(exerciseEquipmentRequirements).values({
      exerciseId,
      equipmentType: "barbell",
    });
    const activated = await activateProgramAtomically(database.db, {
      userId,
      loadUnit: "kg",
      programName: "Data characterization Program",
      days: [{
        name: "Data characterization",
        exercises: [{
          exerciseId,
          sets: 1,
          repMin: 8,
          repMax: 8,
          targetLoad: 100,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Data characterization fixture",
      auditAction: "program.activate",
      auditSummary: "Activated data characterization fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    const [template] = await database.db.query.workoutTemplates.findMany({
      where: (table, { eq }) =>
        eq(table.programVersionId, activated.programVersionId),
    });
    const [slot] = await database.db.query.workoutTemplateExercises.findMany({
      where: (table, { eq }) => eq(table.workoutTemplateId, template.id),
    });
    activeSlotId = slot.id;
  }, 30_000);

  afterEach(async () => database.close());

  async function createSession(startedAt: Date, status: "in_progress" | "completed") {
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Data characterization",
        status,
        startedAt,
        finishedAt:
          status === "completed"
            ? new Date(startedAt.getTime() + 45 * 60_000)
            : null,
        timezone: "America/Toronto",
        localDate: workoutLocalDate(startedAt, "America/Toronto"),
      })
      .returning();
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: "Kilogram Squat",
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        targetSets: 1,
        targetRepsMin: 8,
        targetRepsMax: 8,
      })
      .returning();
    const equipmentSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId,
        sessionId: session.id,
        sessionExerciseId: sessionExercise.id,
        unit: "kg",
        label: "Characterization total-system barbell",
        selectAsCurrent: true,
      }
    );
    if (status === "in_progress") {
      await database.db.insert(sessionOccurrences).values({
        sessionId: session.id,
        sessionExerciseId: sessionExercise.id,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exerciseId,
        outcome: "pending",
      });
    }
    return { session, sessionExercise, equipmentSnapshotId };
  }

  it("preserves a kilogram set and converts it only for pound-denominated analytics", async () => {
    const { sessionExercise, equipmentSnapshotId } = await createSession(
      new Date("2026-01-01T01:00:00.000Z"),
      "in_progress"
    );
    const result = await logWorkoutSet(database.db, userId, {
      sessionExerciseId: sessionExercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "kg",
      reps: 8,
      clientKey: "kg-set",
      equipmentSnapshotId,
      loadEntryMeaning: "total_system",
    });
    expect(result).toMatchObject({ outcome: "saved" });

    const [stored] = await database.db.select().from(completedSets);
    expect(stored).toMatchObject({
      weight: 100,
      weightUnit: "kg",
      metricType: "weight_reps",
      loadEntryMeaning: "total_system",
    });
    const [calendar] = buildHistoryCalendarSessions([
      {
        id: "kg-session",
        templateName: "Kilogram workout",
        status: "completed",
        startedAt: new Date("2026-01-01T01:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2025-12-31",
        finishedAt: new Date("2026-01-01T02:00:00.000Z"),
        excludeDurationFromAnalytics: false,
        occurrences: [
          {
            kind: "working_set",
            origin: "planned",
            outcome: "completed",
            completedSetId: stored.id,
          },
        ],
        exercises: [
          {
            modificationType: "as_planned",
            exercise: {
              loadType: "barbell",
              metricType: "weight_reps",
              loadSemantics: "total",
            },
            sets: [
              {
                id: stored.id,
                weight: stored.weight,
                weightUnit: stored.weightUnit,
                reps: stored.reps,
                metricType: stored.metricType,
                loadEntryMeaning: "total_system",
                distanceKm: null,
                durationSeconds: null,
                excludeFromAnalytics: false,
                isWarmup: false,
                targetMet: true,
              },
            ],
          },
        ],
        painLogs: [],
      },
    ]);
    expect(calendar.volume).toBe(1764);
  });

  it("uses the workout's recorded timezone and local date around midnight", () => {
    const startedAt = new Date("2026-01-01T01:00:00.000Z");
    expect(workoutLocalDate(startedAt, "America/Toronto")).toBe("2025-12-31");
    const [workout] = buildHistoryCalendarSessions([
      {
        id: "midnight-workout",
        templateName: "Late workout",
        status: "completed",
        startedAt,
        timezone: "America/Toronto",
        localDate: "2025-12-31",
        finishedAt: new Date("2026-01-01T02:00:00.000Z"),
        excludeDurationFromAnalytics: false,
        occurrences: [],
        exercises: [],
        painLogs: [],
      },
    ]);
    expect(workout.startedAtISO).toBe("2026-01-01T01:00:00.000Z");
    expect(workout).toMatchObject({
      timezone: "America/Toronto",
      calendarDateKey: "2025-12-31",
    });
  });

  it("round-trips kilograms through last performance, reports, Coach context, CSV, and JSON", async () => {
    const { session, sessionExercise, equipmentSnapshotId } = await createSession(
      new Date("2026-07-12T14:00:00.000Z"),
      "completed"
    );
    const slotId = activeSlotId;
    await database.db
      .update(sessionExercises)
      .set({
        plannedFromTemplateExerciseId: slotId,
        targetSets: 1,
        targetRepsMin: 8,
        targetRepsMax: 8,
        targetLoad: 100,
        targetLoadUnit: "kg",
      })
      .where(eq(sessionExercises.id, sessionExercise.id));
    const [savedSet] = await database.db.insert(completedSets).values({
      sessionExerciseId: sessionExercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "kg",
      reps: 8,
      targetMet: true,
      metricType: "weight_reps",
      performedSemanticsVersion: 1,
      performedLoadType: "barbell",
      performedLoadSemantics: "total",
      loadEntryMeaning: "total_system",
      equipmentSnapshotId,
    }).returning({ id: completedSets.id });
    await database.db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "legacy",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      resolvedAt: session.finishedAt,
      completedSetId: savedSet.id,
      equipmentSnapshotId,
    });
    await database.db.insert(completedSets).values([
      {
        sessionExerciseId: sessionExercise.id,
        setNo: 2,
        weight: 999,
        weightUnit: "kg",
        reps: 10,
        targetMet: true,
      },
      {
        sessionExerciseId: sessionExercise.id,
        setNo: 3,
        weight: 888,
        weightUnit: "kg",
        reps: 10,
        targetMet: true,
      },
      {
        sessionExerciseId: sessionExercise.id,
        setNo: 4,
        weight: 777,
        weightUnit: "kg",
        reps: 10,
        targetMet: true,
      },
    ]);
    await database.db.insert(sessionOccurrences).values([
      {
        sessionId: session.id,
        sessionExerciseId: sessionExercise.id,
        kind: "working_set",
        origin: "legacy",
        sequenceIdx: 1,
        kindOrdinal: 1,
        plannedExerciseId: exerciseId,
        outcome: "skipped",
        outcomeReason: "test_skip",
        resolvedAt: session.finishedAt,
      },
      {
        sessionId: session.id,
        sessionExerciseId: sessionExercise.id,
        kind: "working_set",
        origin: "legacy",
        sequenceIdx: 2,
        kindOrdinal: 2,
        plannedExerciseId: exerciseId,
        outcome: "abandoned",
        outcomeReason: "test_abandon",
        resolvedAt: session.finishedAt,
      },
    ]);
    const [mismatchedWarmupResult] = await database.db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 5,
        weight: 666,
        weightUnit: "kg",
        reps: 10,
        isWarmup: true,
      })
      .returning({ id: completedSets.id });
    await database.db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "legacy",
      sequenceIdx: 3,
      kindOrdinal: 3,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      resolvedAt: session.finishedAt,
      completedSetId: mismatchedWarmupResult.id,
    });

    const [last, dashboard, history, digest, csv, backup] = await Promise.all([
      getLastPerformances(database.db, userId, [slotId]),
      getDashboardStats(database.db, userId),
      getHistoryReport(
        database.db,
        userId,
        "all",
        3,
        new Date("2026-07-13T14:00:00.000Z")
      ),
      buildTrainingDigest(
        database.db,
        userId,
        new Date("2026-07-01T00:00:00.000Z"),
        new Date("2026-07-13T14:00:00.000Z")
      ),
      buildSetsCsv(database.db, userId, null),
      buildJsonBackup(database.db, userId),
    ]);

    expect(last[slotId]?.sets[0]).toMatchObject({
      weight: 100,
      weightUnit: "kg",
      reps: 8,
    });
    expect(dashboard.weeklyVolume.some(({ volume }) => volume === 800)).toBe(true);
    expect(history.overview.loadedVolume).toBe(800);
    expect(history.calendarSessions[0]).toMatchObject({
      id: session.id,
      calendarDateKey: "2026-07-12",
      volume: 800,
    });
    expect(digest.sessions[0]?.exercises[0]).toMatchObject({
      target: "1×8–8 @ 100 kg",
      sets: "100 kg×8",
    });
    expect(csv).toContain("weight_unit");
    expect(csv).toContain(",100,kg,8,");
    expect(csv).toContain("America/Toronto,2026-07-12");
    expect(backup.schemaVersion).toBe("32");
    expect(backup.canonical.tables.workout_sessions[0]).toMatchObject({
      id: session.id,
      timezone: "America/Toronto",
      local_date: "2026-07-12",
    });
    expect(backup.canonical.tables.session_exercises[0]).toMatchObject({
      target_load: 100,
      target_load_unit: "kg",
    });
    expect(
      backup.canonical.tables.completed_sets.find(
        (set) => (set as Record<string, unknown>).set_no === 1
      )
    ).toMatchObject({
      weight: 100,
      weight_unit: "kg",
    });
  });

  it("keeps one captured state when a writer changes data before export returns", async () => {
    const insertedSessionId = crypto.randomUUID();
    const backup = await buildJsonBackup(database.db, userId, async (boundary) => {
      if (boundary !== "backup-captured") return;
      await database.db
        .update(users)
        .set({ name: "After backup boundary" })
        .where(eq(users.id, userId));
      await database.db.insert(workoutSessions).values({
        id: insertedSessionId,
        userId,
        templateName: "Concurrent writer",
        status: "completed",
        startedAt: new Date("2026-07-13T14:00:00.000Z"),
        finishedAt: new Date("2026-07-13T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-13",
      });
    });

    expect(backup.canonical.tables.users[0]).toMatchObject({ name: "Before backup" });
    expect(
      backup.canonical.tables.workout_sessions.map((row) =>
        (row as { id: string }).id
      )
    ).not.toContain(insertedSessionId);
    expect(
      await database.db.query.users.findFirst({ where: eq(users.id, userId) })
    ).toMatchObject({ name: "After backup boundary" });
  });
});
