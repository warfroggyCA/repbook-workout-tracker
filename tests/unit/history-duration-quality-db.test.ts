import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userProfiles, users, workoutSessions } from "@/db/schema";
import { buildTrainingDigest } from "@/services/digest";
import {
  getHistoryCalendarRecords,
  getHistoryReport,
} from "@/services/history-report";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("workout duration quality database boundary", () => {
  let database: TestDatabase;
  let userId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `duration-quality-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId,
      timezone: "America/Toronto",
    });
    await database.db.insert(workoutSessions).values([
      {
        userId,
        templateName: "Normal workout",
        status: "completed",
        timezone: "America/Toronto",
        localDate: "2026-07-20",
        startedAt: new Date("2026-07-20T16:00:00.000Z"),
        finishedAt: new Date("2026-07-20T17:00:00.000Z"),
      },
      {
        userId,
        templateName: "Workout left open",
        status: "completed",
        timezone: "America/Toronto",
        localDate: "2026-07-21",
        startedAt: new Date("2026-07-21T16:00:00.000Z"),
        finishedAt: new Date("2026-07-23T19:46:00.000Z"),
      },
    ]);
  });

  afterEach(async () => {
    await database.client.close();
  });

  it("excludes old unflagged outliers from reports, calendar metrics, and Coach evidence", async () => {
    const [report, calendar, digest] = await Promise.all([
      getHistoryReport(
        database.db,
        userId,
        "all",
        3,
        new Date("2026-07-25T12:00:00.000Z"),
      ),
      getHistoryCalendarRecords(database.db, userId, "lb", {
        view: "month",
        date: "2026-07-21",
      }),
      buildTrainingDigest(
        database.db,
        userId,
        new Date("2026-07-01T00:00:00.000Z"),
        new Date("2026-07-25T12:00:00.000Z"),
      ),
    ]);

    expect(report.overview).toMatchObject({
      completedSessions: 2,
      averageDurationMin: 60,
      excludedDurationSessions: 1,
    });
    expect(
      report.recentSessions.find((session) => session.name === "Workout left open"),
    ).toMatchObject({
      durationMin: null,
      durationExcluded: true,
    });
    expect(
      calendar.find((session) => session.name === "Workout left open"),
    ).toMatchObject({
      durationMin: null,
      durationExcluded: true,
    });
    expect(
      digest.sessions.find((session) => session.template === "Workout left open")
        ?.durationMin,
    ).toBeNull();
  });
});
