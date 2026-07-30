import { afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

const PRE_LIFECYCLE_MIGRATION = "0024_adorable_the_professor";
const EXPAND_MIGRATION = "0025_expand_workout_lifecycle_outbox";
const REPAIR_PREVIEW_MIGRATION = "0026_workout_lifecycle_repair_preview";
const CONTRACT_MIGRATION = "0027_contract_workout_lifecycle_invariants";
const LATEST_MIGRATION = "0029_contract_progression_job_state";

describe("workout lifecycle migration safety", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => database?.close());

  it("previews every ambiguous conflict and blocks the contract without changing data", async () => {
    database = await createTestDatabaseAtMigration(PRE_LIFECYCLE_MIGRATION);
    const userId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const firstSessionId = crypto.randomUUID();
    const secondSessionId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    const firstSetId = crypto.randomUUID();
    const secondSetId = crypto.randomUUID();

    await database.client.exec(`
      INSERT INTO users (id, email)
      VALUES ('${userId}', 'lifecycle-conflict@example.com');
      INSERT INTO user_profiles (user_id, unit, timezone)
      VALUES ('${userId}', 'lb', 'America/Toronto');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics, variant_attributes
      ) VALUES (
        '${exerciseId}', 'Lifecycle conflict squat', 'squat',
        '["quadriceps"]', 'barbell', 'weight_reps', 'total', '{}'
      );
      INSERT INTO workout_sessions (
        id, user_id, template_name, status, source, started_at,
        timezone, local_date
      ) VALUES
        ('${firstSessionId}', '${userId}', 'First active', 'in_progress', 'tracker',
          '2026-07-13T12:00:00.000Z', 'America/Toronto', '2026-07-13'),
        ('${secondSessionId}', '${userId}', 'Second active', 'in_progress', 'tracker',
          '2026-07-13T12:05:00.000Z', 'America/Toronto', '2026-07-13');
      INSERT INTO session_exercises (id, session_id, exercise_id)
      VALUES ('${sessionExerciseId}', '${firstSessionId}', '${exerciseId}');
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps, client_key
      ) VALUES
        ('${firstSetId}', '${sessionExerciseId}', 1, 100, 'lb', 8, 'same-delivery'),
        ('${secondSetId}', '${sessionExerciseId}', 1, 105, 'lb', 7, 'same-delivery');
    `);

    await migrateTestDatabaseThrough(database, EXPAND_MIGRATION);
    await migrateTestDatabaseThrough(database, REPAIR_PREVIEW_MIGRATION);

    const preview = await database.client.query<{
      issue: string;
      entity_id: string;
    }>(
      `SELECT issue, entity_id
       FROM workout_lifecycle_repair_preview
       WHERE user_id = $1
       ORDER BY issue`,
      [userId]
    );
    expect(preview.rows).toEqual([
      { issue: "set.duplicate_active_number", entity_id: sessionExerciseId },
      { issue: "set.duplicate_client_identity", entity_id: sessionExerciseId },
      { issue: "workout.multiple_active_sessions", entity_id: userId },
    ]);

    await expect(
      migrateTestDatabaseThrough(database, CONTRACT_MIGRATION)
    ).rejects.toThrow(/Failed query: DO/);

    const preserved = await database.client.query<{
      active_sessions: number;
      completed_sets: number;
      total_weight: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM workout_sessions
          WHERE user_id = $1 AND status = 'in_progress') AS active_sessions,
        (SELECT count(*)::int FROM completed_sets
          WHERE session_exercise_id = $2) AS completed_sets,
        (SELECT sum(weight)::real FROM completed_sets
          WHERE session_exercise_id = $2) AS total_weight`,
      [userId, sessionExerciseId]
    );
    expect(preserved.rows[0]).toEqual({
      active_sessions: 2,
      completed_sets: 2,
      total_weight: 205,
    });

    // Simulate a reviewed repair: preserve both workouts and sets while making
    // the chosen active session and both delivery identities explicit.
    await database.client.query(
      `UPDATE workout_sessions
       SET status = 'abandoned', finished_at = '2026-07-13T12:06:00.000Z'
       WHERE id = $1`,
      [secondSessionId]
    );
    await database.client.query(
      `UPDATE completed_sets
       SET set_no = 2, client_key = 'reviewed-delivery-2'
       WHERE id = $1`,
      [secondSetId]
    );

    await migrateTestDatabaseThrough(database, LATEST_MIGRATION);
    await expect(
      database.client.query(
        `INSERT INTO workout_sessions (
          user_id, template_name, status, source, started_at, timezone, local_date
        ) VALUES ($1, 'Third active', 'in_progress', 'tracker', now(),
          'America/Toronto', '2026-07-13')`,
        [userId]
      )
    ).rejects.toThrow();
    await expect(
      database.client.query(
        `INSERT INTO completed_sets (
          session_exercise_id, set_no, weight, weight_unit, reps, client_key
        ) VALUES ($1, 1, 100, 'lb', 8, 'third-delivery')`,
        [sessionExerciseId]
      )
    ).rejects.toThrow();
    await expect(
      database.client.query(
        `INSERT INTO completed_sets (
          session_exercise_id, set_no, weight, weight_unit, reps, client_key
        ) VALUES ($1, 3, 100, 'lb', 8, 'same-delivery')`,
        [sessionExerciseId]
      )
    ).rejects.toThrow();
  }, 30_000);

  it("upgrades a clean current schema through the complete lifecycle contract", async () => {
    database = await createTestDatabaseAtMigration(PRE_LIFECYCLE_MIGRATION);
    await migrateTestDatabaseThrough(database, LATEST_MIGRATION);

    const result = await database.client.query<{
      progression_jobs: string | null;
      preview: string | null;
      contract_indexes: number;
    }>(`
      SELECT
        to_regclass('public.progression_jobs')::text AS progression_jobs,
        to_regclass('public.workout_lifecycle_repair_preview')::text AS preview,
        (
          SELECT count(*)::int
          FROM pg_indexes
          WHERE indexname IN (
            'workout_sessions_one_active_uq',
            'completed_sets_client_key_uq',
            'completed_sets_active_set_no_uq',
            'recommendations_progression_job_slot_uq',
            'audit_logs_idempotency_uq'
          )
        ) AS contract_indexes
    `);
    expect(result.rows[0]).toEqual({
      progression_jobs: "progression_jobs",
      preview: "workout_lifecycle_repair_preview",
      contract_indexes: 5,
    });
  }, 30_000);
});
