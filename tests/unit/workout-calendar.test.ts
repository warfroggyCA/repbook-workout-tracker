import { describe, expect, it } from "vitest";
import {
  localDateDifference,
  localWeekStart,
  workoutLocalDate,
} from "@/lib/workout-calendar";
import { buildHistoryCalendarSessions } from "@/services/history-report";

function calendarWorkout(
  id: string,
  startedAt: string,
  timezone: string,
  localDate: string
) {
  return {
    id,
    templateName: id,
    status: "completed" as const,
    startedAt: new Date(startedAt),
    timezone,
    localDate,
    finishedAt: null,
    exercises: [],
    painLogs: [],
  };
}

describe("recorded workout calendar identity", () => {
  it("starts every local week on Monday", () => {
    expect(localWeekStart("2026-07-13")).toBe("2026-07-13");
    expect(localWeekStart("2026-07-19")).toBe("2026-07-13");
  });
  it("keeps a Toronto late-night workout on its recorded local day and week", () => {
    const instant = "2026-01-01T01:00:00.000Z";
    expect(workoutLocalDate(new Date(instant), "America/Toronto")).toBe(
      "2025-12-31"
    );
    const [record] = buildHistoryCalendarSessions([
      calendarWorkout(
        "late Toronto workout",
        instant,
        "America/Toronto",
        "2025-12-31"
      ),
    ]);
    expect(record.calendarDateKey).toBe("2025-12-31");
    expect(localWeekStart(record.calendarDateKey)).toBe("2025-12-29");
  });

  it("keeps travel workouts in the timezone recorded with each workout", () => {
    const instant = new Date("2026-07-01T02:30:00.000Z");
    expect(workoutLocalDate(instant, "America/Vancouver")).toBe("2026-06-30");
    expect(workoutLocalDate(instant, "Asia/Tokyo")).toBe("2026-07-01");
  });

  it("counts spring-forward dates as adjacent calendar days despite a 23-hour gap", () => {
    const before = new Date("2026-03-08T05:30:00.000Z");
    const after = new Date("2026-03-09T04:30:00.000Z");
    expect(after.getTime() - before.getTime()).toBe(23 * 60 * 60 * 1000);
    const beforeDate = workoutLocalDate(before, "America/Toronto");
    const afterDate = workoutLocalDate(after, "America/Toronto");
    expect([beforeDate, afterDate]).toEqual(["2026-03-08", "2026-03-09"]);
    expect(localDateDifference(afterDate, beforeDate)).toBe(1);
  });

  it("counts fall-back dates as adjacent calendar days despite a 25-hour gap", () => {
    const before = new Date("2026-11-01T04:30:00.000Z");
    const after = new Date("2026-11-02T05:30:00.000Z");
    expect(after.getTime() - before.getTime()).toBe(25 * 60 * 60 * 1000);
    const beforeDate = workoutLocalDate(before, "America/Toronto");
    const afterDate = workoutLocalDate(after, "America/Toronto");
    expect([beforeDate, afterDate]).toEqual(["2026-11-01", "2026-11-02"]);
    expect(localDateDifference(afterDate, beforeDate)).toBe(1);
  });
});
