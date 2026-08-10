import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  adaptationEvents,
  exercisePrescriptions,
  exercises,
  recommendations,
  userDecisions,
} from "@/db/schema";
import {
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

const PREVIEW = "0030_recommendation_decision_repair_preview";
const CONTRACT = "0031_contract_recommendation_decisions";

describe("recommendation and quick-log contract migration safety", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => database?.close());

  it("previews ambiguous conflicts, preserves them on refusal, and accepts an explicit repair", async () => {
    database = await createTestDatabaseAtMigration(
      "0029_contract_progression_job_state"
    );
    const user = { id: crypto.randomUUID() };
    await database.client.query(
      "INSERT INTO users (id, email) VALUES ($1, $2)",
      [user.id, `decision-migration-${crypto.randomUUID()}@example.com`],
    );
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: `Decision migration exercise ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: {},
      })
      .returning({ id: exercises.id });
    const program = { id: crypto.randomUUID() };
    const version = { id: crypto.randomUUID() };
    const template = { id: crypto.randomUUID() };
    const slot = { id: crypto.randomUUID() };
    await database.client.query(
      `INSERT INTO programs (id, user_id, name, status)
       VALUES ($1, $2, 'Decision migration program', 'active')`,
      [program.id, user.id]
    );
    await database.client.query(
      `INSERT INTO program_versions (id, program_id, version_no, activated_at)
       VALUES ($1, $2, 1, now())`,
      [version.id, program.id]
    );
    await database.client.query(
      `INSERT INTO workout_templates (id, program_version_id, name, order_idx)
       VALUES ($1, $2, 'Decision migration day', 0)`,
      [template.id, version.id]
    );
    await database.client.query(
      `INSERT INTO workout_template_exercises (
         id, workout_template_id, exercise_id, order_idx, rest_sec,
         warmup_sets, set_notes
       ) VALUES ($1, $2, $3, 0, 90, '[]'::jsonb, '[]'::jsonb)`,
      [slot.id, template.id, exercise.id]
    );
    const prescriptionRows = await database.db
      .insert(exercisePrescriptions)
      .values([
        {
          templateExerciseId: slot.id,
          sets: 3,
          repRangeMin: 6,
          repRangeMax: 8,
          targetLoad: 100,
          targetLoadUnit: "lb",
        },
        {
          templateExerciseId: slot.id,
          sets: 3,
          repRangeMin: 6,
          repRangeMax: 8,
          targetLoad: 105,
          targetLoadUnit: "lb",
        },
      ])
      .returning({ id: exercisePrescriptions.id });
    const recommendation = { id: crypto.randomUUID() };
    await database.client.query(
      `INSERT INTO recommendations (
         id, user_id, status, source, source_template_exercise_id,
         payload, reason, evidence
       ) VALUES ($1, $2, 'pending', 'rule', $3, $4::jsonb,
         'Migration fixture', '{"signals":{}}'::jsonb)`,
      [
        recommendation.id,
        user.id,
        slot.id,
        JSON.stringify({
          kind: "load_change",
          templateExerciseId: slot.id,
          fromLoad: 100,
          toLoad: 105,
          loadUnit: "lb",
        }),
      ]
    );
    const decisions = (await database.client.query<{ id: string }>(
      `INSERT INTO user_decisions (recommendation_id, decision)
       VALUES ($1, 'approve'), ($1, 'reject')
       RETURNING id`,
      [recommendation.id],
    )).rows;
    const adaptations = await database.db
      .insert(adaptationEvents)
      .values([
        {
          userId: user.id,
          recommendationId: recommendation.id,
          beforeSnapshot: {},
          afterSnapshot: {},
        },
        {
          userId: user.id,
          recommendationId: recommendation.id,
          beforeSnapshot: {},
          afterSnapshot: {},
        },
      ])
      .returning({ id: adaptationEvents.id });
    const startedAt = new Date("2026-07-13T12:00:00.000Z");
    const session = { id: crypto.randomUUID() };
    await database.client.query(
      `INSERT INTO workout_sessions (id, user_id, template_name, status, source, started_at, finished_at, timezone, local_date) VALUES ($1, $2, 'Order conflict', 'completed', 'tracker', $3, $3, 'UTC', '2026-07-13')`,
      [session.id, user.id, startedAt.toISOString()],
    );
    const orderedExercises = await database.client.query<{ id: string }>(
      `INSERT INTO session_exercises (session_id, exercise_id, order_idx)
       VALUES ($1, $2, 0), ($1, $2, 0)
       RETURNING id`,
      [session.id, exercise.id],
    );

    await migrateTestDatabaseThrough(database, PREVIEW);
    const preview = await database.client.query<{ issue: string }>(
      `SELECT issue FROM recommendation_decision_repair_preview ORDER BY issue`
    );
    expect(preview.rows.map(({ issue }) => issue)).toEqual([
      "program.multiple_active_prescriptions",
      "quick_log.duplicate_session_order",
      "recommendation.adaptation_state_mismatch",
      "recommendation.multiple_adaptations",
      "recommendation.multiple_decisions",
      "recommendation.status_decision_mismatch",
    ]);

    await expect(
      migrateTestDatabaseThrough(database, CONTRACT)
    ).rejects.toThrow(/Failed query/);
    expect(await database.db.select().from(exercisePrescriptions)).toHaveLength(2);
    expect((await database.client.query(`SELECT id FROM user_decisions`)).rows)
      .toHaveLength(2);
    expect(await database.db.select().from(adaptationEvents)).toHaveLength(2);
    expect((await database.client.query(`SELECT id FROM session_exercises`)).rows).toHaveLength(2);

    // This fixture's explicit review selects one truthful current/decision row
    // and assigns a distinct performed order before the contract is retried.
    await database.db
      .update(exercisePrescriptions)
      .set({ supersededById: prescriptionRows[1].id })
      .where(eq(exercisePrescriptions.id, prescriptionRows[0].id));
    await database.db
      .delete(userDecisions)
      .where(eq(userDecisions.id, decisions[1].id));
    await database.db
      .delete(adaptationEvents)
      .where(eq(adaptationEvents.id, adaptations[1].id));
    await database.db
      .update(recommendations)
      .set({ status: "approved", decidedAt: new Date() })
      .where(eq(recommendations.id, recommendation.id));
    await database.client.query(
      `UPDATE session_exercises SET order_idx = 1 WHERE id = $1`,
      [orderedExercises.rows[1].id],
    );

    expect(
      (
        await database.client.query(
          `SELECT * FROM recommendation_decision_repair_preview`
        )
      ).rows
    ).toHaveLength(0);
    await migrateTestDatabaseThrough(database, CONTRACT);

    await expect(database.client.query(
      `INSERT INTO user_decisions (recommendation_id, decision)
       VALUES ($1, 'reject')`,
      [recommendation.id],
    )).rejects.toThrow();
    await expect(
      database.db.insert(adaptationEvents).values({
        userId: user.id,
        recommendationId: recommendation.id,
        beforeSnapshot: {},
        afterSnapshot: {},
      })
    ).rejects.toThrow();
    await expect(
      database.db.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 3,
        repRangeMin: 6,
        repRangeMax: 8,
        targetLoad: 110,
        targetLoadUnit: "lb",
      })
    ).rejects.toThrow();
    await expect(
      database.client.query(
        `INSERT INTO session_exercises (session_id, exercise_id, order_idx)
         VALUES ($1, $2, 1)`,
        [session.id, exercise.id],
      )
    ).rejects.toThrow();
  }, 30_000);

  it("applies the preview and contract cleanly when no ambiguous data exists", async () => {
    database = await createTestDatabaseAtMigration(
      "0029_contract_progression_job_state"
    );
    await migrateTestDatabaseThrough(database, CONTRACT);
    const applied = await database.client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
    );
    expect(applied.rows[0]?.count).toBe(32);
  }, 30_000);
});
