import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/app/actions/setup", () => ({
  buildProgramRoutineDraft: vi.fn(),
}));

import { ProgramEditor } from "@/components/program/program-editor";
import { ReviewDialog } from "@/components/program/editor/review-dialog";
import { HistoryPanel } from "@/components/program/editor/history-panel";
import { DayWarmupEditor } from "@/components/program/editor/warmup-editor";
import { DayEditor } from "@/components/program/editor/day-editor";
import type { ProgramEditorController } from "@/components/program/editor/use-program-editor-controller";
import type { ProgramReview } from "@/lib/program-editor-client";
import { createSuggestedDayIntent, createSuggestedSlotIntent, type ProgramDocumentDayV3 } from "@/lib/program-document";

describe("Program editor shell", () => {
  it("renders an accessible durable-loading state before the private draft arrives", () => {
    const html = renderToStaticMarkup(
      <ProgramEditor
        ownerId="00000000-0000-4000-8000-000000000001"
        library={[]}
        initialDayId={null}
      />
    );

    expect(html).toContain("Program editor");
    expect(html).toContain("Loading your durable draft");
    expect(html).toContain('href="/program"');
    expect(html).toContain("Back to Program");
  });
});

describe("Program editor split presentation panels", () => {
  it("renders structured warm-up editing and ordering controls", () => {
    const slot = {
      lineageId: "10000000-0000-4000-8000-000000000011",
      exerciseId: "10000000-0000-4000-8000-000000000012",
      sets: 3,
      repMin: 8,
      repMax: 12,
      targetLoad: null,
      targetLoadUnit: null,
      progressionRuleId: "double_progression",
      restSec: 90,
      supersetKey: null,
      groupMemberOrderIdx: null,
      notes: null,
      warmupNotes: null,
      warmupSets: [],
      setNotes: [null, null, null],
      intent: createSuggestedSlotIntent(3, 0),
    };
    const day: ProgramDocumentDayV3 = {
      lineageId: "10000000-0000-4000-8000-000000000010",
      name: "Day A",
      notes: null,
      warmupNotes: "Move smoothly",
      warmupItems: [{
        key: "10000000-0000-4000-8000-000000000013",
        label: "Shoulder circles",
        reps: 10,
        load: null,
        loadUnit: null,
        loadPercent: null,
        loadText: null,
        notes: null,
      }],
      intent: createSuggestedDayIntent([slot]),
      supersets: [],
      exercises: [slot],
    };
    const html = renderToStaticMarkup(
      <DayWarmupEditor
        day={day}
        days={[day]}
        onChange={vi.fn()}
        onItemsChange={vi.fn()}
        onApply={vi.fn()}
      />,
    );

    expect(html).toContain("Shoulder circles");
    expect(html).toContain("Add warm-up step");
    expect(html).toContain("Loading method");
    expect(html).toContain("Move warm-up step 1 up");
    expect(html).toContain("Remove warm-up step 1");
  });

  it("shows group timing, member order, and an explicit unequal-group repair", () => {
    const groupKey = "10000000-0000-4000-8000-000000000020";
    const makeSlot = (suffix: string, sets: number, order: number) => ({
      lineageId: `10000000-0000-4000-8000-0000000000${suffix}`,
      exerciseId: `20000000-0000-4000-8000-0000000000${suffix}`,
      sets,
      repMin: 8,
      repMax: 12,
      targetLoad: null,
      targetLoadUnit: null,
      progressionRuleId: "double_progression",
      restSec: 90,
      supersetKey: groupKey,
      groupMemberOrderIdx: order,
      notes: null,
      warmupNotes: null,
      warmupSets: [],
      setNotes: Array.from({ length: sets }, () => null),
      intent: createSuggestedSlotIntent(sets, order),
    });
    const slots = [makeSlot("21", 3, 0), makeSlot("22", 4, 1)];
    const day: ProgramDocumentDayV3 = {
      lineageId: "10000000-0000-4000-8000-000000000023",
      name: "Grouped day",
      notes: null,
      warmupNotes: null,
      warmupItems: [],
      intent: createSuggestedDayIntent(slots),
      supersets: [{
        key: groupKey,
        name: "Legacy pair",
        structureStatus: "legacy_unequal",
        plannedRounds: null,
        restBetweenMembersSec: 15,
        restBetweenRoundsSec: 90,
        restAfterRoundSec: 90,
      }],
      exercises: slots,
    };
    const editor = {
      document: {
        schemaVersion: "3",
        programId: "10000000-0000-4000-8000-000000000024",
        baseVersionId: "10000000-0000-4000-8000-000000000025",
        name: "Grouped Program",
        days: [day],
      },
      revision: 1,
      router: { push: vi.fn() },
      library: [],
      updateDocument: vi.fn(),
      activeDayId: day.lineageId,
      setActiveDayId: vi.fn(),
      dayHeadingRefs: { current: new Map() },
      updateDay: vi.fn(),
      addDay: vi.fn(),
      addExercise: vi.fn(),
      pairingDayId: null,
      setPairingDayId: vi.fn(),
      pairingSlotIds: [],
      setPairingSlotIds: vi.fn(),
      expandedSlotId: null,
      setExpandedSlotId: vi.fn(),
      slotHeadingRefs: { current: new Map() },
      exerciseById: new Map(),
      moveSlotToDay: vi.fn(),
      requestReview: vi.fn(),
      reviewing: false,
    } as unknown as ProgramEditorController;

    const html = renderToStaticMarkup(<DayEditor editor={editor} />);
    expect(html).toContain("This older group cannot be published yet");
    expect(html).toContain("Use 3 rounds for every member");
    expect(html).toContain("Rest between members");
    expect(html).toContain("Rest after each round");
    expect(html).toContain("Move group member 2 up");
  });

  it("renders the semantic review summary, cautions, and progression consequences", () => {
    const review: ProgramReview = {
      status: "publishable",
      hash: "a".repeat(64),
      reviewedRevision: 3,
      // Historical documents predating structured intent carry no Preflight.
      preflight: null,
      changes: [{
        kind: "remove",
        path: "slots.squat",
        label: "Remove Barbell Squat",
        before: "Barbell Squat",
        after: null,
      }],
      blockingErrors: [],
      cautions: ["Confirm the lower weekly set count."],
      recommendationRevision: 0,
      recommendationConsequences: [],
      summary: {
        weeklySetsBefore: 6,
        weeklySetsAfter: 3,
        durationBefore: [],
        durationAfter: [],
        muscleSetsBefore: { quadriceps: 6 },
        muscleSetsAfter: { quadriceps: 3 },
      },
    };
    const editor = {
      reviewing: false,
      requestReview: vi.fn(),
      publishing: false,
      publish: vi.fn(),
    } as unknown as ProgramEditorController;
    const html = renderToStaticMarkup(
      <ReviewDialog editor={editor} currentReview={review} canReview />
    );

    expect(html).toContain("Training summary");
    expect(html).toContain("Confirm the lower weekly set count.");
    expect(html).toContain("Progression continuity");
    expect(html).toContain("earlier progression remains in workout history");
  });

  it("shows the real blocked-review reason without exposing an activation path", () => {
    const review: ProgramReview = {
      status: "blocked",
      hash: null,
      reviewedRevision: 4,
      preflight: null,
      changes: [],
      blockingErrors: ["The selected equipment cannot execute this exercise."],
      cautions: [],
      recommendationRevision: 0,
      recommendationConsequences: [],
      summary: {
        weeklySetsBefore: 3,
        weeklySetsAfter: 3,
        durationBefore: [],
        durationAfter: [],
        muscleSetsBefore: {},
        muscleSetsAfter: {},
      },
    };
    const editor = {
      reviewing: false,
      requestReview: vi.fn(),
      publishing: false,
      publish: vi.fn(),
      document: null,
      exerciseById: new Map(),
    } as unknown as ProgramEditorController;
    const html = renderToStaticMarkup(
      <ReviewDialog editor={editor} currentReview={review} canReview />
    );

    expect(html).toContain("Activation is blocked");
    expect(html).toContain(
      "The selected equipment cannot execute this exercise.",
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Activate new version/);
    expect(html).not.toContain("The review response is incomplete");
  });

  it("renders immutable history with current, comparison, export, and restore affordances", () => {
    const history = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        versionNo: 2,
        name: "Current Strength",
        activatedAt: "2026-07-18T12:00:00.000Z",
        source: "editor",
        summary: "Current version",
        parentVersionId: "10000000-0000-4000-8000-000000000002",
        restoredFromVersionId: null,
        sourceImportEventId: null,
        reviewHash: "b".repeat(64),
        isCurrent: true,
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        versionNo: 1,
        name: "Original Strength",
        activatedAt: "2026-07-17T12:00:00.000Z",
        source: "setup",
        summary: null,
        parentVersionId: null,
        restoredFromVersionId: null,
        sourceImportEventId: null,
        reviewHash: null,
        isCurrent: false,
      },
    ];
    const editor = {
      inspection: null,
      exerciseById: new Map(),
      inspectionHeadingRef: { current: null },
      setInspection: vi.fn(),
      comparison: null,
      draft: { history },
      inspectingId: null,
      inspectVersion: vi.fn(),
      compareVersion: vi.fn(),
      restoringId: null,
      setConfirmRestore: vi.fn(),
    } as unknown as ProgramEditorController;
    const html = renderToStaticMarkup(<HistoryPanel editor={editor} />);

    expect(html).toContain("Program versions");
    expect(html).toContain("v2 · Current Strength");
    expect(html).toContain("Current");
    expect(html).toContain("Compare with current");
    expect(html).toContain("Export v1");
    expect(html).toContain("Restore as new draft");
  });
});
