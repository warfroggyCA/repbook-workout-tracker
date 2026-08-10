import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  completedSets,
  progressionJobs,
  recordVersions,
  workoutSessions,
} from "@/db/schema";
import { readSetCorrectionEvidence } from "@/lib/set-correction";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import { restoreRecordVersion, updateSetWithVersion } from "@/services/record-versions";
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
import { logWorkoutSet } from "@/services/session-lifecycle";

const expectedDuration = {
  weight: null,
  weightUnit: null,
  reps: null,
  distanceKm: null,
  durationSeconds: 45,
  rpe: null,
  note: null,
};

const correctionEvidence = {
  category: "measurement_entry",
  reasonNote: null,
  source: "workout_history",
} as const;

describe("V2 T02 correction recovery", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;
  let durationSetId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
    const saved = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.duration,
    );
    if (saved.outcome !== "saved") throw new Error(saved.outcome);
    durationSetId = saved.setId;
    await completeT01Workout(database.db, fixture);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  async function correctDuration(
    durationSeconds: number,
    expected: typeof expectedDuration,
    expectedHistoryRevision: number,
  ) {
    return updateSetWithVersion(
      database.db,
      fixture.userId,
      durationSetId,
      { ...expected, durationSeconds },
      "set.completed_correction",
      {
        expected,
        expectedHistoryRevision,
        clientMutationId: crypto.randomUUID(),
        correctionEvidence,
      },
    );
  }

  it("restores timed evidence as a new revision and preserves the intervening correction", async () => {
    const corrected = await correctDuration(75, expectedDuration, 0);
    expect(corrected).toMatchObject({ ok: true, historyRevision: 1 });
    if (!corrected.ok || !corrected.versionId) {
      throw new Error("Missing correction version.");
    }

    const restored = await restoreRecordVersion(
      database.db,
      fixture.userId,
      corrected.versionId,
      {
        expectedHistoryRevision: 1,
        clientMutationId: crypto.randomUUID(),
      },
    );
    expect(restored).toMatchObject({
      ok: true,
      changed: true,
      historyRevision: 2,
    });
    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, durationSetId),
      }),
    ).toMatchObject({
      metricType: "duration",
      durationSeconds: 45,
      distanceKm: null,
      weight: null,
      reps: null,
    });
    const versions = await database.db.query.recordVersions.findMany({
      where: eq(recordVersions.entityId, durationSetId),
    });
    expect(versions).toHaveLength(2);
    const restoreVersion = versions.find(
      (version) => version.action === "set.version_restore",
    );
    expect(restoreVersion?.sourceVersionId).toBe(corrected.versionId);
    expect(
      readSetCorrectionEvidence(
        restoreVersion?.afterData as Record<string, unknown>,
      ),
    ).toMatchObject({
      category: "restore_prior_version",
      source: "record_version_restore",
      sourceHistoryRevision: 1,
      resultHistoryRevision: 2,
      restoredFromVersionId: corrected.versionId,
      dependentConclusions: "recompute_queued",
    });
  });

  it("round-trips the effective value and correction lineage through snapshot restore", async () => {
    const first = await correctDuration(75, expectedDuration, 0);
    expect(first).toMatchObject({ ok: true, historyRevision: 1 });

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 42);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown T02 test key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "T02 correction lineage", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-t02-restore" },
    );
    if (!created.ok) throw new Error(created.reason);

    const secondExpected = { ...expectedDuration, durationSeconds: 75 };
    const second = await correctDuration(90, secondExpected, 1);
    expect(second).toMatchObject({ ok: true, historyRevision: 2 });
    if (!first.ok || !first.versionId) {
      throw new Error("Missing first correction version.");
    }
    const firstVersionId = first.versionId;
    await database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('workout_tracker.authorized_delete', 'snapshot_restore', true)`,
      );
      await tx
        .delete(recordVersions)
        .where(eq(recordVersions.id, firstVersionId));
    });

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
      { store, keyring, appVersion: "v2-t02-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });
    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, durationSetId),
      }),
    ).toMatchObject({ durationSeconds: 75 });
    const versions = await database.db.query.recordVersions.findMany({
      where: eq(recordVersions.entityId, durationSetId),
    });
    expect(versions).toHaveLength(3);
    const restoredSource = versions.find(
      (version) => version.id === firstVersionId,
    );
    expect(readSetCorrectionEvidence(restoredSource?.afterData ?? {})).toMatchObject({
      sourceHistoryRevision: 0,
      resultHistoryRevision: 1,
      sourceLedgerRevision: 0,
      resultLedgerRevision: 1,
    });
    const restoreTransition = versions.find(
      (version) => version.action === "set.snapshot_restore",
    );
    expect(
      readSetCorrectionEvidence(restoreTransition?.afterData ?? {}),
    ).toMatchObject({
      category: "restore_snapshot",
      source: "snapshot_restore",
      sourceHistoryRevision: 2,
      resultHistoryRevision: 1,
      sourceLedgerRevision: 2,
      resultLedgerRevision: 3,
      dependentConclusions: "snapshot_state_reconciled",
      restoredFromSnapshotId: created.snapshotId,
    });
    const restoredWorkout = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, fixture.sessionId),
    });
    expect(restoredWorkout?.historyRevision).toBe(2);
    const restoredProgressionJobs =
      await database.db.query.progressionJobs.findMany({
        where: eq(progressionJobs.sessionId, fixture.sessionId),
      });
    expect(
      restoredProgressionJobs.filter(
        (job) =>
          job.sourceSessionRevision !== restoredWorkout?.historyRevision &&
          (job.status === "pending" || job.status === "processing"),
      ),
    ).toEqual([]);
    expect(
      restoredProgressionJobs.some(
        (job) =>
          job.sourceSessionRevision === restoredWorkout?.historyRevision &&
          job.status === "pending",
      ),
    ).toBe(true);
    expect(
      await evaluateApplicationIntegrity(database.db, fixture.userId),
    ).toEqual([]);

    await database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('workout_tracker.authorized_delete', 'snapshot_restore', true)`,
      );
      await tx
        .delete(recordVersions)
        .where(eq(recordVersions.id, firstVersionId));
      await tx.insert(recordVersions).values({
        id: firstVersionId,
        userId: fixture.userId,
        entityType: "completed_set",
        entityId: durationSetId,
        action: "set.synthetic_identity_conflict",
        beforeData: { id: durationSetId, duration_seconds: 1 },
        afterData: { id: durationSetId, duration_seconds: 2 },
        changedFields: ["duration_seconds"],
      });
    });
    const conflictPreview = await getSnapshotRestorePreview(
      database.db,
      fixture.userId,
      created.snapshotId,
      "history",
      { store, keyring },
    );
    const conflictRestore = await restoreDataSnapshot(
      database.db,
      fixture.userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: conflictPreview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "v2-t02-restore" },
    );
    expect(conflictRestore).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        "Snapshot version identity conflicts with retained history",
      ),
    });
    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, durationSetId),
      }),
    ).toMatchObject({ durationSeconds: 75 });
    expect(
      await database.db.query.recordVersions.findFirst({
        where: eq(recordVersions.id, firstVersionId),
      }),
    ).toMatchObject({ action: "set.synthetic_identity_conflict" });
  });
});
