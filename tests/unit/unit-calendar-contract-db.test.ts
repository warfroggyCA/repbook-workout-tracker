import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completedSets,
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

describe("database-enforced load and calendar identity", () => {
  let database: TestDatabase;
  let userId: string;
  let sessionExerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `unit-contract-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId, unit: "kg" });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "Contract squat",
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        startedAt: new Date("2026-07-01T02:30:00.000Z"),
        timezone: "America/Vancouver",
        localDate: "2026-06-30",
      })
      .returning({ id: workoutSessions.id });
    [{ id: sessionExerciseId }] = await database.db
      .insert(sessionExercises)
      .values({ sessionId: session.id, exerciseId: exercise.id })
      .returning({ id: sessionExercises.id });
  }, 30_000);

  afterEach(async () => database.close());

  it("installs every durable unit and workout calendar contract", async () => {
    const result = await database.client.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conname IN (
        'completed_sets_weight_unit_check',
        'exercise_prescriptions_target_load_unit_check',
        'session_exercises_target_load_unit_check',
        'workout_sessions_local_calendar_check',
        'user_profiles_setup_target_unit_check',
        'user_profiles_setup_warmup_unit_check',
        'wte_warmup_load_unit_check',
        'session_exercises_warmup_load_unit_check',
        'recommendations_load_unit_check',
        'ai_parsing_events_quick_log_unit_check',
        'user_decisions_load_unit_check',
        'adaptation_events_before_load_unit_check',
        'adaptation_events_after_load_unit_check',
        'record_versions_before_load_unit_check',
        'record_versions_after_load_unit_check'
      )
      ORDER BY conname
    `);
    expect(result.rows.map(({ conname }) => conname)).toHaveLength(15);
  });

  it("rejects a weighted set without a unit and accepts the same value as kilograms", async () => {
    await expect(
      database.db.insert(completedSets).values({
        sessionExerciseId,
        setNo: 1,
        weight: 100,
        reps: 8,
      })
    ).rejects.toThrow(/Failed query/);
    expect(await database.db.select().from(completedSets)).toHaveLength(0);

    await expect(
      database.db.insert(completedSets).values({
        sessionExerciseId,
        setNo: 1,
        weight: 100,
        weightUnit: "kg",
        reps: 8,
      })
    ).resolves.toBeDefined();
  });

  it("rejects a local date that disagrees with the workout instant and timezone", async () => {
    await expect(
      database.db.insert(workoutSessions).values({
        userId,
        startedAt: new Date("2026-07-01T02:30:00.000Z"),
        timezone: "America/Vancouver",
        localDate: "2026-07-01",
      })
    ).rejects.toThrow(/Failed query/);
    expect(await database.db.select().from(workoutSessions)).toHaveLength(1);
  });
});
