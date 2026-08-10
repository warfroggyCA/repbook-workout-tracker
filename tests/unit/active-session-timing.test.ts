import { describe, expect, it } from "vitest";
import {
  ACTIVE_SESSION_STALE_AFTER_SECONDS,
  classifyActiveSessionTiming,
  formatWallClockDuration,
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
});
