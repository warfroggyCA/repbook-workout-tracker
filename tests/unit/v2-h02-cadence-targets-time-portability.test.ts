import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import {
  buildJsonBackup,
  buildSetsCsv,
  validateUserHeldJsonBackup,
} from "@/services/export";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedV2H02CadenceTargetsTime,
  V2_H02_IDS,
  type V2H02CadenceFixture,
} from "../helpers/v2-h02-cadence-targets-time";

describe("V2 H02 cadence and target portability", () => {
  let database: TestDatabase;
  let fixture: V2H02CadenceFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedV2H02CadenceTargetsTime(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("exports derived outcomes with their algorithm while retaining raw evidence separately", async () => {
    const rows = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    const bySetId = new Map(rows.map((row) => [row.completed_set_id, row]));

    expect(bySetId.get(fixture.setIds.below)).toMatchObject({
      legacy_target_met_projection: "true",
      calculated_target_outcome: "below",
      target_outcome_algorithm_version: "prescription-outcome-v2",
      target_load: "100",
      target_load_unit: "lb",
      target_reps_min: "8",
      target_reps_max: "10",
    });
    expect(bySetId.get(fixture.setIds.at)).toMatchObject({
      legacy_target_met_projection: "false",
      calculated_target_outcome: "at",
    });
    expect(bySetId.get(fixture.setIds.above)).toMatchObject({
      legacy_target_met_projection: "false",
      calculated_target_outcome: "above",
    });
    expect(bySetId.get(fixture.setIds.compatibleUnit)).toMatchObject({
      weight_unit: "kg",
      calculated_target_outcome: "at",
    });
    expect(bySetId.get(fixture.setIds.unsupportedTarget)).toMatchObject({
      performed_time_precision: "date_only",
      local_date: "2026-07-27",
      legacy_target_met_projection: "true",
      calculated_target_outcome: "unknown",
      target_load_percent: "80",
    });
    expect(bySetId.get(V2_H02_IDS.unplannedExtraSet)).toMatchObject({
      occurrence_origin: "ad_hoc",
      calculated_target_outcome: "",
      target_outcome_algorithm_version: "",
    });
    expect(rows[0]).not.toHaveProperty("target_met");
  });

  it("backs up the legacy projection and immutable target evidence without relabelling either", async () => {
    const backup = validateUserHeldJsonBackup(
      JSON.parse(JSON.stringify(await buildJsonBackup(
        database.db,
        fixture.userId,
        () => undefined,
        { appVersion: "v2-h02-portability" },
      ))),
      fixture.userId,
    );
    expect(backup.canonical.tables.completed_sets).toContainEqual(
      expect.objectContaining({
        id: fixture.setIds.below,
        target_met: true,
        weight: 95,
        reps: 7,
      }),
    );
    expect(backup.canonical.tables.session_occurrences).toContainEqual(
      expect.objectContaining({
        completed_set_id: fixture.setIds.below,
        origin: "planned",
        planned_reps_min: 8,
        planned_reps_max: 10,
        planned_load: 100,
        planned_load_unit: "lb",
      }),
    );
    expect(backup.canonical.tables.workout_sessions).toContainEqual(
      expect.objectContaining({
        id: fixture.sessionIds.dateOnly,
        local_date: "2026-07-27",
        timezone: "America/Toronto",
        performed_time_precision: "date_only",
      }),
    );
  });
});
