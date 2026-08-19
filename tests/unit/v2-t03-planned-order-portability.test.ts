import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import {
  completedSets,
  exercises,
  sessionExercises,
  sessionOccurrences,
  workoutSessions,
} from "@/db/schema";
import { buildTrainingDigest, renderCoachingBrief } from "@/services/digest";
import { buildSetsCsv } from "@/services/export";
import {
  getHistoryCalendarRecords,
  getHistoryReport,
} from "@/services/history-report";
import {
  appendWorkoutSetOccurrence,
  logWorkoutSet,
} from "@/services/session-lifecycle";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("V2 T03 planned-order portability", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("keeps planned and extra evidence distinct in CSV, History, and the review brief", async () => {
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: `T03 portable push-up ${crypto.randomUUID()}`,
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "bodyweight",
      })
      .returning({ id: exercises.id, name: exercises.name });
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: fixture.sessionId,
        exerciseId: exercise.id,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: exercise.name,
        prescribedMetricType: "reps",
        prescribedLoadType: "bodyweight",
        prescribedLoadSemantics: "bodyweight",
        orderIdx: 20,
        targetSets: 1,
        targetRepsMin: 8,
        targetRepsMax: 10,
      })
      .returning({ id: sessionExercises.id });
    await database.db.insert(sessionOccurrences).values({
      sessionId: fixture.sessionId,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 20,
      kindOrdinal: 0,
      plannedExerciseId: exercise.id,
      plannedRepsMin: 8,
      plannedRepsMax: 10,
      plannedRestSec: 60,
    });
    const command = (setNo: number, clientKey: string) => ({
      sessionExerciseId: sessionExercise.id,
      performedExerciseId: exercise.id,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight" as const,
      performedSemanticsVersion: 1 as const,
      metricType: "reps" as const,
      setNo,
      weight: null,
      weightUnit: null,
      reps: 9,
      distanceKm: null,
      durationSeconds: null,
      rpe: null,
      note: null,
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown" as const,
      observedCompletedAtISO: new Date().toISOString(),
      clientKey,
    });
    const extraOccurrenceId = crypto.randomUUID();
    await expect(
      appendWorkoutSetOccurrence(database.db, fixture.userId, {
        sessionExerciseId: sessionExercise.id,
        occurrenceId: extraOccurrenceId,
        expectedSetNo: 2,
      }),
    ).resolves.toMatchObject({ outcome: "appended" });
    const extra = await logWorkoutSet(
      database.db,
      fixture.userId,
      command(2, "t03-portable-extra-before-plan"),
    );
    const planned = await logWorkoutSet(
      database.db,
      fixture.userId,
      command(1, "t03-portable-planned"),
    );
    if (extra.outcome !== "saved" || planned.outcome !== "saved") {
      throw new Error("T03 portability setup did not save both results.");
    }
    await database.db
      .update(completedSets)
      .set({ targetMet: true })
      .where(eq(completedSets.id, extra.setId));
    await database.db
      .update(workoutSessions)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(workoutSessions.id, fixture.sessionId));

    const csvRows = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    const relevant = csvRows
      .filter((row) => [planned.setId, extra.setId].includes(row.completed_set_id))
      .map((row) => ({
        setId: row.completed_set_id,
        origin: row.occurrence_origin,
        ordinal: row.occurrence_kind_ordinal,
        label: row.occurrence_display_label,
        plannedNote: row.occurrence_planned_note,
        targetMet: row.legacy_target_met_projection,
        targetRepsMin: row.target_reps_min,
        targetRepsMax: row.target_reps_max,
      }));
    expect(relevant).toEqual([
      {
        setId: planned.setId,
        origin: "planned",
        ordinal: "0",
        label: "Set 1",
        plannedNote: "",
        targetMet: "true",
        targetRepsMin: "8",
        targetRepsMax: "10",
      },
      {
        setId: extra.setId,
        origin: "ad_hoc",
        ordinal: "1",
        label: "Extra set 1",
        plannedNote: "Added during this workout",
        targetMet: "",
        targetRepsMin: "",
        targetRepsMax: "",
      },
    ]);

    const digest = await buildTrainingDigest(
      database.db,
      fixture.userId,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    );
    expect(digest.targetOutcomes.atOrAboveRate).toBeNull();
    expect(digest.reporting.targetAttainment.coverage).toMatchObject({
      numerator: 0,
      denominator: 9,
      percentage: 0,
    });
    const session = digest.sessions.find(
      (item) => item.template === "T01 truthful recording",
    );
    expect(
      session?.occurrences
        .filter((occurrence) => occurrence.kind === "working_set")
        .map((occurrence) => ({
          origin: occurrence.origin,
          role: occurrence.role,
          label: occurrence.displayLabel,
        })),
    ).toContainEqual({
      origin: "ad_hoc",
      role: "extra",
      label: "Extra set 1",
    });
    const brief = renderCoachingBrief(digest);
    expect(brief).toContain("Occurrence outcomes:");
    expect(brief).toContain(
      "Extra set 1: completed with a retained performed result; origin ad_hoc; role extra",
    );
    expect(brief).not.toContain("Planned occurrence outcomes:");

    const calendar = await getHistoryCalendarRecords(database.db, fixture.userId);
    expect(
      calendar.find((record) => record.recordType === "workout" && record.id === fixture.sessionId),
    ).toMatchObject({ sets: 2, targetHitRate: null });
    const history = await getHistoryReport(database.db, fixture.userId, "all", 3);
    expect(history.overview).toMatchObject({
      workingSets: 3,
      targetHitRate: null,
    });
    expect(history.insights).toContainEqual(
      expect.objectContaining({
        title: "Target-attainment coverage",
        detail: expect.stringContaining(
          "0 of 9 planned outcomes were evaluable (0%). No supported subset statistic is available.",
        ),
      }),
    );
  });
});
