import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import { eq } from "drizzle-orm";
import { workoutSessions } from "@/db/schema";
import { readSetCorrectionEvidence } from "@/lib/set-correction";
import {
  buildJsonBackup,
  buildSetsCsv,
  validateUserHeldJsonBackup,
} from "@/services/export";
import { updateSetWithVersion } from "@/services/record-versions";
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

describe("V2 T02 correction portability", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  it("exports the effective assertion and round-trips the retained original and correction contract", async () => {
    const saved = await recordT01SupportedSets(database.db, fixture);
    await completeT01Workout(database.db, fixture);
    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, fixture.sessionId),
    });
    if (!session) throw new Error("Missing T02 workout.");

    const corrected = await updateSetWithVersion(
      database.db,
      fixture.userId,
      saved.distance.setId,
      {
        weight: null,
        weightUnit: null,
        reps: null,
        distanceKm: 1.4,
        durationSeconds: 630,
        rpe: 8,
        note: "Watch distance was entered incorrectly",
      },
      "set.completed_correction",
      {
        expected: {
          weight: null,
          weightUnit: null,
          reps: null,
          distanceKm: 1.2,
          durationSeconds: 600,
          rpe: null,
          note: null,
        },
        expectedHistoryRevision: session.historyRevision,
        clientMutationId: crypto.randomUUID(),
        correctionEvidence: {
          category: "measurement_entry",
          reasonNote: "Verified against the watch",
          source: "workout_history",
        },
      },
    );
    expect(corrected).toMatchObject({ ok: true, historyRevision: 1 });

    const csv = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    expect(
      csv.find((row) => row.completed_set_id === saved.distance.setId),
    ).toMatchObject({
      distance_km: "1.4",
      duration_seconds: "630",
      note: "Watch distance was entered incorrectly",
    });

    const backup = await buildJsonBackup(
      database.db,
      fixture.userId,
      () => undefined,
      { appVersion: "v2-t02-portability" },
    );
    const roundTripped = validateUserHeldJsonBackup(
      JSON.parse(JSON.stringify(backup)),
      fixture.userId,
    );
    const versions = roundTripped.canonical.tables.record_versions as Array<
      Record<string, unknown>
    >;
    const version = versions.find(
      (row) => row.entity_id === saved.distance.setId,
    );
    expect(version).toBeTruthy();
    expect(version?.before_data).toMatchObject({
      distance_km: 1.2,
      duration_seconds: 600,
      note: null,
    });
    expect(version?.after_data).toMatchObject({
      distance_km: 1.4,
      duration_seconds: 630,
      note: "Watch distance was entered incorrectly",
    });
    expect(
      readSetCorrectionEvidence(
        version?.after_data as Record<string, unknown>,
      ),
    ).toMatchObject({
      category: "measurement_entry",
      reasonNote: "Verified against the watch",
      source: "workout_history",
      sourceHistoryRevision: 0,
      resultHistoryRevision: 1,
      dependentConclusions: "recompute_queued",
    });
  });
});
