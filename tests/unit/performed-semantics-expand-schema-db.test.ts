import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resultRows } from "@/db/result";
import {
  createTestDatabaseAtMigration,
  type TestDatabase,
} from "../helpers/database";

async function applyCandidateMigration(database: TestDatabase) {
  const source = await readFile(
    "src/db/migrations/0068_performed_semantics_expand.sql",
    "utf8",
  );
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.client.exec(statement);
  }
}

describe("0068 performed-semantics expand foundation", () => {
  let database: TestDatabase | undefined;
  afterEach(async () => database?.close());

  it("adds nullable evidence without relabeling existing rows and makes new evidence immutable", async () => {
    database = await createTestDatabaseAtMigration(
      "0067_history_management_contract",
    );
    await database.client.exec(`
      INSERT INTO users (id, email)
      VALUES ('10000000-0000-4000-8000-000000000068', 'semantics@example.test');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics
      ) VALUES (
        '20000000-0000-4000-8000-000000000068', 'Semantic fixture',
        'horizontal_pull', '["back"]'::jsonb, 'barbell', 'weight_reps', 'total'
      );
      INSERT INTO workout_sessions (
        id, user_id, template_name, status, started_at, finished_at,
        timezone, local_date
      ) VALUES (
        '30000000-0000-4000-8000-000000000068',
        '10000000-0000-4000-8000-000000000068',
        'Fixture', 'completed',
        '2026-07-29T12:00:00Z', '2026-07-29T13:00:00Z',
        'UTC', '2026-07-29'
      );
      INSERT INTO session_exercises (id, session_id, exercise_id, order_idx)
      VALUES (
        '40000000-0000-4000-8000-000000000068',
        '30000000-0000-4000-8000-000000000068',
        '20000000-0000-4000-8000-000000000068', 0
      );
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps
      ) VALUES (
        '50000000-0000-4000-8000-000000000068',
        '40000000-0000-4000-8000-000000000068', 1, 100, 'lb', 8
      );
    `);

    await applyCandidateMigration(database);
    const [legacy] = resultRows(
      await database.db.execute(sql`
        SELECT performed_semantics_version, performed_load_type,
               performed_load_semantics
        FROM completed_sets
      `),
    );
    expect(legacy).toEqual({
      performed_semantics_version: null,
      performed_load_type: null,
      performed_load_semantics: null,
    });
    await database.client.exec(`
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps
      ) VALUES (
        '50000000-0000-4000-8000-000000000072',
        '40000000-0000-4000-8000-000000000068', 5, 90, 'lb', 8
      );
    `);
    const [mixedDeployLegacy] = resultRows(
      await database.db.execute(sql`
        SELECT performed_semantics_version, performed_load_type,
               performed_load_semantics
        FROM completed_sets
        WHERE id = '50000000-0000-4000-8000-000000000072'
      `),
    );
    expect(mixedDeployLegacy).toEqual(legacy);

    await database.client.exec(`
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps,
        performed_semantics_version, performed_load_type,
        performed_load_semantics
      ) VALUES (
        '50000000-0000-4000-8000-000000000069',
        '40000000-0000-4000-8000-000000000068', 2, 105, 'lb', 8,
        1, 'barbell', 'total'
      );
    `);
    await expect(
      database.client.exec(`
        UPDATE completed_sets
        SET performed_load_semantics = 'assistance'
        WHERE id = '50000000-0000-4000-8000-000000000069'
      `),
    ).rejects.toThrow("performed semantics are immutable");
    await expect(
      database.client.exec(`
        INSERT INTO completed_sets (
          id,
          session_exercise_id, set_no, performed_semantics_version,
          performed_load_type
        ) VALUES (
          '50000000-0000-4000-8000-000000000070',
          '40000000-0000-4000-8000-000000000068', 3, 1, 'barbell'
        )
      `),
    ).rejects.toThrow("completed_sets_performed_semantics_tuple_valid");
    await expect(
      database.client.exec(`
        INSERT INTO completed_sets (
          id, session_exercise_id, set_no, performed_semantics_version,
          performed_load_type, performed_load_semantics
        ) VALUES (
          '50000000-0000-4000-8000-000000000071',
          '40000000-0000-4000-8000-000000000068', 4, 2, 'barbell', 'total'
        )
      `),
    ).rejects.toThrow("completed_sets_performed_semantics_tuple_valid");
    await expect(
      database.client.exec(`
        INSERT INTO completed_sets (
          id, session_exercise_id, set_no, performed_semantics_version,
          performed_load_type, performed_load_semantics
        ) VALUES (
          '50000000-0000-4000-8000-000000000073',
          '40000000-0000-4000-8000-000000000068', 6, 1, '   ', 'total'
        )
      `),
    ).rejects.toThrow("completed_sets_performed_semantics_tuple_valid");
  });
});
