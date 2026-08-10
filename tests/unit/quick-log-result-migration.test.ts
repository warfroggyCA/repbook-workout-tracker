import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  aiParsingEvents,
  auditLogs,
  workoutSessions,
} from "@/db/schema";
import {
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

const PREVIOUS = "0031_contract_recommendation_decisions";
const RESULT_IDENTITY = "0032_quick_log_result_identity";

describe("quick-log result identity migration", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => database?.close());

  it("backfills one proven result and exposes ambiguous history without guessing", async () => {
    database = await createTestDatabaseAtMigration(PREVIOUS);
    const user = { id: crypto.randomUUID() };
    await database.client.query(
      "INSERT INTO users (id, email) VALUES ($1, $2)",
      [user.id, `quick-log-migration-${crypto.randomUUID()}@example.com`],
    );
    const sessions = await Promise.all(["2026-07-10", "2026-07-11", "2026-07-12"].map(async (localDate) => {
      const id = crypto.randomUUID();
      await database!.client.query(
        `INSERT INTO workout_sessions (id, user_id, template_name, status, started_at, finished_at, timezone, local_date) VALUES ($1, $2, 'Historical quick log', 'completed', $3, $4, 'UTC', $5)`,
        [id, user.id, `${localDate}T12:00:00.000Z`, `${localDate}T12:10:00.000Z`, localDate],
      );
      return { id };
    }));
    const events = [{ id: crypto.randomUUID() }, { id: crypto.randomUUID() }];
    await database.db.execute(sql`
      INSERT INTO ai_parsing_events (
        id, user_id, scope, task, raw_input, confirmed, confirmed_payload
      ) VALUES
        (${events[0].id}::uuid, ${user.id}::uuid, 'log', 'log_parse',
          'one result', true, '{}'::jsonb),
        (${events[1].id}::uuid, ${user.id}::uuid, 'log', 'log_parse',
          'ambiguous result', true, '{}'::jsonb)
    `);
    await database.db.insert(auditLogs).values([
      {
        userId: user.id,
        actorType: "user",
        action: "quicklog.apply",
        entityType: "workout_session",
        entityId: sessions[0].id,
        summary: "Historical quick log",
        causeRef: { parsingEventId: events[0].id },
      },
      ...sessions.slice(1).map((session) => ({
        userId: user.id,
        actorType: "user" as const,
        action: "quicklog.apply",
        entityType: "workout_session",
        entityId: session.id,
        summary: "Racing historical quick log",
        causeRef: { parsingEventId: events[1].id },
      })),
    ]);

    await migrateTestDatabaseThrough(database, RESULT_IDENTITY);

    const migratedEvents = await database.db
      .select({
        id: aiParsingEvents.id,
        confirmed: aiParsingEvents.confirmed,
        resultSessionId: aiParsingEvents.resultSessionId,
      })
      .from(aiParsingEvents);
    expect(migratedEvents.find(({ id }) => id === events[0].id)).toMatchObject({
      resultSessionId: sessions[0].id,
    });
    expect(migratedEvents.find(({ id }) => id === events[1].id)).toMatchObject({
      resultSessionId: null,
    });
    const preview = await database.client.query<{
      parsing_event_id: string;
      issue: string;
      candidate_count: number;
    }>(`SELECT parsing_event_id, issue, candidate_count FROM quick_log_result_repair_preview`);
    expect(preview.rows).toEqual([
      {
        parsing_event_id: events[1].id,
        issue: "multiple_result_candidates",
        candidate_count: 2,
      },
    ]);

    await expect(
      database.db
        .update(aiParsingEvents)
        .set({ resultSessionId: crypto.randomUUID() })
        .where(eq(aiParsingEvents.id, events[1].id))
    ).rejects.toThrow();

    await database.client.query(
      `SELECT set_config('workout_tracker.authorized_delete', 'permanent', false)`
    );
    try {
      await database.db
        .delete(workoutSessions)
        .where(eq(workoutSessions.id, sessions[0].id));
    } finally {
      await database.client.query(
        `SELECT set_config('workout_tracker.authorized_delete', '', false)`
      );
    }
    expect(
      await database.db
        .select({
          confirmed: aiParsingEvents.confirmed,
          resultSessionId: aiParsingEvents.resultSessionId,
        })
        .from(aiParsingEvents)
        .where(eq(aiParsingEvents.id, events[0].id))
        .then((result) => result[0])
    ).toMatchObject({ confirmed: true, resultSessionId: null });
  }, 30_000);

  it("migrates a clean current-schema database through the new contract", async () => {
    database = await createTestDatabaseAtMigration(PREVIOUS);
    await migrateTestDatabaseThrough(database, RESULT_IDENTITY);
    const applied = await database.client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
    );
    expect(applied.rows[0]?.count).toBe(33);
  }, 30_000);
});
