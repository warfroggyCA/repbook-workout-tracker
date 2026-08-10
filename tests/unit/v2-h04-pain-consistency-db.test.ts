import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import {
  adaptationEvents,
  exercises,
  painLogs,
  recommendations,
  userDecisions,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { buildPainFatigueCsv } from "@/services/export";
import { getHistoryReport } from "@/services/history-report";
import { loadExercisePainHold } from "@/services/pain-hold";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("Repbook v2 H04 pain consistency database contract", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("keeps no-issue distinct while positive evidence stays proposal-only", async () => {
    const now = new Date();
    const [user] = await database.db
      .insert(users)
      .values({ email: `v2-h04-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId: user.id,
      timezone: "UTC",
      unit: "lb",
    });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: "H04 exact press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "bodyweight",
      })
      .returning({ id: exercises.id });
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId: user.id,
        templateName: "H04 evidence workout",
        status: "completed",
        startedAt: new Date(now.getTime() - 30 * 60_000),
        finishedAt: now,
        timezone: "UTC",
        localDate: now.toISOString().slice(0, 10),
      })
      .returning({ id: workoutSessions.id });
    const [noIssue, positive] = await database.db
      .insert(painLogs)
      .values([
        {
          userId: user.id,
          sessionId: session.id,
          exerciseId: exercise.id,
          bodyPart: "shoulder",
          severity: 0,
          source: "set_flag",
          createdAt: new Date(now.getTime() - 2_000),
        },
        {
          userId: user.id,
          sessionId: session.id,
          exerciseId: exercise.id,
          bodyPart: "shoulder",
          severity: 4,
          source: "checkin",
          createdAt: new Date(now.getTime() - 1_000),
        },
      ])
      .returning({ id: painLogs.id });

    const report = await getHistoryReport(
      database.db,
      user.id,
      "4w",
      3,
      now,
    );
    expect(report.recovery).toMatchObject({ painEvents: 1, highPainEvents: 1 });
    expect(report.calendarSessions[0]).toMatchObject({ painEvents: 1 });

    await expect(loadExercisePainHold(database.db, {
      userId: user.id,
      exerciseId: exercise.id,
      now: new Date(now.getTime() + 1_000),
    })).resolves.toMatchObject({
      state: "hold",
      evidenceIds: [positive.id],
    });

    const rows = parse(await buildPainFatigueCsv(database.db, user.id, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    expect(rows.find((row) => row.completed_set_id === "" && row.severity === "0"))
      .toMatchObject({
        pain_meaning: "explicit_no_issue",
        pain_algorithm_version: "pain-evidence-v1",
        performed_exercise_id: exercise.id,
      });
    expect(rows.find((row) => row.severity === "4")).toMatchObject({
      pain_meaning: "pain",
      pain_algorithm_version: "pain-evidence-v1",
      performed_exercise_id: exercise.id,
    });

    expect(noIssue.id).not.toBe(positive.id);
    expect(await database.db.select().from(recommendations)).toHaveLength(0);
    expect(await database.db.select().from(userDecisions)).toHaveLength(0);
    expect(await database.db.select().from(adaptationEvents)).toHaveLength(0);
  });
});
