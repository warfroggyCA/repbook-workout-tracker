import { afterEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

const ids = {
  user: "10000000-0000-4000-8000-000000000054",
  exercise: "20000000-0000-4000-8000-000000000054",
  session1: "30000000-0000-4000-8000-000000000054",
  session2: "30000000-0000-4000-8000-000000000055",
  group: "40000000-0000-4000-8000-000000000054",
  sessionExercise1: "50000000-0000-4000-8000-000000000054",
  sessionExercise2: "50000000-0000-4000-8000-000000000055",
  completedSet: "60000000-0000-4000-8000-000000000054",
  occurrence: "70000000-0000-4000-8000-000000000054",
  occurrence2: "70000000-0000-4000-8000-000000000055",
};

async function seed(database: TestDatabase) {
  await database.client.exec(`
    INSERT INTO users (id, email) VALUES ('${ids.user}', 'stage3-schema@example.test');
    INSERT INTO exercises (
      id, user_id, name, movement_pattern, primary_muscles
    ) VALUES (
      '${ids.exercise}', '${ids.user}', 'Stage 3 Test Press',
      'horizontal_push', '["chest"]'::jsonb
    );
    INSERT INTO workout_sessions (
      id, user_id, timezone, local_date, started_at, status, finished_at
    ) VALUES
      ('${ids.session1}', '${ids.user}', 'America/Toronto', '2026-07-21', '2026-07-21T12:00:00-04:00', 'in_progress', NULL),
      ('${ids.session2}', '${ids.user}', 'America/Toronto', '2026-07-22', '2026-07-22T12:00:00-04:00', 'completed', '2026-07-22T13:00:00-04:00');
    INSERT INTO session_exercise_groups (
      id, session_id, provenance, name, order_idx, planned_rounds,
      member_count, rest_between_members_sec, rest_between_rounds_sec
    ) VALUES (
      '${ids.group}', '${ids.session1}', 'program', 'Test tri-set', 0, 2, 3, 20, 90
    );
    INSERT INTO session_exercises (
      id, session_id, exercise_id, order_idx, group_snapshot_id,
      group_member_order_idx
    ) VALUES
      ('${ids.sessionExercise1}', '${ids.session1}', '${ids.exercise}', 0, '${ids.group}', 0),
      ('${ids.sessionExercise2}', '${ids.session2}', '${ids.exercise}', 0, NULL, NULL);
  `);
}

describe("0054 durable workout occurrence schema", () => {
  let database: TestDatabase | undefined;
  afterEach(async () => database?.close());

  it("retains a linked zero-rep performed attempt without treating it as skipped", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    await database.client.exec(`
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, reps, weight, weight_unit
      ) VALUES (
        '${ids.completedSet}', '${ids.sessionExercise1}', 1, 0, 100, 'lb'
      );
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, planned_reps_min, planned_reps_max,
        outcome, resolved_at, completed_set_id
      ) VALUES (
        '${ids.occurrence}', '${ids.session1}', '${ids.sessionExercise1}',
        'working_set', 'planned', 0, 0, '${ids.exercise}', 8, 10,
        'completed', '2026-07-21T12:05:00-04:00', '${ids.completedSet}'
      );
    `);

    const result = await database.client.query<{
      reps: number;
      outcome: string;
      completed_set_id: string;
    }>(`
      SELECT completed.reps, occurrence.outcome, occurrence.completed_set_id
      FROM session_occurrences occurrence
      JOIN completed_sets completed ON completed.id = occurrence.completed_set_id
      WHERE occurrence.id = '${ids.occurrence}'
    `);
    expect(result.rows).toEqual([
      { reps: 0, outcome: "completed", completed_set_id: ids.completedSet },
    ]);
  });

  it("rejects cross-workout links, duplicate sequence identity, and invalid terminal state", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    await expect(database.client.exec(`
      UPDATE session_exercises
      SET group_snapshot_id = '${ids.group}', group_member_order_idx = 1
      WHERE id = '${ids.sessionExercise2}'
    `)).rejects.toThrow();

    await database.client.exec(`
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome
      ) VALUES (
        '${ids.occurrence}', '${ids.session1}', '${ids.sessionExercise1}',
        'working_set', 'planned', 0, 0, '${ids.exercise}', 'pending'
      )
    `);
    await expect(database.client.exec(`
      INSERT INTO session_occurrences (
        session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome
      ) VALUES (
        '${ids.session1}', '${ids.sessionExercise1}', 'working_set',
        'planned', 0, 1, '${ids.exercise}', 'pending'
      )
    `)).rejects.toThrow();
    await expect(database.client.exec(`
      INSERT INTO session_occurrences (
        session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome
      ) VALUES (
        '${ids.session1}', '${ids.sessionExercise1}', 'working_set',
        'planned', 1, 1, '${ids.exercise}', 'skipped'
      )
    `)).rejects.toThrow();
  });

  it("enforces durable receipt identity and protected deletion", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome
      ) VALUES (
        '${ids.occurrence}', '${ids.session1}', '${ids.sessionExercise1}',
        'working_set', 'planned', 0, 0, '${ids.exercise}', 'pending'
      );
      INSERT INTO session_occurrence_mutations (
        occurrence_id, client_key, operation, canonical_payload_hash,
        expected_revision, resulting_revision, result_code
      ) VALUES (
        '${ids.occurrence}', 'receipt-key', 'note', 'hash-one', 0, 1, 'applied'
      );
    `);

    await expect(database.client.exec(`
      INSERT INTO session_occurrence_mutations (
        occurrence_id, client_key, operation, canonical_payload_hash,
        expected_revision, resulting_revision, result_code
      ) VALUES (
        '${ids.occurrence}', 'receipt-key', 'note', 'hash-two', 0, 1, 'applied'
      )
    `)).rejects.toThrow();
    await expect(database.client.exec(`
      DELETE FROM session_occurrence_mutations WHERE occurrence_id = '${ids.occurrence}'
    `)).rejects.toThrow(/Direct deletion from protected table/i);
  });

  it("keeps plan evidence and receipts immutable while allowing documented resolution transitions", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, planned_reps_min, planned_reps_max,
        outcome
      ) VALUES (
        '${ids.occurrence}', '${ids.session1}', '${ids.sessionExercise1}',
        'working_set', 'planned', 0, 0, '${ids.exercise}', 8, 10, 'pending'
      );
    `);

    await expect(database.client.exec(`
      UPDATE session_exercise_groups SET name = 'Changed later'
      WHERE id = '${ids.group}'
    `)).rejects.toThrow(/immutable/i);
    await expect(database.client.exec(`
      UPDATE session_occurrences SET planned_note = 'Changed later'
      WHERE id = '${ids.occurrence}'
    `)).rejects.toThrow(/immutable/i);

    await database.client.exec(`
      UPDATE session_occurrences
      SET outcome = 'skipped', outcome_reason = 'user_skipped',
          revision = 1, resolved_at = '2026-07-21T12:05:00-04:00'
      WHERE id = '${ids.occurrence}';
    `);
    await expect(database.client.exec(`
      UPDATE session_occurrences
      SET outcome_reason = 'tampered', revision = 2
      WHERE id = '${ids.occurrence}'
    `)).rejects.toThrow(/transition is not allowed/i);
    await database.client.exec(`
      UPDATE session_occurrences
      SET outcome_note = 'Saved after resolution', revision = 2
      WHERE id = '${ids.occurrence}';
      UPDATE session_occurrences
      SET outcome = 'pending', outcome_reason = NULL,
          outcome_note = NULL, revision = 3, resolved_at = NULL
      WHERE id = '${ids.occurrence}';
      INSERT INTO session_occurrence_mutations (
        occurrence_id, client_key, operation, canonical_payload_hash,
        expected_revision, resulting_revision, result_code
      ) VALUES (
        '${ids.occurrence}', 'immutable-receipt', 'restore', 'receipt-hash',
        2, 3, 'applied'
      );
    `);

    const state = await database.client.query<{
      outcome: string;
      revision: number;
      resolved_at: string | null;
    }>(`
      SELECT outcome, revision, resolved_at::text
      FROM session_occurrences WHERE id = '${ids.occurrence}'
    `);
    expect(state.rows).toEqual([{ outcome: "pending", revision: 3, resolved_at: null }]);

    await expect(database.client.exec(`
      UPDATE session_occurrence_mutations SET canonical_payload_hash = 'changed'
      WHERE occurrence_id = '${ids.occurrence}'
    `)).rejects.toThrow(/immutable/i);
    await expect(database.client.exec(`
      UPDATE session_occurrences
      SET outcome = 'legacy_unrecorded', revision = 4
      WHERE id = '${ids.occurrence}'
    `)).rejects.toThrow(/transition is not allowed/i);
  });

  it("requires performed-result links only for completed working occurrences", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, reps, weight, weight_unit
      ) VALUES (
        '${ids.completedSet}', '${ids.sessionExercise1}', 1, 8, 100, 'lb'
      );
    `);

    await expect(database.client.exec(`
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, resolved_at
      ) VALUES (
        '${ids.occurrence}', '${ids.session1}', '${ids.sessionExercise1}',
        'working_set', 'planned', 0, 0, '${ids.exercise}',
        'completed', '2026-07-21T12:05:00-04:00'
      )
    `)).rejects.toThrow();

    await database.client.exec(`
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, resolved_at
      ) VALUES (
        '${ids.occurrence2}', '${ids.session1}', '${ids.sessionExercise1}',
        'exercise_warmup', 'planned', 1, 0, '${ids.exercise}',
        'completed', '2026-07-21T12:03:00-04:00'
      )
    `);
    await expect(database.client.exec(`
      INSERT INTO session_occurrences (
        session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, resolved_at, completed_set_id
      ) VALUES (
        '${ids.session1}', '${ids.sessionExercise1}',
        'exercise_warmup', 'planned', 2, 1, '${ids.exercise}',
        'completed', '2026-07-21T12:04:00-04:00', '${ids.completedSet}'
      )
    `)).rejects.toThrow();
  });
});
