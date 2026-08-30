import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EquipmentSelectionOutboxSnapshot } from "@/lib/equipment-selection-outbox";

const outboxState = vi.hoisted(() => ({
  snapshot: {
    entries: [],
    quarantined: [],
    error: null,
  } as EquipmentSelectionOutboxSnapshot,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/app/actions/sessions", () => ({
  setSessionEquipmentSelection: vi.fn(),
}));
vi.mock("@/lib/equipment-selection-outbox", () => ({
  enqueueEquipmentSelection: vi.fn(),
  getEquipmentSelectionOutboxServerSnapshot: () => outboxState.snapshot,
  getEquipmentSelectionOutboxSnapshot: () => outboxState.snapshot,
  hasPendingEquipmentSelection: vi.fn(() => false),
  retryEquipmentSelection: vi.fn(),
  subscribeToEquipmentSelectionOutbox: () => () => undefined,
  subscribeToEquipmentSelectionOutboxStatus: () => () => undefined,
}));

import { EquipmentSetupPanel } from "@/components/session/equipment-setup-panel";

describe("EquipmentSetupPanel", () => {
  beforeEach(() => {
    outboxState.snapshot = { entries: [], quarantined: [], error: null };
  });

  it("renders an accessible physical chooser and independent-stack meaning", () => {
    const html = renderToStaticMarkup(
      <EquipmentSetupPanel
        sessionExerciseId="00000000-0000-4000-8000-000000000001"
        exerciseName="Cable Row"
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

    expect(html).toContain('aria-label="Equipment setup for Cable Row"');
    expect(html).toContain("Using <span");
    expect(html).toContain("Dual cable tower · Rope");
    expect(html).toContain("Physical setup");
    expect(html).toContain("Load entry meaning");
    expect(html).toContain("Load shown for each stack");
    expect(html).toContain("Combined load across all stacks");
    expect(html).toContain("effective load remains unknown");
  });

  it("keeps a failed setup retry touch-sized and names the exercise context", () => {
    outboxState.snapshot = {
      entries: [{
        clientKey: "00000000-0000-4000-8000-000000000020",
        ownerId: "00000000-0000-4000-8000-000000000010",
        sessionId: "00000000-0000-4000-8000-000000000011",
        sessionExerciseId: "00000000-0000-4000-8000-000000000001",
        operation: "select",
        equipmentItemId: "00000000-0000-4000-8000-000000000003",
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        predecessorSelectionClientKey: null,
        provenance: "user_selected",
        equipmentLabel: "Cable tower",
        attachmentLabel: null,
        createdAtISO: "2026-08-10T12:00:00.000Z",
        status: "needs_attention",
        attemptCount: 1,
        nextAttemptAtISO: null,
        lastAttemptAtISO: "2026-08-10T12:00:01.000Z",
        lastError: "Equipment setup needs attention.",
      }],
      quarantined: [],
      error: null,
    };

    const html = renderToStaticMarkup(
      <EquipmentSetupPanel
        sessionExerciseId="00000000-0000-4000-8000-000000000001"
        exerciseName="Cable Row"
        ownerId="00000000-0000-4000-8000-000000000010"
        sessionId="00000000-0000-4000-8000-000000000011"
        setup={{
          sourceExerciseId: "00000000-0000-4000-8000-000000000012",
          sourceTargetLoad: null,
          sourceTargetLoadUnit: null,
          exact: true,
          status: "available",
          selectionRequired: true,
          currentSnapshotId: null,
          currentEquipmentLabel: null,
          currentAttachmentLabel: null,
          currentGuidance: null,
          currentGuidanceByLoadEntryMeaning: {},
          currentSelectionAvailable: false,
          loadEntryMeaning: null,
          loadEntryMeaningChoices: [],
          options: [],
        }}
        loadEntryMeaning="legacy_unknown"
        onLoadEntryMeaningChange={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Equipment setup for Cable Row"');
    expect(html).toMatch(/class="[^"]*min-h-11[^"]*"[^>]*>Retry setup/);
  });

  it("reduces a settled single-option setup to one evidence line", () => {
    const html = renderToStaticMarkup(
      <EquipmentSetupPanel
        sessionExerciseId="00000000-0000-4000-8000-000000000001"
        exerciseName="Barbell Squat"
        ownerId="00000000-0000-4000-8000-000000000010"
        sessionId="00000000-0000-4000-8000-000000000011"
        setup={{
          sourceExerciseId: "00000000-0000-4000-8000-000000000012",
          sourceTargetLoad: 135,
          sourceTargetLoadUnit: "lb",
          exact: true,
          status: "available",
          selectionRequired: false,
          currentSnapshotId: "00000000-0000-4000-8000-000000000002",
          currentEquipmentLabel: "Olympic barbell",
          currentAttachmentLabel: null,
          currentGuidance: "45 lb bar · load 45 lb per side.",
          currentGuidanceByLoadEntryMeaning: {},
          currentSelectionAvailable: true,
          loadEntryMeaning: "total_system",
          loadEntryMeaningChoices: [],
          options: [{
            key: "barbell",
            equipmentItemId: "00000000-0000-4000-8000-000000000003",
            equipmentLabel: "Olympic barbell",
            attachmentItemId: null,
            attachmentLabel: null,
            guidance: "45 lb bar · load 45 lb per side.",
          }],
        }}
        loadEntryMeaning="total_system"
        onLoadEntryMeaningChange={() => undefined}
      />,
    );

    expect(html).toContain("Equipment</span> · <span");
    expect(html).toContain("Using Olympic barbell");
    expect(html).toContain("45 lb bar · load 45 lb per side.");
    expect(html).not.toContain("Physical setup");
    expect(html).not.toContain("Load entry meaning");
  });
});
