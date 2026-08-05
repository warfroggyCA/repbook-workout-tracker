import { describe, expect, it } from "vitest";
import {
  buildHistoryHref,
  buildRetrospectiveWorkoutHref,
  buildWorkoutHistoryHref,
  firstSearchParam,
  parseHistoryCalendarDate,
  parseHistoryCalendarView,
  parseHistoryInsightLens,
  parseHistoryView,
  parseHistoryExerciseEvidenceTier,
  parseHistoryExerciseId,
  historyCalendarWindow,
} from "@/lib/history-navigation";

describe("history navigation", () => {
  it("bounds each calendar view to the dates it renders", () => {
    expect(historyCalendarWindow("week", "2026-07-13")).toEqual({
      start: "2026-07-13",
      end: "2026-07-19",
    });
    expect(historyCalendarWindow("month", "2026-07-13")).toEqual({
      start: "2026-06-29",
      end: "2026-08-09",
    });
    expect(historyCalendarWindow("year", "2026-07-13")).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
  });
  it("accepts only supported calendar views", () => {
    expect(parseHistoryCalendarView("week")).toBe("week");
    expect(parseHistoryCalendarView(["year", "month"])).toBe("year");
    expect(parseHistoryCalendarView("agenda")).toBe("month");
    expect(parseHistoryCalendarView(undefined)).toBe("month");
  });

  it("defaults invalid workspace views and insight lenses safely", () => {
    expect(parseHistoryView("insights")).toBe("insights");
    expect(parseHistoryView(["exercises", "calendar"])).toBe("exercises");
    expect(parseHistoryView("report")).toBe("calendar");
    expect(parseHistoryInsightLens("pain-constraints")).toBe(
      "pain-constraints",
    );
    expect(parseHistoryInsightLens("recovery")).toBe("overview");
  });

  it("parses only supported evidence filters and exact UUID identities", () => {
    expect(parseHistoryExerciseEvidenceTier("corrected")).toBe("corrected");
    expect(parseHistoryExerciseEvidenceTier("derived")).toBe("all");
    expect(parseHistoryExerciseId("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(parseHistoryExerciseId("Bench Press")).toBeNull();
  });

  it("accepts real date keys and rejects malformed or impossible dates", () => {
    expect(parseHistoryCalendarDate("2024-02-29")).toBe("2024-02-29");
    expect(parseHistoryCalendarDate("2026-02-29")).toBeNull();
    expect(parseHistoryCalendarDate("2026-13-01")).toBeNull();
    expect(parseHistoryCalendarDate("July 10, 2026")).toBeNull();
  });

  it("uses the first value when a query parameter is repeated", () => {
    expect(firstSearchParam(["4w", "all"])).toBe("4w");
    expect(firstSearchParam("12w")).toBe("12w");
  });

  it("builds a calendar return address with the full report context", () => {
    expect(
      buildHistoryHref(
        {
          range: "all",
          calendarView: "year",
          calendarDate: "2025-11-18",
        },
        { focusCalendar: true },
      ),
    ).toBe(
      "/history?range=all&calendarView=year&calendarDate=2025-11-18#history-calendar",
    );
  });

  it("carries the same context into a workout detail address", () => {
    expect(
      buildWorkoutHistoryHref("workout id", {
        range: "6m",
        calendarView: "week",
        calendarDate: "2026-07-10",
      }),
    ).toBe(
      "/history/workout%20id?range=6m&calendarView=week&calendarDate=2026-07-10",
    );
  });

  it("canonicalizes workspace links without leaking irrelevant lens state", () => {
    expect(
      buildHistoryHref({
        range: "12w",
        view: "insights",
        lens: "progress",
        calendarView: "month",
        calendarDate: "2026-07-10",
      }),
    ).toBe(
      "/history?range=12w&view=insights&lens=progress&calendarView=month&calendarDate=2026-07-10",
    );
    expect(
      buildWorkoutHistoryHref("workout-id", {
        range: "all",
        view: "exercises",
        exerciseId: "11111111-1111-4111-8111-111111111111",
        evidenceTier: "imported",
      }),
    ).toBe(
      "/history/workout-id?range=all&view=exercises&exerciseId=11111111-1111-4111-8111-111111111111&evidenceTier=imported",
    );
    expect(
      buildHistoryHref({
        range: "12w",
        view: "exercises",
        lens: "records",
        calendarView: "month",
        calendarDate: "2026-07-10",
      }),
    ).toBe(
      "/history?range=12w&view=exercises&calendarView=month&calendarDate=2026-07-10",
    );
    expect(
      buildHistoryHref({
        range: "12w",
        view: "calendar",
        lens: "records",
      }),
    ).toBe("/history?range=12w");
  });

  it("carries a selected past date into the retrospective workout route", () => {
    expect(
      buildRetrospectiveWorkoutHref("2026-07-08", {
        range: "all",
        calendarView: "month",
        calendarDate: "2026-07-08",
      }),
    ).toBe(
      "/history/record?range=all&calendarView=month&calendarDate=2026-07-08&date=2026-07-08",
    );
  });
});
