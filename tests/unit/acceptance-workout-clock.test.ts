import { describe, expect, it } from "vitest";
import { acceptanceWorkoutNow } from "@/lib/acceptance-workout-clock";

const guarded = {
  BA_FIXTURE_MODE: "1",
  BA_CALENDAR_MODE: "1",
  BA_ACCEPTANCE_START_AT: "2026-07-17T03:55:00.000Z",
  BA_ACCEPTANCE_FINISH_AT: "2026-07-17T04:05:00.000Z",
};

describe("disposable BA workout clock", () => {
  it("stays absent unless fixed acceptance instants are supplied", () => {
    expect(acceptanceWorkoutNow("start", {}, false)).toBeUndefined();
  });

  it("returns independent fixed start and finish clocks inside the complete guard", () => {
    expect(acceptanceWorkoutNow("start", guarded, true)?.().toISOString()).toBe(
      guarded.BA_ACCEPTANCE_START_AT,
    );
    expect(acceptanceWorkoutNow("finish", guarded, true)?.().toISOString()).toBe(
      guarded.BA_ACCEPTANCE_FINISH_AT,
    );
  });

  it("refuses every partial, mistyped, or non-disposable configuration", () => {
    expect(() => acceptanceWorkoutNow("start", guarded, false)).toThrow(
      "explicit disposable fixture runtime",
    );
    expect(() => acceptanceWorkoutNow("start", { ...guarded, BA_CALENDAR_MODE: "" }, true)).toThrow(
      "explicit disposable fixture runtime",
    );
    expect(() => acceptanceWorkoutNow("start", { ...guarded, BA_ACCEPTANCE_FINISH_AT: "" }, true)).toThrow(
      "both start and finish instants",
    );
    expect(() => acceptanceWorkoutNow("start", { ...guarded, BA_ACCEPTANCE_START_AT: "2026-07-17" }, true)).toThrow(
      "exact UTC ISO timestamp",
    );
  });
});
