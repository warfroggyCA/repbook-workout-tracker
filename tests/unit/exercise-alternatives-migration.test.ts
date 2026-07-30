import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

async function runMigration(client: PGlite, path: string) {
  const statements = readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await client.exec(statement);
}

describe("exercise alternative migration", () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TABLE exercises (id uuid PRIMARY KEY);
      CREATE TABLE workout_sessions (
        id uuid PRIMARY KEY,
        started_at timestamptz NOT NULL,
        finished_at timestamptz
      );
      CREATE TABLE session_exercises (
        id uuid PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES workout_sessions(id),
        exercise_id uuid NOT NULL REFERENCES exercises(id),
        substituted_for_exercise_id uuid
      );
    `);
  });

  afterEach(async () => {
    await client.close();
  });

  it("backfills existing substitutions and protects their planned exercise reference", async () => {
    const performedId = crypto.randomUUID();
    const plannedId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    await client.query("INSERT INTO exercises (id) VALUES ($1), ($2)", [
      performedId,
      plannedId,
    ]);
    await client.query(
      "INSERT INTO workout_sessions (id, started_at, finished_at) VALUES ($1, $2, $3)",
      [sessionId, "2026-07-01T14:00:00.000Z", "2026-07-01T15:00:00.000Z"]
    );
    await client.query(
      "INSERT INTO session_exercises (id, session_id, exercise_id, substituted_for_exercise_id) VALUES ($1, $2, $3, $4)",
      [sessionExerciseId, sessionId, performedId, plannedId]
    );

    await runMigration(client, "src/db/migrations/0017_far_wolf_cub.sql");
    await runMigration(client, "src/db/migrations/0018_brave_timeslip.sql");

    const migrated = await client.query<{
      substitution_reason: string;
      substituted_at: Date;
    }>(
      "SELECT substitution_reason, substituted_at FROM session_exercises WHERE id = $1",
      [sessionExerciseId]
    );
    expect(migrated.rows[0]?.substitution_reason).toBe("other");
    expect(migrated.rows[0]?.substituted_at.toISOString()).toBe(
      "2026-07-01T15:00:00.000Z"
    );
    await expect(
      client.query("DELETE FROM exercises WHERE id = $1", [plannedId])
    ).rejects.toThrow(/foreign key/i);
  });
});
