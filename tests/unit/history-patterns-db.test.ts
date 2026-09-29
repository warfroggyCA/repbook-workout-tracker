import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  users,
  exercises,
  workoutSessions,
  sessionExercises,
  sessionOccurrences,
} from "@/db/schema";
import { getHistoryPatterns } from "@/services/history-patterns";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("History pattern source boundaries", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);
  afterAll(async () => {
    await database.close();
  });
  it("reads exact planned identities without counting other owners, archived or unversioned workouts", async () => {
    const [owner, other] = await database.db
      .insert(users)
      .values([
        { email: "pattern-owner@example.com" },
        { email: "pattern-other@example.com" },
      ])
      .returning();
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Calf raises",
        movementPattern: "squat",
        primaryMuscles: ["calves"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "bodyweight",
      })
      .returning();
    const slotId = crypto.randomUUID();
    const sessionIds: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const [session] = await database.db
        .insert(workoutSessions)
        .values({
          userId: i === 5 ? other.id : owner.id,
          templateName: "Leg day",
          status: "completed",
          startedAt: new Date(`2026-09-0${i}T15:00:00Z`),
          localDate: `2026-09-0${i}`,
          timezone: "America/Toronto",
          sourceProgramId: crypto.randomUUID(),
          sourceProgramVersionId: crypto.randomUUID(),
          sourceDayLineageId: crypto.randomUUID(),
        })
        .returning();
      sessionIds.push(session.id);
      const [row] = await database.db
        .insert(sessionExercises)
        .values({
          sessionId: session.id,
          exerciseId: exercise.id,
          modificationType: i === 2 ? "as_planned" : "skipped",
          sourceSlotLineageId: slotId,
          prescribedSemanticsVersion: 1,
          prescribedExerciseName: "Calf raises",
          prescribedMetricType: "reps",
          prescribedLoadType: "bodyweight",
          prescribedLoadSemantics: "bodyweight",
        })
        .returning();
      await database.db
        .insert(sessionOccurrences)
        .values(
          [1, 2].map((n) => ({
            sessionId: session.id,
            sessionExerciseId: row.id,
            kind: "working_set",
            origin: "planned",
            sequenceIdx: n,
            kindOrdinal: n,
            plannedExerciseId: exercise.id,
          })),
        );
    }
    await database.db
      .update(workoutSessions)
      .set({ archivedAt: new Date() })
      .where(eq(workoutSessions.id, sessionIds[5]));
    const patterns = await getHistoryPatterns(
      database.db,
      owner.id,
      "America/Toronto",
      new Date("2026-09-29T12:00:00Z"),
    );
    expect(patterns).toHaveLength(1);
    expect(patterns[0].skipped).toBe(3);
    expect(patterns[0].workouts.map((row) => row.sessionId)).toEqual(
      sessionIds.slice(0, 4).reverse(),
    );
    expect(
      await getHistoryPatterns(
        database.db,
        other.id,
        "America/Toronto",
        new Date("2026-09-29T12:00:00Z"),
      ),
    ).toEqual([]);
    await database.db
      .update(workoutSessions)
      .set({
        sourceProgramId: null,
        sourceProgramVersionId: null,
        sourceDayLineageId: null,
      })
      .where(eq(workoutSessions.id, sessionIds[0]));
    expect(
      await getHistoryPatterns(
        database.db,
        owner.id,
        "America/Toronto",
        new Date("2026-09-29T12:00:00Z"),
      ),
    ).toEqual([]);
  });
});
