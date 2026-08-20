import { describe, expect, it } from "vitest";
import { hasProgrammedWarmupActions } from "@/lib/warmup";

describe("programmed warm-up actions", () => {
  it("does not offer opt-in for reference-only warm-up notes", () => {
    expect(
      hasProgrammedWarmupActions({
        dayWarmupItems: [],
        exerciseWarmupSets: [[], []],
      }),
    ).toBe(false);
  });

  it("offers opt-in for structured day or exercise warm-up actions", () => {
    expect(
      hasProgrammedWarmupActions({
        dayWarmupItems: [{}],
        exerciseWarmupSets: [],
      }),
    ).toBe(true);
    expect(
      hasProgrammedWarmupActions({
        dayWarmupItems: [],
        exerciseWarmupSets: [[], [{}]],
      }),
    ).toBe(true);
  });
});
