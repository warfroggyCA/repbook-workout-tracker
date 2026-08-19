import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import {
  sessionExercises,
  sessionOccurrences,
  workoutSessions,
} from "@/db/schema";
import { buildTrainingDigest, renderCoachingBrief } from "@/services/digest";
import { buildSetsCsv } from "@/services/export";
import { mutateWorkoutOccurrence } from "@/services/session-lifecycle";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  completeT01Workout,
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("V2 T04 warm-up occurrence portability", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("exports each action once with its exact outcome while keeping overview guidance non-actionable", async () => {
    const dayOccurrenceId = crypto.randomUUID();
    const exerciseOccurrenceId = crypto.randomUUID();
    const dayOverview = "T04 day overview is reference guidance only.";
    const exerciseOverview = "T04 exercise overview is reference guidance only.";
    await database.db
      .update(workoutSessions)
      .set({ dayWarmupNotes: dayOverview })
      .where(eq(workoutSessions.id, fixture.sessionId));
    await database.db
      .update(sessionExercises)
      .set({ warmupNotes: exerciseOverview })
      .where(eq(sessionExercises.id, fixture.sessionExerciseIds.loaded));
    await database.db.insert(sessionOccurrences).values([
      {
        id: dayOccurrenceId,
        sessionId: fixture.sessionId,
        kind: "day_warmup",
        origin: "planned",
        sequenceIdx: 7,
        kindOrdinal: 0,
        label: "T04 day mobility",
        plannedRepsMin: 8,
        plannedRepsMax: 8,
      },
      {
        id: exerciseOccurrenceId,
        sessionId: fixture.sessionId,
        sessionExerciseId: fixture.sessionExerciseIds.loaded,
        kind: "exercise_warmup",
        origin: "planned",
        sequenceIdx: 8,
        kindOrdinal: 0,
        plannedExerciseId: fixture.exerciseIds.loaded,
        label: "T04 press rehearsal",
        plannedLoadText: "empty implement",
        plannedNote: "Keep the setup stable",
      },
    ]);

    await mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: dayOccurrenceId,
      clientKey: crypto.randomUUID(),
      expectedRevision: 0,
      operation: "note",
      note: "Moved comfortably",
    });
    await mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: dayOccurrenceId,
      clientKey: crypto.randomUUID(),
      expectedRevision: 1,
      operation: "complete",
    });
    await mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: exerciseOccurrenceId,
      clientKey: crypto.randomUUID(),
      expectedRevision: 0,
      operation: "skip",
      reason: "time",
      note: "Setup was already warm",
    });
    await completeT01Workout(database.db, fixture);

    const csvRows = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    const exportedWarmups = csvRows.filter((row) =>
      [dayOccurrenceId, exerciseOccurrenceId].includes(row.occurrence_id),
    );
    expect(exportedWarmups).toHaveLength(2);
    expect(exportedWarmups).toContainEqual(
      expect.objectContaining({
        occurrence_id: dayOccurrenceId,
        occurrence_kind: "day_warmup",
        occurrence_outcome: "completed",
        occurrence_note: "Moved comfortably",
        planned_label: "T04 day mobility",
      }),
    );
    expect(exportedWarmups).toContainEqual(
      expect.objectContaining({
        occurrence_id: exerciseOccurrenceId,
        occurrence_kind: "exercise_warmup",
        occurrence_outcome: "skipped",
        occurrence_reason: "time",
        occurrence_note: "Setup was already warm",
        planned_label: "T04 press rehearsal",
        occurrence_planned_note: "Keep the setup stable",
      }),
    );
    expect(await buildSetsCsv(database.db, fixture.userId, null)).not.toContain(
      dayOverview,
    );
    expect(await buildSetsCsv(database.db, fixture.userId, null)).not.toContain(
      exerciseOverview,
    );

    const digest = await buildTrainingDigest(
      database.db,
      fixture.userId,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    );
    const session = digest.sessions.find(
      (candidate) => candidate.template === "T01 truthful recording",
    );
    expect(session?.occurrences.filter((row) => row.kind !== "working_set"))
      .toEqual([
        expect.objectContaining({
          kind: "day_warmup",
          label: "T04 day mobility",
          outcome: "completed",
          note: "Moved comfortably",
        }),
        expect.objectContaining({
          kind: "exercise_warmup",
          label: "T04 press rehearsal",
          outcome: "skipped",
          reason: "time",
          note: "Setup was already warm",
        }),
      ]);
    const brief = renderCoachingBrief(digest);
    const compact = brief.slice(
      brief.indexOf("## Compact workout summaries"),
      brief.indexOf("## Target attainment and confidence"),
    );
    const audit = brief.slice(brief.indexOf("## Detailed audit appendix"));
    expect(compact.match(/T04 day mobility/g)).toHaveLength(1);
    expect(compact.match(/T04 press rehearsal/g)).toHaveLength(1);
    expect(audit.match(/T04 day mobility/g)).toHaveLength(1);
    expect(audit.match(/T04 press rehearsal/g)).toHaveLength(1);
    expect(brief).not.toContain(dayOverview);
    expect(brief).not.toContain(exerciseOverview);
  });
});
