import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InventoryChangeReview } from "@/components/equipment/inventory-change-review";

describe("equipment exact-profile review", () => {
  it("names future-only guidance impact without implying history is rewritten", () => {
    const html = renderToStaticMarkup(
      <InventoryChangeReview
        unit="lb"
        pending={false}
        onBack={vi.fn()}
        onConfirm={vi.fn()}
        preview={{
          added: [], changed: [], removed: [], plateChanges: [], barChanges: [],
          loadProfileChanges: [{
            equipmentItemId: "10000000-0000-4000-8000-000000000001",
            label: "Cable station", kind: "cable_machine", change: "changed",
            reducesGuidance: true,
          }],
          impact: {
            exercisesBecomingUnavailable: [], exercisesBecomingAvailable: [],
            affectedProgramSlots: [],
            fitReviewsRequiringReview: [],
          },
          requiresConfirmation: true,
          noChanges: false,
        }}
      />,
    );
    expect(html).toContain("Exact setup changes");
    expect(html).toContain("future loading guidance becomes less precise");
    expect(html).toContain("Saved workouts keep the exact equipment snapshot");
  });
});
