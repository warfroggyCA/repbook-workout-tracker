import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import {
  exercises,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrences,
  workoutSessions,
} from "@/db/schema";
import { buildTrainingDigest } from "@/services/digest";
import { buildSetsCsv } from "@/services/export";
import {
  logWorkoutSet,
  mutateWorkoutOccurrence,
} from "@/services/session-lifecycle";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("V2 T05 execution-semantics portability", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("exports exact group order, outcomes, and nullable rest facts without a client-only state", async () => {
    const definitions = await database.db
      .insert(exercises)
      .values([
        {
          name: "T05 portable raise",
          movementPattern: "vertical_push",
          primaryMuscles: ["shoulders"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
        },
        {
          name: "T05 portable press",
          movementPattern: "core",
          primaryMuscles: ["core"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
        },
      ])
      .returning({ id: exercises.id });
    const [group] = await database.db
      .insert(sessionExerciseGroups)
      .values({
        sessionId: fixture.sessionId,
        provenance: "compiler",
        name: "T05 portable pair",
        orderIdx: 10,
        plannedRounds: 2,
        memberCount: 2,
        restBetweenMembersSec: 20,
        restBetweenRoundsSec: 90,
      })
      .returning({ id: sessionExerciseGroups.id });
    const members = await database.db
      .insert(sessionExercises)
      .values(definitions.map((definition, index) => ({
        sessionId: fixture.sessionId,
        exerciseId: definition.id,
        orderIdx: 20 + index,
        groupSnapshotId: group.id,
        groupMemberOrderIdx: index,
        targetSets: 2,
        targetRepsMin: 8,
        targetRepsMax: 10,
      })))
      .returning({ id: sessionExercises.id, exerciseId: sessionExercises.exerciseId });
    const coordinates = [
      { member: 0, round: 1, sequence: 30, ordinal: 0, rest: 20 },
      { member: 1, round: 1, sequence: 31, ordinal: 0, rest: 90 },
      { member: 0, round: 2, sequence: 32, ordinal: 1, rest: 20 },
      { member: 1, round: 2, sequence: 33, ordinal: 1, rest: null },
    ];
    const occurrences = await database.db
      .insert(sessionOccurrences)
      .values(coordinates.map((coordinate) => ({
        sessionId: fixture.sessionId,
        sessionExerciseId: members[coordinate.member].id,
        kind: "working_set" as const,
        origin: "planned" as const,
        sequenceIdx: coordinate.sequence,
        kindOrdinal: coordinate.ordinal,
        plannedExerciseId: members[coordinate.member].exerciseId,
        plannedRepsMin: 8,
        plannedRepsMax: 10,
        plannedRestSec: coordinate.rest,
        groupSnapshotId: group.id,
        groupRound: coordinate.round,
        groupMemberOrderIdx: coordinate.member,
      })))
      .returning({ id: sessionOccurrences.id });
    const command = (member: number, setNo: number, clientKey: string) => ({
      sessionExerciseId: members[member].id,
      performedExerciseId: members[member].exerciseId,
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

    await logWorkoutSet(database.db, fixture.userId, command(0, 1, "t05-portable-r1-a"));
    await mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: occurrences[1].id,
      operation: "skip",
      reason: "time",
      expectedRevision: 0,
      clientKey: "t05-portable-r1-b-skip",
    });
    await logWorkoutSet(database.db, fixture.userId, command(0, 2, "t05-portable-r2-a"));
    await mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: occurrences[3].id,
      operation: "skip",
      reason: "equipment",
      expectedRevision: 0,
      clientKey: "t05-portable-r2-b-skip",
    });
    await database.db
      .update(workoutSessions)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(workoutSessions.id, fixture.sessionId));

    const csvRows = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    expect(
      csvRows
        .filter((row) => occurrences.some((occurrence) => occurrence.id === row.occurrence_id))
        .map((row) => ({
          id: row.occurrence_id,
          sequence: row.occurrence_sequence,
          outcome: row.occurrence_outcome,
          rest: row.planned_rest_seconds,
          group: row.group_snapshot_id,
          round: row.group_round,
          member: row.group_member_order,
        })),
    ).toEqual([
      { id: occurrences[0].id, sequence: "30", outcome: "completed", rest: "20", group: group.id, round: "1", member: "0" },
      { id: occurrences[1].id, sequence: "31", outcome: "skipped", rest: "90", group: group.id, round: "1", member: "1" },
      { id: occurrences[2].id, sequence: "32", outcome: "completed", rest: "20", group: group.id, round: "2", member: "0" },
      { id: occurrences[3].id, sequence: "33", outcome: "skipped", rest: "", group: group.id, round: "2", member: "1" },
    ]);

    const digest = await buildTrainingDigest(
      database.db,
      fixture.userId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    const session = digest.sessions.find(
      (candidate) => candidate.template === "T01 truthful recording",
    );
    expect(
      session?.occurrences
        .filter((occurrence) => occurrence.sequence >= 30 && occurrence.sequence <= 33)
        .map((occurrence) => ({
          sequence: occurrence.sequence,
          outcome: occurrence.outcome,
          group: occurrence.group,
        })),
    ).toEqual([
      expect.objectContaining({
        sequence: 30,
        outcome: "completed",
        group: expect.objectContaining({ round: 1, memberOrder: 0, restAfterSeconds: 20 }),
      }),
      expect.objectContaining({
        sequence: 31,
        outcome: "skipped",
        group: expect.objectContaining({ round: 1, memberOrder: 1, restAfterSeconds: 90 }),
      }),
      expect.objectContaining({
        sequence: 32,
        outcome: "completed",
        group: expect.objectContaining({ round: 2, memberOrder: 0, restAfterSeconds: 20 }),
      }),
      expect.objectContaining({
        sequence: 33,
        outcome: "skipped",
        group: expect.objectContaining({ round: 2, memberOrder: 1, restAfterSeconds: null }),
      }),
    ]);
  });
});
