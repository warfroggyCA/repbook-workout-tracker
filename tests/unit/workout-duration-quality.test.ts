import { describe, expect, it } from "vitest";
import {
  ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS,
  analyticsWorkoutDurationMinutes,
  classifyWorkoutDurationReview,
  effectiveWorkoutDurationMinutes,
  resolveWorkoutActiveDurationCorrection,
  resolveWorkoutCompletionDuration,
  shouldExcludeWorkoutDuration,
  wallClockElapsedWorkoutMinutes,
} from "@/lib/workout-duration-quality";

const startedAt = new Date("2026-08-10T12:00:00.000Z");

describe("workout active-duration evidence", () => {
  it("requires interruption review only after the three-hour boundary", () => {
    expect(classifyWorkoutDurationReview(
      startedAt,
      new Date(startedAt.getTime() + ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS * 1_000),
    )).toEqual({
      wallClockElapsedSeconds: ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS,
      reviewRequired: false,
      reviewReason: null,
    });
    expect(classifyWorkoutDurationReview(
      startedAt,
      new Date(startedAt.getTime() + (ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS + 1) * 1_000),
    )).toEqual({
      wallClockElapsedSeconds: ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS + 1,
      reviewRequired: true,
      reviewReason: "stale",
    });
    expect(classifyWorkoutDurationReview(
      startedAt,
      new Date(startedAt.getTime() - 1_000),
    )).toEqual({
      wallClockElapsedSeconds: 0,
      reviewRequired: true,
      reviewReason: "clock_skew",
    });
  });

  it("does not silently complete a stale workout without defensible active-time evidence", () => {
    const finishedAt = new Date("2026-08-10T16:00:00.000Z");
    expect(resolveWorkoutCompletionDuration({ startedAt, finishedAt })).toMatchObject({
      ok: false,
      code: "duration_review_required",
      reviewRequired: true,
    });
    expect(resolveWorkoutCompletionDuration({
      startedAt,
      finishedAt,
      decision: { basis: "wall_clock_no_stale_signal" },
    })).toMatchObject({
      ok: false,
      code: "duration_review_required",
    });
  });

  it("accepts bounded owner evidence or an explicit unknown without changing wall-clock facts", () => {
    const finishedAt = new Date("2026-08-10T16:00:00.000Z");
    expect(resolveWorkoutCompletionDuration({
      startedAt,
      finishedAt,
      decision: { basis: "owner_reported", activeDurationSeconds: 3_600 },
    })).toMatchObject({
      ok: true,
      wallClockElapsedSeconds: 14_400,
      activeDurationSeconds: 3_600,
      activeDurationBasis: "owner_reported",
    });
    expect(resolveWorkoutCompletionDuration({
      startedAt,
      finishedAt,
      decision: { basis: "interruption_unknown" },
    })).toMatchObject({
      ok: true,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
    });
    expect(resolveWorkoutCompletionDuration({
      startedAt,
      finishedAt,
      decision: { basis: "owner_reported", activeDurationSeconds: 14_401 },
    })).toMatchObject({ ok: false, code: "invalid_duration_review" });
  });

  it("uses only the global safety bound when correction has no wall-clock finish", () => {
    expect(resolveWorkoutActiveDurationCorrection({
      startedAt,
      finishedAt: null,
      decision: { basis: "owner_reported", activeDurationSeconds: 604_800 },
    })).toMatchObject({
      ok: true,
      wallClockElapsedSeconds: null,
      activeDurationSeconds: 604_800,
      activeDurationBasis: "owner_reported",
    });
    expect(resolveWorkoutActiveDurationCorrection({
      startedAt,
      finishedAt: null,
      decision: { basis: "owner_reported", activeDurationSeconds: 604_801 },
    })).toMatchObject({ ok: false, wallClockElapsedSeconds: null });
    expect(resolveWorkoutActiveDurationCorrection({
      startedAt,
      finishedAt: null,
      decision: { basis: "interruption_unknown" },
    })).toMatchObject({
      ok: true,
      wallClockElapsedSeconds: null,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
    });
    expect(resolveWorkoutActiveDurationCorrection({
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 3_600_000),
      decision: { basis: "owner_reported", activeDurationSeconds: 3_601 },
    })).toMatchObject({ ok: false, wallClockElapsedSeconds: 3_600 });
  });

  it("keeps legacy wall-clock elapsed available only at the explicit raw display boundary", () => {
    const finishedAt = new Date("2026-08-10T16:00:00.000Z");
    expect(wallClockElapsedWorkoutMinutes(startedAt, finishedAt)).toBe(240);
    expect(effectiveWorkoutDurationMinutes(startedAt, finishedAt)).toBeNull();
    expect(analyticsWorkoutDurationMinutes(startedAt, finishedAt)).toBeNull();
    expect(analyticsWorkoutDurationMinutes(startedAt, finishedAt, false, {
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 3_600,
      activeDurationBasis: "owner_reported",
    })).toBe(60);
    expect(shouldExcludeWorkoutDuration(startedAt, finishedAt, false, {
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
    })).toBe(true);
  });
});
