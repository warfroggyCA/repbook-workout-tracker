import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  sessionExercises,
} from "@/db/schema";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  createDataSnapshot,
  type SnapshotKeyring,
} from "@/services/snapshots";
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
  recordT01SupportedSets,
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("V2 T01 recording restore", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  it("restores raw performed evidence and recomputes consequential projections without filling legacy gaps", async () => {
    const saved = await recordT01SupportedSets(database.db, fixture);
    await completeT01Workout(database.db, fixture);

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 41);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown T01 test key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "T01 recording truth", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-t01-restore" },
    );
    if (!created.ok) throw new Error(created.reason);

    await database.db
      .update(completedSets)
      .set({ durationSeconds: 999, targetMet: true })
      .where(eq(completedSets.id, saved.duration.setId));
    await database.db
      .update(completedSets)
      .set({ distanceKm: 9.9, durationSeconds: null, targetMet: true })
      .where(eq(completedSets.id, saved.distance.setId));
    await database.db
      .update(completedSets)
      .set({ targetMet: true })
      .where(eq(completedSets.id, fixture.legacySetId));
    await database.db
      .update(sessionExercises)
      .set({
        modificationType: "as_planned",
        substitutedForExerciseId: null,
        substitutionReason: null,
        substitutedAt: null,
      })
      .where(eq(
        sessionExercises.id,
        fixture.sessionExerciseIds.bodyweightSubstitution,
      ));

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
      { store, keyring, appVersion: "v2-t01-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });

    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, saved.duration.setId),
    })).toMatchObject({
      metricType: "duration",
      weight: null,
      reps: null,
      distanceKm: null,
      durationSeconds: 45,
      performedSemanticsVersion: 1,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight",
      targetMet: null,
    });
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, saved.distance.setId),
    })).toMatchObject({
      metricType: "distance_duration",
      distanceKm: 1.2,
      durationSeconds: 600,
      targetMet: null,
    });
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, fixture.legacySetId),
    })).toMatchObject({
      weight: 50,
      weightUnit: "lb",
      reps: 10,
      performedSemanticsVersion: null,
      performedLoadType: null,
      performedLoadSemantics: null,
      targetMet: null,
    });
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(
        sessionExercises.id,
        fixture.sessionExerciseIds.bodyweightSubstitution,
      ),
    })).toMatchObject({
      exerciseId: fixture.exerciseIds.bodyweightSubstitution,
      modificationType: "substituted",
      substitutedForExerciseId: fixture.exerciseIds.plannedSubstitution,
      substitutionReason: "equipment_busy",
    });
  });
});
