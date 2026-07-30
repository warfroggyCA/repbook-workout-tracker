import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exercises, users } from "@/db/schema";
import migrationJournal from "@/db/migrations/meta/_journal.json";
import {
  createMigratedTestDatabase,
  failAfterBoundary,
  getWorkoutIntegrity,
  InjectedBoundaryFailure,
  runSimultaneously,
  seedLargeWorkoutHistory,
  type TestDatabase,
} from "../helpers/database";

describe("production proof-system helpers", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: "proof-system@example.com" })
      .returning({ id: users.id });
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: "Proof System Squat",
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
  }, 30_000);

  afterAll(async () => database.close());

  it("releases simultaneous operations only after every participant arrives", async () => {
    let active = 0;
    let highestActive = 0;
    const results = await runSimultaneously(12, async (index) => {
      active += 1;
      highestActive = Math.max(highestActive, active);
      await Promise.resolve();
      active -= 1;
      return index;
    });

    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(highestActive).toBe(12);
  });

  it("injects a failure at an exact named write boundary", async () => {
    const checkpoint = failAfterBoundary("session-created");
    await checkpoint("before-write");
    await expect(checkpoint("session-created")).rejects.toEqual(
      new InjectedBoundaryFailure("session-created")
    );
  });

  it("creates a large internally consistent history within the Phase 1 budget", async () => {
    const started = performance.now();
    const seeded = await seedLargeWorkoutHistory(database.db, {
      userId,
      exerciseId,
      sessionCount: 250,
      setsPerSession: 4,
    });
    const elapsedMs = performance.now() - started;
    const integrity = await getWorkoutIntegrity(database.db, userId);

    expect(seeded).toMatchObject({ sessionCount: 250, setCount: 1_000 });
    expect(integrity).toMatchObject({
      sessions: 250,
      session_exercises: 250,
      completed_sets: 1_000,
      orphan_exercises: 0,
      orphan_sets: 0,
    });
    expect(elapsedMs).toBeLessThan(10_000);
  }, 20_000);

  it("applies the latest migration over the previous-version schema", async () => {
    const upgraded = await createMigratedTestDatabase("previous-version");
    try {
      const result = await upgraded.client.query(`
        select
          (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
          to_regclass('public.exercise_media_assets') is not null as media,
          exists (
            select 1 from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_exercises'
              and column_name = 'substitution_reason'
          ) as alternatives
      `);
      expect(result.rows[0]).toEqual({
        migrations: migrationJournal.entries.length,
        media: true,
        alternatives: true,
      });
    } finally {
      await upgraded.close();
    }
  }, 30_000);
});
