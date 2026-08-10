import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type {
  SessionExerciseData,
  SessionOccurrenceData,
} from "@/components/session/types";
import {
  exercises,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrences,
  workoutSessions,
} from "@/db/schema";
import { projectSessionGuidance } from "@/lib/session-guidance";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
} from "@/services/snapshot-restore";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  createDataSnapshot,
  type SnapshotKeyring,
} from "@/services/snapshots";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("V2 T05 execution-semantics recovery", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("restores the exact occurrence order, group coordinates, nullable rest, and derived completion", async () => {
    const definitions = await database.db
      .insert(exercises)
      .values([
        {
          name: "T05 restored raise",
          movementPattern: "vertical_push",
          primaryMuscles: ["shoulders"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
        },
        {
          name: "T05 restored press",
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
        name: "T05 restored pair",
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
      })))
      .returning({ id: sessionExercises.id });
    const resolvedAt = new Date();
    const coordinates = [
      { member: 0, round: 1, sequence: 30, ordinal: 0, rest: 20, outcome: "skipped" as const },
      { member: 1, round: 1, sequence: 31, ordinal: 0, rest: 90, outcome: "abandoned" as const },
      { member: 0, round: 2, sequence: 32, ordinal: 1, rest: 20, outcome: "skipped" as const },
      { member: 1, round: 2, sequence: 33, ordinal: 1, rest: null, outcome: "abandoned" as const },
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
        plannedExerciseId: definitions[coordinate.member].id,
        plannedRepsMin: 8,
        plannedRepsMax: 10,
        plannedRestSec: coordinate.rest,
        groupSnapshotId: group.id,
        groupRound: coordinate.round,
        groupMemberOrderIdx: coordinate.member,
        outcome: coordinate.outcome,
        outcomeReason: "retained T05 fixture",
        revision: 1,
        resolvedAt,
      })))
      .returning({ id: sessionOccurrences.id });
    await database.db
      .update(workoutSessions)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(workoutSessions.id, fixture.sessionId));

    const projection = async () => {
      const rows = await database.db
        .select()
        .from(sessionOccurrences)
        .where(eq(sessionOccurrences.groupSnapshotId, group.id))
        .orderBy(asc(sessionOccurrences.sequenceIdx));
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
        sets: [],
        last: null,
      }));
      const derived = projectSessionGuidance({
        occurrences: occurrenceData,
        exercises: exerciseData,
        exerciseGroups: [{
          id: group.id,
          name: group.name ?? "Exercise group",
          plannedRounds: group.plannedRounds,
          memberCount: group.memberCount,
          orderIdx: group.orderIdx,
        }],
        equipmentSetups: {},
      });
      return {
        rows: rows.map((row) => ({
          id: row.id,
          sequenceIdx: row.sequenceIdx,
          plannedRestSec: row.plannedRestSec,
          groupRound: row.groupRound,
          groupMemberOrderIdx: row.groupMemberOrderIdx,
          outcome: row.outcome,
        })),
        rest: derived.actions.map((action) => action.restAfter),
        completion: derived.groups[0].completion,
        workoutState: derived.completion.state,
      };
    };

    const before = await projection();
    expect(before).toMatchObject({
      rest: [
        { kind: "between_members", seconds: 20 },
        { kind: "between_rounds", seconds: 90 },
        { kind: "between_members", seconds: 20 },
        { kind: "unknown", seconds: null },
      ],
      completion: "resolved_with_changes",
      workoutState: "ready_to_finish",
    });

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 45);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown T05 test key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "T05 execution recovery", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-t05-restore" },
    );
    if (!created.ok) throw new Error(created.reason);

    await expect(
      database.db
        .update(sessionOccurrences)
        .set({ plannedRestSec: 777 })
        .where(eq(sessionOccurrences.id, occurrences[1].id)),
    ).rejects.toThrow(/Failed query: update "session_occurrences"/);

    const preview = await getSnapshotRestorePreview(
      database.db,
      fixture.userId,
      created.snapshotId,
      "history",
      { store, keyring },
    );
    const restored = await restoreDataSnapshot(
      database.db,
      fixture.userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "v2-t05-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });
    expect(await projection()).toEqual(before);
  });
});
