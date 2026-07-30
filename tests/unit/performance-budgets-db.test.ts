import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { resultRows } from "@/db/result";
import budgets from "../../docs/production-performance-budgets.json";
import {
  barbellConfigs,
  completedSets,
  equipmentItems,
  exercises,
  healthActivities,
  plateInventory,
  recommendations,
  sessionEquipmentSnapshots,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { buildSessionEquipmentConfigurationIdentity } from "@/lib/session-equipment-snapshot-contract";
import { getDashboardStats } from "@/services/dashboard";
import {
  getHistoryCalendarRecords,
  getHistoryReport,
} from "@/services/history-report";
import { getActivityReport } from "@/services/activity-report";
import { getHistoryPageMaintenance } from "@/services/history-page";
import {
  HEVY_HEADERS,
  parseHevyCsv,
} from "@/services/hevy-import";
import {
  evaluateSessionProgression,
  type ProgressionReadObservation,
} from "@/services/progression";
import { activateProgramAtomically } from "@/services/program-activation";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import {
  createMigratedTestDatabase,
  seedLargeWorkoutHistory,
  type TestDatabase,
} from "../helpers/database";

async function explainText(database: TestDatabase, query: ReturnType<typeof sql>) {
  const result = await database.db.execute(sql`EXPLAIN ${query}`);
  return resultRows(result)
    .map((row) => String(row["QUERY PLAN"] ?? row["query plan"] ?? ""))
    .join("\n");
}

describe("production performance budgets", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it(
    "keeps Today, History, and the visible calendar bounded when history grows 10x",
    async () => {
      const [user] = await database.db
        .insert(users)
        .values({ email: `performance-${crypto.randomUUID()}@example.com` })
        .returning({ id: users.id });
      await database.db.insert(userProfiles).values({
        userId: user.id,
        timezone: "America/Toronto",
        unit: "lb",
      });
      const [exercise] = await database.db
        .insert(exercises)
        .values({
          name: `Performance squat ${crypto.randomUUID()}`,
          movementPattern: "squat",
          primaryMuscles: ["quadriceps"],
          loadType: "barbell",
        })
        .returning({ id: exercises.id });
      const end = new Date("2026-07-13T15:00:00.000Z");
      const baselineStart = new Date(end.getTime() - 249 * 86_400_000);
      await seedLargeWorkoutHistory(database.db, {
        userId: user.id,
        exerciseId: exercise.id,
        sessionCount: 250,
        setsPerSession: 3,
        startAt: baselineStart,
      });

      const readVisibleState = async () => {
        const heapBefore = process.memoryUsage().heapUsed;
        const started = performance.now();
        const [dashboard, report, calendar] = await Promise.all([
          getDashboardStats(database.db, user.id),
          getHistoryReport(
            database.db,
            user.id,
            "all",
            3,
            end,
            { timezone: "America/Toronto", unit: "lb" }
          ),
          getHistoryCalendarRecords(database.db, user.id, "lb", {
            view: "month",
            date: "2026-07-13",
          }),
        ]);
        return {
          dashboard,
          report,
          calendar,
          durationMs: performance.now() - started,
          heapGrowth: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
          payloadBytes: Buffer.byteLength(
            JSON.stringify({ dashboard, report, calendar })
          ),
        };
      };

      const baseline = await readVisibleState();
      await seedLargeWorkoutHistory(database.db, {
        userId: user.id,
        exerciseId: exercise.id,
        sessionCount: 2250,
        setsPerSession: 3,
        startAt: new Date(baselineStart.getTime() - 2250 * 86_400_000),
      });
      const large = await readVisibleState();

      expect(large.dashboard.weeklyVolume).toHaveLength(
        budgets.finalBudgets.dashboard.maxWeeks
      );
      expect(large.dashboard.recentPRs.length).toBeLessThanOrEqual(
        budgets.finalBudgets.dashboard.maxRecentPRs
      );
      expect(large.report.weekly.length).toBeLessThanOrEqual(
        budgets.finalBudgets.historyPage.maxWeeklyPoints
      );
      expect(large.report.recentSessions.length).toBeLessThanOrEqual(
        budgets.finalBudgets.historyPage.maxRecentSessions
      );
      expect(large.report.calendarSessions.length).toBeLessThanOrEqual(
        budgets.finalBudgets.historyPage.maxRecentSessions
      );
      expect(large.calendar).toHaveLength(baseline.calendar.length);
      expect(large.payloadBytes / baseline.payloadBytes).toBeLessThan(
        budgets.finalBudgets.largeHistoryFixture
          .maxPayloadGrowthRatioFrom10xHistory
      );
      expect(large.durationMs).toBeLessThan(
        budgets.finalBudgets.largeHistoryFixture.maxDurationMs
      );
      expect(large.heapGrowth).toBeLessThan(
        budgets.finalBudgets.largeHistoryFixture.maxHeapGrowthBytes
      );

      const historyPageQueries = vi.spyOn(database.db, "execute");
      await Promise.all([
        getHistoryReport(
          database.db,
          user.id,
          "all",
          3,
          end,
          { timezone: "America/Toronto", unit: "lb" }
        ),
        getActivityReport(database.db, user.id, "all", end),
        getHistoryCalendarRecords(database.db, user.id, "lb", {
          view: "month",
          date: "2026-07-13",
        }),
        getHistoryPageMaintenance(database.db, user.id),
      ]);
      expect(historyPageQueries).toHaveBeenCalledTimes(
        budgets.finalBudgets.historyPage.maxQueries
      );
      if (process.env.PRINT_PERFORMANCE_EVIDENCE === "1") {
        process.stdout.write(
          `${JSON.stringify({
            performanceEvidence: {
              baselineSessions: 250,
              largeSessions: 2500,
              dashboardRows: 1,
              dashboardWeeks: large.dashboard.weeklyVolume.length,
              historyAggregateRows: 1,
              historyRecentRows: large.report.recentSessions.length,
              calendarRows: large.calendar.length,
              historyPageQueries: historyPageQueries.mock.calls.length,
              baselinePayloadBytes: baseline.payloadBytes,
              largePayloadBytes: large.payloadBytes,
              payloadGrowthRatio: Number(
                (large.payloadBytes / baseline.payloadBytes).toFixed(3)
              ),
              largeDurationMs: Number(large.durationMs.toFixed(1)),
              largeHeapGrowthBytes: large.heapGrowth,
            },
          })}\n`
        );
      }
      historyPageQueries.mockRestore();

      await database.db.execute(sql`ANALYZE`);
      await database.db.execute(sql`SET enable_seqscan = off`);
      const historyPlan = await explainText(
        database,
        sql`SELECT id FROM workout_sessions
            WHERE user_id = ${user.id}::uuid
              AND archived_at IS NULL
              AND status IN ('completed', 'abandoned')
              AND local_date BETWEEN '2026-06-29'::date AND '2026-08-09'::date`
      );
      expect(historyPlan).toContain("workout_sessions_active_history_idx");
    },
    120_000
  );

  it(
    "loads progression history, prescriptions, state, and alternatives once for every slot",
    async () => {
      const [user] = await database.db
        .insert(users)
        .values({ email: `progression-performance-${crypto.randomUUID()}@example.com` })
        .returning({ id: users.id });
      await database.db.insert(userProfiles).values({ userId: user.id });
      const exerciseRows = await database.db
        .insert(exercises)
        .values(
          Array.from({ length: 6 }, (_, index) => ({
            name: `Batched progression exercise ${index + 1} ${crypto.randomUUID()}`,
            movementPattern: "squat" as const,
            primaryMuscles: ["quadriceps"],
            loadType: "barbell" as const,
          }))
        )
        .returning({ id: exercises.id });
      const activated = await activateProgramAtomically(database.db, {
        userId: user.id,
        loadUnit: "lb",
        programName: "Batched progression",
        days: [{
          name: "Batch day",
          exercises: exerciseRows.map((exercise) => ({
            exerciseId: exercise.id,
            sets: 3,
            repMin: 6,
            repMax: 8,
            targetLoad: 100,
            restSec: 90,
            supersetKey: null,
            notes: null,
          })),
        }],
        changeSummary: "Batched progression performance fixture",
        auditAction: "program.activate",
        auditSummary: "Activated batched progression performance fixture",
      });
      if (!activated.ok) throw new Error(activated.reason);
      const [template] = await database.db.query.workoutTemplates.findMany({
        where: (table, { eq }) =>
          eq(table.programVersionId, activated.programVersionId),
      });
      const slots = (
        await database.db.query.workoutTemplateExercises.findMany({
          where: (table, { eq }) => eq(table.workoutTemplateId, template.id),
        })
      ).sort((left, right) => left.orderIdx - right.orderIdx);

      const sessions = await database.db
        .insert(workoutSessions)
        .values(
          Array.from({ length: 10 }, (_, index) => {
            const startedAt = new Date(
              Date.UTC(2026, 6, 4 + index, 15, 0, 0)
            );
            return {
              userId: user.id,
              templateId: template.id,
              templateName: "Batch day",
              sourceProgramId: activated.programId,
              sourceProgramVersionId: activated.programVersionId,
              sourceDayLineageId: template.lineageId,
              status: "completed" as const,
              startedAt,
              finishedAt: new Date(startedAt.getTime() + 3_600_000),
              timezone: "America/Toronto",
              localDate: startedAt.toISOString().slice(0, 10),
            };
          })
        )
        .returning({ id: workoutSessions.id });
      const sessionExerciseRows = await database.db
        .insert(sessionExercises)
        .values(
          sessions.flatMap((session) =>
            exerciseRows.map((exercise, index) => ({
              sessionId: session.id,
              exerciseId: exercise.id,
              plannedFromTemplateExerciseId: slots[index].id,
              sourceSlotLineageId: slots[index].lineageId,
              orderIdx: index,
              targetSets: 3,
              targetRepsMin: 6,
              targetRepsMax: 8,
              targetLoad: 100,
              targetLoadUnit: "lb" as const,
            }))
          )
        )
        .returning({
          id: sessionExercises.id,
          sessionId: sessionExercises.sessionId,
          exerciseId: sessionExercises.exerciseId,
          orderIdx: sessionExercises.orderIdx,
        });
      const equipmentLabel = "Performance total-system barbell";
      const geometrySnapshot = {
        version: 1 as const,
        kind: "plate_loaded_implement" as const,
        loadingKind: "olympic" as const,
        emptyWeight: 45,
        collarWeight: 0,
        unit: "lb" as const,
        sharedPlatePoolCompatible: true,
        compatiblePlates: [],
      };
      const [equipmentItem] = await database.db
        .insert(equipmentItems)
        .values({
          userId: user.id,
          type: "barbell",
          label: equipmentLabel,
        })
        .returning({ id: equipmentItems.id });
      const [loadProfile] = await database.db
        .insert(barbellConfigs)
        .values({
          userId: user.id,
          barType: "olympic",
          equipmentItemId: equipmentItem.id,
          unit: "lb",
          loadingKind: "olympic",
          sharedPlatePoolCompatible: true,
          barWeight: 45,
          collarWeight: 0,
          label: equipmentLabel,
        })
        .returning({ id: barbellConfigs.id });
      await database.db.insert(plateInventory).values([
        { userId: user.id, denomination: 25, unit: "lb", quantity: 2 },
        { userId: user.id, denomination: 2.5, unit: "lb", quantity: 4 },
      ]);
      const configurationHash = sha256Hex(
        Buffer.from(
          canonicalJson(
            buildSessionEquipmentConfigurationIdentity({
              equipmentItemId: equipmentItem.id,
              equipmentLabel,
              equipmentDefinitionKey: null,
              attachmentItemId: null,
              attachmentLabel: null,
              attachmentDefinitionKey: null,
              attachmentKind: null,
              geometry: geometrySnapshot,
            })
          ),
          "utf8"
        )
      );
      const snapshotRows = await database.db
        .insert(sessionEquipmentSnapshots)
        .values(
          sessionExerciseRows.map((sessionExercise) => ({
            userId: user.id,
            sessionId: sessionExercise.sessionId,
            sessionExerciseId: sessionExercise.id,
            equipmentItemId: equipmentItem.id,
            loadProfileId: loadProfile.id,
            equipmentLabel,
            profileKind: "plate_loaded_implement",
            geometryCertainty: "known",
            unit: "lb" as const,
            selectionProvenance: "imported",
            configurationRevision: 1,
            configurationHash,
            geometryVersion: 1,
            geometrySnapshot,
          }))
        )
        .returning({
          id: sessionEquipmentSnapshots.id,
          sessionExerciseId: sessionEquipmentSnapshots.sessionExerciseId,
        });
      const snapshotBySessionExerciseId = new Map(
        snapshotRows.map((snapshot) => [
          snapshot.sessionExerciseId,
          snapshot.id,
        ])
      );
      const completedSetRows = await database.db.insert(completedSets).values(
        sessionExerciseRows.flatMap((sessionExercise) =>
          [1, 2, 3].map((setNo) => ({
            sessionExerciseId: sessionExercise.id,
            equipmentSnapshotId: snapshotBySessionExerciseId.get(
              sessionExercise.id
            ),
            setNo,
            weight: 100,
            weightUnit: "lb" as const,
            reps: 8,
            rpe: 7,
            metricType: "weight_reps" as const,
            loadEntryMeaning: "total_system",
          }))
        )
      ).returning({
        id: completedSets.id,
        sessionExerciseId: completedSets.sessionExerciseId,
        setNo: completedSets.setNo,
      });
      const sessionExerciseById = new Map(
        sessionExerciseRows.map((row) => [row.id, row])
      );
      await database.db.insert(sessionOccurrences).values(
        completedSetRows.map((completedSet) => {
          const sessionExercise = sessionExerciseById.get(
            completedSet.sessionExerciseId
          );
          if (!sessionExercise) {
            throw new Error("Missing session exercise for completed set fixture");
          }
          return {
            sessionId: sessionExercise.sessionId,
            sessionExerciseId: sessionExercise.id,
            kind: "working_set",
            origin: "planned",
            sequenceIdx:
              sessionExercise.orderIdx * 3 + (completedSet.setNo - 1),
            kindOrdinal: completedSet.setNo - 1,
            plannedExerciseId: sessionExercise.exerciseId,
            plannedRepsMin: 6,
            plannedRepsMax: 8,
            plannedLoad: 100,
            plannedLoadUnit: "lb" as const,
            plannedRestSec: 90,
            outcome: "completed",
            resolvedAt: new Date("2026-07-14T16:00:00.000Z"),
            completedSetId: completedSet.id,
            equipmentSnapshotId: snapshotBySessionExerciseId.get(
              sessionExercise.id
            ),
          };
        })
      );

      const reads: ProgressionReadObservation[] = [];
      await evaluateSessionProgression(
        database.db,
        user.id,
        sessions.at(-1)!.id,
        {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
        undefined,
        (observation) => reads.push(observation)
      );

      // Stable Program lineage adds one bounded mapping read before the
      // previously budgeted progression reads.
      expect(reads).toHaveLength(
        budgets.finalBudgets.progressionBatch.maxReadQueries + 1
      );
      expect(new Set(reads.map(({ stage }) => stage)).size).toBe(reads.length);
      expect(reads.find(({ stage }) => stage === "lineage_mappings")?.rows).toBe(6);
      expect(reads.find(({ stage }) => stage === "prescriptions")?.rows).toBe(6);
      expect(reads.find(({ stage }) => stage === "exposures")?.rows).toBe(
        6 *
          budgets.finalBudgets.progressionBatch.maxHistoricalExposuresPerSlot *
          3
      );
      expect(await database.db.select().from(recommendations)).toHaveLength(6);
      if (process.env.PRINT_PERFORMANCE_EVIDENCE === "1") {
        process.stdout.write(
          `${JSON.stringify({
            progressionEvidence: {
              slots: 6,
              storedExposureSessionsPerSlot: 10,
              returnedExposureSessionsPerSlot:
                budgets.finalBudgets.progressionBatch
                  .maxHistoricalExposuresPerSlot,
              returnedSetRows: reads.find(({ stage }) => stage === "exposures")
                ?.rows,
              batchedReadQueries: reads.length,
            },
          })}\n`
        );
      }

      await database.db.execute(sql`ANALYZE`);
      await database.db.execute(sql`SET enable_seqscan = off`);
      const slotPlan = await explainText(
        database,
        sql`SELECT session_id FROM session_exercises
            WHERE planned_from_template_exercise_id = ${slots[0].id}::uuid`
      );
      expect(slotPlan).toContain("session_exercises_slot_session_idx");

      await database.db.insert(healthActivities).values({
        userId: user.id,
        activityType: "walk",
        startedAt: new Date("2026-07-13T15:00:00.000Z"),
        timezone: "America/Toronto",
        durationSeconds: 1800,
        fingerprint: crypto.randomUUID(),
      });
      await database.db.execute(sql`ANALYZE health_activities`);
      const activityPlan = await explainText(
        database,
        sql`SELECT id FROM health_activities
            WHERE user_id = ${user.id}::uuid
              AND archived_at IS NULL
              AND started_at >= '2026-07-01'::timestamptz`
      );
      expect(activityPlan).toContain("health_activities_active_user_started_idx");
    },
    60_000
  );

  it("parses the maximum accepted Hevy row count inside its CPU and memory budget", () => {
    const rowCount = budgets.finalBudgets.hevyMaximumAccepted.rows;
    const csv = [
      HEVY_HEADERS.join(","),
      ...Array.from(
        { length: rowCount },
        (_, index) =>
          `Maximum import,"Jun 1, 2026, 6:00 PM","Jun 1, 2026, 7:00 PM",,Bench Press (Barbell),,,${index},normal,135,8,,,8`
      ),
    ].join("\n");
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const parsed = parseHevyCsv(csv, "America/Toronto");
    const durationMs = performance.now() - started;
    const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

    expect(parsed.profile.sets).toBe(rowCount);
    expect(durationMs).toBeLessThan(
      budgets.finalBudgets.hevyMaximumAccepted.maxDurationMs
    );
    expect(heapGrowth).toBeLessThan(
      budgets.finalBudgets.hevyMaximumAccepted.maxHeapGrowthBytes
    );
    if (process.env.PRINT_PERFORMANCE_EVIDENCE === "1") {
      process.stdout.write(
        `${JSON.stringify({
          hevyImportEvidence: {
            rows: rowCount,
            bytes: Buffer.byteLength(csv),
            durationMs: Number(durationMs.toFixed(1)),
            heapGrowthBytes: heapGrowth,
          },
        })}\n`
      );
    }
  }, 30_000);
});
