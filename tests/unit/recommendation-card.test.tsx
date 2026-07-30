import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/app/actions/recommendations", () => ({
  approveRecommendation: vi.fn(),
  rejectRecommendation: vi.fn(),
}));

import {
  RecommendationCard,
  type RecommendationCardData,
} from "@/components/coach/recommendation-card";

const baseRecommendation: RecommendationCardData = {
  id: "recommendation-id",
  ruleId: "pain_freeze",
  source: "rule",
  exerciseName: "Barbell Bench Press",
  reason:
    "A 4/10 pain flag is keeping the load from going up until the 14-day evidence window clears.",
  kind: "hold",
  fromLoad: null,
  toLoad: null,
  loadUnit: null,
  suggestedExercise: null,
  alternatives: [],
  evidence: [
    { label: "Highest recorded pain flag", value: "4/10" },
    { label: "Evidence window", value: "14 days" },
  ],
};

function render(rec: RecommendationCardData) {
  return renderToStaticMarkup(
    <RecommendationCard rec={rec} loadStep={5} />,
  );
}

describe("RecommendationCard", () => {
  it("renders a hold as an informational notice with dismissal only", () => {
    const html = render(baseRecommendation);

    expect(html).toContain("Automatic status");
    expect(html).toContain("Load held");
    expect(html).toContain("doesn&#x27;t change your Program");
    expect(html).toContain("Evidence window");
    expect(html).toContain("Dismiss notice");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain(">Reject<");
    expect(html).not.toContain("Confidence");
  });

  it("keeps load-change and substitution proposals actionable", () => {
    const loadHtml = render({
      ...baseRecommendation,
      ruleId: "double_progression",
      kind: "load_change",
      reason: "Two completed workouts support a cautious increase.",
      fromLoad: 105,
      toLoad: 110,
      loadUnit: "lb",
    });
    const substitutionHtml = render({
      ...baseRecommendation,
      ruleId: "pain_substitute",
      kind: "substitution",
      reason: "Consider a different exercise.",
      suggestedExercise: "Dumbbell Bench Press",
    });

    for (const html of [loadHtml, substitutionHtml]) {
      expect(html).toContain("Decision required");
      expect(html).toContain("Approve");
      expect(html).toContain(">Reject<");
      expect(html).not.toContain("Dismiss notice");
    }
    expect(loadHtml).toContain("105");
    expect(loadHtml).toContain("110");
    expect(substitutionHtml).toContain(
      "Switch to: Dumbbell Bench Press",
    );
  });
});
