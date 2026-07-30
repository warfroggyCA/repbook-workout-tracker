import { describe, expect, it } from "vitest";
import { formatRestTime, restTimeFromParts, restTimeParts } from "@/lib/rest-time";

describe("rest time", () => {
  it.each([
    [15, "15 sec"],
    [45, "45 sec"],
    [60, "1 min"],
    [75, "1 min 15 sec"],
    [120, "2 min"],
  ])("formats %i seconds", (seconds, expected) => {
    expect(formatRestTime(seconds)).toBe(expected);
  });

  it("retains a legacy custom remainder until the owner edits it", () => {
    expect(restTimeParts(77)).toEqual({ minutes: 1, seconds: 17, isCustom: true });
    expect(restTimeFromParts(1, 17)).toBe(77);
    expect(restTimeFromParts(1, 15)).toBe(75);
  });
});
