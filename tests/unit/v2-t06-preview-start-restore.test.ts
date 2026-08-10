import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { sessionExercises, workoutSessions } from "@/db/schema";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
  upgradeSnapshotPayload,
  validateSnapshotPayload,
} from "@/services/snapshot-restore";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import { createDataSnapshot, type SnapshotKeyring } from "@/services/snapshots";
import { startWorkoutSession } from "@/services/session-lifecycle";
import { createMigratedTestDatabase, type TestDatabase } from "../helpers/database";
import { seedT06PreviewStart } from "../helpers/v2-t06-preview-start";

describe("Repbook v2 T06 Start recovery", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("restores exact Start identity and prescribed meaning without catalog inference", async () => {
    const fixture = await seedT06PreviewStart(database.db);
    const startRequestKey = crypto.randomUUID();
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
      undefined,
      { startRequestKey, timezone: "America/Toronto" },
    );
    const beforeSession = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    });
    const beforeExercise = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, started.sessionId),
    });
    if (!beforeSession || !beforeExercise) throw new Error("T06 restore fixture is missing.");

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 66);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown T06 snapshot key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "T06 Start recovery", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-t06-restore" },
    );
    if (!created.ok) throw new Error(created.reason);

    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('workout_tracker.authorized_delete', 'snapshot_restore', true)`);
      await tx
        .update(workoutSessions)
        .set({ startRequestHash: "f".repeat(64) })
        .where(eq(workoutSessions.id, started.sessionId));
      await tx
        .update(sessionExercises)
        .set({ prescribedExerciseName: "Temporary restore mutation" })
        .where(eq(sessionExercises.id, beforeExercise.id));
    });

    const preview = await getSnapshotRestorePreview(
      database.db,
      fixture.userId,
      created.snapshotId,
      "full",
      { store, keyring },
    );
    const restored = await restoreDataSnapshot(
      database.db,
      fixture.userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "v2-t06-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "full" });
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, started.sessionId),
      }),
    ).toMatchObject({
      startRequestKey,
      startRequestHash: beforeSession.startRequestHash,
    });
    expect(
      await database.db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, beforeExercise.id),
      }),
    ).toMatchObject({
      prescribedSemanticsVersion: 1,
      prescribedExerciseName: fixture.exerciseName,
      prescribedMetricType: "weight_reps",
      prescribedLoadType: "dumbbell",
      prescribedLoadSemantics: "per_implement",
    });
  }, 30_000);

  it("upgrades schema 27 to explicit null unknowns and rejects incoherent schema 28 tuples", async () => {
    const fixture = await seedT06PreviewStart(database.db);
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
      undefined,
      { startRequestKey: crypto.randomUUID(), timezone: "America/Toronto" },
    );
    const current = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-02T18:00:00.000Z"),
      "v2-t06-schema-27",
    );
    const legacy = structuredClone(current);
    legacy.schemaVersion = "27";
    for (const workout of legacy.tables.workout_sessions as Array<Record<string, unknown>>) {
      delete workout.start_request_key;
      delete workout.start_request_hash;
    }
    for (const exercise of legacy.tables.session_exercises as Array<Record<string, unknown>>) {
      delete exercise.prescribed_semantics_version;
      delete exercise.prescribed_exercise_name;
      delete exercise.prescribed_metric_type;
      delete exercise.prescribed_load_type;
      delete exercise.prescribed_load_semantics;
    }

    const upgraded = upgradeSnapshotPayload(legacy);
    expect(upgraded.schemaVersion).toBe("31");
    expect(
      (upgraded.tables.workout_sessions as Array<Record<string, unknown>>)
        .find((row) => row.id === started.sessionId),
    ).toMatchObject({ start_request_key: null, start_request_hash: null });
    expect(
      (upgraded.tables.session_exercises as Array<Record<string, unknown>>).find(
        (row) => row.session_id === started.sessionId,
      ),
    ).toMatchObject({
      prescribed_semantics_version: null,
      prescribed_exercise_name: null,
      prescribed_metric_type: null,
      prescribed_load_type: null,
      prescribed_load_semantics: null,
    });
    expect(() => validateSnapshotPayload(upgraded, fixture.userId)).not.toThrow();

    const partial = structuredClone(current);
    const exercise = (partial.tables.session_exercises as Array<Record<string, unknown>>)
      .find((row) => row.session_id === started.sessionId) as Record<string, unknown>;
    exercise.prescribed_load_type = null;
    expect(() => validateSnapshotPayload(partial, fixture.userId)).toThrow(
      /incoherent prescribed meaning/i,
    );

    const invalidIdentity = structuredClone(current);
    const workout = (invalidIdentity.tables.workout_sessions as Array<Record<string, unknown>>)
      .find((row) => row.id === started.sessionId) as Record<string, unknown>;
    workout.start_request_hash = "not-a-sha";
    expect(() => validateSnapshotPayload(invalidIdentity, fixture.userId)).toThrow(
      /invalid Start request identity/i,
    );
  });
});
