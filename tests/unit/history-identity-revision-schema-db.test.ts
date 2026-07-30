import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabaseAtMigration,
  type TestDatabase,
} from "../helpers/database";
import { restoreArchiveOperation } from "@/services/archive";

const ids = {
  user1: "10000000-0000-4000-8000-000000000067",
  user2: "10000000-0000-4000-8000-000000000068",
  program: "20000000-0000-4000-8000-000000000067",
  version: "21000000-0000-4000-8000-000000000067",
  template: "22000000-0000-4000-8000-000000000067",
  dayLineage: "23000000-0000-4000-8000-000000000067",
  exercise: "30000000-0000-4000-8000-000000000067",
  templateExercise: "31000000-0000-4000-8000-000000000067",
  slotLineage: "32000000-0000-4000-8000-000000000067",
  session1: "40000000-0000-4000-8000-000000000067",
  session2: "40000000-0000-4000-8000-000000000068",
  otherSession: "40000000-0000-4000-8000-000000000069",
  sessionExercise1: "50000000-0000-4000-8000-000000000067",
  sessionExercise2: "50000000-0000-4000-8000-000000000068",
  set1: "60000000-0000-4000-8000-000000000067",
  job1: "70000000-0000-4000-8000-000000000067",
  job2: "70000000-0000-4000-8000-000000000068",
  recommendation: "71000000-0000-4000-8000-000000000067",
  archive: "80000000-0000-4000-8000-000000000067",
  archive2: "80000000-0000-4000-8000-000000000068",
};

async function applyCandidateMigration(database: TestDatabase) {
  const sql = await readFile(
    "src/db/migrations/0067_history_management_contract.sql",
    "utf8",
  );
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.client.exec(statement);
  }
}

async function seedPreMigration(database: TestDatabase) {
  await database.client.exec(`
    INSERT INTO users (id, email) VALUES
      ('${ids.user1}', 'history-contract-1@example.test'),
      ('${ids.user2}', 'history-contract-2@example.test');
    INSERT INTO exercises (id, name, movement_pattern, primary_muscles)
    VALUES ('${ids.exercise}', 'History contract row', 'horizontal_pull', '["back"]'::jsonb);
    INSERT INTO programs (id, user_id, name, status, archived_at)
    VALUES ('${ids.program}', '${ids.user1}', 'Historical Program', 'archived', now());
    INSERT INTO program_versions (id, program_id, version_no, name)
    VALUES ('${ids.version}', '${ids.program}', 1, 'Historical Program');
    INSERT INTO workout_templates (
      id, program_version_id, lineage_id, name, order_idx
    ) VALUES (
      '${ids.template}', '${ids.version}', '${ids.dayLineage}', 'Day one', 0
    );
    INSERT INTO workout_template_exercises (
      id, workout_template_id, exercise_id, lineage_id, order_idx
    ) VALUES (
      '${ids.templateExercise}', '${ids.template}', '${ids.exercise}',
      '${ids.slotLineage}', 0
    );
    INSERT INTO workout_sessions (
      id, user_id, template_id, source, source_workout_key, status,
      timezone, local_date, started_at, finished_at
    ) VALUES
      (
        '${ids.session1}', '${ids.user1}', '${ids.template}', 'tracker', NULL,
        'completed', 'America/Toronto', '2026-07-20',
        '2026-07-20T12:00:00-04:00', '2026-07-20T13:00:00-04:00'
      ),
      (
        '${ids.session2}', '${ids.user1}', NULL, 'tracker', NULL,
        'completed', 'America/Toronto', '2026-07-19',
        '2026-07-19T12:00:00-04:00', '2026-07-19T13:00:00-04:00'
      ),
      (
        '${ids.otherSession}', '${ids.user2}', NULL, 'tracker', NULL,
        'completed', 'America/Toronto', '2026-07-18',
        '2026-07-18T12:00:00-04:00', '2026-07-18T13:00:00-04:00'
      );
    INSERT INTO session_exercises (
      id, session_id, exercise_id, planned_from_template_exercise_id, order_idx
    ) VALUES
      (
        '${ids.sessionExercise1}', '${ids.session1}', '${ids.exercise}',
        '${ids.templateExercise}', 0
      ),
      (
        '${ids.sessionExercise2}', '${ids.session2}', '${ids.exercise}',
        '${ids.templateExercise}', 0
      );
    INSERT INTO completed_sets (
      id, session_exercise_id, set_no, reps, logged_at
    ) VALUES (
      '${ids.set1}', '${ids.sessionExercise1}', 1, 8,
      '2026-07-25T20:30:00Z'
    );
  `);
}

describe("0067 History identity and revision foundation", () => {
  let database: TestDatabase | undefined;
  afterEach(async () => database?.close());

  async function setup() {
    database = await createTestDatabaseAtMigration("0066_contextual_notes");
    await seedPreMigration(database);
    await applyCandidateMigration(database);
    return database;
  }

  it("backfills only exact surviving Program lineage and leaves timing unknown", async () => {
    const db = await setup();
    const sessions = await db.client.query<{
      id: string;
      history_revision: number;
      performed_time_precision: string;
      source_program_id: string | null;
      source_program_version_id: string | null;
      source_day_lineage_id: string | null;
    }>(`
      SELECT id::text, history_revision, performed_time_precision,
        source_program_id::text, source_program_version_id::text,
        source_day_lineage_id::text
      FROM workout_sessions
      WHERE user_id = '${ids.user1}'
      ORDER BY id
    `);
    expect(sessions.rows).toEqual([
      {
        id: ids.session1,
        history_revision: 0,
        performed_time_precision: "instant",
        source_program_id: ids.program,
        source_program_version_id: ids.version,
        source_day_lineage_id: ids.dayLineage,
      },
      {
        id: ids.session2,
        history_revision: 0,
        performed_time_precision: "instant",
        source_program_id: null,
        source_program_version_id: null,
        source_day_lineage_id: null,
      },
    ]);

    const exercises = await db.client.query<{
      id: string;
      source_slot_lineage_id: string | null;
    }>(`
      SELECT id::text, source_slot_lineage_id::text
      FROM session_exercises
      WHERE session_id IN ('${ids.session1}', '${ids.session2}')
      ORDER BY id
    `);
    expect(exercises.rows).toEqual([
      { id: ids.sessionExercise1, source_slot_lineage_id: ids.slotLineage },
      { id: ids.sessionExercise2, source_slot_lineage_id: null },
    ]);

    const completed = await db.client.query<{
      logged_at: Date;
      observed_completed_at: Date | null;
      observed_completion_provenance: string;
      observed_completion_quality: string;
    }>(`
      SELECT logged_at, observed_completed_at,
        observed_completion_provenance, observed_completion_quality
      FROM completed_sets WHERE id = '${ids.set1}'
    `);
    expect(completed.rows[0]).toMatchObject({
      observed_completed_at: null,
      observed_completion_provenance: "unknown",
      observed_completion_quality: "unknown",
    });
    expect(new Date(completed.rows[0].logged_at).toISOString()).toBe(
      "2026-07-25T20:30:00.000Z",
    );
  });

  it("enforces revision, precision, manual identity, and complete source linkage", async () => {
    const db = await setup();
    await expect(db.client.exec(`
      UPDATE workout_sessions SET history_revision = -1
      WHERE id = '${ids.session1}'
    `)).rejects.toThrow();
    await expect(db.client.exec(`
      UPDATE workout_sessions SET performed_time_precision = 'estimated'
      WHERE id = '${ids.session1}'
    `)).rejects.toThrow();
    await expect(db.client.exec(`
      UPDATE workout_sessions
      SET source_program_version_id = NULL
      WHERE id = '${ids.session1}'
    `)).rejects.toThrow();

    await db.client.exec(`
      UPDATE workout_sessions
      SET source = 'history_manual', source_workout_key = 'stable-request'
      WHERE id = '${ids.session1}';
    `);
    await expect(db.client.exec(`
      UPDATE workout_sessions
      SET source = 'history_manual', source_workout_key = 'stable-request'
      WHERE id = '${ids.session2}'
    `)).rejects.toThrow();
  });

  it("accepts only coherent observed completion evidence and freezes recorded time", async () => {
    const db = await setup();
    await db.client.exec(`
      UPDATE completed_sets
      SET observed_completed_at = '2026-07-20T16:45:00Z',
          observed_completion_provenance = 'live_client',
          observed_completion_quality = 'trustworthy'
      WHERE id = '${ids.set1}'
    `);
    await db.client.exec(`
      UPDATE completed_sets
      SET observed_completed_at = '2026-07-20T16:44:00Z',
          observed_completion_provenance = 'manual_explicit',
          observed_completion_quality = 'owner_reported'
      WHERE id = '${ids.set1}'
    `);
    await expect(db.client.exec(`
      UPDATE completed_sets
      SET observed_completion_quality = 'trustworthy'
      WHERE id = '${ids.set1}'
    `)).rejects.toThrow();
    await expect(db.client.exec(`
      UPDATE completed_sets
      SET observed_completed_at = NULL
      WHERE id = '${ids.set1}'
    `)).rejects.toThrow();
    await expect(db.client.exec(`
      UPDATE completed_sets
      SET logged_at = logged_at + interval '1 minute'
      WHERE id = '${ids.set1}'
    `)).rejects.toThrow(/recording time is immutable/i);
  });

  it("keys jobs by source revision and enforces exact input ownership", async () => {
    const db = await setup();
    await db.client.exec(`
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision, coaching_prefs
      ) VALUES (
        '${ids.job1}', '${ids.user1}', '${ids.session1}', 0, '{}'::jsonb
      );
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision, coaching_prefs
      ) VALUES (
        '${ids.job2}', '${ids.user1}', '${ids.session1}', 1, '{}'::jsonb
      );
      INSERT INTO progression_job_input_sessions (
        job_id, user_id, source_slot_lineage_id, session_id, history_revision
      ) VALUES (
        '${ids.job2}', '${ids.user1}', '${ids.slotLineage}', '${ids.session1}', 0
      );
    `);
    await expect(db.client.exec(`
      INSERT INTO progression_jobs (
        user_id, session_id, source_session_revision, coaching_prefs
      ) VALUES (
        '${ids.user1}', '${ids.session1}', 1, '{}'::jsonb
      )
    `)).rejects.toThrow();
    await expect(db.client.exec(`
      INSERT INTO progression_jobs (
        user_id, session_id, source_session_revision, coaching_prefs
      ) VALUES (
        '${ids.user1}', '${ids.otherSession}', 0, '{}'::jsonb
      )
    `)).rejects.toThrow();
    await expect(db.client.exec(`
      INSERT INTO progression_job_input_sessions (
        job_id, user_id, source_slot_lineage_id, session_id, history_revision
      ) VALUES (
        '${ids.job2}', '${ids.user1}', '${ids.slotLineage}', '${ids.otherSession}', 0
      )
    `)).rejects.toThrow();
    await expect(db.client.exec(`
      INSERT INTO progression_job_input_sessions (
        job_id, user_id, source_slot_lineage_id, session_id, history_revision
      ) VALUES (
        '${ids.job1}', '${ids.user1}', '${ids.slotLineage}', '${ids.session2}', -1
      )
    `)).rejects.toThrow();
  });

  it("keeps shared derived evidence safe across separate workout Archive actions", async () => {
    const db = await setup();
    await db.client.exec(`
      UPDATE programs
      SET status = 'active', archived_at = NULL,
          current_version_id = '${ids.version}'
      WHERE id = '${ids.program}';
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision, coaching_prefs
      ) VALUES
        ('${ids.job1}', '${ids.user1}', '${ids.session1}', 0, '{}'::jsonb),
        ('${ids.job2}', '${ids.user1}', '${ids.session2}', 0, '{}'::jsonb);
      INSERT INTO progression_job_input_sessions (
        job_id, user_id, source_slot_lineage_id, session_id, history_revision
      ) VALUES
        ('${ids.job1}', '${ids.user1}', '${ids.slotLineage}', '${ids.session1}', 0),
        ('${ids.job2}', '${ids.user1}', '${ids.slotLineage}', '${ids.session1}', 0),
        ('${ids.job2}', '${ids.user1}', '${ids.slotLineage}', '${ids.session2}', 0);
      INSERT INTO recommendations (
        id, user_id, source, status, progression_job_id,
        source_template_exercise_id, source_slot_lineage_id,
        payload, reason, evidence
      ) VALUES (
        '${ids.recommendation}', '${ids.user1}', 'rule', 'pending',
        '${ids.job2}', '${ids.templateExercise}', '${ids.slotLineage}',
        '{"kind":"hold","templateExerciseId":"${ids.templateExercise}","reason":"shared"}'::jsonb,
        'Shared derived recommendation',
        '{"signals":{},"sessionIds":["${ids.session1}","${ids.session2}"]}'::jsonb
      );
      INSERT INTO archive_operations (
        id, user_id, action, status, summary, record_counts
      ) VALUES
        (
          '${ids.archive}', '${ids.user1}', 'workout.archive', 'active',
          'History contract archive', '{}'::jsonb
        ),
        (
          '${ids.archive2}', '${ids.user1}', 'workout.archive', 'active',
          'Second History contract archive', '{}'::jsonb
        );
      UPDATE workout_sessions
      SET archived_at = now(), archive_operation_id = '${ids.archive}'
      WHERE id = '${ids.session1}';
      UPDATE workout_sessions
      SET archived_at = now(), archive_operation_id = '${ids.archive2}'
      WHERE id = '${ids.session2}';
      UPDATE recommendations
      SET archived_at = now(), archive_operation_id = '${ids.archive}'
      WHERE id = '${ids.recommendation}';
      INSERT INTO archive_operation_records (
        operation_id, user_id, entity_type, entity_id, relationship_role
      ) VALUES
        (
          '${ids.archive}', '${ids.user1}', 'workout_session',
          '${ids.session1}', 'root'
        ),
        (
          '${ids.archive2}', '${ids.user1}', 'workout_session',
          '${ids.session2}', 'root'
        );
    `);

    const members = await db.client.query<{
      entity_type: string;
      count: number;
    }>(`
      SELECT entity_type, count(*)::int AS count
      FROM archive_operation_records
      WHERE operation_id = '${ids.archive}'
        AND entity_type IN ('progression_job', 'progression_job_input_session')
      GROUP BY entity_type
      ORDER BY entity_type
    `);
    expect(members.rows).toEqual([]);
    const preview = await db.client.query<{
      progression_jobs: number;
      progression_inputs: number;
    }>(`
      SELECT
        (permanent_delete_archive_preview(
          '${ids.user1}'::uuid, '${ids.archive}'::uuid
        )#>>'{deleteCounts,progressionJobs}')::int AS progression_jobs,
        (permanent_delete_archive_preview(
          '${ids.user1}'::uuid, '${ids.archive}'::uuid
        )#>>'{deleteCounts,progressionJobInputSessions}')::int AS progression_inputs
    `);
    expect(preview.rows).toEqual([
      { progression_jobs: 2, progression_inputs: 3 },
    ]);
    const sharedRecommendationMembers = await db.client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM archive_operation_records
      WHERE entity_type = 'recommendation'
        AND entity_id = '${ids.recommendation}'
    `);
    expect(sharedRecommendationMembers.rows).toEqual([{ count: 2 }]);
    const blocked = await db.client.query<{ blockers: unknown[] }>(`
      SELECT permanent_delete_archive_preview(
        '${ids.user1}'::uuid, '${ids.archive}'::uuid
      )->'blockers' AS blockers
    `);
    expect(blocked.rows[0]?.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "shared_recommendation_archive" }),
      ])
    );

    expect(
      (await restoreArchiveOperation(db.db, ids.user1, ids.archive)).ok
    ).toBe(true);
    const stillArchivedRecommendation = await db.client.query<{
      archived: boolean;
    }>(`
      SELECT archived_at IS NOT NULL AS archived
      FROM recommendations WHERE id = '${ids.recommendation}'
    `);
    expect(stillArchivedRecommendation.rows).toEqual([{ archived: true }]);
    expect(
      (await restoreArchiveOperation(db.db, ids.user1, ids.archive2)).ok
    ).toBe(true);
    const restoredRecommendation = await db.client.query<{ archived: boolean }>(`
      SELECT archived_at IS NOT NULL AS archived
      FROM recommendations WHERE id = '${ids.recommendation}'
    `);
    expect(restoredRecommendation.rows).toEqual([{ archived: false }]);
  });
});
