import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatWarmupSetLine } from "@/lib/warmup";
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

import { ExerciseCard } from "@/components/session/exercise-card";
import type {
  SessionExerciseData,
  SessionOccurrenceData,
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
  it("renders total-load, shared warm-up, save-state, and note-cap presentation", () => {
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
    expect(html).toContain(formatWarmupSetLine(warmupSet));
    expect(html).toContain("Warm-up complete");
    expect(html).toContain("Show details");
    expect(html).toContain("<details");
    expect(html).toContain("Waiting for save acknowledgement");
    expect(html).not.toContain("Use the Next set dock");
    expect(html).toContain("Workout actions");
    expect(html).toContain("Add note");
    expect(html).toContain("Flag pain");
    expect(html).toContain("Skip exercise");
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
          restAfterSec: 90,
        }}
        isCurrentExercise
        onPatch={() => undefined}
        onQueueSet={async () => true}
        onPrepareRestCue={() => undefined}
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
    expect(html).toContain('aria-label="Assistance"');
    expect(html).not.toContain("80 lb ×");
  });

  it("renders the current planned set entry inline with effort, exact RPE, plate, log, and skip parity", () => {
    const current = { ...exercise, sets: [] };
    const html = renderToStaticMarkup(
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
          restAfterSec: 90,
        }}
        isCurrentExercise
        onPatch={() => undefined}
        onQueueSet={async () => true}
        onPrepareRestCue={() => undefined}
        onSkipSet={async () => true}
        onRetrySet={async () => undefined}
        onDiscardSet={async () => undefined}
        onSkipComplete={() => undefined}
        onOpenCoach={() => undefined}
        adjustIntent={null}
        onAdjustIntentChange={() => undefined}
      />
    );

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
    expect(html).toContain("Current exercise");
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
  });

  it("keeps the planned occurrence number after an earlier set is skipped", () => {
    const afterSkippedSecond = {
      ...exercise,
      sets: [
        { id: "saved-first", clientKey: "first-key", setNo: 1, weight: 95, weightUnit: "lb" as const, reps: 8, rpe: null, note: null, saveState: "saved" as const },
      ],
    };
    const html = renderToStaticMarkup(
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
          restAfterSec: 90,
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
      />
    );

    expect(html).toContain("Set 3 of 3");
    expect(html).toContain(
      `id="set-entry-${afterSkippedSecond.id}-00000000-0000-4000-8000-000000000004"`,
    );
    expect(html).toContain("Set 2");
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
      restAfterSec: 90,
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
    expect(saving).toContain("Discard unsaved change");

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
      restAfterSec: 90,
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
