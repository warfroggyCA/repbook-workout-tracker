import { afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

const PRE_UNIT_MIGRATION = "0018_brave_timeslip";
const REPAIR_PREVIEW_MIGRATION = "0020_backfill_load_units_calendar_identity";
const LATEST_UNIT_MIGRATION = "0032_quick_log_result_identity";

describe("unit and workout-calendar migration safety", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => database?.close());

  it("surfaces ambiguous native data and refuses to guess during contract migration", async () => {
    database = await createTestDatabaseAtMigration(PRE_UNIT_MIGRATION);
    const userId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    const setId = crypto.randomUUID();

    await database.client.exec(
      `
        INSERT INTO users (id, email) VALUES ('${userId}', 'ambiguous@example.com');
        INSERT INTO user_profiles (user_id, unit) VALUES ('${userId}', 'kg');
        INSERT INTO exercises (
          id, name, movement_pattern, primary_muscles, load_type,
          metric_type, load_semantics, variant_attributes
        ) VALUES ('${exerciseId}', 'Ambiguous native squat', 'squat', '["quadriceps"]',
          'barbell', 'weight_reps', 'total', '{}');
        INSERT INTO workout_sessions (
          id, user_id, template_name, status, source, started_at, finished_at
        ) VALUES ('${sessionId}', '${userId}', 'Native workout', 'completed', 'tracker',
          '2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z');
        INSERT INTO session_exercises (id, session_id, exercise_id)
        VALUES ('${sessionExerciseId}', '${sessionId}', '${exerciseId}');
        INSERT INTO completed_sets (id, session_exercise_id, set_no, weight, reps)
        VALUES ('${setId}', '${sessionExerciseId}', 1, 100, 8);
      `
    );

    await migrateTestDatabaseThrough(database, REPAIR_PREVIEW_MIGRATION);
    const preview = await database.client.query<{ issue: string; entity_id: string }>(
      `SELECT issue, entity_id
       FROM production_data_repair_preview
       WHERE user_id = $1
       ORDER BY issue`,
      [userId]
    );
    expect(preview.rows).toEqual(
      expect.arrayContaining([
        { issue: "profile.timezone_missing", entity_id: expect.any(String) },
        { issue: "set.weight_unit_missing", entity_id: setId },
        { issue: "workout.calendar_identity_missing", entity_id: sessionId },
      ])
    );

    await expect(
      migrateTestDatabaseThrough(database, LATEST_UNIT_MIGRATION)
    ).rejects.toThrow(/Unit\/calendar contract blocked/);
    const preserved = await database.client.query<{
      weight: number;
      weight_unit: string | null;
      timezone: string | null;
      local_date: string | null;
    }>(
      `SELECT cs.weight, cs.weight_unit, ws.timezone, ws.local_date::text
       FROM completed_sets cs
       JOIN session_exercises se ON se.id = cs.session_exercise_id
       JOIN workout_sessions ws ON ws.id = se.session_id
       WHERE cs.id = $1`,
      [setId]
    );
    expect(preserved.rows[0]).toEqual({
      weight: 100,
      weight_unit: null,
      timezone: null,
      local_date: null,
    });
  }, 30_000);

  it("upgrades confirmed Hevy history only from its stored source evidence", async () => {
    database = await createTestDatabaseAtMigration(PRE_UNIT_MIGRATION);
    const userId = crypto.randomUUID();
    const importEventId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    const setId = crypto.randomUUID();

    await database.client.exec(
      `
        INSERT INTO users (id, email) VALUES ('${userId}', 'hevy@example.com');
        INSERT INTO user_profiles (user_id, unit) VALUES ('${userId}', 'lb');
        INSERT INTO import_events (
          id, user_id, source, raw_payload, status
        ) VALUES ('${importEventId}', '${userId}', 'csv', 'reviewed Hevy fixture', 'confirmed');
        INSERT INTO history_import_batches (
          id, user_id, import_event_id, source, original_filename,
          file_hash, timezone, status, summary
        ) VALUES ('${batchId}', '${userId}', '${importEventId}', 'hevy', 'workouts.csv', '${crypto.randomUUID()}',
          'America/Toronto', 'confirmed',
          '{"workouts":1,"exerciseOccurrences":1,"sets":1,"warmupSets":0,"supersetGroups":0,"excludedExercises":0,"warnings":0}');
        INSERT INTO exercises (
          id, name, movement_pattern, primary_muscles, load_type,
          metric_type, load_semantics, variant_attributes
        ) VALUES ('${exerciseId}', 'Imported squat', 'squat', '["quadriceps"]',
          'barbell', 'weight_reps', 'total', '{}');
        INSERT INTO workout_sessions (
          id, user_id, import_batch_id, template_name, status, source,
          started_at, finished_at
        ) VALUES ('${sessionId}', '${userId}', '${batchId}', 'Hevy workout', 'completed', 'hevy',
          '2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z');
        INSERT INTO session_exercises (id, session_id, exercise_id)
        VALUES ('${sessionExerciseId}', '${sessionId}', '${exerciseId}');
        INSERT INTO completed_sets (id, session_exercise_id, set_no, weight, reps)
        VALUES ('${setId}', '${sessionExerciseId}', 1, 225, 5);
      `
    );

    await migrateTestDatabaseThrough(database, LATEST_UNIT_MIGRATION);
    const upgraded = await database.client.query<{
      profile_timezone: string;
      timezone: string;
      local_date: string;
      weight: number;
      weight_unit: string;
    }>(
      `SELECT
         profile.timezone AS profile_timezone,
         ws.timezone,
         ws.local_date::text,
         cs.weight,
         cs.weight_unit
       FROM completed_sets cs
       JOIN session_exercises se ON se.id = cs.session_exercise_id
       JOIN workout_sessions ws ON ws.id = se.session_id
       JOIN user_profiles profile ON profile.user_id = ws.user_id
       WHERE cs.id = $1`,
      [setId]
    );
    expect(upgraded.rows[0]).toEqual({
      profile_timezone: "America/Toronto",
      timezone: "America/Toronto",
      local_date: "2025-12-31",
      weight: 225,
      weight_unit: "lb",
    });
    const remaining = await database.client.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM production_data_repair_preview
       WHERE user_id = $1`,
      [userId]
    );
    expect(remaining.rows[0]?.count).toBe(0);
  }, 30_000);

  it("does not apply an imported timezone to ambiguous native workout history", async () => {
    database = await createTestDatabaseAtMigration(PRE_UNIT_MIGRATION);
    const userId = crypto.randomUUID();
    const importEventId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const nativeSessionId = crypto.randomUUID();

    await database.client.exec(
      `
        INSERT INTO users (id, email) VALUES ('${userId}', 'mixed-history@example.com');
        INSERT INTO user_profiles (user_id, unit) VALUES ('${userId}', 'lb');
        INSERT INTO import_events (
          id, user_id, source, raw_payload, status
        ) VALUES ('${importEventId}', '${userId}', 'csv', 'reviewed Hevy fixture', 'confirmed');
        INSERT INTO history_import_batches (
          id, user_id, import_event_id, source, original_filename,
          file_hash, timezone, status, summary
        ) VALUES ('${batchId}', '${userId}', '${importEventId}', 'hevy', 'workouts.csv', '${crypto.randomUUID()}',
          'America/Toronto', 'confirmed',
          '{"workouts":0,"exerciseOccurrences":0,"sets":0,"warmupSets":0,"supersetGroups":0,"excludedExercises":0,"warnings":0}');
        INSERT INTO workout_sessions (
          id, user_id, template_name, status, source, started_at, finished_at
        ) VALUES ('${nativeSessionId}', '${userId}', 'Native workout', 'completed', 'tracker',
          '2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z');
      `
    );

    await migrateTestDatabaseThrough(database, REPAIR_PREVIEW_MIGRATION);
    const result = await database.client.query<{
      profile_timezone: string;
      timezone: string | null;
      local_date: string | null;
      issue: string;
    }>(
      `SELECT
         profile.timezone AS profile_timezone,
         session.timezone,
         session.local_date::text,
         preview.issue
       FROM workout_sessions session
       JOIN user_profiles profile ON profile.user_id = session.user_id
       JOIN production_data_repair_preview preview
         ON preview.entity_id = session.id::text
       WHERE session.id = $1`,
      [nativeSessionId]
    );
    expect(result.rows).toEqual([
      {
        profile_timezone: "America/Toronto",
        timezone: null,
        local_date: null,
        issue: "workout.calendar_identity_missing",
      },
    ]);
  }, 30_000);
});
