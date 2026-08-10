import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  completedSets,
  exercises,
  externalExerciseMappings,
  recordVersions,
  sessionExercises,
  sessionOccurrences,
} from "@/db/schema";
import { getHistoryReport } from "@/services/history-report";
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
  seedV2H02CadenceTargetsTime,
  V2_H02_NOW,
  type V2H02CadenceFixture,
} from "../helpers/v2-h02-cadence-targets-time";
import {
  addV2H03OwnedExerciseAndMappingEvidence,
  V2_H03_IDS,
  V2_H03_NORMALIZED_KEY,
} from "../helpers/v2-h03-exercise-evidence";

describe("V2 H03 recovery identity", () => {
  let database: TestDatabase;
  let fixture: V2H02CadenceFixture;
  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedV2H02CadenceTargetsTime(database.db);
  }, 30_000);
  afterEach(async () => database.close());

  it("restores exact identity and mapping facts, then recomputes H03 eligibility", async () => {
    await addV2H03OwnedExerciseAndMappingEvidence(database.db, fixture);
    await database.db.insert(recordVersions).values({
      id: V2_H03_IDS.correctionVersion,
      userId: fixture.userId,
      entityType: "completed_set",
      entityId: fixture.setIds.unsupportedTarget,
      action: "set.completed_correction",
      beforeData: {
        id: fixture.setIds.unsupportedTarget,
        weight: 90,
        weight_unit: "lb",
      },
      afterData: {
        id: fixture.setIds.unsupportedTarget,
        weight: 100,
        weight_unit: "lb",
      },
      changedFields: ["weight"],
      createdAt: new Date("2026-07-29T12:00:00.000Z"),
    });
    const before = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    const beforeImport = before.exerciseEvidence.find(
      (entry) => entry.exerciseId === V2_H03_IDS.importExercise,
    );
    expect(beforeImport).toMatchObject({
      scope: "import_created",
      calculationEligibleSets: 2,
      tiers: ["corrected", "imported"],
      reviewedMappings: [
        {
          id: V2_H03_IDS.ownerMapping,
          normalizedKey: V2_H03_NORMALIZED_KEY,
        },
      ],
    });
    expect(beforeImport?.evidence).toContainEqual(
      expect.objectContaining({
        setId: fixture.setIds.unsupportedTarget,
        tier: "corrected",
        mappingStatus: "confirmed",
        calculationEligible: true,
      }),
    );

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 73);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown H03 snapshot key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "H03 exact exercise evidence", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-h03-restore" },
    );
    if (!created.ok) throw new Error(created.reason);

    await database.db
      .update(externalExerciseMappings)
      .set({ normalizedKey: "temporarily-broken-mapping" })
      .where(eq(externalExerciseMappings.id, V2_H03_IDS.ownerMapping));
    await database.db
      .update(exercises)
      .set({ createdFromImportEventId: null })
      .where(eq(exercises.id, V2_H03_IDS.importExercise));
    await database.db
      .update(completedSets)
      .set({ weight: 1 })
      .where(eq(completedSets.id, fixture.setIds.unsupportedTarget));
    await database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('workout_tracker.authorized_delete', 'snapshot_restore', true)`,
      );
      await tx
        .delete(recordVersions)
        .where(eq(recordVersions.id, V2_H03_IDS.correctionVersion));
    });

    const changed = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    expect(
      changed.exerciseEvidence.find(
        (entry) => entry.exerciseId === V2_H03_IDS.importExercise,
      ),
    ).toMatchObject({
      scope: "owner_created",
      calculationEligibleSets: 0,
      reviewedMappings: [],
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
      { store, keyring, appVersion: "v2-h03-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "full" });

    expect(
      await database.db.query.externalExerciseMappings.findFirst({
        where: eq(externalExerciseMappings.id, V2_H03_IDS.ownerMapping),
      }),
    ).toMatchObject({
      userId: fixture.userId,
      source: "hevy",
      normalizedKey: V2_H03_NORMALIZED_KEY,
      exerciseId: V2_H03_IDS.importExercise,
    });
    expect(
      await database.db.query.exercises.findFirst({
        where: eq(exercises.id, V2_H03_IDS.importExercise),
      }),
    ).toMatchObject({
      userId: fixture.userId,
      createdFromImportEventId: V2_H03_IDS.importEvent,
    });
    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, fixture.setIds.unsupportedTarget),
        columns: { weight: true },
      }),
    ).toEqual({ weight: 100 });
    expect(
      await database.db.query.recordVersions.findFirst({
        where: eq(recordVersions.id, V2_H03_IDS.correctionVersion),
      }),
    ).toMatchObject({
      entityType: "completed_set",
      entityId: fixture.setIds.unsupportedTarget,
    });
    const restoredExerciseIds = (
      await database.db.query.sessionExercises.findMany({
        where: eq(sessionExercises.sessionId, fixture.sessionIds.dateOnly),
        columns: { id: true },
      })
    ).map((entry) => entry.id);
    const restoredOccurrences = await database.db.query.sessionOccurrences.findMany({
      where: eq(sessionOccurrences.sessionId, fixture.sessionIds.dateOnly),
    });
    expect(
      restoredOccurrences.filter(
        (entry) =>
          entry.sessionExerciseId != null &&
          restoredExerciseIds.includes(entry.sessionExerciseId) &&
          entry.kind === "working_set" &&
          entry.outcome === "completed" &&
          entry.completedSetId != null,
      ),
    ).toHaveLength(2);

    const after = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    const afterImport = after.exerciseEvidence.find(
      (entry) => entry.exerciseId === V2_H03_IDS.importExercise,
    );
    expect(afterImport).toMatchObject({
      scope: "import_created",
      retainedSets: 2,
      exactLinkedSets: 2,
      calculationEligibleSets: 2,
      tiers: ["corrected"],
      reviewedMappings: [
        {
          id: V2_H03_IDS.ownerMapping,
          normalizedKey: V2_H03_NORMALIZED_KEY,
        },
      ],
    });
    expect(afterImport?.evidence).toContainEqual(
      expect.objectContaining({
        setId: fixture.setIds.unsupportedTarget,
        weight: 100,
        tier: "corrected",
        mappingStatus: "confirmed",
        calculationEligible: true,
      }),
    );
  }, 60_000);
});
