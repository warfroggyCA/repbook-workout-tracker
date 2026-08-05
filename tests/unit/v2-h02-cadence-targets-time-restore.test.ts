import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { completedSets } from "@/db/schema";
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

describe("V2 H02 restore invalidation", () => {
  let database: TestDatabase;
  let fixture: V2H02CadenceFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedV2H02CadenceTargetsTime(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("restores raw facts and recomputes current outcomes from the retained occurrence", async () => {
    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 62);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown H02 test key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      fixture.userId,
      { name: "H02 cadence and targets", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-h02-restore" },
    );
    if (!created.ok) throw new Error(created.reason);

    await database.db
      .update(completedSets)
      .set({ weight: 120, reps: 12, targetMet: true })
      .where(eq(completedSets.id, fixture.setIds.below));
    const changed = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    expect(changed.overview.targetOutcomes).toMatchObject({
      below: 0,
      at: 2,
      above: 2,
      unknown: 1,
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
      { store, keyring, appVersion: "v2-h02-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });

    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, fixture.setIds.below),
      columns: { weight: true, reps: true, targetMet: true },
    })).toEqual({ weight: 95, reps: 7, targetMet: false });
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, fixture.setIds.unsupportedTarget),
      columns: { targetMet: true },
    })).toEqual({ targetMet: null });

    const report = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    expect(report.overview.targetOutcomes).toMatchObject({
      below: 1,
      at: 2,
      above: 1,
      unknown: 1,
      atOrAboveRate: 75,
    });
    expect(report.cadence.completedSessions).toBe(5);
  }, 60_000);
});
