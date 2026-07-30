import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  exercises,
  painLogs,
  users,
  workoutSessions,
} from "@/db/schema";
import { loadExercisePainHold } from "@/services/pain-hold";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

const NOW = new Date("2026-07-30T16:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("pain hold database boundary", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;
  let samePatternExerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `pain-hold-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    [{ id: exerciseId }, { id: samePatternExerciseId }] = await database.db
      .insert(exercises)
      .values([
        {
          name: "Exact press",
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "barbell",
        },
        {
          name: "Other press",
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "dumbbell",
        },
      ])
      .returning({ id: exercises.id });
  }, 30_000);

  afterEach(async () => database.close());

  async function completedSession(daysAgo: number) {
    const startedAt = new Date(NOW.getTime() - daysAgo * DAY);
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        status: "completed",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 45 * 60_000),
        timezone: "UTC",
        localDate: startedAt.toISOString().slice(0, 10),
      })
      .returning({ id: workoutSessions.id });
    return session.id;
  }

  async function pain(input: {
    sessionId: string;
    severity: number;
    daysAgo: number;
    forExerciseId?: string;
  }) {
    const [row] = await database.db
      .insert(painLogs)
      .values({
        userId,
        sessionId: input.sessionId,
        exerciseId: input.forExerciseId ?? exerciseId,
        bodyPart: "shoulder",
        severity: input.severity,
        source: "set_flag",
        createdAt: new Date(NOW.getTime() - input.daysAgo * DAY),
      })
      .returning({ id: painLogs.id });
    return row.id;
  }

  async function classify() {
    return loadExercisePainHold(database.db, {
      userId,
      exerciseId,
      now: NOW,
    });
  }

  it("uses exact completed-workout evidence and never treats missing or zero as release", async () => {
    const painSession = await completedSession(5);
    const holdId = await pain({ sessionId: painSession, severity: 4, daysAgo: 5 });
    await completedSession(3);
    await completedSession(1);
    const zeroSession = await completedSession(2);
    await pain({ sessionId: zeroSession, severity: 0, daysAgo: 2 });
    const otherSession = await completedSession(1);
    await pain({
      sessionId: otherSession,
      severity: 5,
      daysAgo: 1,
      forExerciseId: samePatternExerciseId,
    });

    const held = await classify();
    expect(held.state).toBe("hold");
    expect(held.evidenceIds).toEqual([holdId]);
    expect(held.explanation).toContain(
      "A workout with no pain entry doesn't shorten that time."
    );
  });

  it("excludes archived parents and reuses preserved timestamps when restored", async () => {
    const sessionId = await completedSession(4);
    const painId = await pain({ sessionId, severity: 4, daysAgo: 4 });
    expect((await classify()).state).toBe("hold");

    await database.db
      .update(workoutSessions)
      .set({ archivedAt: NOW })
      .where(eq(workoutSessions.id, sessionId));
    expect((await classify()).state).toBe("clear");

    await database.db
      .update(workoutSessions)
      .set({ archivedAt: null })
      .where(eq(workoutSessions.id, sessionId));
    expect((await classify()).state).toBe("hold");

    await database.db
      .update(painLogs)
      .set({ archivedAt: NOW })
      .where(eq(painLogs.id, painId));
    expect((await classify()).state).toBe("clear");

    await database.db
      .update(painLogs)
      .set({ archivedAt: null })
      .where(eq(painLogs.id, painId));
    const restored = await classify();
    expect(restored.state).toBe("hold");
    expect(restored.releaseAt?.toISOString()).toBe("2026-08-09T16:00:00.000Z");
  });

  it("counts distinct linked workouts and releases only when recording evidence expires", async () => {
    const first = await completedSession(13);
    const second = await completedSession(8);
    const third = await completedSession(2);
    await pain({ sessionId: first, severity: 1, daysAgo: 13 });
    await pain({ sessionId: second, severity: 2, daysAgo: 8 });
    await pain({ sessionId: third, severity: 1, daysAgo: 2 });

    expect((await classify()).state).toBe("substitution_review");
    expect(
      await loadExercisePainHold(database.db, {
        userId,
        exerciseId,
        now: new Date(NOW.getTime() + 15 * DAY),
      })
    ).toMatchObject({ state: "clear", evidenceIds: [] });
  });
});
