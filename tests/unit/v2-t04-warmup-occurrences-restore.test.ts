import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import {
  sessionEquipmentSnapshots,
  sessionOccurrenceMutations,
  sessionOccurrences,
} from "@/db/schema";
import { mutateWorkoutOccurrence } from "@/services/session-lifecycle";
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
  completeT01Workout,
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("V2 T04 warm-up occurrence recovery", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("restores stable warm-up identities, outcomes, equipment, notes, and receipts without synthesis", async () => {
    const dayOccurrenceId = crypto.randomUUID();
    const exerciseOccurrenceId = crypto.randomUUID();
    const [equipment] = await database.db
      .insert(sessionEquipmentSnapshots)
      .values({
        userId: fixture.userId,
        sessionId: fixture.sessionId,
        sessionExerciseId: fixture.sessionExerciseIds.loaded,
        equipmentLabel: "T04 portable setup",
        profileKind: "bodyweight",
        geometryCertainty: "known",
        selectionProvenance: "user_selected",
        configurationRevision: 1,
        configurationHash: "4".repeat(64),
        geometryVersion: 1,
        geometrySnapshot: { version: 1, kind: "bodyweight" },
      })
      .returning({ id: sessionEquipmentSnapshots.id });
    await database.db.insert(sessionOccurrences).values([
      {
        id: dayOccurrenceId,
        sessionId: fixture.sessionId,
        kind: "day_warmup",
        origin: "planned",
        sequenceIdx: 7,
        kindOrdinal: 0,
        label: "T04 restored mobility",
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
        label: "T04 restored rehearsal",
        plannedLoadPercent: 55,
        plannedNote: "Retain this prescription",
        equipmentSnapshotId: equipment.id,
      },
    ]);

    await mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: dayOccurrenceId,
      clientKey: "t04-restore-day-note",
      expectedRevision: 0,
      operation: "note",
      note: "Retain this completion note",
    });
    await mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: dayOccurrenceId,
      clientKey: "t04-restore-day-complete",
      expectedRevision: 1,
      operation: "complete",
    });
    await mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: exerciseOccurrenceId,
      clientKey: "t04-restore-exercise-skip",
      expectedRevision: 0,
      operation: "skip",
      reason: "equipment",
      note: "Rack temporarily unavailable",
    });
    await completeT01Workout(database.db, fixture);

    const beforeRows = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, fixture.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    const beforeReceipts = await database.db
      .select()
      .from(sessionOccurrenceMutations)
      .where(inArray(sessionOccurrenceMutations.occurrenceId, [
        dayOccurrenceId,
        exerciseOccurrenceId,
      ]))
      .orderBy(asc(sessionOccurrenceMutations.createdAt));

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 44);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown T04 test key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "T04 warm-up recovery", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-t04-restore" },
    );
    if (!created.ok) throw new Error(created.reason);
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
      { store, keyring, appVersion: "v2-t04-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });

    const afterRows = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, fixture.sessionId))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    expect(afterRows).toEqual(beforeRows);
    expect(afterRows.filter((row) => row.kind !== "working_set")).toEqual([
      expect.objectContaining({
        id: dayOccurrenceId,
        outcome: "completed",
        outcomeNote: "Retain this completion note",
        revision: 2,
      }),
      expect.objectContaining({
        id: exerciseOccurrenceId,
        outcome: "skipped",
        outcomeReason: "equipment",
        outcomeNote: "Rack temporarily unavailable",
        plannedExerciseId: fixture.exerciseIds.loaded,
        plannedLoadPercent: 55,
        equipmentSnapshotId: equipment.id,
        revision: 1,
      }),
    ]);
    const afterReceipts = await database.db
      .select()
      .from(sessionOccurrenceMutations)
      .where(inArray(sessionOccurrenceMutations.occurrenceId, [
        dayOccurrenceId,
        exerciseOccurrenceId,
      ]))
      .orderBy(asc(sessionOccurrenceMutations.createdAt));
    expect(afterReceipts).toEqual(beforeReceipts);
    expect(afterReceipts.map((receipt) => receipt.operation)).toEqual(
      expect.arrayContaining(["note", "complete", "skip"]),
    );
  });
});
