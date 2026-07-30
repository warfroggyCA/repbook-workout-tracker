import { describe, expect, it } from "vitest";
import { shouldShowMissingWarmupMessage } from "@/lib/session-runner";

describe("session warm-up guidance", () => {
  it("does not contradict a structured checkable warm-up", () => {
    expect(
      shouldShowMissingWarmupMessage({
        dayWarmupNotes: null,
        hasStructuredWarmup: true,
      }),
    ).toBe(false);
  });

  it("keeps the empty-state explanation when no warm-up was saved", () => {
    expect(
      shouldShowMissingWarmupMessage({
        dayWarmupNotes: null,
        hasStructuredWarmup: false,
      }),
    ).toBe(true);
  });
});
