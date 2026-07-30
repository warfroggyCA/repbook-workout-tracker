import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  HistoryCalendar,
  HistoryDayRecordList,
} from "@/components/history/history-calendar";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

type CalendarRecord = Parameters<typeof HistoryCalendar>[0]["records"][number];

function calendarSession(
  id: string,
  name: string,
  startedAtISO = "2026-07-08T21:15:00.000Z",
  calendarDateKey = startedAtISO.slice(0, 10)
): Extract<CalendarRecord, { recordType: "workout" }> {
  return {
    recordType: "workout",
    id,
    name,
    status: "completed",
    source: "tracker",
    performedTimePrecision: "instant",
    startedAtISO,
    timezone: "America/Toronto",
    calendarDateKey,
    durationMin: 45,
    durationExcluded: false,
    sets: 12,
    volume: 5000,
    targetHitRate: 90,
    skipped: 0,
    painEvents: 0,
  };
}

function activityRecord(
  id: string,
  name: string,
  startedAtISO = "2026-07-08T22:15:00.000Z"
): Extract<CalendarRecord, { recordType: "activity" }> {
  return {
    recordType: "activity",
    id,
    name,
    activityType: "walk",
    startedAtISO,
    timezone: "America/Toronto",
    calendarDateKey: "2026-07-08",
    durationMin: 42,
    distanceKm: 3.5,
    averagePaceSecondsPerKm: 720,
    intensity: "moderate",
    elevationGainM: null,
    averageHeartRateBpm: 116,
    energyKcal: null,
    source: "manual",
  };
}

function renderCalendar(
  records: CalendarRecord[],
  initialDate = "2026-07-08",
  initialView: "month" | "week" | "year" = "month"
) {
  return renderToStaticMarkup(
    <HistoryCalendar
      records={records}
      unit="lb"
      range="all"
      initialView={initialView}
      initialDate={initialDate}
      ownerToday="2026-07-10"
    />
  );
}

describe("HistoryCalendar date actions", () => {
  it("places a workout on its recorded local date instead of its UTC date", () => {
    const html = renderCalendar(
      [
        calendarSession(
          "late-workout",
          "Late workout",
          "2026-01-01T01:00:00.000Z",
          "2025-12-31"
        ),
      ],
      "2025-12-31"
    );

    expect(html).toContain(
      'href="/history/late-workout?range=all&amp;calendarView=month&amp;calendarDate=2025-12-31"'
    );
    expect(html).not.toContain(
      'href="/history/late-workout?range=all&amp;calendarView=month&amp;calendarDate=2026-01-01"'
    );
  });

  it("renders a single-workout date as a direct detail link", () => {
    const html = renderCalendar([calendarSession("workout-one", "Day One")]);

    expect(html).toContain(
      'href="/history/workout-one?range=all&amp;calendarView=month&amp;calendarDate=2026-07-08"'
    );
    expect(html).toContain(": Open Day One");
  });

  it("renders a multiple-workout date as a chooser button", () => {
    const html = renderCalendar([
      calendarSession("workout-one", "Day One"),
      calendarSession("workout-two", "Day Two", "2026-07-08T23:15:00.000Z"),
    ]);

    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("Choose from 2 records");
    expect(html).not.toContain('href="/history/workout-one?');
    expect(html).not.toContain('href="/history/workout-two?');
  });

  it("renders past empty dates as retrospective actions", () => {
    const html = renderCalendar([calendarSession("workout-one", "Day One")]);

    expect(html).toContain(
      "/history/record?range=all&amp;calendarView=month&amp;calendarDate=2026-07-07&amp;date=2026-07-07"
    );
    expect(html).toContain(
      "Tuesday, July 7, 2026: Record a workout"
    );
  });

  it("routes an empty owner-today date to Today and keeps future dates inert", () => {
    const html = renderCalendar([calendarSession("workout-one", "Day One")]);

    expect(html).toContain('href="/today"');
    expect(html).toContain("Friday, July 10, 2026: Open Today to record a workout");
    expect(html).toContain("Saturday, July 11, 2026: No history");
  });

  it.each(["week", "year"] as const)(
    "keeps past empty dates actionable and future dates inert in %s view",
    (view) => {
      const html = renderCalendar(
        [calendarSession("workout-one", "Day One")],
        "2026-07-08",
        view
      );

      expect(html).toContain("Tuesday, July 7, 2026: Record a workout");
      expect(html).toContain("Saturday, July 11, 2026: No history");
      expect(html).toContain('href="/today"');
    }
  );

  it("renders a single activity as a direct activity link", () => {
    const html = renderCalendar([
      activityRecord("activity-one", "Evening power walk"),
    ]);

    expect(html).toContain(
      'href="/activity/activity-one?range=all&amp;calendarView=month&amp;calendarDate=2026-07-08"'
    );
    expect(html).toContain(": Open Evening power walk");
  });

  it("uses one chooser for a workout and activity on the same date", () => {
    const html = renderCalendar([
      calendarSession("workout-one", "Strength day"),
      activityRecord("activity-one", "Evening walk"),
    ]);

    expect(html).toContain("Choose from 2 records");
    const list = renderToStaticMarkup(
      <HistoryDayRecordList
        records={[
          calendarSession("workout-one", "Strength day"),
          activityRecord("activity-one", "Evening walk"),
        ]}
        range="all"
        view="month"
        date="2026-07-08"
        unit="lb"
      />
    );
    expect(list).toContain("Evening walk");
    expect(list).toContain("Workout");
    expect(list).toContain("Walk");
  });

  it("formats workout time in the retained workout timezone", () => {
    const workout = {
      ...calendarSession(
        "travel-workout",
        "Travel workout",
        "2026-07-08T01:15:00.000Z",
      ),
      timezone: "Pacific/Kiritimati",
    } satisfies Extract<CalendarRecord, { recordType: "workout" }>;
    const list = renderToStaticMarkup(
      <HistoryDayRecordList
        records={[workout]}
        range="all"
        view="month"
        date="2026-07-08"
        unit="lb"
      />,
    );

    expect(list).toContain("3:15 PM");
  });

  it("labels date-only retrospective records without exposing the storage anchor", () => {
    const retrospective = {
      ...calendarSession(
        "retrospective-one",
        "Recorded later",
        "2026-07-08T16:00:00.000Z",
      ),
      source: "history_manual",
      performedTimePrecision: "date_only",
    } satisfies Extract<CalendarRecord, { recordType: "workout" }>;
    const list = renderToStaticMarkup(
      <HistoryDayRecordList
        records={[retrospective]}
        range="all"
        view="month"
        date="2026-07-08"
        unit="lb"
      />,
    );

    expect(list).toContain("Entered later");
    expect(list).toContain("Time unknown");
    expect(list).not.toContain("12:00");
  });
});
