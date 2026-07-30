import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { users } from "@/db/schema";
import {
  acquireExpensiveOperation,
  releaseExpensiveOperation,
  runExpensiveOperation,
} from "@/services/expensive-operations";
import {
  createMigratedTestDatabase,
  createStartBarrier,
  type TestDatabase,
} from "../helpers/database";

describe("expensive operation controls", () => {
  let database: TestDatabase;
  let userId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `operation-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
  }, 30_000);

  afterEach(async () => database.close());

  it("allows only one concurrent operation of the same kind per user", async () => {
    const ready = createStartBarrier(8);
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        await ready();
        return acquireExpensiveOperation(database.db, userId, "snapshot");
      })
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(7);
  });

  it("allows a restore to follow its snapshot preview immediately", async () => {
    const startedAt = new Date("2030-01-01T00:00:00.000Z");
    const preview = await acquireExpensiveOperation(
      database.db,
      userId,
      "snapshot",
      startedAt
    );
    if (!preview.ok) throw new Error("Snapshot preview lease was not acquired.");
    await releaseExpensiveOperation(database.db, userId, preview.lease, startedAt);
    await expect(
      acquireExpensiveOperation(
        database.db,
        userId,
        "snapshot",
        new Date(startedAt.getTime() + 1)
      )
    ).resolves.toMatchObject({ ok: true });
  });

  it("keeps a cooldown after release and recovers an expired lease", async () => {
    const startedAt = new Date("2030-01-01T00:00:00.000Z");
    const first = await acquireExpensiveOperation(
      database.db,
      userId,
      "backup",
      startedAt
    );
    if (!first.ok) throw new Error("Initial lease was not acquired.");
    await releaseExpensiveOperation(database.db, userId, first.lease, startedAt);
    await expect(
      acquireExpensiveOperation(
        database.db,
        userId,
        "backup",
        new Date("2030-01-01T00:00:10.000Z")
      )
    ).resolves.toMatchObject({ ok: false, retryAfterSeconds: 30 });

    const second = await acquireExpensiveOperation(
      database.db,
      userId,
      "backup",
      new Date("2030-01-01T00:00:31.000Z")
    );
    expect(second.ok).toBe(true);
    await expect(
      acquireExpensiveOperation(
        database.db,
        userId,
        "backup",
        new Date("2030-01-01T00:03:32.000Z")
      )
    ).resolves.toMatchObject({ ok: true });
  });

  it("runs only one expensive callback when confirmation requests overlap", async () => {
    let calls = 0;
    let releaseWork!: () => void;
    const workMayFinish = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const first = runExpensiveOperation(database.db, userId, "import", async () => {
      calls += 1;
      await workMayFinish;
      return "confirmed";
    });
    await expect.poll(() => calls).toBe(1);
    const overlapping = await Promise.all(
      Array.from({ length: 7 }, () =>
        runExpensiveOperation(database.db, userId, "import", async () => {
          calls += 1;
          return "duplicate";
        })
      )
    );
    expect(overlapping.every((result) => !result.ok)).toBe(true);
    expect(calls).toBe(1);
    releaseWork();
    await expect(first).resolves.toMatchObject({
      ok: true,
      value: "confirmed",
    });
  });
});
