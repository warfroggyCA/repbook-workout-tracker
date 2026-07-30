import { describe, expect, it } from "vitest";
import {
  activityFingerprint,
  activityInputSchema,
  normalizeActivityInput,
} from "@/services/activities";
import type { ActivityInput } from "@/lib/activities";
import {
  activityDateKey,
  dateTimeLocalInZoneToDate,
  formatActivitySpeed,
  formatDateTimeLocalInZone,
} from "@/lib/activities";

const now = new Date("2026-07-10T18:00:00.000Z");

function input(overrides: Partial<ActivityInput> = {}): ActivityInput {
  return {
    activityType: "walk",
    title: "Power walk",
    startedAtISO: "2026-07-10T14:00:00.000Z",
    timezone: "America/Toronto",
    durationMinutes: 42,
    distanceValue: 3.5,
    distanceUnit: "km",
    intensity: "moderate",
    elevationValue: 120,
    elevationUnit: "ft",
    averageHeartRateBpm: 116,
    energyKcal: 280,
    notes: "Steady effort.",
    ...overrides,
  };
}

describe("manual health activities", () => {
  it("normalizes duration, distance, pace, elevation, and provenance", () => {
    const activity = normalizeActivityInput(input(), now);

    expect(activity.durationSeconds).toBe(2520);
    expect(activity.distanceKm).toBe(3.5);
    expect(activity.averagePaceSecondsPerKm).toBe(720);
    expect(activity.elevationGainM).toBeCloseTo(36.576);
    expect(activity.originalMetrics).toEqual({
      distanceValue: 3.5,
      distanceUnit: "km",
      elevationValue: 120,
      elevationUnit: "ft",
    });
    expect(activity.source).toBe("manual");
  });

  it("converts miles to kilometers without losing the entered measurement", () => {
    const activity = normalizeActivityInput(
      input({ distanceValue: 2, distanceUnit: "mi" }),
      now
    );

    expect(activity.distanceKm).toBeCloseTo(3.218688);
    expect(activity.originalMetrics).toMatchObject({
      distanceValue: 2,
      distanceUnit: "mi",
    });
  });

  it("rejects future activities and implausible measurements", () => {
    expect(() =>
      normalizeActivityInput(
        input({ startedAtISO: "2026-07-11T14:00:00.000Z" }),
        now
      )
    ).toThrow("future");
    expect(
      activityInputSchema.safeParse(input({ averageHeartRateBpm: 300 })).success
    ).toBe(false);
  });

  it("uses stable identity fields and ignores editable notes and titles", () => {
    const first = normalizeActivityInput(input(), now);
    const second = normalizeActivityInput(
      input({ title: "Evening walk", notes: "Different note" }),
      now
    );

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toBe(
      activityFingerprint({
        activityType: first.activityType,
        startedAt: first.startedAt,
        durationSeconds: first.durationSeconds,
        distanceKm: first.distanceKm,
      })
    );
  });

  it("can present the same normalized pace as cycling speed", () => {
    expect(formatActivitySpeed(180)).toBe("20.0 km/h");
  });

  it("round-trips the recorded wall time and date in its own timezone", () => {
    const instant = dateTimeLocalInZoneToDate(
      "2026-03-30T21:00",
      "America/Toronto"
    );

    expect(instant?.toISOString()).toBe("2026-03-31T01:00:00.000Z");
    expect(
      formatDateTimeLocalInZone(instant!, "America/Toronto")
    ).toBe("2026-03-30T21:00");
    expect(activityDateKey(instant!, "America/Toronto")).toBe("2026-03-30");
  });

  it("rejects a local time that does not exist during daylight saving change", () => {
    expect(
      dateTimeLocalInZoneToDate("2026-03-08T02:30", "America/Toronto")
    ).toBeNull();
  });
});
