import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import {
  buildJsonBackup,
  buildPainFatigueCsv,
  buildSetsCsv,
  validateUserHeldJsonBackup,
} from "@/services/export";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  completeT01Workout,
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";
import { recordU02Exception } from "../helpers/v2-u02-exception-context";

describe("V2 U02 exception context portability", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("exports and backs up exact context without converting missing fields to none", async () => {
    const saved = await recordU02Exception(database.db, fixture);
    await completeT01Workout(database.db, fixture);

    const setRows = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    expect(setRows.find((row) => row.completed_set_id === saved.setId)).toMatchObject({
      rpe: "",
      rir: "2",
      technique_issue: "bracing",
      limitation_cause: "strength_fatigue",
      note: "Stopped before technique degraded further",
    });

    const painRows = parse(
      await buildPainFatigueCsv(database.db, fixture.userId, null),
      { columns: true, skip_empty_lines: true },
    ) as Array<Record<string, string>>;
    expect(painRows).toContainEqual(expect.objectContaining({
      kind: "pain",
      session_id: fixture.sessionId,
      completed_set_id: saved.setId,
      body_part: "back",
      severity: "4",
      source: "set_exception",
      pain_meaning: "pain",
      pain_algorithm_version: "pain-evidence-v1",
      performed_exercise_id: fixture.exerciseIds.loaded,
      planned_exercise_id: fixture.exerciseIds.loaded,
      modification_type: "as_planned",
    }));

    const backup = validateUserHeldJsonBackup(
      JSON.parse(JSON.stringify(await buildJsonBackup(
        database.db,
        fixture.userId,
        () => undefined,
        { appVersion: "v2-u02-portability" },
      ))),
      fixture.userId,
    );
    expect(backup.schemaVersion).toBe("37");
    expect(backup.canonical.tables.completed_sets).toContainEqual(
      expect.objectContaining({
        id: saved.setId,
        rpe: null,
        rir: 2,
        technique_issue: "bracing",
        limitation_cause: "strength_fatigue",
      }),
    );
    expect(backup.canonical.tables.pain_logs).toContainEqual(
      expect.objectContaining({
        completed_set_id: saved.setId,
        body_part: "back",
        severity: 4,
      }),
    );
  });
});
