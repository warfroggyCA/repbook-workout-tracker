import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exercises,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

const actionContext = vi.hoisted(() => ({
  database: null as TestDatabase["db"] | null,
  email: "",
  authCalls: 0,
  corruptNextBootstrapId: null as string | null,
}));

vi.mock("@/db", () => ({
  getDb: vi.fn(async () => {
    if (!actionContext.database) throw new Error("Test database is missing");
    return actionContext.database;
  }),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => {
    actionContext.authCalls += 1;
    return { user: { email: actionContext.email, name: "Cache test" } };
  }),
}));

vi.mock("@/lib/user", () => ({
  getCurrentUser: vi.fn(async () => {
    throw new Error("logSet must not use the full CurrentUser path");
  }),
}));

vi.mock("@/services/account-bootstrap", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/services/account-bootstrap")
  >();
  return {
    ...actual,
    bootstrapUserAccount: vi.fn(async (...args: Parameters<typeof actual.bootstrapUserAccount>) => {
      const user = await actual.bootstrapUserAccount(...args);
      const corruptId = actionContext.corruptNextBootstrapId;
      actionContext.corruptNextBootstrapId = null;
      return corruptId ? { ...user, id: corruptId } : user;
    }),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));

import { logSet } from "@/app/actions/sessions";
import {
  getCurrentUserIdFast,
  resetUserIdCacheForTests,
} from "@/lib/user-id-cache";

describe("logSet user-id cache", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    actionContext.database = database.db;
    actionContext.authCalls = 0;
    actionContext.corruptNextBootstrapId = null;
    resetUserIdCacheForTests();
  }, 30_000);

  afterEach(async () => {
    actionContext.database = null;
    vi.unstubAllEnvs();
    await database.close();
  });

  async function seedOwnedExercise(email: string) {
    actionContext.email = email;
    vi.stubEnv("ALLOWED_EMAILS", email);
    const [user] = await database.db
      .insert(users)
      .values({ email })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId: user.id });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: `Cache press ${crypto.randomUUID()}`,
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "dumbbell",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId: user.id,
        templateName: "Cache workout",
        status: "in_progress",
        startedAt: new Date("2026-07-18T12:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-18",
      })
      .returning({ id: workoutSessions.id });
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({ sessionId: session.id, exerciseId: exercise.id, orderIdx: 0 })
      .returning({ id: sessionExercises.id });
    return {
      userId: user.id,
      exerciseId: exercise.id,
      sessionExerciseId: sessionExercise.id,
    };
  }

  function setInput(
    sessionExerciseId: string,
    setNo: number,
    performedExerciseId = crypto.randomUUID(),
  ) {
    return {
      sessionExerciseId,
      performedExerciseId,
      performedSemanticsVersion: 1 as const,
      performedLoadType: "dumbbell",
      performedLoadSemantics: "total" as const,
      setNo,
      metricType: "weight_reps" as const,
      weight: 40,
      weightUnit: "lb" as const,
      reps: 8,
      distanceKm: null,
      durationSeconds: null,
      clientKey: crypto.randomUUID(),
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown" as const,
    };
  }

  it("rejects mismatched equipment evidence before authentication or database work", async () => {
    const statements = vi.spyOn(database.client, "query");
    await expect(logSet({
      ...setInput(crypto.randomUUID(), 1),
      equipmentSnapshotId: crypto.randomUUID(),
      loadEntryMeaning: "legacy_unknown",
    })).resolves.toEqual({ outcome: "invalid" });
    expect(statements).not.toHaveBeenCalled();
    expect(actionContext.authCalls).toBe(0);
  });

  it("uses exactly two statements cold and one statement warm", async () => {
    const seeded = await seedOwnedExercise("cache-count@example.com");

    const coldStatements = vi.spyOn(database.client, "query");
    await expect(logSet(setInput(
      seeded.sessionExerciseId,
      1,
      seeded.exerciseId,
    ))).resolves.toMatchObject({
      outcome: "saved",
    });
    expect(coldStatements).toHaveBeenCalledTimes(2);
    coldStatements.mockRestore();

    const warmStatements = vi.spyOn(database.client, "query");
    await expect(logSet(setInput(
      seeded.sessionExerciseId,
      2,
      seeded.exerciseId,
    ))).resolves.toMatchObject({
      outcome: "saved",
    });
    expect(warmStatements).toHaveBeenCalledTimes(1);
    expect(actionContext.authCalls).toBe(2);
  });

  it("evicts a stale id, bootstraps once, and retries the owned statement once", async () => {
    const email = "cache-stale@example.com";
    const seeded = await seedOwnedExercise(email);
    actionContext.corruptNextBootstrapId = crypto.randomUUID();
    await getCurrentUserIdFast();
    const staleStatements = vi.spyOn(database.client, "query");
    await expect(
      logSet(setInput(seeded.sessionExerciseId, 1, seeded.exerciseId))
    ).resolves.toMatchObject({ outcome: "saved" });
    expect(staleStatements).toHaveBeenCalledTimes(3);
    expect(actionContext.authCalls).toBe(3);
  });

  it("rechecks the allowlist on a warm cache hit", async () => {
    const seeded = await seedOwnedExercise("cache-auth@example.com");
    await logSet(setInput(seeded.sessionExerciseId, 1, seeded.exerciseId));
    vi.stubEnv("ALLOWED_EMAILS", "somebody-else@example.com");
    const statements = vi.spyOn(database.client, "query");
    await expect(logSet(setInput(
      seeded.sessionExerciseId,
      2,
      seeded.exerciseId,
    ))).rejects.toThrow(
      "no longer authorized"
    );
    expect(statements).not.toHaveBeenCalled();
  });

  it("evicts the least-recent identity after sixteen cached emails", async () => {
    const emails = Array.from(
      { length: 17 },
      (_, index) => `cache-bound-${index}@example.com`
    );
    vi.stubEnv("ALLOWED_EMAILS", emails.join(","));
    for (const email of emails) {
      await database.db.insert(users).values({ email });
    }
    const rows = await database.db.select({ id: users.id, email: users.email }).from(users);
    await database.db.insert(userProfiles).values(
      rows
        .filter((row) => emails.includes(row.email))
        .map((row) => ({ userId: row.id }))
    );
    for (const email of emails) {
      actionContext.email = email;
      await getCurrentUserIdFast();
    }

    actionContext.email = emails[0];
    const statements = vi.spyOn(database.client, "query");
    await getCurrentUserIdFast();
    expect(statements).toHaveBeenCalledTimes(1);
  });
});
