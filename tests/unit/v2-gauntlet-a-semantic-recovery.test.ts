import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import {
  progressionJobs,
} from "@/db/schema";
import {
  buildJsonBackup,
  buildSetsCsv,
  validateUserHeldJsonBackup,
} from "@/services/export";
import { buildTrainingDigest } from "@/services/digest";
import { getHistoryReport } from "@/services/history-report";
import { abandonWorkoutSession, logWorkoutSet } from "@/services/session-lifecycle";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("Repbook v2 Gauntlet A semantic recovery", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("exports acknowledged abandoned-session facts without treating them as completed training", async () => {
    const saved = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.loaded,
    );
    if (saved.outcome !== "saved") throw new Error(saved.outcome);

    await abandonWorkoutSession(
      database.db,
      fixture.userId,
      fixture.sessionId,
    );

    const csvRows = parse(
      await buildSetsCsv(database.db, fixture.userId, null),
      { columns: true, skip_empty_lines: true },
    ) as Array<Record<string, string>>;
    const abandonedRows = csvRows.filter(
      (row) => row.template === "T01 truthful recording",
    );
    expect(abandonedRows).toHaveLength(7);
    expect(abandonedRows.every((row) => row.session_status === "abandoned"))
      .toBe(true);
    expect(
      abandonedRows.filter((row) => row.completed_set_id === saved.setId),
    ).toEqual([
      expect.objectContaining({
        occurrence_outcome: "completed",
        reps: "5",
        weight: "100",
        weight_unit: "kg",
      }),
    ]);
    expect(
      abandonedRows.filter((row) => row.occurrence_outcome === "abandoned"),
    ).toHaveLength(6);

    const history = await getHistoryReport(
      database.db,
      fixture.userId,
      "all",
      3,
    );
    expect(history.overview).toMatchObject({
      completedSessions: 1,
      abandonedSessions: 1,
      workingSets: 1,
    });
    expect(history.recentSessions).toContainEqual(
      expect.objectContaining({ id: fixture.sessionId, status: "abandoned" }),
    );

    const digest = await buildTrainingDigest(
      database.db,
      fixture.userId,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      new Date(Date.now() + 60 * 1000),
    );
    expect(digest.sessions).toContainEqual(
      expect.objectContaining({ id: fixture.sessionId, status: "abandoned" }),
    );
    expect(digest.cadence.completedSessions).toBe(1);
    expect(await database.db.select().from(progressionJobs)).toHaveLength(0);

    const backup = await buildJsonBackup(
      database.db,
      fixture.userId,
      () => undefined,
      { appVersion: "v2-gauntlet-a" },
    );
    const roundTripped = validateUserHeldJsonBackup(
      JSON.parse(JSON.stringify(backup)),
      fixture.userId,
    );
    expect(
      roundTripped.canonical.tables.workout_sessions,
    ).toContainEqual(
      expect.objectContaining({ id: fixture.sessionId, status: "abandoned" }),
    );
    expect(roundTripped.canonical.tables.completed_sets).toContainEqual(
      expect.objectContaining({ id: saved.setId, reps: 5, weight: 100 }),
    );
    const retainedOccurrences = (
      roundTripped.canonical.tables.session_occurrences as Array<
        Record<string, unknown>
      >
    ).filter((row) => row.session_id === fixture.sessionId);
    expect(retainedOccurrences).toHaveLength(7);
    expect(
      retainedOccurrences.filter((row) => row.outcome === "completed"),
    ).toHaveLength(1);
    expect(
      retainedOccurrences.filter((row) => row.outcome === "abandoned"),
    ).toHaveLength(6);

    expect(
      await database.db.query.workoutSessions.findFirst({
        where: (session, { eq }) => eq(session.id, fixture.sessionId),
      }),
    ).toMatchObject({ status: "abandoned" });
  });
});
