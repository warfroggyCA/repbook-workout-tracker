import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type {
  SessionExerciseData,
  SessionExerciseGroupData,
  SessionOccurrenceData,
} from "@/components/session/types";
import {
  completedSets,
  exercises,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrences,
} from "@/db/schema";
import { projectSessionGuidance } from "@/lib/session-guidance";
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

describe("V2 T05 execution semantics database and service contract", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("derives ordered member and round progress from acknowledged occurrence facts", async () => {
    const definitions = await database.db
      .insert(exercises)
      .values([
        {
          name: "T05 raise",
          movementPattern: "vertical_push",
          primaryMuscles: ["shoulders"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
        },
        {
          name: "T05 Pallof press",
          movementPattern: "core",
          primaryMuscles: ["core"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
        },
      ])
      .returning({ id: exercises.id, name: exercises.name });
    const [group] = await database.db
      .insert(sessionExerciseGroups)
      .values({
        sessionId: fixture.sessionId,
        provenance: "compiler",
        name: "T05 alternating pair",
        orderIdx: 10,
        plannedRounds: 2,
        memberCount: 2,
        restBetweenMembersSec: 20,
        restBetweenRoundsSec: 90,
      })
      .returning();
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
        restSec: 60,
      })))
      .returning({ id: sessionExercises.id, exerciseId: sessionExercises.exerciseId });
    const coordinates = [
      { member: 0, round: 1, sequence: 30, ordinal: 0, rest: 20 },
      { member: 1, round: 1, sequence: 31, ordinal: 0, rest: 90 },
      { member: 0, round: 2, sequence: 32, ordinal: 1, rest: 20 },
      { member: 1, round: 2, sequence: 33, ordinal: 1, rest: 0 },
    ];
    const createdOccurrences = await database.db
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

    await expect(
      logWorkoutSet(database.db, fixture.userId, command(1, 1, "t05-too-early")),
    ).resolves.toMatchObject({ outcome: "set_order_conflict" });
    const first = await logWorkoutSet(
      database.db,
      fixture.userId,
      command(0, 1, "t05-first-member"),
    );
    if (first.outcome !== "saved") throw new Error(first.outcome);

    const project = async () => {
      const rows = await database.db
        .select()
        .from(sessionOccurrences)
        .where(eq(sessionOccurrences.groupSnapshotId, group.id))
        .orderBy(asc(sessionOccurrences.sequenceIdx));
      const resultRows = await database.db
        .select()
        .from(completedSets)
        .where(eq(completedSets.sessionExerciseId, members[0].id));
      const occurrenceData = rows.map((row): SessionOccurrenceData => ({
        id: row.id,
        sessionExerciseId: row.sessionExerciseId,
        kind: row.kind as SessionOccurrenceData["kind"],
        origin: row.origin as SessionOccurrenceData["origin"],
        sequenceIdx: row.sequenceIdx,
        kindOrdinal: row.kindOrdinal,
        label: row.label,
        plannedExerciseId: row.plannedExerciseId,
        plannedNote: row.plannedNote,
        plannedRepsMin: row.plannedRepsMin,
        plannedRepsMax: row.plannedRepsMax,
        plannedLoad: row.plannedLoad,
        plannedLoadUnit: row.plannedLoadUnit,
        plannedLoadPercent: row.plannedLoadPercent,
        plannedLoadText: row.plannedLoadText,
        plannedRestSec: row.plannedRestSec,
        groupSnapshotId: row.groupSnapshotId,
        groupRound: row.groupRound,
        groupMemberOrderIdx: row.groupMemberOrderIdx,
        outcome: row.outcome as SessionOccurrenceData["outcome"],
        outcomeReason: row.outcomeReason,
        outcomeNote: row.outcomeNote,
        revision: row.revision,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        completedSetId: row.completedSetId,
      }));
      const exerciseData = definitions.map((definition, index): SessionExerciseData => ({
        id: members[index].id,
        exerciseId: definition.id,
        name: definition.name,
        family: null,
        loadType: "bodyweight",
        loadSemantics: "bodyweight",
        movementPattern: index === 0 ? "vertical_push" : "core",
        orderIdx: 20 + index,
        supersetKey: group.id,
        restSec: 60,
        modificationType: "as_planned",
        skipReason: null,
        substitutedForExerciseId: null,
        substitutionReason: null,
        substitutedAt: null,
        plannedExerciseName: null,
        targetSets: 2,
        targetRepsMin: 8,
        targetRepsMax: 10,
        targetLoad: null,
        targetLoadUnit: null,
        notes: null,
        warmupNotes: null,
        warmupSets: [],
        setNotes: [],
        cautionBodyParts: [],
        media: null,
        sets: index === 0
          ? resultRows.map((set) => ({
              id: set.id,
              clientKey: set.clientKey,
              setNo: set.setNo,
              weight: set.weight,
              weightUnit: set.weightUnit,
              reps: set.reps,
              metricType: set.metricType,
              distanceKm: set.distanceKm,
              durationSeconds: set.durationSeconds,
              rpe: set.rpe,
              note: set.note,
            }))
          : [],
        last: null,
      }));
      const groupData: SessionExerciseGroupData = {
        id: group.id,
        name: group.name ?? "Exercise group",
        plannedRounds: group.plannedRounds,
        memberCount: group.memberCount,
        orderIdx: group.orderIdx,
      };
      return projectSessionGuidance({
        occurrences: occurrenceData,
        exercises: exerciseData,
        exerciseGroups: [groupData],
        equipmentSetups: {},
      });
    };

    const afterFirst = await project();
    expect(afterFirst.actions.map((action) => action.restAfter)).toEqual([
      { kind: "between_members", seconds: 20 },
      { kind: "between_rounds", seconds: 90 },
      { kind: "between_members", seconds: 20 },
      { kind: "none", seconds: 0 },
    ]);
    expect(afterFirst.current).toMatchObject({
      occurrenceId: createdOccurrences[1].id,
      group: { round: 1, member: 2 },
    });
    expect(afterFirst.upNext).toMatchObject({
      occurrenceId: createdOccurrences[2].id,
      group: { round: 2, member: 1 },
    });

    const skipInput = {
      occurrenceId: createdOccurrences[1].id,
      operation: "skip" as const,
      reason: "owner chose to skip",
      expectedRevision: 0,
      clientKey: "t05-skip-member",
    };
    const skipped = await mutateWorkoutOccurrence(
      database.db,
      fixture.userId,
      skipInput,
    );
    const retried = await mutateWorkoutOccurrence(
      database.db,
      fixture.userId,
      skipInput,
    );
    expect(skipped).toMatchObject({ outcome: "saved" });
    if (skipped.outcome !== "saved") throw new Error(skipped.outcome);
    expect(retried).toMatchObject({
      outcome: "replayed",
      occurrence: skipped.occurrence,
    });

    await expect(
      logWorkoutSet(database.db, fixture.userId, command(0, 2, "t05-round-two")),
    ).resolves.toMatchObject({ outcome: "saved" });
    await expect(
      mutateWorkoutOccurrence(database.db, fixture.userId, {
        occurrenceId: createdOccurrences[3].id,
        operation: "skip",
        reason: "owner chose to skip",
        expectedRevision: 0,
        clientKey: "t05-final-skip",
      }),
    ).resolves.toMatchObject({ outcome: "saved" });

    const resolved = await project();
    expect(resolved.groups[0]).toMatchObject({
      completion: "resolved_with_changes",
      totals: { performed: 2, skipped: 2, pending: 0 },
    });
    expect(resolved.completion).toMatchObject({
      state: "ready_to_finish",
      pendingOccurrences: 0,
    });
  });
});
