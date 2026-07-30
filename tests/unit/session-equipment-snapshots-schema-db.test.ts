import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabaseAtMigration,
  type TestDatabase,
} from "../helpers/database";

const ids = {
  user1: "10000000-0000-4000-8000-000000000062",
  user2: "10000000-0000-4000-8000-000000000063",
  exercise: "20000000-0000-4000-8000-000000000062",
  session1: "30000000-0000-4000-8000-000000000062",
  session2: "30000000-0000-4000-8000-000000000063",
  otherSession: "30000000-0000-4000-8000-000000000064",
  sessionExercise1: "40000000-0000-4000-8000-000000000062",
  sessionExercise2: "40000000-0000-4000-8000-000000000063",
  otherSessionExercise: "40000000-0000-4000-8000-000000000064",
  item1: "50000000-0000-4000-8000-000000000062",
  item2: "50000000-0000-4000-8000-000000000063",
  barItem1: "50000000-0000-4000-8000-000000000064",
  barItem2: "50000000-0000-4000-8000-000000000065",
  barProfile1: "51000000-0000-4000-8000-000000000064",
  barProfile2: "51000000-0000-4000-8000-000000000065",
  snapshot1: "60000000-0000-4000-8000-000000000062",
  snapshot2: "60000000-0000-4000-8000-000000000063",
  snapshotOtherExercise: "60000000-0000-4000-8000-000000000064",
  set1: "70000000-0000-4000-8000-000000000062",
  setLegacy: "70000000-0000-4000-8000-000000000063",
  occurrence1: "80000000-0000-4000-8000-000000000062",
  occurrenceLegacy: "80000000-0000-4000-8000-000000000063",
  receiptClient: "90000000-0000-4000-8000-000000000062",
};

const hash = "a".repeat(64);

async function applyCandidateMigration(database: TestDatabase) {
  const sql = await readFile(
    "src/db/migrations/0062_session_equipment_snapshots.sql",
    "utf8",
  );
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.client.exec(statement);
  }
}

async function seed(database: TestDatabase) {
  await database.client.exec(`
    INSERT INTO users (id, email) VALUES
      ('${ids.user1}', 'equipment-snapshot-1@example.test'),
      ('${ids.user2}', 'equipment-snapshot-2@example.test');
    INSERT INTO exercises (id, name, movement_pattern, primary_muscles)
    VALUES ('${ids.exercise}', 'Snapshot Test Row', 'horizontal_pull', '["back"]'::jsonb);
    INSERT INTO workout_sessions (
      id, user_id, timezone, local_date, started_at, status, finished_at
    ) VALUES
      ('${ids.session1}', '${ids.user1}', 'America/Toronto', '2026-07-21', '2026-07-21T12:00:00-04:00', 'in_progress', NULL),
      ('${ids.session2}', '${ids.user1}', 'America/Toronto', '2026-07-20', '2026-07-20T12:00:00-04:00', 'completed', '2026-07-20T13:00:00-04:00'),
      ('${ids.otherSession}', '${ids.user2}', 'America/Toronto', '2026-07-20', '2026-07-20T12:00:00-04:00', 'completed', '2026-07-20T13:00:00-04:00');
    INSERT INTO session_exercises (id, session_id, exercise_id, order_idx) VALUES
      ('${ids.sessionExercise1}', '${ids.session1}', '${ids.exercise}', 0),
      ('${ids.sessionExercise2}', '${ids.session2}', '${ids.exercise}', 0),
      ('${ids.otherSessionExercise}', '${ids.otherSession}', '${ids.exercise}', 0);
    INSERT INTO equipment_items (id, user_id, type, label, attrs) VALUES
      ('${ids.item1}', '${ids.user1}', 'dumbbell', 'Owner one dumbbells', '{}'::jsonb),
      ('${ids.item2}', '${ids.user2}', 'dumbbell', 'Owner two dumbbells', '{}'::jsonb);
  `);
}

function snapshotSql(input: {
  id: string;
  userId?: string;
  sessionId?: string;
  sessionExerciseId?: string;
  equipmentItemId?: string;
  label?: string;
  geometry?: string;
  profileKind?: string;
  loadProfileId?: string;
}) {
  return `
    INSERT INTO session_equipment_snapshots (
      id, user_id, session_id, session_exercise_id, equipment_item_id, load_profile_id,
      equipment_label, profile_kind, geometry_certainty, unit,
      selection_provenance, configuration_revision, configuration_hash,
      geometry_version, geometry_snapshot
    ) VALUES (
      '${input.id}', '${input.userId ?? ids.user1}',
      '${input.sessionId ?? ids.session1}',
      '${input.sessionExerciseId ?? ids.sessionExercise1}',
      '${input.equipmentItemId ?? ids.item1}',
      ${input.loadProfileId ? `'${input.loadProfileId}'` : "NULL"},
      '${input.label ?? "Snapshot dumbbells"}', '${input.profileKind ?? "incremental_implement"}',
      'known', 'lb', 'user_selected', 1, '${hash}', 1,
      '${input.geometry ?? '{"version":1,"kind":"incremental_implement","increments":[10,20]}'}'::jsonb
    )
  `;
}

describe("0062 session equipment snapshot foundation", () => {
  let database: TestDatabase | undefined;
  afterEach(async () => database?.close());

  async function setup() {
    database = await createTestDatabaseAtMigration("0060_equipment_load_profiles");
    await applyCandidateMigration(database);
    await seed(database);
    return database;
  }

  it("retains validated versioned geometry and permits only same-exercise current selection", async () => {
    const db = await setup();
    await db.client.exec(snapshotSql({ id: ids.snapshot1 }));
    await db.client.exec(snapshotSql({
      id: ids.snapshotOtherExercise,
      sessionId: ids.session2,
      sessionExerciseId: ids.sessionExercise2,
    }));

    await db.client.exec(`
      UPDATE session_exercises
      SET current_equipment_snapshot_id = '${ids.snapshot1}'
      WHERE id = '${ids.sessionExercise1}'
    `);
    await expect(db.client.exec(`
      UPDATE session_exercises
      SET current_equipment_snapshot_id = '${ids.snapshotOtherExercise}'
      WHERE id = '${ids.sessionExercise1}'
    `)).rejects.toThrow();
    await expect(db.client.exec(snapshotSql({
      id: ids.snapshot2,
      geometry: '{"version":2,"kind":"incremental_implement"}',
    }))).rejects.toThrow();
    await expect(db.client.exec(snapshotSql({
      id: ids.snapshot2,
      sessionId: ids.session1,
      sessionExerciseId: ids.sessionExercise2,
    }))).rejects.toThrow();
  });

  it("rejects cross-owner item and workout provenance", async () => {
    const db = await setup();
    await expect(db.client.exec(snapshotSql({
      id: ids.snapshot1,
      equipmentItemId: ids.item2,
    }))).rejects.toThrow(/another account/i);
    await expect(db.client.exec(snapshotSql({
      id: ids.snapshot2,
      userId: ids.user2,
      sessionId: ids.session1,
      sessionExerciseId: ids.sessionExercise1,
      equipmentItemId: ids.item2,
    }))).rejects.toThrow();
  });

  it("requires an exact typed profile to match its item and complete known geometry", async () => {
    const db = await setup();
    await db.client.exec(`
      INSERT INTO equipment_items (id, user_id, type, label) VALUES
        ('${ids.barItem1}', '${ids.user1}', 'ez_bar', '18 lb EZ bar'),
        ('${ids.barItem2}', '${ids.user1}', 'ez_bar', '25 lb EZ bar');
      INSERT INTO barbell_configs (
        id, user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, label
      ) VALUES
        ('${ids.barProfile1}', '${ids.user1}', 'ez', '${ids.barItem1}', 'lb', 'ez', true, 18, '18 lb EZ bar'),
        ('${ids.barProfile2}', '${ids.user1}', 'ez', '${ids.barItem2}', 'lb', 'ez', true, 25, '25 lb EZ bar');
    `);
    const completeGeometry = JSON.stringify({
      version: 1,
      kind: "plate_loaded_implement",
      emptyWeight: 18,
      collarWeight: 0,
      unit: "lb",
      sharedPlatePoolCompatible: true,
    });
    await db.client.exec(snapshotSql({
      id: ids.snapshot1,
      equipmentItemId: ids.barItem1,
      loadProfileId: ids.barProfile1,
      profileKind: "plate_loaded_implement",
      geometry: completeGeometry,
    }));
    await expect(db.client.exec(snapshotSql({
      id: ids.snapshot2,
      equipmentItemId: ids.barItem1,
      loadProfileId: ids.barProfile2,
      profileKind: "plate_loaded_implement",
      geometry: completeGeometry,
    }))).rejects.toThrow(/profile|item|account/i);
    await expect(db.client.exec(snapshotSql({
      id: ids.snapshot2,
      equipmentItemId: ids.barItem2,
      loadProfileId: ids.barProfile2,
      profileKind: "plate_loaded_implement",
      geometry: '{"version":1,"kind":"plate_loaded_implement"}',
    }))).rejects.toThrow(/geometry|incomplete/i);
  });

  it("enforces occurrence/set snapshot equality including immutable completed evidence", async () => {
    const db = await setup();
    await db.client.exec(snapshotSql({ id: ids.snapshot1 }));
    await db.client.exec(snapshotSql({ id: ids.snapshot2, label: "Second setup" }));
    await db.client.exec(`
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, reps, weight, weight_unit,
        equipment_snapshot_id, load_entry_meaning
      ) VALUES (
        '${ids.set1}', '${ids.sessionExercise1}', 1, 8, 40, 'lb',
        '${ids.snapshot1}', 'total_system'
      )
    `);

    await expect(db.client.exec(`
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, resolved_at,
        completed_set_id, equipment_snapshot_id
      ) VALUES (
        '${ids.occurrence1}', '${ids.session1}', '${ids.sessionExercise1}',
        'working_set', 'planned', 0, 0, '${ids.exercise}', 'completed', now(),
        '${ids.set1}', '${ids.snapshot2}'
      )
    `)).rejects.toThrow(/same equipment snapshot/i);

    await db.client.exec(`
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, resolved_at,
        completed_set_id, equipment_snapshot_id
      ) VALUES (
        '${ids.occurrence1}', '${ids.session1}', '${ids.sessionExercise1}',
        'working_set', 'planned', 0, 0, '${ids.exercise}', 'completed', now(),
        '${ids.set1}', '${ids.snapshot1}'
      )
    `);
    await expect(db.client.exec(`
      UPDATE session_equipment_snapshots SET equipment_label = 'Rewritten'
      WHERE id = '${ids.snapshot1}'
    `)).rejects.toThrow(/immutable/i);
    await expect(db.client.exec(`
      UPDATE completed_sets
      SET equipment_snapshot_id = '${ids.snapshot2}'
      WHERE id = '${ids.set1}'
    `)).rejects.toThrow(/immutable|same equipment snapshot/i);
    await expect(db.client.exec(`
      UPDATE session_occurrences
      SET equipment_snapshot_id = '${ids.snapshot2}', revision = 1
      WHERE id = '${ids.occurrence1}'
    `)).rejects.toThrow(/same equipment snapshot|transition is not allowed/i);
  });

  it("keeps legacy evidence explicitly unknown without inventing a snapshot", async () => {
    const db = await setup();
    await db.client.exec(`
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, reps, weight, weight_unit
      ) VALUES ('${ids.setLegacy}', '${ids.sessionExercise1}', 1, 8, 40, 'lb');
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, resolved_at, completed_set_id
      ) VALUES (
        '${ids.occurrenceLegacy}', '${ids.session1}', '${ids.sessionExercise1}',
        'working_set', 'legacy', 0, 0, '${ids.exercise}', 'completed', now(),
        '${ids.setLegacy}'
      );
    `);
    const result = await db.client.query<{
      load_entry_meaning: string;
      set_snapshot: string | null;
      occurrence_snapshot: string | null;
    }>(`
      SELECT completed.load_entry_meaning,
        completed.equipment_snapshot_id::text AS set_snapshot,
        occurrence.equipment_snapshot_id::text AS occurrence_snapshot
      FROM completed_sets completed
      JOIN session_occurrences occurrence ON occurrence.completed_set_id = completed.id
      WHERE completed.id = '${ids.setLegacy}'
    `);
    expect(result.rows).toEqual([{
      load_entry_meaning: "legacy_unknown",
      set_snapshot: null,
      occurrence_snapshot: null,
    }]);
  });

  it("allows revisioned pending selection changes but freezes terminal occurrence evidence", async () => {
    const db = await setup();
    await db.client.exec(snapshotSql({ id: ids.snapshot1 }));
    await db.client.exec(snapshotSql({ id: ids.snapshot2, label: "Second setup" }));
    await db.client.exec(`
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, equipment_snapshot_id
      ) VALUES (
        '${ids.occurrence1}', '${ids.session1}', '${ids.sessionExercise1}',
        'working_set', 'planned', 0, 0, '${ids.exercise}', 'pending',
        '${ids.snapshot1}'
      );
      UPDATE session_occurrences
      SET equipment_snapshot_id = '${ids.snapshot2}', revision = 1
      WHERE id = '${ids.occurrence1}';
    `);
    await expect(db.client.exec(`
      UPDATE session_occurrences
      SET equipment_snapshot_id = '${ids.snapshot1}'
      WHERE id = '${ids.occurrence1}'
    `)).rejects.toThrow(/revision/i);
    await db.client.exec(`
      UPDATE session_occurrences
      SET outcome = 'skipped', outcome_reason = 'equipment', resolved_at = now(),
          revision = 2
      WHERE id = '${ids.occurrence1}'
    `);
    await db.client.exec(`
      UPDATE session_occurrences
      SET outcome_note = 'Kept after resolution', revision = 3
      WHERE id = '${ids.occurrence1}'
    `);
    await expect(db.client.exec(`
      UPDATE session_occurrences
      SET equipment_snapshot_id = '${ids.snapshot1}', revision = 4
      WHERE id = '${ids.occurrence1}'
    `)).rejects.toThrow(/transition is not allowed/i);
  });

  it("makes selection receipts UUID-idempotent, owner-scoped, and immutable", async () => {
    const db = await setup();
    await db.client.exec(snapshotSql({ id: ids.snapshot1 }));
    await db.client.exec(`
      INSERT INTO session_equipment_selection_receipts (
        user_id, session_id, session_exercise_id, client_key, operation,
        canonical_payload_hash, resulting_snapshot_id, result_code
      ) VALUES (
        '${ids.user1}', '${ids.session1}', '${ids.sessionExercise1}',
        '${ids.receiptClient}', 'select', '${hash}', '${ids.snapshot1}', 'applied'
      )
    `);
    await expect(db.client.exec(`
      INSERT INTO session_equipment_selection_receipts (
        user_id, session_id, session_exercise_id, client_key, operation,
        canonical_payload_hash, resulting_snapshot_id, result_code
      ) VALUES (
        '${ids.user1}', '${ids.session1}', '${ids.sessionExercise1}',
        '${ids.receiptClient}', 'select', '${"b".repeat(64)}', '${ids.snapshot1}', 'applied'
      )
    `)).rejects.toThrow();
    await expect(db.client.exec(`
      UPDATE session_equipment_selection_receipts SET result_code = 'no_change'
      WHERE client_key = '${ids.receiptClient}'
    `)).rejects.toThrow(/immutable/i);
    await expect(db.client.exec(`
      DELETE FROM session_equipment_selection_receipts
      WHERE client_key = '${ids.receiptClient}'
    `)).rejects.toThrow(/Direct deletion from protected table/i);
    await expect(db.client.exec(`
      DELETE FROM session_equipment_snapshots WHERE id = '${ids.snapshot1}'
    `)).rejects.toThrow(/Direct deletion from protected table/i);
    await expect(db.client.exec(`
      INSERT INTO session_equipment_selection_receipts (
        user_id, session_id, session_exercise_id, client_key, operation,
        canonical_payload_hash, resulting_snapshot_id, result_code
      ) VALUES (
        '${ids.user2}', '${ids.session1}', '${ids.sessionExercise1}',
        '90000000-0000-4000-8000-000000000063', 'select', '${hash}',
        '${ids.snapshot1}', 'applied'
      )
    `)).rejects.toThrow();
    await expect(db.client.exec(`
      INSERT INTO session_equipment_selection_receipts (
        user_id, session_id, session_exercise_id, client_key, operation,
        canonical_payload_hash, resulting_snapshot_id, result_code
      ) VALUES (
        '${ids.user1}', '${ids.session1}', '${ids.sessionExercise1}',
        'not-a-uuid', 'select', '${hash}', '${ids.snapshot1}', 'applied'
      )
    `)).rejects.toThrow();
  });
});
