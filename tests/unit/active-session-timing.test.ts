import { describe, expect, it } from "vitest";
import {
  ACTIVE_SESSION_STALE_AFTER_SECONDS,
  classifyActiveSessionTiming,
  formatWallClockDuration,
  parseOwnerReportedActiveSeconds,
  validateOwnerReportedActiveMinutes,
} from "@/lib/active-session-timing";

const startedAt = new Date("2026-08-10T12:00:00.000Z");

function after(seconds: number) {
  return new Date(startedAt.getTime() + seconds * 1_000);
}

describe("active session timing", () => {
  it("requires review only after the conservative three-hour boundary", () => {
    expect(
      classifyActiveSessionTiming(
        startedAt,
        after(ACTIVE_SESSION_STALE_AFTER_SECONDS - 1),
      ).reviewRequired,
    ).toBe(false);
    expect(
      classifyActiveSessionTiming(
        startedAt,
        after(ACTIVE_SESSION_STALE_AFTER_SECONDS),
      ).reviewRequired,
    ).toBe(false);
    expect(
      classifyActiveSessionTiming(
        startedAt,
        after(ACTIVE_SESSION_STALE_AFTER_SECONDS + 1),
      ),
    ).toMatchObject({ reviewRequired: true, reason: "stale" });
  });

  it("makes clock skew explicit instead of inventing elapsed time", () => {
    expect(classifyActiveSessionTiming(startedAt, after(-1))).toEqual({
      wallClockSeconds: 0,
      wallClockLabel: "unavailable",
      reviewRequired: true,
      reason: "clock_skew",
    });
  });

  it("keeps compact wall-clock labels truthful across minutes, hours, and days", () => {
    expect(formatWallClockDuration(42 * 60)).toBe("42 min");
    expect(formatWallClockDuration((3 * 60 + 15) * 60)).toBe("3 hr 15 min");
    expect(formatWallClockDuration((6 * 24 + 2) * 60 * 60)).toBe(
      "6 days 2 hr",
    );
  });

  it("accepts a reviewed zero-minute duration within the global safety bound", () => {
    expect(parseOwnerReportedActiveSeconds("0")).toBe(0);
    expect(parseOwnerReportedActiveSeconds(" 0 ")).toBe(0);
    expect(parseOwnerReportedActiveSeconds("10080")).toBe(604_800);
    expect(parseOwnerReportedActiveSeconds("")).toBeNull();
    expect(parseOwnerReportedActiveSeconds("-1")).toBeNull();
    expect(parseOwnerReportedActiveSeconds("1.5")).toBeNull();
    expect(parseOwnerReportedActiveSeconds("1e2")).toBeNull();
    expect(parseOwnerReportedActiveSeconds("10081")).toBeNull();
    expect(validateOwnerReportedActiveMinutes("1.5", 2_000_000)).toMatchObject({
      status: "invalid",
      reason: "not_whole",
    });
    expect(validateOwnerReportedActiveMinutes("10081", 2_000_000)).toMatchObject({
      status: "invalid",
      reason: "out_of_range",
    });
    expect(validateOwnerReportedActiveMinutes("43", 2_520)).toMatchObject({
      status: "invalid",
      reason: "exceeds_wall_clock",
    });
    expect(validateOwnerReportedActiveMinutes("10080", 604_800)).toEqual({
      status: "valid",
      seconds: 604_800,
      error: null,
    });
  });
});
