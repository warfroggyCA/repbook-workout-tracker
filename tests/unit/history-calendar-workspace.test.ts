import { describe, expect, it } from "vitest";
import { selectHistoryActionSignal } from "@/components/history/history-calendar-workspace";
import type { HistoryLens } from "@/services/history-lenses";

function lens(
  key: HistoryLens["key"],
  tone: HistoryLens["tone"],
  supported: boolean,
): HistoryLens {
  return {
    key,
    title: key,
    question: `Question for ${key}`,
    answer: `Answer for ${key}`,
    tone,
    evidence: [],
    limitation: "Known limits remain visible.",
    decision: {
      supported,
      statement: supported
        ? `A decision is supported for ${key}.`
        : `No decision is supported for ${key}.`,
    },
  };
}

describe("selectHistoryActionSignal", () => {
  it("returns no signal when the period supports no action", () => {
    expect(selectHistoryActionSignal([
      lens("progress", "watch", false),
      lens("records", "positive", false),
    ])).toBeNull();
  });

  it("returns one supported signal using tone priority and stable lens order", () => {
    const lenses = [
      lens("progress", "positive", true),
      lens("program-fit", "watch", false),
      lens("pain-constraints", "watch", true),
      lens("work-capacity", "watch", true),
      lens("records", "neutral", false),
    ];

    expect(selectHistoryActionSignal(lenses)?.key).toBe("pain-constraints");
  });
});
