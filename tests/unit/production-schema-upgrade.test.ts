import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  barbellConfigs,
  exerciseEquipmentRequirements,
  exercisePrescriptions,
  plateInventory,
  sessionExercises,
  sessionOccurrences,
} from "@/db/schema";
import { buildJsonBackup } from "@/services/export";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import { mutateWorkoutOccurrence } from "@/services/session-lifecycle";
import { actionableActiveSessionOccurrences } from "@/lib/warmup-occurrence-compatibility";
import {
  createMigratedTestDatabase,
  createTestDatabaseAtMigration,
  getPublicSchemaFingerprint,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

const PRODUCTION_MIGRATION = "0018_brave_timeslip";
const LATEST_MIGRATION = "0084_restore_finish_command_receipts";

const previewBoundaries = [
  {
    migration: "0020_backfill_load_units_calendar_identity",
    views: ["production_data_repair_preview"],
  },
  {
    migration: "0026_workout_lifecycle_repair_preview",
    views: [
      "production_data_repair_preview",
      "workout_lifecycle_repair_preview",
    ],
  },
  {
    migration: "0030_recommendation_decision_repair_preview",
    views: ["recommendation_decision_repair_preview"],
  },
  {
    migration: "0032_quick_log_result_identity",
    views: ["quick_log_result_repair_preview"],
  },
  {
    migration: "0035_ai_privacy_repair_preview",
    views: ["ai_privacy_repair_preview"],
  },
  {
    migration: "0038_snapshot_lifecycle_repair_preview",
    views: ["snapshot_lifecycle_repair_preview"],
  },
  {
    migration: "0044_versioned_program_editor_preview",
    views: ["program_editor_repair_preview"],
  },
  {
    migration: "0060_equipment_load_profiles",
    views: ["equipment_load_profile_repair_preview"],
  },
  {
    migration: "0063_equipment_truth_backfill_bridge",
    views: ["equipment_load_profile_repair_preview"],
  },
] as const;

describe("current production schema upgrade", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("backfills active gaps as pending and historical group gaps as unknown without losing zero-rep work", async () => {
    database = await createTestDatabaseAtMigration(
      "0056_permanent_delete_occurrence_contract",
    );
    const userId = crypto.randomUUID();
    const exerciseIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const completedSessionId = crypto.randomUUID();
    const activeSessionId = crypto.randomUUID();
    const completedExerciseIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const activeExerciseId = crypto.randomUUID();
    const zeroRepSetId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email) VALUES ('${userId}', 'stage3-backfill@example.com');
      INSERT INTO user_profiles (user_id, timezone) VALUES ('${userId}', 'America/Toronto');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics, variant_attributes
      ) VALUES
        ('${exerciseIds[0]}', 'Backfill A', 'squat', '["quadriceps"]', 'barbell', 'weight_reps', 'total', '{}'),
        ('${exerciseIds[1]}', 'Backfill B', 'squat', '["quadriceps"]', 'dumbbell', 'weight_reps', 'per_implement', '{}'),
        ('${exerciseIds[2]}', 'Backfill C', 'squat', '["quadriceps"]', 'cable', 'weight_reps', 'total', '{}');
      INSERT INTO workout_sessions (
        id, user_id, template_name, day_warmup_notes, status, source,
        started_at, finished_at, timezone, local_date
      ) VALUES
        ('${completedSessionId}', '${userId}', 'Historical tri-set', 'Move first', 'completed', 'tracker',
         '2026-07-01T14:00:00Z', '2026-07-01T15:00:00Z', 'America/Toronto', '2026-07-01'),
        ('${activeSessionId}', '${userId}', 'Active workout', 'Prepare now', 'in_progress', 'tracker',
         '2026-07-21T14:00:00Z', NULL, 'America/Toronto', '2026-07-21');
      INSERT INTO session_exercises (
        id, session_id, exercise_id, order_idx, superset_key,
        target_sets, target_reps_min, target_reps_max, warmup_notes, warmup_sets
      ) VALUES
        ('${completedExerciseIds[0]}', '${completedSessionId}', '${exerciseIds[0]}', 0, 'legacy-tri', 2, 8, 10, NULL, '[]'),
        ('${completedExerciseIds[1]}', '${completedSessionId}', '${exerciseIds[1]}', 1, 'legacy-tri', 2, 8, 10, NULL, '[]'),
        ('${completedExerciseIds[2]}', '${completedSessionId}', '${exerciseIds[2]}', 2, 'legacy-tri', 2, 8, 10, NULL, '[]'),
        ('${activeExerciseId}', '${activeSessionId}', '${exerciseIds[0]}', 0, NULL, 2, 5, 5,
         'Prepare the press', '[{"label":"Empty bar","reps":5,"load":null,"loadUnit":null,"loadPercent":null,"loadText":"empty bar","notes":null}]');
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps
      ) VALUES ('${zeroRepSetId}', '${completedExerciseIds[0]}', 1, 100, 'lb', 0);
    `);

    await migrateTestDatabaseThrough(database, LATEST_MIGRATION);
    const completed = await database.client.query<{
      kind: string;
      outcome: string;
      completed_set_id: string | null;
      group_round: number | null;
      group_member_order_idx: number | null;
    }>(`
      SELECT kind, outcome, completed_set_id, group_round, group_member_order_idx
      FROM session_occurrences
      WHERE session_id = $1
      ORDER BY sequence_idx
    `, [completedSessionId]);
    expect(completed.rows.map((row) => row.kind)).toEqual([
      "day_warmup",
      "working_set", "working_set", "working_set",
      "working_set", "working_set", "working_set",
    ]);
    expect(completed.rows.map((row) => row.outcome)).toEqual([
      "legacy_unrecorded",
      "completed", "legacy_unrecorded", "legacy_unrecorded",
      "legacy_unrecorded", "legacy_unrecorded", "legacy_unrecorded",
    ]);
    expect(completed.rows[1]).toMatchObject({
      completed_set_id: zeroRepSetId,
      group_round: 1,
      group_member_order_idx: 0,
    });
    expect(completed.rows.slice(1).map((row) => [
      row.group_round,
      row.group_member_order_idx,
    ])).toEqual([
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ]);
    const active = await database.client.query<{ kind: string; outcome: string }>(`
      SELECT kind, outcome FROM session_occurrences
      WHERE session_id = $1 ORDER BY sequence_idx
    `, [activeSessionId]);
    expect(active.rows).toEqual([
      { kind: "day_warmup", outcome: "pending" },
      { kind: "exercise_warmup", outcome: "pending" },
      { kind: "exercise_warmup", outcome: "pending" },
      { kind: "working_set", outcome: "pending" },
      { kind: "working_set", outcome: "pending" },
    ]);
    const upgradedActiveSession = await database.db.query.workoutSessions.findFirst({
      where: (session, { eq: equal }) => equal(session.id, activeSessionId),
      with: {
        occurrences: { orderBy: sessionOccurrences.sequenceIdx },
        exercises: { orderBy: sessionExercises.orderIdx },
      },
    });
    if (!upgradedActiveSession) throw new Error("Active upgrade fixture missing.");
    const actionable = actionableActiveSessionOccurrences({
      sessionId: upgradedActiveSession.id,
      templateId: upgradedActiveSession.templateId,
      sourceDayLineageId: upgradedActiveSession.sourceDayLineageId,
      dayWarmupNotes: upgradedActiveSession.dayWarmupNotes,
      dayWarmupItems: upgradedActiveSession.dayWarmupItems,
      exercises: upgradedActiveSession.exercises,
      occurrences: upgradedActiveSession.occurrences,
    });
    expect(actionable.map((occurrence) => occurrence.kind)).toEqual([
      "exercise_warmup",
      "working_set",
      "working_set",
    ]);
    const projectedOverviews = upgradedActiveSession.occurrences.filter(
      (occurrence) =>
        occurrence.kind === "day_warmup" ||
        (occurrence.kind === "exercise_warmup" &&
          occurrence.label === "Prepare the press"),
    );
    expect(projectedOverviews).toHaveLength(2);
    for (const projectedOverview of projectedOverviews) {
      await expect(mutateWorkoutOccurrence(database.db, userId, {
        occurrenceId: projectedOverview.id,
        clientKey: crypto.randomUUID(),
        expectedRevision: projectedOverview.revision,
        operation: "complete",
      })).resolves.toEqual({ outcome: "conflict" });
      expect(await database.db.query.sessionOccurrences.findFirst({
        where: eq(sessionOccurrences.id, projectedOverview.id),
      })).toMatchObject({ outcome: "pending", revision: 0 });
    }
  }, 60_000);

  it("normalizes redundant legacy warm-up load descriptions during the occurrence backfill", async () => {
    database = await createTestDatabaseAtMigration(
      "0056_permanent_delete_occurrence_contract",
    );
    const userId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email)
      VALUES ('${userId}', 'legacy-warmup-load@example.com');
      INSERT INTO user_profiles (user_id, timezone)
      VALUES ('${userId}', 'America/Toronto');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics, variant_attributes
      ) VALUES (
        '${exerciseId}', 'Legacy warm-up press', 'horizontal_push', '["chest"]', 'barbell',
        'weight_reps', 'total', '{}'
      );
      INSERT INTO workout_sessions (
        id, user_id, template_name, status, source,
        started_at, finished_at, timezone, local_date
      ) VALUES (
        '${sessionId}', '${userId}', 'Historical warm-up', 'completed', 'tracker',
        '2026-07-01T14:00:00Z', '2026-07-01T15:00:00Z',
        'America/Toronto', '2026-07-01'
      );
      INSERT INTO session_exercises (
        id, session_id, exercise_id, order_idx, target_sets,
        target_reps_min, target_reps_max, warmup_sets
      ) VALUES (
        '${sessionExerciseId}', '${sessionId}', '${exerciseId}', 0, 1, 5, 5,
        '[{"label":"First ramp","reps":5,"load":null,"loadUnit":null,"loadPercent":55,"loadText":"~55% of work weight ×5","notes":null}]'
      );
    `);

    await migrateTestDatabaseThrough(database, LATEST_MIGRATION);

    const warmup = await database.client.query<{
      planned_load: string | null;
      planned_load_unit: string | null;
      planned_load_percent: string | null;
      planned_load_text: string | null;
    }>(`
      SELECT
        planned_load::text,
        planned_load_unit::text,
        planned_load_percent::text,
        planned_load_text
      FROM session_occurrences
      WHERE session_id = $1 AND kind = 'exercise_warmup'
    `, [sessionId]);
    expect(warmup.rows).toEqual([{
      planned_load: null,
      planned_load_unit: null,
      planned_load_percent: "55.00",
      planned_load_text: null,
    }]);
    const source = await database.client.query<{ warmup_sets: unknown }>(`
      SELECT warmup_sets
      FROM session_exercises
      WHERE id = $1
    `, [sessionExerciseId]);
    expect(source.rows[0]?.warmup_sets).toEqual([{
      label: "First ramp",
      reps: 5,
      load: null,
      loadUnit: null,
      loadPercent: 55,
      loadText: "~55% of work weight ×5",
      notes: null,
    }]);
  }, 60_000);

  it("matches a fresh final schema exactly through the A05 Review bridge contract", async () => {
    const fresh = await createMigratedTestDatabase();
    const productionShaped = await createTestDatabaseAtMigration(
      PRODUCTION_MIGRATION
    );

    try {
      // Production was physically at 0018 with one fewer historical journal row.
      await productionShaped.client.exec(`
        DELETE FROM drizzle.__drizzle_migrations
        WHERE created_at = (
          SELECT min(created_at) FROM drizzle.__drizzle_migrations
        )
      `);
      await migrateTestDatabaseThrough(productionShaped, LATEST_MIGRATION);

      const [freshSchema, upgradedSchema] = await Promise.all([
        getPublicSchemaFingerprint(fresh),
        getPublicSchemaFingerprint(productionShaped),
      ]);
      expect(upgradedSchema).toEqual(freshSchema);

      expect(freshSchema.columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table_name: "program_versions",
            column_name: "document_schema_version",
            type: "integer",
            not_null: true,
          }),
          expect.objectContaining({
            table_name: "program_versions",
            column_name: "publication_preflight",
            type: "jsonb",
          }),
          expect.objectContaining({
            table_name: "workout_templates",
            column_name: "intent",
            type: "jsonb",
          }),
          expect.objectContaining({
            table_name: "workout_template_exercises",
            column_name: "intent",
            type: "jsonb",
          }),
          expect.objectContaining({
            table_name: "workout_sessions",
            column_name: "compilation_acceptance_key",
            type: "text",
          }),
          expect.objectContaining({
            table_name: "workout_sessions",
            column_name: "compilation_snapshot",
            type: "jsonb",
          }),
          expect.objectContaining({
            table_name: "session_occurrences",
            column_name: "outcome",
            type: "text",
            not_null: true,
          }),
          expect.objectContaining({
            table_name: "session_exercise_groups",
            column_name: "planned_rounds",
            type: "integer",
          }),
          expect.objectContaining({
            table_name: "workout_templates",
            column_name: "warmup_items",
            type: "jsonb",
            not_null: true,
          }),
          expect.objectContaining({
            table_name: "workout_sessions",
            column_name: "day_warmup_items",
            type: "jsonb",
            not_null: true,
          }),
          expect.objectContaining({
            table_name: "workout_sessions",
            column_name: "history_revision",
            type: "integer",
            not_null: true,
          }),
          expect.objectContaining({
            table_name: "completed_sets",
            column_name: "observed_completed_at",
            type: "timestamp with time zone",
            not_null: false,
          }),
          expect.objectContaining({
            table_name: "progression_job_input_sessions",
            column_name: "history_revision",
            type: "integer",
            not_null: true,
          }),
          expect.objectContaining({
            table_name: "completed_sets",
            column_name: "rir",
            type: "real",
            not_null: false,
          }),
          expect.objectContaining({
            table_name: "completed_sets",
            column_name: "technique_issue",
            type: "text",
            not_null: false,
          }),
          expect.objectContaining({
            table_name: "completed_sets",
            column_name: "limitation_cause",
            type: "text",
            not_null: false,
          }),
        ])
      );
      expect(freshSchema.objects).toContainEqual({
        kind: "r",
        name: "session_compiler_proposals",
      });
      expect(freshSchema.objects).toEqual(
        expect.arrayContaining([
          { kind: "r", name: "session_exercise_groups" },
          { kind: "r", name: "session_occurrences" },
          { kind: "r", name: "session_occurrence_mutations" },
          { kind: "r", name: "progression_job_input_sessions" },
        ]),
      );

      const constraintNames = freshSchema.constraints.map(
        ({ constraint_name }) => constraint_name
      );
      expect(constraintNames).toEqual(
        expect.arrayContaining([
          "program_versions_document_schema_valid",
          "session_compiler_proposals_status_check",
          "session_compiler_proposals_revision_check",
          "session_compiler_proposals_decision_check",
          "workout_sessions_compilation_snapshot_check",
          "completed_sets_effort_measure_valid",
          "completed_sets_technique_issue_valid",
          "completed_sets_limitation_cause_valid",
        ])
      );

      const indexNames = freshSchema.indexes.map(({ index_name }) => index_name);
      expect(indexNames).toEqual(
        expect.arrayContaining([
          "session_compiler_proposals_user_created_idx",
          "session_compiler_proposals_user_mutation_uq",
          "session_compiler_proposals_session_uq",
          "session_compiler_proposals_acceptance_uq",
          "workout_sessions_compilation_acceptance_uq",
          "pain_logs_active_completed_set_uq",
        ])
      );

      const triggerNames = freshSchema.triggers.map(
        ({ trigger_name }) => trigger_name
      );
      expect(triggerNames).toEqual(
        expect.arrayContaining([
          "session_compiler_proposals_immutable",
          "workout_sessions_compiler_provenance_immutable",
          "pain_logs_completed_set_context_valid",
        ])
      );
      expect(freshSchema.triggers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table_name: "session_compiler_proposals",
            trigger_name: "protected_delete_guard",
          }),
        ])
      );

      const functionNames = freshSchema.functions.map(
        ({ function_name }) => function_name
      );
      expect(functionNames).toEqual(
        expect.arrayContaining([
          "protect_compiler_provenance",
          "protect_session_compiler_proposal",
          "restore_user_snapshot",
          "permanent_delete_archive_preview",
          "validate_pain_completed_set_context",
        ])
      );
    } finally {
      await Promise.all([fresh.close(), productionShaped.close()]);
    }
  }, 60_000);

  it("passes every repair preview and preserves representative production history", async () => {
    database = await createTestDatabaseAtMigration(PRODUCTION_MIGRATION);
    const userId = crypto.randomUUID();
    const importEventId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    const setId = crypto.randomUUID();
    const fileHash = crypto.randomUUID();
    const programId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const slotId = crypto.randomUUID();
    const prescriptionId = crypto.randomUUID();
    const recommendationId = crypto.randomUUID();
    const plateId = crypto.randomUUID();
    const barId = crypto.randomUUID();
    const barEquipmentItemId = crypto.randomUUID();
    const requirementId = crypto.randomUUID();

    // Production was originally established with a schema push, so its physical
    // schema is fully at 0018 while the historical journal has one fewer old row.
    // The migrator keys forward progress from the newest journal timestamp.
    await database.client.exec(`
      DELETE FROM drizzle.__drizzle_migrations
      WHERE created_at = (
        SELECT min(created_at) FROM drizzle.__drizzle_migrations
      )
    `);
    const beforeJournal = await database.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations"
    );
    expect(beforeJournal.rows[0]?.count).toBe(18);
    const productionSentinels = await database.client.query<{
      media: boolean;
      substitution_reason: boolean;
      substitution_time: boolean;
    }>(`SELECT
      to_regclass('public.exercise_media_assets') IS NOT NULL AS media,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'session_exercises'
          AND column_name = 'substitution_reason'
      ) AS substitution_reason,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'session_exercises'
          AND column_name = 'substituted_at'
      ) AS substitution_time
    `);
    expect(productionSentinels.rows[0]).toEqual({
      media: true,
      substitution_reason: true,
      substitution_time: true,
    });

    await database.client.exec(`
      INSERT INTO users (id, email, name)
      VALUES ('${userId}', 'production-upgrade@example.com', 'Production fixture');
      INSERT INTO user_profiles (user_id, unit)
      VALUES ('${userId}', 'lb');
      INSERT INTO import_events (
        id, user_id, source, raw_payload, status
      ) VALUES (
        '${importEventId}', '${userId}', 'csv', 'reviewed Hevy production fixture', 'confirmed'
      );
      INSERT INTO history_import_batches (
        id, user_id, import_event_id, source, original_filename,
        file_hash, timezone, status, summary
      ) VALUES (
        '${batchId}', '${userId}', '${importEventId}', 'hevy', 'workouts.csv',
        '${fileHash}', 'America/Toronto', 'confirmed',
        '{"workouts":1,"exerciseOccurrences":1,"sets":1,"warmupSets":0,"supersetGroups":0,"excludedExercises":0,"warnings":0}'
      );
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics, variant_attributes
      ) VALUES (
        '${exerciseId}', 'Production imported squat', 'squat', '["quadriceps"]',
        'barbell', 'weight_reps', 'total', '{}'
      );
      INSERT INTO workout_sessions (
        id, user_id, import_batch_id, template_name, status, source,
        source_workout_key, started_at, finished_at
      ) VALUES (
        '${sessionId}', '${userId}', '${batchId}', 'Production Hevy workout',
        'completed', 'hevy', 'production-workout-1',
        '2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z'
      );
      INSERT INTO session_exercises (
        id, session_id, exercise_id, source_exercise_key, source_exercise_name,
        order_idx, target_sets, target_reps_min, target_reps_max,
        target_load
      ) VALUES (
        '${sessionExerciseId}', '${sessionId}', '${exerciseId}',
        'production-squat', 'Squat', 0, 1, 5, 5, 32.3
      );
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps,
        source_set_index, source_row
      ) VALUES (
        '${setId}', '${sessionExerciseId}', 1, 225, 'lb', 5, 0, 2
      );
      INSERT INTO equipment_items (id, user_id, type, label)
      VALUES ('${barEquipmentItemId}', '${userId}', 'barbell', 'Production bar');
      INSERT INTO plate_inventory (id, user_id, denomination, count_per_side)
      VALUES ('${plateId}', '${userId}', 2.5, 4);
      INSERT INTO barbell_configs (
        id, user_id, bar_type, bar_weight, collar_weight, quantity, label
      ) VALUES (
        '${barId}', '${userId}', 'olympic', 10.075, 1.25, 1, 'Production bar'
      );
      INSERT INTO exercise_equipment_requirements (
        id, exercise_id, equipment_type, min_weight
      ) VALUES ('${requirementId}', '${exerciseId}', 'barbell', 32.3);
    `);

    await migrateTestDatabaseThrough(
      database,
      "0019_expand_load_units_calendar_identity"
    );
    await database.client.exec(`
      UPDATE session_exercises
      SET target_load_unit = 'kg'
      WHERE id = '${sessionExerciseId}'
    `);

    for (const boundary of previewBoundaries) {
      if (boundary.migration === "0044_versioned_program_editor_preview") {
        await migrateTestDatabaseThrough(database, "0042_eminent_king_cobra");
        await database.client.exec(`
          INSERT INTO programs (id, user_id, name, status)
          VALUES ('${programId}', '${userId}', 'Production Program', 'active');
          INSERT INTO program_versions (
            id, program_id, version_no, activated_at, change_summary
          ) VALUES (
            '${versionId}', '${programId}', 1, '2025-12-01T12:00:00.000Z', 'Production v1'
          );
          INSERT INTO workout_templates (id, program_version_id, name, order_idx)
          VALUES ('${templateId}', '${versionId}', 'Production Day', 0);
          INSERT INTO workout_template_exercises (
            id, workout_template_id, exercise_id, order_idx, rest_sec,
            warmup_sets, set_notes
          ) VALUES (
            '${slotId}', '${templateId}', '${exerciseId}', 0, 120, '[]', '[null,null,null]'
          );
          INSERT INTO exercise_prescriptions (
            id, template_exercise_id, sets, rep_range_min, rep_range_max,
            target_load, target_load_unit
          ) VALUES (
            '${prescriptionId}', '${slotId}', 3, 5, 8, 32.3, 'kg'
          );
          INSERT INTO recommendations (
            id, user_id, source, source_template_exercise_id, payload, reason, evidence
          ) VALUES (
            '${recommendationId}', '${userId}', 'rule', '${slotId}',
            '{"kind":"load_change","templateExerciseId":"${slotId}","fromLoad":225,"toLoad":230,"loadUnit":"lb"}',
            'Production progression suggestion', '{"signals":{}}'
          );
        `);
      }
      await migrateTestDatabaseThrough(database, boundary.migration);
      for (const view of boundary.views) {
        const previewRows = await database.client.query<Record<string, unknown>>(
          `SELECT * FROM ${view}`
        );
        expect(previewRows.rows.length, `${view} must be empty: ${JSON.stringify(previewRows.rows)}`).toBe(0);
      }
    }

    const loadRowCountsBefore = await database.client.query<{
      bars: number;
      plates: number;
      requirements: number;
      prescriptions: number;
      session_targets: number;
    }>(`SELECT
      (SELECT count(*)::int FROM barbell_configs) AS bars,
      (SELECT count(*)::int FROM plate_inventory) AS plates,
      (SELECT count(*)::int FROM exercise_equipment_requirements
       WHERE id = '${requirementId}') AS requirements,
      (SELECT count(*)::int FROM exercise_prescriptions) AS prescriptions,
      (SELECT count(*)::int FROM session_exercises) AS session_targets
    `);

    await migrateTestDatabaseThrough(database, LATEST_MIGRATION);

    const journal = JSON.parse(
      await readFile("./src/db/migrations/meta/_journal.json", "utf8")
    ) as { entries: Array<{ tag: string; when: number }> };
    const migrated = await database.client.query<{
      count: number;
      latest_created_at: string;
    }>(
      "SELECT count(*)::int AS count, max(created_at)::bigint::text AS latest_created_at FROM drizzle.__drizzle_migrations"
    );
    expect(migrated.rows[0]).toEqual({
      count: journal.entries.length - 1,
      latest_created_at: String(journal.entries.at(-1)?.when),
    });
    expect(journal.entries.at(-1)?.tag).toBe(LATEST_MIGRATION);
    expect(await database.db.query.sessionOccurrences.findMany({
      where: eq(sessionOccurrences.sessionId, sessionId),
    })).toEqual([
      expect.objectContaining({
        sessionExerciseId,
        kind: "working_set",
        origin: "imported",
        kindOrdinal: 0,
        outcome: "completed",
        completedSetId: setId,
      }),
    ]);
    expect(
      await database.client.query<{
        history_revision: number;
        performed_time_precision: string;
        source_program_id: string | null;
      }>(
        `SELECT history_revision, performed_time_precision, source_program_id
         FROM workout_sessions WHERE id = '${sessionId}'`
      )
    ).toMatchObject({
      rows: [{
        history_revision: 0,
        performed_time_precision: "instant",
        source_program_id: null,
      }],
    });
    expect(
      await database.client.query<{
        logged_at: string;
        observed_completed_at: string | null;
        observed_completion_provenance: string;
        observed_completion_quality: string;
      }>(
        `SELECT logged_at, observed_completed_at,
                observed_completion_provenance, observed_completion_quality
         FROM completed_sets WHERE id = '${setId}'`
      )
    ).toMatchObject({
      rows: [{
        logged_at: expect.anything(),
        observed_completed_at: null,
        observed_completion_provenance: "unknown",
        observed_completion_quality: "unknown",
      }],
    });

    for (const view of [
      "production_data_repair_preview",
      "program_editor_repair_preview",
    ]) {
      const previewRows = await database.client.query<Record<string, unknown>>(
        `SELECT * FROM ${view}`
      );
      expect(
        previewRows.rows,
        `${view} must remain usable and empty after the type change`
      ).toEqual([]);
    }

    const numericLoadColumns = await database.client.query<{
      table_name: string;
      column_name: string;
      numeric_precision: number;
      numeric_scale: number;
    }>(`SELECT table_name, column_name, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (table_name, column_name) IN (
          ('barbell_configs', 'bar_weight'),
          ('barbell_configs', 'collar_weight'),
          ('plate_inventory', 'denomination'),
          ('exercise_equipment_requirements', 'min_weight'),
          ('exercise_prescriptions', 'target_load'),
          ('session_exercises', 'target_load')
        )
      ORDER BY table_name, column_name
    `);
    expect(numericLoadColumns.rows).toHaveLength(6);
    expect(numericLoadColumns.rows).toEqual(
      numericLoadColumns.rows.map((column) => ({
        ...column,
        numeric_precision: 7,
        numeric_scale: 2,
      }))
    );

    const loadRowCountsAfter = await database.client.query(`SELECT
      (SELECT count(*)::int FROM barbell_configs) AS bars,
      (SELECT count(*)::int FROM plate_inventory) AS plates,
      (SELECT count(*)::int FROM exercise_equipment_requirements
       WHERE id = '${requirementId}') AS requirements,
      (SELECT count(*)::int FROM exercise_prescriptions) AS prescriptions,
      (SELECT count(*)::int FROM session_exercises) AS session_targets
    `);
    expect(loadRowCountsAfter.rows).toEqual(loadRowCountsBefore.rows);

    const preservedLoads = await database.client.query<{
      bar_weight: string;
      collar_weight: string;
      denomination: string;
      min_weight: string;
      prescription_target: string;
      session_target: string;
    }>(`SELECT
      bar.bar_weight::text,
      bar.collar_weight::text,
      plate.denomination::text,
      requirement.min_weight::text,
      prescription.target_load::text AS prescription_target,
      session_exercise.target_load::text AS session_target
    FROM barbell_configs bar
    CROSS JOIN plate_inventory plate
    CROSS JOIN exercise_equipment_requirements requirement
    CROSS JOIN exercise_prescriptions prescription
    CROSS JOIN session_exercises session_exercise
    WHERE bar.id = $1 AND plate.id = $2 AND requirement.id = $3
      AND prescription.id = $4 AND session_exercise.id = $5`,
      [barId, plateId, requirementId, prescriptionId, sessionExerciseId]
    );
    expect(preservedLoads.rows).toEqual([{
      bar_weight: "10.08",
      collar_weight: "1.25",
      denomination: "2.50",
      min_weight: "32.30",
      prescription_target: "32.30",
      session_target: "32.30",
    }]);

    const [barLoad, plateLoad, requirementLoad, prescriptionLoad, sessionLoad] =
      await Promise.all([
        database.db.query.barbellConfigs.findFirst({
          where: eq(barbellConfigs.id, barId),
        }),
        database.db.query.plateInventory.findFirst({
          where: eq(plateInventory.id, plateId),
        }),
        database.db.query.exerciseEquipmentRequirements.findFirst({
          where: eq(exerciseEquipmentRequirements.id, requirementId),
        }),
        database.db.query.exercisePrescriptions.findFirst({
          where: eq(exercisePrescriptions.id, prescriptionId),
        }),
        database.db.query.sessionExercises.findFirst({
          where: eq(sessionExercises.id, sessionExerciseId),
        }),
      ]);
    expect({
      barWeight: barLoad?.barWeight,
      collarWeight: barLoad?.collarWeight,
      denomination: plateLoad?.denomination,
      minWeight: requirementLoad?.minWeight,
      prescriptionTarget: prescriptionLoad?.targetLoad,
      sessionTarget: sessionLoad?.targetLoad,
    }).toEqual({
      barWeight: 10.08,
      collarWeight: 1.25,
      denomination: 2.5,
      minWeight: 32.3,
      prescriptionTarget: 32.3,
      sessionTarget: 32.3,
    });

    // Migration 0049 renamed plate_inventory.count_per_side to quantity and
    // doubled the stored pairs into a total plate count, so the production
    // seed's 4 pairs upgrades to 8 individual plates under the new column.
    expect(plateLoad?.quantity).toBe(8);
    const plateColumns = await database.client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'plate_inventory'`
    );
    const plateColumnNames = plateColumns.rows.map((row) => row.column_name);
    expect(plateColumnNames).toContain("quantity");
    expect(plateColumnNames).not.toContain("count_per_side");

    const newSafetyBoundaries = await database.client.query<{
      time_budget_constraint: boolean;
      time_budget_validated: boolean;
      expensive_operation_leases: boolean;
    }>(`SELECT
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workout_sessions_time_budget_check'
      ) AS time_budget_constraint,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workout_sessions_time_budget_check'
          AND convalidated
      ) AS time_budget_validated,
      to_regclass('public.expensive_operation_leases') IS NOT NULL
        AS expensive_operation_leases
    `);
    expect(newSafetyBoundaries.rows[0]).toEqual({
      time_budget_constraint: true,
      time_budget_validated: true,
      expensive_operation_leases: true,
    });

    const versionedProgram = await database.client.query<{
      current_version_id: string;
      recommendation_revision: number;
      version_name: string;
      publication_source: string;
      day_lineage_id: string;
      slot_lineage_id: string;
      recommendation_lineage_id: string;
    }>(`SELECT
      program.current_version_id::text,
      program.recommendation_revision,
      version.name AS version_name,
      version.publication_source,
      day.lineage_id::text AS day_lineage_id,
      slot.lineage_id::text AS slot_lineage_id,
      recommendation.source_slot_lineage_id::text AS recommendation_lineage_id
    FROM programs program
    JOIN program_versions version ON version.id = program.current_version_id
    JOIN workout_templates day ON day.program_version_id = version.id
    JOIN workout_template_exercises slot ON slot.workout_template_id = day.id
    JOIN recommendations recommendation ON recommendation.source_template_exercise_id = slot.id
    WHERE program.id = $1`, [programId]);
    expect(versionedProgram.rows).toEqual([{
      current_version_id: versionId,
      recommendation_revision: 0,
      version_name: "Production Program",
      publication_source: "setup",
      day_lineage_id: templateId,
      slot_lineage_id: slotId,
      recommendation_lineage_id: slotId,
    }]);

    const preserved = await database.client.query<{
      email: string;
      profile_timezone: string;
      import_status: string;
      import_batch_id: string;
      source_workout_key: string;
      timezone: string;
      local_date: string;
      weight: number;
      weight_unit: string;
      reps: number;
      source_set_index: number;
      source_row: number;
      day_warmup_notes: string | null;
      active_duration_semantics_version: number | null;
      active_duration_seconds: number | null;
      active_duration_basis: string | null;
    }>(
      `SELECT
         owner.email,
         profile.timezone AS profile_timezone,
         import.status AS import_status,
         session.import_batch_id::text,
         session.source_workout_key,
         session.timezone,
         session.local_date::text,
         completed_set.weight,
         completed_set.weight_unit,
         completed_set.reps,
         completed_set.source_set_index,
         completed_set.source_row,
         session.day_warmup_notes,
         session.active_duration_semantics_version,
         session.active_duration_seconds,
         session.active_duration_basis
       FROM users owner
       JOIN user_profiles profile ON profile.user_id = owner.id
       JOIN import_events import ON import.user_id = owner.id
       JOIN workout_sessions session ON session.user_id = owner.id
       JOIN session_exercises session_exercise ON session_exercise.session_id = session.id
       JOIN completed_sets completed_set ON completed_set.session_exercise_id = session_exercise.id
       WHERE owner.id = $1`,
      [userId]
    );
    expect(preserved.rows).toEqual([
      {
        email: "production-upgrade@example.com",
        profile_timezone: "America/Toronto",
        import_status: "confirmed",
        import_batch_id: batchId,
        source_workout_key: "production-workout-1",
        timezone: "America/Toronto",
        local_date: "2025-12-31",
        weight: 225,
        weight_unit: "lb",
        reps: 5,
        source_set_index: 0,
        source_row: 2,
        day_warmup_notes: null,
        active_duration_semantics_version: null,
        active_duration_seconds: null,
        active_duration_basis: null,
      },
    ]);

    expect(await evaluateApplicationIntegrity(database.db, userId)).toEqual([]);
    const backup = await buildJsonBackup(database.db, userId, undefined, {
      now: new Date("2026-07-13T20:00:00.000Z"),
      appVersion: "production-upgrade-rehearsal",
    });
    expect(backup).toMatchObject({
      format: "workout-tracker-canonical-backup",
      schemaVersion: "35",
      recordCounts: {
        users: 1,
        user_profiles: 1,
        import_events: 1,
        history_import_batches: 1,
        workout_sessions: 1,
        session_exercises: 1,
        completed_sets: 1,
      },
    });
    expect(backup.canonical.tables.completed_sets).toEqual([
      expect.objectContaining({ id: setId, weight: 225, weight_unit: "lb" }),
    ]);
  }, 60_000);

  it("refuses the contract when the repair preview contains ambiguous Program data", async () => {
    database = await createTestDatabaseAtMigration("0043_versioned_program_editor_expand");
    const userId = crypto.randomUUID();
    const programId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email, name)
      VALUES ('${userId}', 'program-contract-refusal@example.com', 'Contract refusal');
      INSERT INTO user_profiles (user_id, unit) VALUES ('${userId}', 'lb');
      INSERT INTO programs (id, user_id, name, status, current_version_id)
      VALUES ('${programId}', '${userId}', 'Ambiguous Program', 'active', NULL);
    `);
    await migrateTestDatabaseThrough(database, "0044_versioned_program_editor_preview");
    const preview = await database.client.query<{ issue: string }>(
      "SELECT issue FROM program_editor_repair_preview WHERE entity_id = $1 ORDER BY issue",
      [programId]
    );
    expect(preview.rows.map((row) => row.issue)).toEqual(
      expect.arrayContaining(["missing_current_version", "program_without_version"])
    );
    await expect(
      migrateTestDatabaseThrough(database, "0045_versioned_program_editor_contract")
    ).rejects.toThrow(/repair preview/i);
    const preserved = await database.client.query<{ name: string; current_version_id: string | null }>(
      "SELECT name, current_version_id::text FROM programs WHERE id = $1",
      [programId]
    );
    expect(preserved.rows).toEqual([{ name: "Ambiguous Program", current_version_id: null }]);
  }, 60_000);

  it("refuses out-of-range column and draft loads without changing existing data", async () => {
    database = await createTestDatabaseAtMigration(
      "0047_program_editor_metadata_contract"
    );
    const userId = crypto.randomUUID();
    const barId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email, name)
      VALUES ('${userId}', 'numeric-refusal@example.com', 'Numeric refusal');
      INSERT INTO user_profiles (user_id, unit, setup_state)
      VALUES (
        '${userId}', 'lb',
        '{"completedSteps":[],"routineDraft":{"days":[{"exercises":[{"targetLoad":100000,"targetLoadUnit":"lb"}]}]}}'
      );
      INSERT INTO barbell_configs (
        id, user_id, bar_type, bar_weight, collar_weight, quantity, label
      ) VALUES (
        '${barId}', '${userId}', 'olympic', 100000, 0, 1, 'Oversized bar'
      );
    `);

    await expect(
      migrateTestDatabaseThrough(database, LATEST_MIGRATION)
    ).rejects.toThrow();

    const preserved = await database.client.query<{
      bar_weight: number;
      data_type: string;
    }>(`SELECT bar.bar_weight, column_info.data_type
      FROM barbell_configs bar
      CROSS JOIN information_schema.columns column_info
      WHERE bar.id = $1
        AND column_info.table_schema = current_schema()
        AND column_info.table_name = 'barbell_configs'
        AND column_info.column_name = 'bar_weight'`, [barId]);
    expect(preserved.rows).toEqual([{ bar_weight: 100000, data_type: "real" }]);

    await database.client.query(
      "UPDATE barbell_configs SET bar_weight = 10 WHERE id = $1",
      [barId]
    );
    await expect(
      migrateTestDatabaseThrough(database, LATEST_MIGRATION)
    ).rejects.toThrow();
    const preservedDraft = await database.client.query<{
      target_load: string;
      data_type: string;
    }>(`SELECT
        (profile.setup_state #>> '{routineDraft,days,0,exercises,0,targetLoad}')::numeric AS target_load,
        column_info.data_type
      FROM user_profiles profile
      CROSS JOIN information_schema.columns column_info
      WHERE profile.user_id = $1
        AND column_info.table_schema = current_schema()
        AND column_info.table_name = 'barbell_configs'
        AND column_info.column_name = 'bar_weight'`, [userId]);
    expect(preservedDraft.rows).toEqual([
      { target_load: "100000", data_type: "real" },
    ]);
  }, 60_000);

  it("keeps old application writes compatible during the expand-to-bridge window", async () => {
    database = await createTestDatabaseAtMigration("0044_versioned_program_editor_preview");
    const userId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const programId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const slotId = crypto.randomUUID();
    const recommendationId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email, name)
      VALUES ('${userId}', 'program-bridge@example.com', 'Program bridge');
      INSERT INTO user_profiles (user_id, unit) VALUES ('${userId}', 'lb');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics, variant_attributes
      ) VALUES (
        '${exerciseId}', 'Bridge squat', 'squat', '["quadriceps"]', 'barbell',
        'weight_reps', 'total', '{}'
      );

      -- These statements deliberately use the pre-editor application shape:
      -- no current pointer, version metadata, or lineage columns are supplied.
      INSERT INTO programs (id, user_id, name, status)
      VALUES ('${programId}', '${userId}', 'Bridge Program', 'active');
      INSERT INTO program_versions (id, program_id, version_no, activated_at)
      VALUES ('${versionId}', '${programId}', 1, now());
      INSERT INTO workout_templates (id, program_version_id, name, order_idx)
      VALUES ('${templateId}', '${versionId}', 'Bridge Day', 0);
      INSERT INTO workout_template_exercises (
        id, workout_template_id, exercise_id, order_idx, rest_sec,
        warmup_sets, set_notes
      ) VALUES (
        '${slotId}', '${templateId}', '${exerciseId}', 0, 90, '[]', '[null,null,null]'
      );
      INSERT INTO exercise_prescriptions (
        template_exercise_id, sets, rep_range_min, rep_range_max,
        target_load, target_load_unit
      ) VALUES ('${slotId}', 3, 6, 8, 100, 'lb');
      INSERT INTO recommendations (
        id, user_id, source, source_template_exercise_id,
        payload, reason, evidence
      ) VALUES (
        '${recommendationId}', '${userId}', 'rule', '${slotId}',
        '{"kind":"load_change","templateExerciseId":"${slotId}","fromLoad":100,"toLoad":105,"loadUnit":"lb"}',
        'Bridge recommendation', '{"signals":{}}'
      );
    `);

    const bridged = await database.client.query<{
      current_version_id: string;
      version_name: string;
      publication_source: string;
      day_lineage: string;
      slot_lineage: string;
      recommendation_lineage: string;
    }>(`
      SELECT
        program.current_version_id::text,
        version.name AS version_name,
        version.publication_source,
        day.lineage_id::text AS day_lineage,
        slot.lineage_id::text AS slot_lineage,
        recommendation.source_slot_lineage_id::text AS recommendation_lineage
      FROM programs program
      JOIN program_versions version ON version.id = '${versionId}'
      JOIN workout_templates day ON day.id = '${templateId}'
      JOIN workout_template_exercises slot ON slot.id = '${slotId}'
      JOIN recommendations recommendation ON recommendation.id = '${recommendationId}'
      WHERE program.id = '${programId}'
    `);
    expect(bridged.rows).toEqual([expect.objectContaining({
      current_version_id: versionId,
      version_name: "Bridge Program",
      publication_source: "setup",
    })]);
    expect(bridged.rows[0]?.day_lineage).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridged.rows[0]?.recommendation_lineage).toBe(
      bridged.rows[0]?.slot_lineage
    );
    expect((await database.client.query(
      "SELECT * FROM program_editor_repair_preview"
    )).rows).toEqual([]);

    await migrateTestDatabaseThrough(database, LATEST_MIGRATION);
    expect((await database.client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname LIKE 'bridge_%' AND NOT tgisinternal
    `)).rows).toEqual([{ count: 0 }]);
  });
});
