import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivitySummary } from "@/components/history/activity-summary";
import { formatIndependentActivityContext } from "@/lib/history-activity-context";
import {
  summarizeActivities,
  type ActivityReportInput,
} from "@/services/activity-report";

function renderActivitySummary(activities: ActivityReportInput[]) {
  const report = summarizeActivities(
    activities,
    new Date("2026-04-17T12:00:00.000Z"),
    new Date("2026-07-10T12:00:00.000Z")
  );
  return renderToStaticMarkup(
    <ActivitySummary report={report} rangeLabel="12 weeks" />
  );
}

describe("History independent activity summary", () => {
  it("labels representative manual activity trends as separate from strength", () => {
    const html = renderActivitySummary([
      {
        id: "walk-1",
        activityType: "walk",
        title: "Long power walk",
        startedAt: new Date("2026-07-08T22:00:00.000Z"),
        timezone: "America/Toronto",
        durationSeconds: 5400,
        distanceKm: 7.5,
        averagePaceSecondsPerKm: 720,
        intensity: "moderate",
        elevationGainM: 80,
        averageHeartRateBpm: 118,
        energyKcal: 480,
        source: "manual",
        excludeFromAnalytics: false,
      },
    ]);

    expect(html).toContain("Independent health activities");
    expect(html).toContain("Separate from strength progress");
    expect(html).toContain("1 hr 30 min");
    expect(html).toContain("7.50 km");
    expect(html).toContain("12:00 /km");
    expect(html).toContain("heart rate 1/1");
  });

  it("offers activity entry without implying missing workouts", () => {
    const html = renderActivitySummary([]);
    expect(html).toContain("No independent activities in 12 weeks");
    expect(html).toContain('href="/activity/new"');
    expect(html).toContain("does not need to follow a workout");
  });

  it("calls a zero four-week duration change unchanged rather than higher", () => {
    const report = summarizeActivities(
      [
        {
          id: "steady-walk",
          activityType: "walk",
          title: "Steady walk",
          startedAt: new Date("2026-07-08T22:00:00.000Z"),
          timezone: "America/Toronto",
          durationSeconds: 3600,
          distanceKm: null,
          averagePaceSecondsPerKm: null,
          intensity: null,
          elevationGainM: null,
          averageHeartRateBpm: null,
          energyKcal: null,
          source: "manual",
          excludeFromAnalytics: false,
        },
      ],
      new Date("2026-04-17T12:00:00.000Z"),
      new Date("2026-07-10T12:00:00.000Z"),
    );
    report.trend.minuteChangePercent = 0;

    expect(formatIndependentActivityContext(report)).toContain(
      "unchanged from the prior four weeks",
    );
    expect(formatIndependentActivityContext(report)).not.toContain("higher");
  });
});
