import { afterEach, beforeEach, describe, expect, it } from "vitest";
import budgets from "../../docs/production-performance-budgets.json";
import { and, eq } from "drizzle-orm";
import { dataSnapshots, userProfiles, users } from "@/db/schema";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  AUTOMATIC_SNAPSHOT_DAILY_DAYS,
  AUTOMATIC_SNAPSHOT_FAILED_DAYS,
  AUTOMATIC_SNAPSHOT_RECENT_LIMIT,
  AUTOMATIC_SNAPSHOT_WEEKLY_DAYS,
  runSnapshotLifecycle,
  SNAPSHOT_CREATING_STALE_HOURS,
  SNAPSHOT_DELETION_LEASE_MINUTES,
  SNAPSHOT_MAINTENANCE_BATCH,
  SNAPSHOT_ORPHAN_GRACE_DAYS,
} from "@/services/snapshot-lifecycle";
import {
  createMigratedTestDatabase,
  runSimultaneously,
  type TestDatabase,
} from "../helpers/database";

describe("automatic snapshot lifecycle", () => {
  let database: TestDatabase;
  let userId: string;
  let store: MemorySnapshotObjectStore;
  const now = new Date("2026-07-13T20:00:00.000Z");

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    store = new MemorySnapshotObjectStore();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `lifecycle-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId });
  }, 30_000);

  afterEach(async () => database.close());

  it("matches the checked-in recovery storage budget", () => {
    expect({
      maxRecentAutomatic: AUTOMATIC_SNAPSHOT_RECENT_LIMIT,
      dailyCoverageDays: AUTOMATIC_SNAPSHOT_DAILY_DAYS,
      weeklyCoverageDays: AUTOMATIC_SNAPSHOT_WEEKLY_DAYS,
      failedAutomaticDays: AUTOMATIC_SNAPSHOT_FAILED_DAYS,
      staleCreatingHours: SNAPSHOT_CREATING_STALE_HOURS,
      orphanGraceDays: SNAPSHOT_ORPHAN_GRACE_DAYS,
      maxDeletesPerRun: SNAPSHOT_MAINTENANCE_BATCH,
    }).toEqual(budgets.finalBudgets.snapshotLifecycle);
  });

  async function insertSnapshot(input: {
    createdAt: Date;
    snapshotKind: "user" | "automatic";
    pinned?: boolean;
    status?: "creating" | "verified" | "failed";
    name?: string;
  }) {
    const id = crypto.randomUUID();
    const objectPath = `snapshots/${userId}/${id}.wtbk`;
    const bytes = new Uint8Array([1, 2, 3]);
    store.seed(objectPath, bytes, input.createdAt, `etag-${id}`);
    await database.db.insert(dataSnapshots).values({
      id,
      userId,
      name: input.name ?? `${input.snapshotKind} ${id}`,
      reason: input.snapshotKind === "user" ? "manual" : "automatic-test",
      status: input.status ?? "verified",
      objectPath,
      objectEtag: `etag-${id}`,
      appVersion: "test",
      schemaVersion: "17",
      sizeBytes: bytes.length,
      recordCounts: { total: 0 },
      plaintextChecksum: `plain-${id}`,
      ciphertextChecksum: `cipher-${id}`,
      encryptionAlgorithm: "aes-256-gcm",
      encryptionKeyVersion: "v1",
      snapshotKind: input.snapshotKind,
      pinned: input.pinned ?? false,
      verifiedAt: input.status === "verified" || !input.status ? input.createdAt : null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return { id, objectPath };
  }

  async function insertAutomaticSeries(count: number) {
    const inserted = [];
    for (let index = 0; index < count; index += 1) {
      inserted.push(
        await insertSnapshot({
          snapshotKind: "automatic",
          createdAt: new Date(now.getTime() - index * 60_000),
        })
      );
    }
    return inserted;
  }

  it("bounds automatic copies while preserving every user-created and pinned point", async () => {
    const automatic = await insertAutomaticSeries(60);
    const named = await insertSnapshot({
      snapshotKind: "user",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      name: "Never silently expire this",
    });
    const pinned = await insertSnapshot({
      snapshotKind: "automatic",
      pinned: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      name: "Pinned automatic milestone",
    });

    const result = await runSnapshotLifecycle(database.db, { store, now });
    expect(result).toMatchObject({
      claimedForDeletion: 10,
      deletedSnapshots: 10,
      deletionFailures: 0,
    });
    expect(
      await database.db.query.dataSnapshots.findMany({
        where: and(
          eq(dataSnapshots.userId, userId),
          eq(dataSnapshots.snapshotKind, "automatic"),
          eq(dataSnapshots.pinned, false)
        ),
      })
    ).toHaveLength(50);
    expect(await database.db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, named.id),
    })).toBeDefined();
    expect(await database.db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, pinned.id),
    })).toBeDefined();
    expect(store.objects.has(named.objectPath)).toBe(true);
    expect(store.objects.has(pinned.objectPath)).toBe(true);
    for (const expired of automatic.slice(50)) {
      expect(store.objects.has(expired.objectPath)).toBe(false);
    }

    expect(await runSnapshotLifecycle(database.db, { store, now })).toMatchObject({
      claimedForDeletion: 0,
      deletedSnapshots: 0,
    });
  }, 30_000);

  it("retries object failures and a lost metadata acknowledgement without losing the tombstone", async () => {
    const automatic = await insertAutomaticSeries(51);
    const target = automatic.at(-1)!;
    store.failNextDelete = true;
    const failed = await runSnapshotLifecycle(database.db, { store, now });
    expect(failed).toMatchObject({
      claimedForDeletion: 1,
      deletedSnapshots: 0,
      deletionFailures: 1,
    });
    expect(await database.db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, target.id),
    })).toMatchObject({
      deletionStatus: "delete_failed",
      deletionAttempts: 1,
    });
    expect(store.objects.has(target.objectPath)).toBe(true);

    const retried = await runSnapshotLifecycle(database.db, { store, now });
    expect(retried).toMatchObject({ claimedForDeletion: 1, deletedSnapshots: 1 });
    expect(await database.db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, target.id),
    })).toBeUndefined();

    const replacement = await insertSnapshot({
      snapshotKind: "automatic",
      createdAt: new Date(now.getTime() - 2 * 60 * 60_000),
    });
    const lost = await runSnapshotLifecycle(database.db, {
      store,
      now,
      failAfterObjectDelete: true,
    });
    expect(lost).toMatchObject({ claimedForDeletion: 1, deletionFailures: 1 });
    expect(store.objects.has(replacement.objectPath)).toBe(false);
    expect(await database.db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, replacement.id),
    })).toMatchObject({ deletionStatus: "deleting", deletionAttempts: 1 });

    expect(await runSnapshotLifecycle(database.db, { store, now })).toMatchObject({
      claimedForDeletion: 0,
    });
    const afterLease = new Date(
      now.getTime() + (SNAPSHOT_DELETION_LEASE_MINUTES + 1) * 60_000
    );
    expect(
      await runSnapshotLifecycle(database.db, { store, now: afterLease })
    ).toMatchObject({ claimedForDeletion: 1, deletedSnapshots: 1 });
    expect(await database.db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, replacement.id),
    })).toBeUndefined();
  }, 30_000);

  it("marks stale creation, retains user failure evidence, and safely cleans only old true orphans", async () => {
    const staleUser = await insertSnapshot({
      snapshotKind: "user",
      status: "creating",
      createdAt: new Date(now.getTime() - 3 * 60 * 60_000),
    });
    const oldOrphan = `snapshots/${userId}/${crypto.randomUUID()}.wtbk`;
    const recentOrphan = `snapshots/${userId}/${crypto.randomUUID()}.wtbk`;
    store.seed(oldOrphan, new Uint8Array([4]), new Date("2026-07-01T00:00:00.000Z"));
    store.seed(recentOrphan, new Uint8Array([5]), new Date("2026-07-12T00:00:00.000Z"));

    const result = await runSnapshotLifecycle(database.db, { store, now });
    expect(result).toMatchObject({
      staleCreatingMarkedFailed: 1,
      orphanObjectsFound: 2,
      orphanObjectsDeleted: 1,
      recentOrphanObjects: 1,
    });
    expect(await database.db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, staleUser.id),
    })).toMatchObject({ snapshotKind: "user", status: "failed" });
    expect(store.objects.has(staleUser.objectPath)).toBe(true);
    expect(store.objects.has(oldOrphan)).toBe(false);
    expect(store.objects.has(recentOrphan)).toBe(true);
  }, 30_000);

  it("lets only one simultaneous maintenance worker claim each automatic copy", async () => {
    await insertAutomaticSeries(51);
    const results = await runSimultaneously(2, () =>
      runSnapshotLifecycle(database.db, { store, now })
    );
    expect(results.reduce((sum, result) => sum + result.claimedForDeletion, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.deletedSnapshots, 0)).toBe(1);
    expect(await database.db.query.dataSnapshots.findMany({
      where: and(
        eq(dataSnapshots.userId, userId),
        eq(dataSnapshots.snapshotKind, "automatic")
      ),
    })).toHaveLength(50);
  }, 30_000);
});
