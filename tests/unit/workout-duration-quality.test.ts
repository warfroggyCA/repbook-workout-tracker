import { describe, expect, it } from "vitest";
import {
  analyticsWorkoutDurationMinutes,
  recordedWorkoutDurationMinutes,
  shouldExcludeWorkoutDuration,
} from "@/lib/workout-duration-quality";

const startedAt = new Date("2026-07-20T12:00:00.000Z");

describe("workout duration quality", () => {
  it("includes durations up to three hours", () => {
    const finishedAt = new Date("2026-07-20T15:00:00.000Z");

    expect(recordedWorkoutDurationMinutes(startedAt, finishedAt)).toBe(180);
    expect(shouldExcludeWorkoutDuration(startedAt, finishedAt)).toBe(false);
    expect(analyticsWorkoutDurationMinutes(startedAt, finishedAt)).toBe(180);
  });

  it("excludes longer and explicitly questionable durations", () => {
    const finishedAt = new Date("2026-07-20T15:00:00.001Z");

    expect(shouldExcludeWorkoutDuration(startedAt, finishedAt)).toBe(true);
    expect(analyticsWorkoutDurationMinutes(startedAt, finishedAt)).toBeNull();
    expect(
      analyticsWorkoutDurationMinutes(
        startedAt,
        new Date("2026-07-20T13:00:00.000Z"),
        true,
      ),
    ).toBeNull();
  });

  it("does not turn missing or backward timestamps into analytics", () => {
    expect(analyticsWorkoutDurationMinutes(startedAt, null)).toBeNull();
    expect(
      analyticsWorkoutDurationMinutes(
        startedAt,
        new Date("2026-07-20T11:59:59.000Z"),
      ),
    ).toBeNull();
  });
});
