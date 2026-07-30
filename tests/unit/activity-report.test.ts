import { describe, expect, it } from "vitest";
import type { ActivityReportInput } from "@/services/activity-report";
import { summarizeActivities } from "@/services/activity-report";

const now = new Date("2026-07-10T18:00:00.000Z");
const since = new Date("2026-05-15T18:00:00.000Z");

function activity(
  overrides: Partial<ActivityReportInput> &
    Pick<ActivityReportInput, "id" | "startedAt">
): ActivityReportInput {
  return {
    ...overrides,
    activityType: "walk",
    title: "Power walk",
    timezone: "America/Toronto",
    durationSeconds: 3600,
    distanceKm: 5,
    averagePaceSecondsPerKm: 720,
    intensity: "moderate",
    elevationGainM: 50,
    averageHeartRateBpm: 115,
    energyKcal: 300,
    source: "manual",
    excludeFromAnalytics: false,
    ...overrides,
  };
}

describe("independent activity report", () => {
  it("summarizes consistency, measurements, types, and pace without touching workouts", () => {
    const report = summarizeActivities(
      [
        activity({
          id: "walk-1",
          startedAt: new Date("2026-05-20T22:00:00.000Z"),
          durationSeconds: 3600,
          distanceKm: 5,
          averagePaceSecondsPerKm: 720,
        }),
        activity({
          id: "walk-2",
          startedAt: new Date("2026-06-10T22:00:00.000Z"),
          durationSeconds: 3600,
          distanceKm: 6,
          averagePaceSecondsPerKm: 600,
        }),
        activity({
          id: "ride-1",
          activityType: "cycling",
          title: "Easy ride",
          startedAt: new Date("2026-07-08T12:00:00.000Z"),
          durationSeconds: 1800,
          distanceKm: 10,
          averagePaceSecondsPerKm: 180,
          elevationGainM: null,
          averageHeartRateBpm: null,
          energyKcal: null,
        }),
        activity({
          id: "excluded",
          startedAt: new Date("2026-07-09T12:00:00.000Z"),
          durationSeconds: 9999,
          excludeFromAnalytics: true,
        }),
      ],
      since,
      now
    );

    expect(report.overview).toMatchObject({
      totalActivities: 3,
      totalMinutes: 150,
      totalDistanceKm: 21,
      averageDurationMinutes: 50,
      activitiesPerWeek: 0.4,
      activeWeeks: 3,
      weeksInRange: 8,
      consistencyPercent: 38,
      excludedActivities: 1,
    });
    expect(report.byType[0]).toMatchObject({
      activityType: "walk",
      activities: 2,
      totalMinutes: 120,
      distanceKm: 11,
      performanceChangePercent: 16.7,
      performanceObservationCount: 2,
    });
    expect(report.measurementCoverage).toMatchObject({
      activities: 3,
      distance: 3,
      pace: 3,
      intensity: 3,
      elevation: 2,
      heartRate: 2,
      energy: 2,
    });
    expect(report.rule).toContain("never change strength-workout progression");
  });

  it("uses the activity timezone when assigning late-night records to weeks", () => {
    const report = summarizeActivities(
      [
        activity({
          id: "late-sunday",
          startedAt: new Date("2026-07-06T03:30:00.000Z"),
          timezone: "America/Toronto",
        }),
      ],
      new Date("2026-06-29T00:00:00.000Z"),
      new Date("2026-07-07T00:00:00.000Z")
    );

    const activeWeek = report.weekly.find((week) => week.activities === 1);
    expect(activeWeek?.weekStartISO).toBe("2026-06-29T00:00:00.000Z");
  });

  it("returns an honest empty report", () => {
    const report = summarizeActivities([], since, now);
    expect(report.overview.totalActivities).toBe(0);
    expect(report.overview.averageDurationMinutes).toBeNull();
    expect(report.byType).toEqual([]);
    expect(report.recent).toEqual([]);
  });
});
