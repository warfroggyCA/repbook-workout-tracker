import { cloneElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatCompactPlateLoadGuidance } from "@/lib/exercise-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/sessions", () => ({
  correctAcknowledgedSet: vi.fn(),
  archiveSet: vi.fn(),
  skipExercise: vi.fn(),
  unskipExercise: vi.fn(),
  logPain: vi.fn(),
  saveExerciseNote: vi.fn(),
  getAlternativeOptions: vi.fn(),
  getReplacementOptions: vi.fn(),
  substituteExercise: vi.fn(),
  replaceExercise: vi.fn(),
  undoExerciseSubstitution: vi.fn(),
}));
vi.mock("@/app/actions/archive", () => ({ restoreArchiveOperation: vi.fn() }));

import {
  ExerciseCard,
  runGuardedLogRequest,
  unconfirmedSetsBlockLogging,
} from "@/components/session/exercise-card";
import type {
  SessionExerciseData,
  SessionOccurrenceData,
  SetAcknowledgementReceipt,
} from "@/components/session/types";
import type { OccurrenceMutationOutboxEntry } from "@/lib/occurrence-mutation-outbox";

const warmupSet = {
  label: "Ramp 1",
  reps: 5,
  load: 45,
  loadUnit: "lb" as const,
  loadPercent: null,
  loadText: null,
  notes: null,
};

const exercise: SessionExerciseData = {
  id: "00000000-0000-4000-8000-000000000001",
  exerciseId: "00000000-0000-4000-8000-000000000002",
  name: "Barbell Squat",
  family: "Squat",
  loadType: "barbell",
  loadSemantics: "total",
  metricType: "weight_reps",
  movementPattern: "squat",
  orderIdx: 0,
  supersetKey: null,
  restSec: 90,
  modificationType: "as_planned",
  skipReason: null,
  substitutedForExerciseId: null,
  substitutionReason: null,
  substitutedAt: null,
  plannedExerciseName: null,
  targetSets: 3,
  targetRepsMin: 6,
  targetRepsMax: 8,
  targetLoad: 95,
  targetLoadUnit: "lb",
  notes: null,
  warmupNotes: "Move smoothly",
  warmupSets: [warmupSet],
  setNotes: [],
  cautionBodyParts: [],
  media: null,
  sets: [
    { id: "pending", clientKey: "pending-key", setNo: 1, weight: 95, weightUnit: "lb", reps: 8, rpe: null, note: null, saveState: "pending" },
    {
      id: "failed",
      clientKey: "failed-key",
      setNo: 2,
      weight: 95,
      weightUnit: "lb",
      reps: 8,
      rpe: null,
      note: null,
      saveState: "failed",
      lastError: "Enter the numeric assistance or keep it in a note.",
    },
  ],
  last: null,
};

describe("ExerciseCard", () => {
  it("renders total-load, reference guidance, save-state, and note-cap presentation", () => {
    const html = renderToStaticMarkup(
      <ExerciseCard
        exercise={exercise}
        historyRevision={0}
        progress={{
          sessionExerciseId: exercise.id,
          exerciseName: exercise.name,
          total: 3,
          planned: 3,
          extra: 0,
          workoutOnly: 0,
          performed: 0,
          plannedPerformed: 0,
          extraPerformed: 0,
          workoutOnlyPerformed: 0,
          skipped: 0,
          abandoned: 0,
          pending: 3,
          legacyUnknown: 0,
          completedWithoutResult: 0,
          status: "current",
        }}
        expanded
        warmupResolved
        onToggle={() => undefined}
        plateConfigs={{
          barbell: {
            barWeight: 45,
            collarWeight: 0,
            plates: [{ denomination: 25, countPerSide: 1 }],
          },
        }}
        incrementals={{}}
        unit="lb"
        onPatch={() => undefined}
        onQueueSet={async () => true}
        onRetrySet={async () => undefined}
        onDiscardSet={async () => undefined}
        onSkipComplete={() => undefined}
        onOpenCoach={() => undefined}
        adjustIntent={null}
        onAdjustIntentChange={() => undefined}
      />
    );

    expect(html).toContain("Pending on this device");
    expect(html).toContain("Save failed");
    expect(html).toContain("Retry");
    expect(html).toContain("Discard");
    expect(html).toContain("Enter the numeric assistance or keep it in a note.");
    expect(html).toContain(
      `id="logged-set-${exercise.id}-1"`,
    );
    expect(html).toContain(
      `id="logged-set-${exercise.id}-2"`,
    );
    expect(html).toContain("0/3 planned performed · 2 saving");
    expect(html).not.toContain("Ramp 1 · 45 lb · 5 reps");
    expect(html).toContain("Warm-up guidance · reference");
    expect(html).toContain("Move smoothly");
    expect(html).toContain("Show details");
    expect(html).toContain("<details");
    expect(html).toContain("Waiting for save acknowledgement");
    expect(html).not.toContain("Use the Next set dock");
    expect(html).toContain("Workout actions");
    expect(html).toContain("Add note");
    expect(html).toContain("Pain / no issue");
    expect(html).toContain("Skip exercise");
    expect(html).toContain("Exercise progress &amp; extras");
    expect(html).toContain("More for this exercise");
    expect(html.indexOf(`id=\"logged-set-${exercise.id}-1\"`)).toBeLessThan(
      html.indexOf("Exercise progress &amp; extras"),
    );
    expect(html.indexOf("Exercise progress &amp; extras")).toBeLessThan(
      html.indexOf("Add extra set"),
    );
    expect(html.indexOf("More for this exercise")).toBeLessThan(
      html.indexOf("Workout actions"),
    );
  });

  it("labels an assisted set as assistance during the active workout", () => {
    const assistedExercise: SessionExerciseData = {
      ...exercise,
      id: "00000000-0000-4000-8000-000000000011",
      exerciseId: "00000000-0000-4000-8000-000000000012",
      name: "Assisted Pull-up",
      loadType: "bodyweight",
      loadSemantics: "assistance",
      metricType: "assisted_reps",
      targetSets: 2,
      sets: [
        {
          id: "assisted-set",
          clientKey: null,
          setNo: 1,
          weight: 80,
          weightUnit: "lb",
          reps: 8,
          metricType: "assisted_reps",
          rpe: null,
          note: null,
          saveState: "saved",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <ExerciseCard
        exercise={assistedExercise}
        historyRevision={0}
        progress={{
          sessionExerciseId: assistedExercise.id,
          exerciseName: assistedExercise.name,
          total: 2,
          planned: 2,
          extra: 0,
          workoutOnly: 0,
          performed: 1,
          plannedPerformed: 1,
          extraPerformed: 0,
          workoutOnlyPerformed: 0,
          skipped: 0,
          abandoned: 0,
          pending: 1,
          legacyUnknown: 0,
          completedWithoutResult: 0,
          status: "current",
        }}
        expanded
        onToggle={() => undefined}
        plateConfigs={{}}
        incrementals={{}}
        unit="lb"
        activeOccurrence={{
          id: "00000000-0000-4000-8000-000000000013",
          sessionExerciseId: assistedExercise.id,
          kind: "working_set",
          origin: "planned",
          sequenceIdx: 1,
          kindOrdinal: 1,
          label: null,
          plannedExerciseId: assistedExercise.exerciseId,
          plannedNote: null,
          plannedRepsMin: 6,
          plannedRepsMax: 8,
          plannedLoad: null,
          plannedLoadUnit: null,
          plannedLoadPercent: null,
          plannedLoadText: null,
          plannedRestSec: 90,
          groupSnapshotId: null,
          groupRound: null,
          groupMemberOrderIdx: null,
          outcome: "pending",
          outcomeReason: null,
          outcomeNote: null,
          revision: 0,
          resolvedAt: null,
          completedSetId: null,
        }}
        isCurrentExercise
        onPatch={() => undefined}
        onQueueSet={async () => true}
        onSkipSet={async () => true}
        onRetrySet={async () => undefined}
        onDiscardSet={async () => undefined}
        onSkipComplete={() => undefined}
        onOpenCoach={() => undefined}
        adjustIntent={null}
        onAdjustIntentChange={() => undefined}
      />,
    );
    expect(html).toContain("Assistance: 80 lb · 8 reps");
    expect(html).toContain("Previous comparable set unavailable");
    expect(html).toContain('aria-label="Assistance"');
    expect(html).not.toContain("80 lb ×");
    expect(html.indexOf("Exercise progress &amp; extras")).toBeLessThan(
      html.indexOf(`id=\"logged-set-${assistedExercise.id}-1\"`),
    );
  });

  it("renders the current planned set entry inline with effort, exact RPE, plate, log, and skip parity", () => {
    const current: SessionExerciseData = {
      ...exercise,
      sets: [],
      targetLoad: 95,
      previousComparable: {
        status: "available",
        currentSessionExerciseId: exercise.id,
        exerciseId: exercise.exerciseId,
        semantics: {
          version: 1,
          metricType: "weight_reps",
          loadType: "barbell",
          loadSemantics: "total",
          loadEntryMeaning: "total_system",
        },
        source: {
          workoutId: "00000000-0000-4000-8000-000000000050",
          localDate: "2026-08-03",
          startedAtISO: "2026-08-03T14:00:00.000Z",
          finishedAtISO: "2026-08-03T15:00:00.000Z",
          historyHref: "/history/00000000-0000-4000-8000-000000000050",
          workoutSource: "tracker",
        },
        sets: [{
          setId: "00000000-0000-4000-8000-000000000051",
          setNo: 1,
          weight: 100,
          weightUnit: "lb",
          reps: 7,
          distanceKm: null,
          durationSeconds: null,
          rpe: 8,
          rir: null,
          observedCompletedAtISO: "2026-08-03T14:20:00.000Z",
          observedCompletionProvenance: "live_client",
          observedCompletionQuality: "trustworthy",
          correctionProvenance: {
            state: "version_restored",
            count: 2,
          },
        }],
      },
    };
    const card = (
      <ExerciseCard
        exercise={current}
        historyRevision={0}
        progress={{
          sessionExerciseId: current.id,
          exerciseName: current.name,
          total: 3,
          planned: 3,
          extra: 0,
          workoutOnly: 0,
          performed: 0,
          plannedPerformed: 0,
          extraPerformed: 0,
          workoutOnlyPerformed: 0,
          skipped: 0,
          abandoned: 0,
          pending: 3,
          legacyUnknown: 0,
          completedWithoutResult: 0,
          status: "current",
        }}
        expanded
        onToggle={() => undefined}
        plateConfigs={{
          [current.id]: {
            barWeight: 45,
            collarWeight: 0,
            plates: [{ denomination: 25, countPerSide: 1 }],
          },
        }}
        incrementals={{}}
        unit="lb"
        loadEntryMeaning="total_system"
        activeOccurrence={{
          id: "00000000-0000-4000-8000-000000000003",
          sessionExerciseId: current.id,
          kind: "working_set",
          origin: "planned",
          sequenceIdx: 0,
          kindOrdinal: 0,
          label: null,
          plannedExerciseId: current.exerciseId,
          plannedNote: null,
          plannedRepsMin: 6,
          plannedRepsMax: 8,
          plannedLoad: 95,
          plannedLoadUnit: "lb",
          plannedLoadPercent: null,
          plannedLoadText: null,
          plannedRestSec: 90,
          groupSnapshotId: null,
          groupRound: null,
          groupMemberOrderIdx: null,
          outcome: "pending",
          outcomeReason: null,
          outcomeNote: null,
          revision: 0,
          resolvedAt: null,
          completedSetId: null,
        }}
        isCurrentExercise
        nextActionLabel="Barbell Squat, set 2"
        onPatch={() => undefined}
        onQueueSet={async () => true}
        onSkipSet={async () => true}
        onRetrySet={async () => undefined}
        onDiscardSet={async () => undefined}
        onSkipComplete={() => undefined}
        onOpenCoach={() => undefined}
        adjustIntent={null}
        onAdjustIntentChange={() => undefined}
      />
    );
    const html = renderToStaticMarkup(card);

    expect(html).toContain(
      `id="set-entry-${current.id}-00000000-0000-4000-8000-000000000003"`,
    );
    expect(html).toContain("Total load");
    expect(html).toContain("Per side: 25 lb");
    expect(html).toContain("Enter exact RPE instead");
    expect(html).toContain("Easy — RPE 6");
    expect(html).toContain("OK — RPE 7");
    expect(html).toContain("Hard — RPE 8");
    expect(html).toContain("Grind — RPE 9.5");
    expect(html).toContain('role="group" aria-label="Effort shortcuts"');
    for (const shortcut of ["Easy", "OK", "Hard", "Grind"]) {
      expect(html).toMatch(
        new RegExp(`aria-label="${shortcut}[^\"]*" aria-pressed="false"`),
      );
    }
    expect(html).toContain("Current action");
    expect(html).toContain("Previous · 2026-08-03 · Version restored ×2");
    expect(html).toContain('data-comparison-state="available"');
    expect(html).toContain("100 lb × 7 reps · source set 1");
    expect(html).toContain('aria-label="Total load"');
    expect(html).toContain('value="95"');
    expect(html).toContain("View source workout");
    expect(html).toContain(
      'href="/history/00000000-0000-4000-8000-000000000050"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Performed measure");
    expect(html).toContain("Barbell Squat, set 2");
    expect(html).toContain("Optional effort and set note");
    expect(html).toContain("RIR (0–10)");
    expect(html).toContain("Technique issue");
    expect(html).toContain("What limited this set?");
    expect(html).toContain("No flag means unknown, not “no pain.”");
    expect(html).toContain("Record pain");
    expect(html).not.toContain('aria-label="Pain severity 1"');
    expect(html).toContain("Set exceptions");
    expect(html).toContain("Set options");
    expect(html).toContain("Exercise progress &amp; extras");
    expect(html).toContain("More for this exercise");
    expect(html.indexOf("Current action")).toBeLessThan(
      html.indexOf("Previous ·"),
    );
    expect(html.indexOf("Previous ·")).toBeLessThan(
      html.indexOf("Performed measure"),
    );
    expect(html.indexOf("Performed measure")).toBeLessThan(
      html.indexOf("Next action"),
    );
    expect(html.indexOf("Next action")).toBeLessThan(
      html.indexOf("Set exceptions"),
    );
    expect(html.indexOf("Current action")).toBeLessThan(
      html.indexOf("Warm-up guidance"),
    );
    expect(html.match(/Log set/g)).toHaveLength(1);
    expect(html).toContain("Ask Coach gives guidance");
    expect(html).toContain("Change exercise for this workout");
    expect(html).toContain("Compatible alternatives");
    expect(html).toContain("Replace exercise");
    expect(html).toContain("without similarity ranking");
    expect(html).toContain("Log set");
    expect(html).toContain("Skip set");
    expect(html).toContain("Add extra set");
    expect(html).toContain(
      "Adds ad-hoc work without changing the planned set order.",
    );

    const unavailableHtml = renderToStaticMarkup(cloneElement(card, {
      comparisonTemporarilyUnavailable: true,
    }));
    expect(unavailableHtml).toContain('data-comparison-state="loading"');
    expect(unavailableHtml).toContain("Checking previous comparable set…");
    expect(unavailableHtml).not.toContain("100 lb × 7 reps");
    expect(unavailableHtml).toContain('aria-label="Total load"');
    expect(unavailableHtml).toContain('value="95"');
  });

  it("keeps the planned occurrence number after an earlier set is skipped", () => {
    const afterSkippedSecond = {
      ...exercise,
      sets: [
        { id: "saved-first", clientKey: "first-key", setNo: 1, weight: 95, weightUnit: "lb" as const, reps: 8, rpe: null, note: null, saveState: "saved" as const },
      ],
    };
    const renderCard = (
      acknowledgementReceipt: SetAcknowledgementReceipt | null = null,
      nextActionLabel: string | null = "Workout complete",
    ) => renderToStaticMarkup(
      <ExerciseCard
        exercise={afterSkippedSecond}
        historyRevision={0}
        progress={{
          sessionExerciseId: afterSkippedSecond.id,
          exerciseName: afterSkippedSecond.name,
          total: 3,
          planned: 3,
          extra: 0,
          workoutOnly: 0,
          performed: 1,
          plannedPerformed: 1,
          extraPerformed: 0,
          workoutOnlyPerformed: 0,
          skipped: 1,
          abandoned: 0,
          pending: 1,
          legacyUnknown: 0,
          completedWithoutResult: 0,
          status: "current",
        }}
        expanded
        onToggle={() => undefined}
        plateConfigs={{}}
        incrementals={{}}
        unit="lb"
        activeOccurrence={{
          id: "00000000-0000-4000-8000-000000000004",
          sessionExerciseId: afterSkippedSecond.id,
          kind: "working_set",
          origin: "planned",
          sequenceIdx: 2,
          kindOrdinal: 2,
          label: null,
          plannedExerciseId: afterSkippedSecond.exerciseId,
          plannedNote: null,
          plannedRepsMin: 6,
          plannedRepsMax: 8,
          plannedLoad: 95,
          plannedLoadUnit: "lb",
          plannedLoadPercent: null,
          plannedLoadText: null,
          plannedRestSec: 90,
          groupSnapshotId: null,
          groupRound: null,
          groupMemberOrderIdx: null,
          outcome: "pending",
          outcomeReason: null,
          outcomeNote: null,
          revision: 0,
          resolvedAt: null,
          completedSetId: null,
        }}
        acknowledgementReceipt={acknowledgementReceipt}
        isCurrentExercise
        nextActionLabel={nextActionLabel}
        onPatch={() => undefined}
        onQueueSet={async () => true}
        onSkipSet={async () => true}
        onRetrySet={async () => undefined}
        onDiscardSet={async () => undefined}
        onSkipComplete={() => undefined}
        onOpenCoach={() => undefined}
        adjustIntent={null}
        onAdjustIntentChange={() => undefined}
      />
    );
    const html = renderCard();

    expect(html).toContain("Set 3 of 3");
    expect(html).toContain(
      `id="active-set-save-receipt-${afterSkippedSecond.id}-1"`,
    );
    expect(html).toContain("Saved · Set 1");
    expect(html).toContain("Acknowledged by Repbook");
    expect(html).toContain("Wrong value? Correct the saved set");
    expect(html).toContain("Correct set");
    expect(html).toContain(
      `id="set-entry-${afterSkippedSecond.id}-00000000-0000-4000-8000-000000000004"`,
    );
    expect(html).toContain("Set 2");

    const sourceExerciseId = "00000000-0000-4000-8000-000000000030";
    const crossExerciseHtml = renderCard(
      {
        sessionExerciseId: sourceExerciseId,
        exerciseName: "Barbell Bench Press",
        metricType: "weight_reps",
        set: {
          id: "acknowledged-third",
          clientKey: "acknowledged-third-key",
          setNo: 3,
          weight: 135,
          weightUnit: "lb",
          reps: 8,
          metricType: "weight_reps",
          rpe: null,
          note: null,
          saveState: "saved",
        },
      },
      null,
    );
    expect(crossExerciseHtml).toContain(
      `id="active-set-save-receipt-${sourceExerciseId}-3"`,
    );
    expect(crossExerciseHtml).toContain(
      "Saved · Barbell Bench Press · Set 3",
    );
    expect(crossExerciseHtml).toContain("135 lb × 8 reps");
    expect(crossExerciseHtml).toContain("Acknowledged by Repbook");
  });

  it("names and links the exact earlier occurrence that blocks a retained attempt", () => {
    const blockerOccurrence: SessionOccurrenceData = {
      id: "60000000-0000-4000-8000-000000000001",
      sessionExerciseId: exercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      label: null,
      plannedExerciseId: exercise.exerciseId,
      plannedNote: null,
      plannedRepsMin: 6,
      plannedRepsMax: 8,
      plannedLoad: 95,
      plannedLoadUnit: "lb",
      plannedLoadPercent: null,
      plannedLoadText: null,
      plannedRestSec: 90,
      groupSnapshotId: null,
      groupRound: null,
      groupMemberOrderIdx: null,
      outcome: "pending",
      outcomeReason: null,
      outcomeNote: null,
      revision: 0,
      resolvedAt: null,
      completedSetId: null,
    };
    const failedAttempt: SessionExerciseData = {
      ...exercise,
      sets: [{
        id: "failed-order-attempt",
        clientKey: "failed-order-key",
        setNo: 2,
        weight: 95,
        weightUnit: "lb",
        reps: 8,
        rpe: null,
        note: null,
        saveState: "failed",
        lastError: "Finish or skip the earlier set first.",
      }],
    };
    const baseProps = {
      exercise: failedAttempt,
      historyRevision: 0,
      progress: {
        sessionExerciseId: failedAttempt.id,
        exerciseName: failedAttempt.name,
        total: 3,
        planned: 3,
        extra: 0,
        workoutOnly: 0,
        performed: 0,
        plannedPerformed: 0,
        extraPerformed: 0,
        workoutOnlyPerformed: 0,
        skipped: 0,
        abandoned: 0,
        pending: 3,
        legacyUnknown: 0,
        completedWithoutResult: 0,
        status: "current" as const,
      },
      expanded: true,
      onToggle: () => undefined,
      plateConfigs: {},
      incrementals: {},
      unit: "lb" as const,
      activeOccurrence: blockerOccurrence,
      workingOccurrences: [blockerOccurrence],
      isCurrentExercise: true,
      nextActionLabel: "Barbell Squat, Set 2",
      onPatch: () => undefined,
      onQueueSet: async () => true,
      onRetrySet: async () => undefined,
      onDiscardSet: async () => undefined,
      onSkipComplete: () => undefined,
      onOpenCoach: () => undefined,
      adjustIntent: null,
      onAdjustIntentChange: () => undefined,
    };
    const exact = renderToStaticMarkup(
      <ExerciseCard
        {...baseProps}
        setOrderBlockers={{
          "failed-order-key": {
            blockerOccurrenceId: blockerOccurrence.id,
            blockerExerciseName: "Barbell Squat",
            blockerLabel: "Set 1",
            blockerTargetId:
              `set-entry-${failedAttempt.id}-${blockerOccurrence.id}`,
          },
        }}
        onRevealBlocker={() => undefined}
        onRefreshWorkout={() => undefined}
      />,
    );

    expect(exact).toContain("Barbell Squat · Set 1 comes first");
    expect(exact).toContain("Go to Set 1");
    expect(exact).not.toContain("Retry save");
    expect(exact).toContain("Discard device copy");
    expect(exact).not.toContain("Refresh workout");
    expect(exact).toContain('data-testid="current-set-entry"');
    const exactLogButton = exact.match(
      /<button[^>]*data-testid="active-log-set"[^>]*>/,
    )?.[0];
    expect(exactLogButton).toBeDefined();
    expect(exactLogButton).not.toMatch(/\sdisabled(?:=|>|\s)/);
    expect(exact.indexOf("Current action")).toBeLessThan(
      exact.indexOf("Save failed"),
    );

    const mismatched = renderToStaticMarkup(
      <ExerciseCard
        {...baseProps}
        setOrderBlockers={{
          "failed-order-key": {
            blockerOccurrenceId: "60000000-0000-4000-8000-000000000099",
            blockerExerciseName: "Barbell Squat",
            blockerLabel: "Set 1",
            blockerTargetId: "set-entry-mismatched",
          },
        }}
        onRevealBlocker={() => undefined}
        onRefreshWorkout={() => undefined}
      />,
    );
    expect(mismatched).not.toContain('data-testid="current-set-entry"');
    expect(mismatched).toContain("Waiting for save acknowledgement");

    const fallback = renderToStaticMarkup(
      <ExerciseCard
        {...baseProps}
        onRefreshWorkout={() => undefined}
      />,
    );
    expect(fallback).toContain(
      "Workout order changed. Refresh to find the exact set that comes first.",
    );
    expect(fallback).toContain("Refresh workout");
    expect(fallback).not.toContain("Finish or skip the earlier set first.");

    const stale = renderToStaticMarkup(
      <ExerciseCard
        {...baseProps}
        setReviewRequired={{ "failed-order-key": true }}
        onRefreshWorkout={() => undefined}
      />,
    );
    expect(stale).toContain("based on an older workout state");
    expect(stale).toContain("Refresh workout");
    expect(stale).not.toContain("Retry it, or discard it");
    expect(stale).not.toContain("Retry save");
  });

  it("keeps the exact working-set row visible while a skip saves and after it is acknowledged", () => {
    const current = { ...exercise, sets: [] };
    const occurrence = {
      id: "00000000-0000-4000-8000-000000000021",
      sessionExerciseId: current.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      label: null,
      plannedExerciseId: current.exerciseId,
      plannedNote: null,
      plannedRepsMin: 6,
      plannedRepsMax: 8,
      plannedLoad: 95,
      plannedLoadUnit: "lb",
      plannedLoadPercent: null,
      plannedLoadText: null,
      plannedRestSec: 90,
      groupSnapshotId: null,
      groupRound: null,
      groupMemberOrderIdx: null,
      outcome: "pending",
      outcomeReason: null,
      outcomeNote: null,
      revision: 0,
      resolvedAt: null,
      completedSetId: null,
    } satisfies SessionOccurrenceData;
    const mutation = {
      clientKey: "00000000-0000-4000-8000-000000000022",
      ownerId: "00000000-0000-4000-8000-000000000023",
      sessionId: "00000000-0000-4000-8000-000000000024",
      occurrenceId: occurrence.id,
      label: "Working set",
      expectedRevision: 0,
      operation: "skip",
      reason: "time",
      note: null,
      createdAtISO: "2026-07-29T12:00:00.000Z",
      status: "queued",
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    } satisfies OccurrenceMutationOutboxEntry;
    const common = {
      exercise: current,
      historyRevision: 0,
      progress: {
        sessionExerciseId: current.id,
        exerciseName: current.name,
        total: 3,
        planned: 3,
        extra: 0,
        workoutOnly: 0,
        performed: 0,
        plannedPerformed: 0,
        extraPerformed: 0,
        workoutOnlyPerformed: 0,
        skipped: 0,
        abandoned: 0,
        pending: 3,
        legacyUnknown: 0,
        completedWithoutResult: 0,
        status: "current" as const,
      },
      expanded: true,
      onToggle: () => undefined,
      plateConfigs: {},
      incrementals: {},
      unit: "lb" as const,
      isCurrentExercise: true,
      onPatch: () => undefined,
      onQueueSet: async () => true,
      onSkipSet: async () => true,
      onRetrySet: async () => undefined,
      onDiscardSet: async () => undefined,
      onSkipComplete: () => undefined,
      onOpenCoach: () => undefined,
      adjustIntent: null,
      onAdjustIntentChange: () => undefined,
    };

    const saving = renderToStaticMarkup(
      <ExerciseCard
        {...common}
        activeOccurrence={occurrence}
        workingOccurrences={[occurrence]}
        occurrenceMutationEntries={[mutation]}
        occurrenceRuntimeSaveStates={{ [mutation.clientKey]: "saving" }}
      />,
    );
    expect(saving).toContain(
      `id="set-entry-${current.id}-${occurrence.id}"`,
    );
    expect(saving).toContain("Skip · Saving");
    expect(saving).toContain("Discard device copy");

    const skipped = {
      ...occurrence,
      outcome: "skipped",
      outcomeReason: "time",
      revision: 1,
      resolvedAt: "2026-07-29T12:00:01.000Z",
    } satisfies SessionOccurrenceData;
    const saved = renderToStaticMarkup(
      <ExerciseCard
        {...common}
        activeOccurrence={null}
        workingOccurrences={[skipped]}
        acknowledgedOccurrenceIds={[skipped.id]}
      />,
    );
    expect(saved).toContain("Set 1");
    expect(saved).toContain("skipped");
    expect(saved).toContain("Saved");
    expect(saved.indexOf("Set 1")).toBeLessThan(
      saved.indexOf("Exercise progress &amp; extras"),
    );
  });

  it("does not reinterpret a pre-existing ad-hoc occurrence as an appended set", () => {
    const current = { ...exercise, sets: [] };
    const legacyAdHoc = {
      id: "00000000-0000-4000-8000-000000000004",
      sessionExerciseId: current.id,
      kind: "working_set" as const,
      origin: "ad_hoc" as const,
      sequenceIdx: 3,
      kindOrdinal: 3,
      label: null,
      plannedExerciseId: current.exerciseId,
      plannedNote: null,
      plannedRepsMin: 6,
      plannedRepsMax: 8,
      plannedLoad: 95,
      plannedLoadUnit: "lb" as const,
      plannedLoadPercent: null,
      plannedLoadText: null,
      plannedRestSec: 90,
      groupSnapshotId: null,
      groupRound: null,
      groupMemberOrderIdx: null,
      outcome: "pending" as const,
      outcomeReason: null,
      outcomeNote: null,
      revision: 0,
      resolvedAt: null,
      completedSetId: null,
    };
    const html = renderToStaticMarkup(
      <ExerciseCard
        exercise={current}
        historyRevision={0}
        progress={{
          sessionExerciseId: current.id,
          exerciseName: current.name,
          total: 4,
          planned: 4,
          extra: 0,
          workoutOnly: 0,
          performed: 0,
          plannedPerformed: 0,
          extraPerformed: 0,
          workoutOnlyPerformed: 0,
          skipped: 0,
          abandoned: 0,
          pending: 4,
          legacyUnknown: 0,
          completedWithoutResult: 0,
          status: "current",
        }}
        expanded
        onToggle={() => undefined}
        plateConfigs={{}}
        incrementals={{}}
        unit="lb"
        workingOccurrences={[legacyAdHoc]}
        onPatch={() => undefined}
        onQueueSet={async () => true}
        onRetrySet={async () => undefined}
        onDiscardSet={async () => undefined}
        onSkipComplete={() => undefined}
        onOpenCoach={() => undefined}
        adjustIntent={null}
        onAdjustIntentChange={() => undefined}
      />,
    );

    expect(html).not.toContain("Added to this workout");
    expect(html).toContain("Add extra set");
    expect(html).toContain(
      "Adds ad-hoc work without changing the planned set order.",
    );
  });
});

describe("order-conflict logging gate", () => {
  const retainedLaterSet = {
    id: "optimistic-later",
    clientKey: "70000000-0000-4000-8000-000000000002",
    setNo: 2,
    weight: 95,
    weightUnit: "lb" as const,
    reps: 8,
    rpe: null,
    note: null,
    saveState: "failed" as const,
  };

  it("allows only the exact authoritative blocker to be logged first", () => {
    const blockerOccurrenceId = "60000000-0000-4000-8000-000000000001";
    const blockers = {
      [retainedLaterSet.clientKey]: {
        blockerOccurrenceId,
        blockerLabel: "Set 1",
      },
    };

    expect(unconfirmedSetsBlockLogging({
      sets: [retainedLaterSet],
      targetOccurrenceId: blockerOccurrenceId,
      blockers,
    })).toBe(false);
    expect(unconfirmedSetsBlockLogging({
      sets: [retainedLaterSet],
      targetOccurrenceId: "60000000-0000-4000-8000-000000000003",
      blockers,
    })).toBe(true);
  });
});

describe("rapid Log set request guard", () => {
  it("creates only one enqueue identity for two immediate invocations", async () => {
    const inFlight = new Set<string>();
    const clientKeys: string[] = [];
    let releaseFirst!: () => void;
    const firstEnqueue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runGuardedLogRequest(inFlight, "occurrence-1", async () => {
      clientKeys.push("client-key-1");
      await firstEnqueue;
      return true;
    });
    const duplicate = await runGuardedLogRequest(
      inFlight,
      "occurrence-1",
      async () => {
        clientKeys.push("client-key-2");
        return true;
      },
    );

    expect(duplicate).toEqual({ started: false });
    expect(clientKeys).toEqual(["client-key-1"]);
    expect(inFlight.has("occurrence-1")).toBe(true);

    releaseFirst();
    await expect(first).resolves.toEqual({ started: true, value: true });
    expect(inFlight.size).toBe(0);
  });
});

describe("compact plate load guidance", () => {
  const plateConfig = {
    barWeight: 45,
    collarWeight: 0,
    plates: [{ denomination: 25, countPerSide: 1 }],
  };

  it("leads with per-side plates and names the bare base only without them", () => {
    expect(formatCompactPlateLoadGuidance(95, plateConfig, "lb")).toBe(
      "Per side: 25 lb"
    );
    expect(formatCompactPlateLoadGuidance(45, plateConfig, "lb")).toBe(
      "Empty bar and collars: 45 lb"
    );
  });

  it("names every available neighbouring load instead of an impossible one", () => {
    expect(formatCompactPlateLoadGuidance(100, plateConfig, "lb")).toBe(
      "Not loadable · nearest lower 95 lb"
    );
    expect(formatCompactPlateLoadGuidance(70, plateConfig, "lb")).toBe(
      "Not loadable · nearest lower 45 lb · upper 95 lb"
    );
  });

  it("stays silent without a bar configuration or a weight", () => {
    expect(formatCompactPlateLoadGuidance(95, undefined, "lb")).toBeNull();
    expect(formatCompactPlateLoadGuidance(null, plateConfig, "lb")).toBeNull();
  });
});
