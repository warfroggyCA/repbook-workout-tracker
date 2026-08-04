import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { completedSets, painLogs } from "@/db/schema";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import { createDataSnapshot, type SnapshotKeyring } from "@/services/snapshots";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
} from "@/services/snapshot-restore";
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

describe("V2 U02 exception context restore", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("restores set and pain evidence together without rebuilding a recommendation", async () => {
    const saved = await recordU02Exception(database.db, fixture);
    await completeT01Workout(database.db, fixture);
    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 52);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown U02 test key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "U02 exception context", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-u02-restore" },
    );
    if (!created.ok) throw new Error(created.reason);

    await database.db.update(completedSets).set({
      rir: null,
      techniqueIssue: null,
      limitationCause: null,
      note: null,
    }).where(eq(completedSets.id, saved.setId));
    await database.db.update(painLogs).set({
      bodyPart: "shoulder",
      severity: 1,
      note: null,
    }).where(eq(painLogs.completedSetId, saved.setId));

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
      { store, keyring, appVersion: "v2-u02-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, saved.setId),
    })).toMatchObject({
      rpe: null,
      rir: 2,
      techniqueIssue: "bracing",
      limitationCause: "strength_fatigue",
      note: "Stopped before technique degraded further",
    });
    expect(await database.db.query.painLogs.findFirst({
      where: eq(painLogs.completedSetId, saved.setId),
    })).toMatchObject({
      bodyPart: "back",
      severity: 4,
      note: "Sharp only at the bottom",
    });
  });
});

