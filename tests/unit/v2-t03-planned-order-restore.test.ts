import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { completedSets, sessionOccurrences } from "@/db/schema";
import {
  appendWorkoutSetOccurrence,
  logWorkoutSet,
} from "@/services/session-lifecycle";
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

describe("V2 T03 planned-order recovery", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("preserves immutable occurrence roles and removes invented target truth from an extra", async () => {
    const extraOccurrenceId = crypto.randomUUID();
    await appendWorkoutSetOccurrence(database.db, fixture.userId, {
      sessionExerciseId: fixture.sessionExerciseIds.loaded,
      occurrenceId: extraOccurrenceId,
      expectedSetNo: 2,
    });
    const extra = await logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      setNo: 2,
      clientKey: "t03-restore-extra",
    });
    const planned = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.loaded,
    );
    if (extra.outcome !== "saved" || planned.outcome !== "saved") {
      throw new Error("T03 recovery setup did not save both results.");
    }
    await completeT01Workout(database.db, fixture);

    // Simulate a retained pre-T03 derived value. Restore must interpret the
    // raw occurrence origin and refuse to revive it as planned target truth.
    await database.db
      .update(completedSets)
      .set({ targetMet: true })
      .where(eq(completedSets.id, extra.setId));

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 43);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown T03 test key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "T03 planned order", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-t03-restore" },
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
      { store, keyring, appVersion: "v2-t03-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });

    const occurrences = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(
        sessionOccurrences.sessionExerciseId,
        fixture.sessionExerciseIds.loaded,
      ))
      .orderBy(asc(sessionOccurrences.sequenceIdx));
    expect(occurrences).toEqual([
      expect.objectContaining({
        id: planned.occurrenceId,
        origin: "planned",
        kindOrdinal: 0,
        plannedNote: null,
        completedSetId: planned.setId,
      }),
      expect.objectContaining({
        id: extraOccurrenceId,
        origin: "ad_hoc",
        kindOrdinal: 1,
        plannedNote: "Added during this workout",
        completedSetId: extra.setId,
      }),
    ]);
    expect(occurrences[0].sequenceIdx).toBeLessThan(occurrences[1].sequenceIdx);
    await expect(
      database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, extra.setId),
        columns: { targetMet: true },
      }),
    ).resolves.toEqual({ targetMet: null });
    await expect(
      database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, planned.setId),
        columns: { targetMet: true },
      }),
    ).resolves.toEqual({ targetMet: null });
  });
});
