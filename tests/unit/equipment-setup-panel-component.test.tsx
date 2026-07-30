import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/app/actions/sessions", () => ({
  setSessionEquipmentSelection: vi.fn(),
}));

import { EquipmentSetupPanel } from "@/components/session/equipment-setup-panel";

describe("EquipmentSetupPanel", () => {
  it("renders an accessible physical chooser and independent-stack meaning", () => {
    const html = renderToStaticMarkup(
      <EquipmentSetupPanel
        sessionExerciseId="00000000-0000-4000-8000-000000000001"
        ownerId="00000000-0000-4000-8000-000000000010"
        sessionId="00000000-0000-4000-8000-000000000011"
        setup={{
          sourceExerciseId: "00000000-0000-4000-8000-000000000012",
          sourceTargetLoad: 50,
          sourceTargetLoadUnit: "lb",
          exact: true,
          status: "available",
          selectionRequired: false,
          currentSnapshotId: "00000000-0000-4000-8000-000000000002",
          currentEquipmentLabel: "Dual cable tower",
          currentAttachmentLabel: "Rope",
          currentGuidance: "stack 1: 50 lb · stack 2: 50 lb. Pulley ratio is unknown, so effective load remains unknown.",
          currentGuidanceByLoadEntryMeaning: {
            per_stack: "stack 1: 50 lb · stack 2: 50 lb. Pulley ratio is unknown, so effective load remains unknown.",
            combined_stacks: "Combined exact 50 lb: stack 1 25 lb + stack 2 25 lb.",
          },
          currentSelectionAvailable: true,
          loadEntryMeaning: "per_stack",
          loadEntryMeaningChoices: ["per_stack", "combined_stacks"],
          options: [
            {
              key: "tower:rope",
              equipmentItemId: "00000000-0000-4000-8000-000000000003",
              equipmentLabel: "Dual cable tower",
              attachmentItemId: "00000000-0000-4000-8000-000000000004",
              attachmentLabel: "Rope",
              guidance: "Use both stack positions.",
            },
            {
              key: "tower:bar",
              equipmentItemId: "00000000-0000-4000-8000-000000000003",
              equipmentLabel: "Dual cable tower",
              attachmentItemId: "00000000-0000-4000-8000-000000000005",
              attachmentLabel: "Straight bar",
              guidance: "Use both stack positions.",
            },
          ],
        }}
        loadEntryMeaning="per_stack"
        onLoadEntryMeaningChange={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Workout equipment setup"');
    expect(html).toContain("Using <span");
    expect(html).toContain("Dual cable tower · Rope");
    expect(html).toContain("Physical setup");
    expect(html).toContain("Load entry meaning");
    expect(html).toContain("Load shown for each stack");
    expect(html).toContain("Combined load across all stacks");
    expect(html).toContain("effective load remains unknown");
  });
});
