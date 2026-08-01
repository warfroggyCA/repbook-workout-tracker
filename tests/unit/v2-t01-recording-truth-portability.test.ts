import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import {
  buildJsonBackup,
  buildSetsCsv,
  validateUserHeldJsonBackup,
} from "@/services/export";
import { getHistoryReport } from "@/services/history-report";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  completeT01Workout,
  recordT01SupportedSets,
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("V2 T01 recording portability", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  it("round-trips exact performed shapes and legacy uncertainty through History, CSV, and canonical JSON", async () => {
    const saved = await recordT01SupportedSets(database.db, fixture);
    await completeT01Workout(database.db, fixture);

    const history = await getHistoryReport(
      database.db,
      fixture.userId,
      "all",
      0,
    );
    expect(history.overview).toMatchObject({
      workingSets: 6,
      totalReps: 29,
      timedActivityMinutes: 11,
      distanceKm: 1.2,
    });

    const csvRows = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    const bySetId = new Map(csvRows.map((row) => [row.completed_set_id, row]));
    expect(bySetId.get(saved.loaded.setId)).toMatchObject({
      weight: "100",
      weight_unit: "kg",
      reps: "5",
      metric_type: "weight_reps",
      performed_semantics_version: "1",
      performed_load_type: "dumbbell",
      performed_load_semantics: "total",
      distance_km: "",
      duration_seconds: "",
      observed_completion_provenance: "live_client",
      observed_completion_quality: "trustworthy",
    });
    expect(bySetId.get(saved.bodyweightSubstitution.setId)).toMatchObject({
      planned_exercise: expect.stringContaining("T01 planned split squat"),
      weight: "",
      weight_unit: "",
      reps: "8",
      metric_type: "reps",
      performed_load_semantics: "bodyweight",
      modification: "substituted",
    });
    expect(bySetId.get(saved.assisted.setId)).toMatchObject({
      weight: "25",
      weight_unit: "kg",
      reps: "6",
      metric_type: "assisted_reps",
      performed_load_semantics: "assistance",
    });
    expect(bySetId.get(saved.duration.setId)).toMatchObject({
      weight: "",
      reps: "",
      metric_type: "duration",
      distance_km: "",
      duration_seconds: "45",
    });
    expect(bySetId.get(saved.distance.setId)).toMatchObject({
      weight: "",
      reps: "",
      metric_type: "distance_duration",
      distance_km: "1.2",
      duration_seconds: "600",
    });

    const backup = await buildJsonBackup(
      database.db,
      fixture.userId,
      () => undefined,
      { appVersion: "v2-t01-portability" },
    );
    const roundTripped = validateUserHeldJsonBackup(
      JSON.parse(JSON.stringify(backup)),
      fixture.userId,
    );
    const completed = roundTripped.canonical.tables.completed_sets as Array<
      Record<string, unknown>
    >;
    const canonicalById = new Map(completed.map((row) => [row.id, row]));
    expect(canonicalById.get(saved.duration.setId)).toMatchObject({
      metric_type: "duration",
      weight: null,
      weight_unit: null,
      reps: null,
      distance_km: null,
      duration_seconds: 45,
      performed_semantics_version: 1,
      performed_load_type: "bodyweight",
      performed_load_semantics: "bodyweight",
    });
    expect(canonicalById.get(saved.distance.setId)).toMatchObject({
      metric_type: "distance_duration",
      distance_km: 1.2,
      duration_seconds: 600,
    });
    expect(canonicalById.get(fixture.legacySetId)).toMatchObject({
      weight: 50,
      weight_unit: "lb",
      reps: 10,
      performed_semantics_version: null,
      performed_load_type: null,
      performed_load_semantics: null,
      target_met: null,
    });

    const sessionExerciseRows = roundTripped.canonical.tables.session_exercises as Array<
      Record<string, unknown>
    >;
    expect(sessionExerciseRows).toContainEqual(expect.objectContaining({
      id: fixture.sessionExerciseIds.bodyweightSubstitution,
      exercise_id: fixture.exerciseIds.bodyweightSubstitution,
      substituted_for_exercise_id: fixture.exerciseIds.plannedSubstitution,
      modification_type: "substituted",
    }));
    const occurrenceRows = roundTripped.canonical.tables.session_occurrences as Array<
      Record<string, unknown>
    >;
    expect(occurrenceRows).toContainEqual(expect.objectContaining({
      id: saved.bodyweightSubstitution.occurrenceId,
      planned_exercise_id: fixture.exerciseIds.plannedSubstitution,
      completed_set_id: saved.bodyweightSubstitution.setId,
      outcome: "completed",
    }));
  });
});
