import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAINING_BRIEF_RANGE_KEY,
  resolveTrainingBriefRange,
  TRAINING_BRIEF_RANGE_OPTIONS,
} from "@/lib/training-brief-range";

describe("training brief range", () => {
  it.each(TRAINING_BRIEF_RANGE_OPTIONS)(
    "maps History range $key to $weeks weeks",
    ({ key, weeks }) => {
      expect(resolveTrainingBriefRange(key)).toEqual({
        option: expect.objectContaining({ key, weeks }),
        selectedFromAllTime: false,
      });
    },
  );

  it("uses an explicit bounded default when History is all time", () => {
    const result = resolveTrainingBriefRange("all");

    expect(result.option.key).toBe(DEFAULT_TRAINING_BRIEF_RANGE_KEY);
    expect(result.option.weeks).toBe(12);
    expect(result.selectedFromAllTime).toBe(true);
  });

  it.each([undefined, "unknown", ["4w", "12w"]])(
    "uses the safe default for absent or malformed input %#",
    (value) => {
      const result = resolveTrainingBriefRange(value);

      expect(result.option.key).toBe(DEFAULT_TRAINING_BRIEF_RANGE_KEY);
      expect(result.selectedFromAllTime).toBe(false);
    },
  );
});
