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
        activeDurationSemanticsVersion: 1,
        activeDurationSeconds: 3_600,
        activeDurationBasis: "wall_clock_no_stale_signal",
      },
      {
        userId,
        templateName: "Legacy short workout",
        status: "completed",
        timezone: "America/Toronto",
        localDate: "2026-07-20",
        startedAt: new Date("2026-07-20T18:00:00.000Z"),
        finishedAt: new Date("2026-07-20T18:45:00.000Z"),
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
      {
        userId,
        templateName: "Date-only reviewed active time",
        status: "completed",
        timezone: "America/Toronto",
        localDate: "2026-07-22",
        startedAt: new Date("2026-07-22T16:00:00.000Z"),
        finishedAt: null,
        performedTimePrecision: "date_only",
        activeDurationSemanticsVersion: 1,
        activeDurationSeconds: 2_700,
        activeDurationBasis: "owner_reported",
        excludeDurationFromAnalytics: false,
        dataQualityFlags: ["unknown_time"],
      },
      {
        userId,
        templateName: "Date-only unknown active time",
        status: "completed",
        timezone: "America/Toronto",
        localDate: "2026-07-23",
        startedAt: new Date("2026-07-23T16:00:00.000Z"),
        finishedAt: null,
        performedTimePrecision: "date_only",
        activeDurationSemanticsVersion: 1,
        activeDurationSeconds: null,
        activeDurationBasis: "interruption_unknown",
        excludeDurationFromAnalytics: true,
        dataQualityFlags: ["unknown_time", "workout_active_duration_unknown"],
      },
      {
        userId,
        templateName: "Date-only legacy active time",
        status: "completed",
        timezone: "America/Toronto",
        localDate: "2026-07-24",
        startedAt: new Date("2026-07-24T16:00:00.000Z"),
        finishedAt: null,
        performedTimePrecision: "date_only",
        excludeDurationFromAnalytics: true,
        dataQualityFlags: ["unknown_time"],
      },
    ]);
  });

  afterEach(async () => {
    await database.client.close();
  });

  it("keeps every legacy active duration unavailable across reports and Coach evidence", async () => {
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
      completedSessions: 6,
      averageDurationMin: 53,
      excludedDurationSessions: 4,
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
      calendar.find((session) => session.name === "Legacy short workout"),
    ).toMatchObject({
      durationMin: null,
      durationExcluded: true,
    });
    expect(
      digest.sessions.find((session) => session.template === "Workout left open")
        ?.durationMin,
    ).toBeNull();
    expect(
      digest.sessions.find((session) => session.template === "Legacy short workout")
        ?.durationMin,
    ).toBeNull();
    expect(
      report.recentSessions.find(
        (session) => session.name === "Date-only reviewed active time",
      ),
    ).toMatchObject({ durationMin: 45, durationExcluded: false });
    expect(
      calendar.find(
        (session) => session.name === "Date-only reviewed active time",
      ),
    ).toMatchObject({ durationMin: 45, durationExcluded: false });
    expect(
      digest.sessions.find(
        (session) => session.template === "Date-only reviewed active time",
      )?.durationMin,
    ).toBe(45);
    for (const name of [
      "Date-only unknown active time",
      "Date-only legacy active time",
    ]) {
      expect(report.recentSessions.find((session) => session.name === name))
        .toMatchObject({ durationMin: null, durationExcluded: true });
      expect(calendar.find((session) => session.name === name))
        .toMatchObject({ durationMin: null, durationExcluded: true });
      expect(digest.sessions.find((session) => session.template === name)?.durationMin)
        .toBeNull();
    }
  });
});
