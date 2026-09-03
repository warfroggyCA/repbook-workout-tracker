import { cloneElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  exerciseSwipeRevealsRemove,
  formatCompactPlateLoadGuidance,
} from "@/lib/exercise-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/sessions", () => ({
  correctAcknowledgedSet: vi.fn(),
  archiveSet: vi.fn(),
  confirmExerciseUnskipped: vi.fn(),
  skipExercise: vi.fn(),
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
  cachedDraftProtectsPreviousWeight,
  ExerciseCard,
  hydratePreviousComparableWeight,
  parseFiniteDraftNumber,
  runGuardedLogRequest,
  unconfirmedSetsBlockLogging,
} from "@/components/session/exercise-card";
import type {
  SessionExerciseData,
  SessionOccurrenceData,
} from "@/components/session/types";
import type { OccurrenceMutationOutboxEntry } from "@/lib/occurrence-mutation-outbox";
import { ADDED_WORKOUT_SET_NOTE } from "@/lib/session-occurrences";

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

function workingOccurrenceFor(
  exerciseData: SessionExerciseData,
  kindOrdinal: number,
  overrides: Partial<SessionOccurrenceData> = {},
): SessionOccurrenceData {
  return {
    id: `90000000-0000-4000-8000-${String(kindOrdinal + 1).padStart(12, "0")}`,
    sessionExerciseId: exerciseData.id,
    kind: "working_set",
    origin: "planned",
    sequenceIdx: kindOrdinal,
    kindOrdinal,
    label: null,
    plannedExerciseId: exerciseData.exerciseId,
    plannedNote: null,
    plannedRepsMin: exerciseData.targetRepsMin,
    plannedRepsMax: exerciseData.targetRepsMax,
    plannedLoad: exerciseData.targetLoad,
    plannedLoadUnit: exerciseData.targetLoadUnit,
    plannedLoadPercent: null,
    plannedLoadText: null,
    plannedRestSec: exerciseData.restSec,
    groupSnapshotId: null,
    groupRound: null,
    groupMemberOrderIdx: null,
    outcome: "pending",
    outcomeReason: null,
    outcomeNote: null,
    revision: 0,
    resolvedAt: null,
    completedSetId: null,
    ...overrides,
  };
}

describe("ExerciseCard", () => {
  it("never replaces a valid controlled draft number with a non-finite value", () => {
    expect(parseFiniteDraftNumber("77", null)).toBe(77);
    expect(parseFiniteDraftNumber("", 77)).toBeNull();
    expect(parseFiniteDraftNumber("NaN", 77)).toBe(77);
    expect(parseFiniteDraftNumber("1e309", 77)).toBe(77);
    expect(parseFiniteDraftNumber(".", 77)).toBe(77);
    expect(parseFiniteDraftNumber("NaN", null)).toBeNull();
  });

  it("hydrates a compatible previous load only into an untouched blank draft", () => {
    const blank = {
      weight: null,
      weightUnit: null,
      reps: 8,
      distanceKm: null,
      durationSeconds: null,
      rpe: null,
      rir: null,
      techniqueIssue: null,
      limitationCause: null,
      pain: null,
      note: "",
    } as const;

    expect(hydratePreviousComparableWeight({
      draft: { ...blank, reps: 9, rpe: 7 },
      weight: 115,
      unit: "lb",
      source: "Previous comparable set",
      protectedDraft: false,
      edited: false,
    })).toMatchObject({ weight: 115, weightUnit: "lb", reps: 9, rpe: 7 });
    expect(hydratePreviousComparableWeight({
      draft: { ...blank },
      weight: 115,
      unit: "lb",
      source: "Previous comparable set",
      protectedDraft: false,
      edited: true,
    })).toEqual(blank);
    expect(hydratePreviousComparableWeight({
      draft: { ...blank },
      weight: 115,
      unit: "lb",
      source: "Previous comparable set",
      protectedDraft: true,
      edited: false,
    })).toEqual(blank);
    expect(hydratePreviousComparableWeight({
      draft: { ...blank, weight: 120, weightUnit: "lb" },
      weight: 115,
      unit: "lb",
      source: "Previous comparable set",
      protectedDraft: false,
      edited: false,
    })).toMatchObject({ weight: 120, weightUnit: "lb" });
  });

  it("keeps a reps-only cached draft eligible for previous-load hydration after a remount", () => {
    const cachedRepsOnlyDraft = {
      weight: null,
      weightUnit: null,
      reps: 9,
      distanceKm: null,
      durationSeconds: null,
      rpe: 7,
      rir: null,
      techniqueIssue: null,
      limitationCause: null,
      pain: null,
      note: "Felt steady",
    } as const;

    expect(cachedDraftProtectsPreviousWeight({ weightEdited: false }))
      .toBe(false);
    expect(hydratePreviousComparableWeight({
      draft: cachedRepsOnlyDraft,
      weight: 115,
      unit: "lb",
      source: "Previous comparable set",
      protectedDraft: cachedDraftProtectsPreviousWeight({
        weightEdited: false,
      }),
      edited: false,
    })).toMatchObject({
      weight: 115,
      weightUnit: "lb",
      reps: 9,
      rpe: 7,
      note: "Felt steady",
    });
    expect(cachedDraftProtectsPreviousWeight({ weightEdited: true }))
      .toBe(true);
  });

  it("requires a deliberate horizontal swipe before revealing removal", () => {
    expect(exerciseSwipeRevealsRemove({ deltaX: -63, deltaY: 0 })).toBe(false);
    expect(exerciseSwipeRevealsRemove({ deltaX: -80, deltaY: 70 })).toBe(false);
    expect(exerciseSwipeRevealsRemove({ deltaX: -80, deltaY: 12 })).toBe(true);
    expect(exerciseSwipeRevealsRemove({ deltaX: 90, deltaY: 0 })).toBe(false);
  });

  it("fences the visible un-skip action with the current history revision", () => {
    const source = readFileSync(
      "src/components/session/exercise-card.tsx",
      "utf8",
    );
    expect(source).toContain(
      "withDocumentActionDeadline(\n                      confirmExerciseUnskipped({",
    );
    expect(source).toContain("expectedHistoryRevision: historyRevision");
    expect(source).toContain("onHistoryRevisionChange(result.historyRevision)");
    expect(source).toContain("if (reportDeploymentMismatch(error)) return");
    expect(source).toContain("reportDocumentActionTimeout()");
    expect(source).toContain(
      "withDocumentActionDeadline(\n                      skipExercise({",
    );
    expect(source).not.toContain("await unskipExercise(");
    expect(source).toContain("Checking saved skip…");
    expect(source).toContain("!skipRecoverySettlementPending");
    expect(source).toContain("Remove from today");
    expect(source).toContain(
      "transition-transform motion-reduce:transition-none",
    );
    const drawerSource = readFileSync("src/components/ui/drawer.tsx", "utf8");
    expect(drawerSource.match(/motion-reduce:transition-none/g)).toHaveLength(2);
    expect(drawerSource.match(/motion-reduce:duration-0/g)).toHaveLength(2);
    expect(source).toContain(
      "Completed sets stay in workout history. The saved routine is unchanged.",
    );
    expect(source).toContain(
      "expectedHistoryRevision: resultHistoryRevision",
    );
    expect(source).toContain("restored to today");
    expect(source).toContain("Remove from future");
    expect(source).toContain(
      "nothing changes in future workouts",
    );
  });

  it("keeps both read-only exercise catalogs abortable and retryable", () => {
    const source = readFileSync(
      "src/components/session/exercise-card.tsx",
      "utf8",
    );
    expect(source).toContain('mode: "alternative"');
    expect(source).toContain('mode: "replacement"');
    expect(source).toContain("loadAbortRef.current?.abort");
    expect(source).toContain("Try loading catalog again");
    expect(source).toContain("generation !== loadGenerationRef.current");
    expect(source).toContain("reconcileOnNextLoadRef.current = true");
    expect(source).toContain("reconcileOnNextLoadRef.current = false");
    expect(source).toContain("setReconciliationRequired(true)");
    expect(source).toContain("setReconciliationRequired(false)");
    expect(source).toContain("onLoadedRef.current?.(result)");
    expect(source).toContain("if (reconcileOnNextLoadRef.current) return");
    expect(source).toContain("Try updating workout again");
    expect(source).toContain("Back to Today");
    expect(source.match(
      /buttonVariants\(\{ variant: "outline", size: "touch" \}\)/g,
    )).toHaveLength(2);
    expect(source).toContain("catalog.retryLoad()");
    expect(source).not.toContain(
      'if (result.code === "replacement_stale") {\n                      mutationRef.current = null;\n                      const controller = new AbortController()',
    );
  });

  it("renders total-load, reference guidance, save-state, and note-cap presentation", () => {
    const occurrences = [0, 1, 2].map((index) =>
      workingOccurrenceFor(exercise, index),
    );
    const exerciseWithLinkedDeviceSets = {
      ...exercise,
      sets: [
        ...exercise.sets.map((set, index) => ({
          ...set,
          occurrenceId: occurrences[index].id,
          ...(index === 0
            ? {
                rpe: 8,
                rir: 2,
                techniqueIssue: "control" as const,
                limitationCause: "grip" as const,
                pain: {
                  bodyPart: "wrist" as const,
                  severity: 3,
                  note: "Sharp on the last rep",
                },
                note: "Keep the brace",
              }
            : {}),
        })),
        {
          id: "unlinked-saved-set",
          clientKey: null,
          occurrenceId: null,
          setNo: 3,
          weight: 95,
          weightUnit: "lb" as const,
          reps: 8,
          rpe: 9.5,
          rir: 0,
          techniqueIssue: "tempo" as const,
          limitationCause: "breathing_conditioning" as const,
          pain: {
            bodyPart: "shoulder" as const,
            severity: 4,
            note: "Pinched at the bottom",
          },
          note: "Unknown-row exact note",
          saveState: "saved" as const,
          correctionCount: 1,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <ExerciseCard
        exercise={exerciseWithLinkedDeviceSets}
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
        activeOccurrence={occurrences[2]}
        workingOccurrences={occurrences}
        isCurrentExercise
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

    expect(html).toContain("Unsaved on this device");
    expect(html).toContain("Save failed");
    expect(html).toContain("Retry");
    expect(html).toContain("Discard");
    expect(html).toContain("Enter the numeric assistance or keep it in a note.");
    expect(html).toContain('data-set-row-state="retained_locally"');
    expect(html).toContain('data-set-row-state="failed"');
    expect(html).toContain("0 of 3 sets · 1 saving · 1 needs attention");
    expect(html).toContain("Keep the brace");
    expect(html).toContain("Effort: Hard");
    expect(html).toContain("RIR 2");
    expect(html).toContain("Technique: Control");
    expect(html).toContain("Limited by: Grip");
    expect(html).toContain("Pain: wrist 3/10");
    expect(html).toContain("Pain note: Sharp on the last rep");
    expect(html).toContain("0 completed");
    expect(html).toContain("Recorded set 3");
    expect(html).toContain("cannot be presented as saved");
    expect(html).toContain("Unknown-row exact note");
    expect(html).toContain("Effort: Grind");
    expect(html).toContain("RIR 0");
    expect(html).toContain("Technique: Tempo");
    expect(html).toContain("Limited by: Breathing or conditioning");
    expect(html).toContain("Pain: shoulder 4/10");
    expect(html).toContain("Pain note: Pinched at the bottom");
    expect(html).not.toContain("Acknowledged by Repbook");
    expect(html).not.toContain('aria-label="Archive set"');
    expect(html).not.toContain("Ramp 1 · 45 lb · 5 reps");
    expect(html).toContain("Warm-up guidance · reference");
    expect(html).toContain("Move smoothly");
    expect(html).toContain("Show details");
    expect(html).toContain("<details");
    expect(html).toContain('data-set-row-state="current_editable"');
    expect(html).not.toContain("Use the Next set dock");
    expect(html).toContain("Workout actions");
    expect(html).toContain("Add note");
    expect(html).toContain("Pain / no issue");
    expect(html).toContain("Skip exercise");
    expect(html).toContain("Remove from today");
    expect(html).toContain("do not rewrite the saved Program");
    expect(html).toContain("Completed sets");
    expect(html).toContain("More for this exercise");
    expect(html.indexOf('data-testid="active-set-ledger"')).toBeLessThan(
      html.indexOf("More for this exercise"),
    );
    expect(html.indexOf("Add extra set")).toBeLessThan(
      html.indexOf("More for this exercise"),
    );
    expect(html.indexOf("More for this exercise")).toBeLessThan(
      html.indexOf("Workout actions"),
    );
  });

  it("names an exercise preparation blocker and links to its exact action", () => {
    const html = renderToStaticMarkup(
      <ExerciseCard
        exercise={{ ...exercise, sets: [] }}
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
          status: "not_started",
        }}
        expanded
        onToggle={() => undefined}
        plateConfigs={{}}
        incrementals={{}}
        unit="lb"
        preparationBlocker={{
          blockerOccurrenceId: "00000000-0000-4000-8000-000000000020",
          blockerLabel: "preparation set",
          blockerExerciseName: "Barbell Squat",
          blockerTargetId:
            "warmup-occurrence-00000000-0000-4000-8000-000000000020",
        }}
        onRevealBlocker={() => undefined}
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

    expect(html).toContain("Complete Barbell Squat preparation set first");
    expect(html).toContain("Go to preparation set");
    expect(html).toContain("Starting load: 95 lb · Program target");
    expect(html).not.toContain("Reach this set in the workout flow");
  });

  it("wraps a long active title without repeating comparable performance in the header", () => {
    const html = renderToStaticMarkup(
      <ExerciseCard
        exercise={{
          ...exercise,
          name: "Single-Arm Overhead Cable Triceps Extension With Rope Attachment",
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
              localDate: "2026-08-10",
              startedAtISO: "2026-08-10T11:00:00.000Z",
              finishedAtISO: "2026-08-10T12:00:00.000Z",
              historyHref: "/history/00000000-0000-4000-8000-000000000050",
              workoutSource: "tracker",
            },
            sets: [{
              setId: "00000000-0000-4000-8000-000000000051",
              setNo: 2,
              weight: 42.5,
              weightUnit: "lb",
              reps: 8,
              distanceKm: null,
              durationSeconds: null,
              rpe: null,
              rir: null,
              observedCompletedAtISO: "2026-08-10T11:40:00.000Z",
              observedCompletionProvenance: "live_client",
              observedCompletionQuality: "trustworthy",
              correctionProvenance: { state: "original", count: 0 },
            }],
          },
        }}
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
        expanded={false}
        isCurrentExercise
        onToggle={() => undefined}
        plateConfigs={{}}
        incrementals={{}}
        unit="lb"
        loadEntryMeaning="total_system"
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

    expect(html).toContain(
      "Single-Arm Overhead Cable Triceps Extension With Rope Attachment",
    );
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).not.toContain("truncate");
    expect(html).not.toContain(
      'data-testid="active-exercise-performance-context"',
    );
    expect(html).not.toContain("Last:");
  });

  it("renders one exact-best insight at exercise level and suppresses it while comparison evidence is refreshing", () => {
    const exactBestExercise: SessionExerciseData = {
      ...exercise,
      sets: [
        {
          id: "00000000-0000-4000-8000-000000000061",
          clientKey: "00000000-0000-4000-8000-000000000061",
          setNo: 1,
          weight: 95,
          weightUnit: "lb",
          reps: 8,
          metricType: "weight_reps",
          rpe: null,
          note: null,
          saveState: "saved",
        },
      ],
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
          workoutId: "00000000-0000-4000-8000-000000000062",
          localDate: "2026-08-10",
          startedAtISO: "2026-08-10T11:00:00.000Z",
          finishedAtISO: "2026-08-10T12:00:00.000Z",
          historyHref: "/history/00000000-0000-4000-8000-000000000062",
          workoutSource: "tracker",
        },
        sets: [
          {
            setId: "00000000-0000-4000-8000-000000000063",
            setNo: 1,
            weight: 95,
            weightUnit: "lb",
            reps: 8,
            distanceKm: null,
            durationSeconds: null,
            rpe: null,
            rir: null,
            observedCompletedAtISO: "2026-08-10T11:20:00.000Z",
            observedCompletionProvenance: "live_client",
            observedCompletionQuality: "trustworthy",
            correctionProvenance: { state: "original", count: 0 },
          },
        ],
      },
    };
    const render = (
      comparisonTemporarilyUnavailable: boolean,
      loadEntryMeaning: "total_system" | "per_loading_point" = "total_system",
    ) =>
      renderToStaticMarkup(
        <ExerciseCard
          exercise={exactBestExercise}
          comparisonTemporarilyUnavailable={comparisonTemporarilyUnavailable}
          historyRevision={0}
          progress={{
            sessionExerciseId: exactBestExercise.id,
            exerciseName: exactBestExercise.name,
            total: 3,
            planned: 3,
            extra: 0,
            workoutOnly: 0,
            performed: 1,
            plannedPerformed: 1,
            extraPerformed: 0,
            workoutOnlyPerformed: 0,
            skipped: 0,
            abandoned: 0,
            pending: 2,
            legacyUnknown: 0,
            completedWithoutResult: 0,
            status: "current",
          }}
          expanded
          isCurrentExercise
          onToggle={() => undefined}
          plateConfigs={{}}
          incrementals={{}}
          unit="lb"
          loadEntryMeaning={loadEntryMeaning}
          onPatch={() => undefined}
          onQueueSet={async () => true}
          onRetrySet={async () => undefined}
          onDiscardSet={async () => undefined}
          onSkipComplete={() => undefined}
          onOpenCoach={() => undefined}
          onExplainInsight={() => undefined}
          adjustIntent={null}
          onAdjustIntentChange={() => undefined}
        />,
      );

    const available = render(false);
    expect(available.match(/data-testid="athlete-insight-active_set"/g)).toHaveLength(1);
    expect(available).toContain(
      "Matched your recent Barbell Squat best: 95 lb × 8",
    );
    expect(available).toContain("How calculated");
    expect(available).toContain("Explain");
    expect(available.indexOf('data-testid="active-log-set"')).toBeLessThan(
      available.indexOf('data-testid="athlete-insight-active_set"'),
    );

    const refreshing = render(true);
    expect(refreshing).not.toContain("athlete-insight-active_set");
    expect(refreshing).not.toContain("Matched your recent");

    const changedLoadMeaning = render(false, "per_loading_point");
    expect(changedLoadMeaning).not.toContain("athlete-insight-active_set");
    expect(changedLoadMeaning).not.toContain("Matched your recent");
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
          occurrenceId: "00000000-0000-4000-8000-000000000014",
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
        workingOccurrences={[
          workingOccurrenceFor(assistedExercise, 0, {
            id: "00000000-0000-4000-8000-000000000014",
            outcome: "completed",
            completedSetId: "assisted-set",
            revision: 1,
          }),
        ]}
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
    expect(html).toContain("Previous comparison unavailable");
    expect(html).toContain('aria-label="Assistance"');
    expect(html).not.toContain("80 lb ×");
    expect(html.indexOf("Completed sets")).toBeLessThan(
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
    expect(html.match(/data-testid="active-workout-primary"/g)).toHaveLength(1);
    expect(html.match(/data-testid="active-exercise-details"/g)).toHaveLength(1);
    expect(html.match(/<h2[^>]*>Barbell Squat<\/h2>/g)).toHaveLength(1);
    expect(html).not.toContain(">Barbell Squat · Set 1<");
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
    expect(html).toContain(
      "Previous · 2026-08-03 · Latest: Version restored · 2 changes",
    );
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
    expect(html).toContain("Optional effort and set note");
    expect(html).toContain("RIR (0–10)");
    expect(html).toContain("Technique issue");
    expect(html).toContain("What limited this set?");
    expect(html).toContain("No flag means unknown, not “no pain.”");
    expect(html).toContain("Record pain");
    expect(html).not.toContain('aria-label="Pain severity 1"');
    expect(html).toContain("Set options");
    expect(html).toContain("Completed sets");
    expect(html).toContain("More for this exercise");
    expect(html.indexOf("Current action")).toBeLessThan(
      html.indexOf("Target 6–8 reps · 95 lb"),
    );
    expect(html.indexOf("Target 6–8 reps · 95 lb")).toBeLessThan(
      html.indexOf("Performed measure"),
    );
    expect(html.indexOf("Performed measure")).toBeLessThan(
      html.indexOf("Previous ·"),
    );
    expect(html.indexOf("Current action")).toBeLessThan(
      html.indexOf("Warm-up guidance"),
    );
    expect(html.match(/Log set/g)).toHaveLength(1);
    expect(html).toContain("Ask Coach gives guidance");
    expect(html).toContain("Change exercise for this workout");
    expect(html).toContain("Compatible alternatives");
    expect(html).toContain("Replace exercise");
    expect(html).toContain('data-testid="replace-current-exercise"');
    expect(html).toContain("without similarity ranking");
    expect(html).toContain("Log set");
    expect(html).toContain("Skip set");
    expect(html).toContain("Add extra set");
    expect(html).toContain(
      "Adds ad-hoc work without changing the planned set order.",
    );

    const restingHtml = renderToStaticMarkup(cloneElement(card, {
      resting: true,
      activeOccurrence: null,
      workingOccurrences: card.props.activeOccurrence
        ? [card.props.activeOccurrence]
        : [],
    }));
    expect(restingHtml).toContain('data-testid="active-set-ledger"');
    expect(restingHtml).not.toContain('data-testid="current-set-entry"');
    expect(restingHtml).not.toContain('data-testid="active-workout-primary"');
    expect(restingHtml).not.toContain('data-testid="active-log-set"');
    expect(restingHtml.match(/data-testid="active-exercise-details"/g))
      .toHaveLength(1);

    const unavailableHtml = renderToStaticMarkup(cloneElement(card, {
      comparisonTemporarilyUnavailable: true,
    }));
    expect(unavailableHtml).toContain('data-comparison-state="loading"');
    expect(unavailableHtml).toContain("Checking previous comparable set…");
    expect(unavailableHtml).not.toContain("100 lb × 7 reps");
    expect(unavailableHtml).toContain('aria-label="Total load"');
    expect(unavailableHtml).toContain('value="95"');

    const previousOnlyId = "00000000-0000-4000-8000-000000000060";
    const previousOnlyHtml = renderToStaticMarkup(cloneElement(card, {
      exercise: {
        ...current,
        id: previousOnlyId,
        targetLoad: null,
        targetLoadUnit: null,
        previousComparable: current.previousComparable?.status === "available"
          ? {
              ...current.previousComparable,
              currentSessionExerciseId: previousOnlyId,
            }
          : current.previousComparable,
      },
      activeOccurrence: {
        ...card.props.activeOccurrence,
        id: "00000000-0000-4000-8000-000000000061",
        sessionExerciseId: previousOnlyId,
        plannedLoad: null,
        plannedLoadUnit: null,
      },
    }));
    expect(previousOnlyHtml).toContain('value="100"');
    expect(previousOnlyHtml).toContain(
      'aria-label="Starting load: Previous comparable set"',
    );
    expect(previousOnlyHtml).toContain("Load: prior comparable");

    const currentOccurrence = card.props.activeOccurrence!;
    const extraOccurrence: SessionOccurrenceData = {
      ...currentOccurrence,
      id: "00000000-0000-4000-8000-000000000062",
      origin: "ad_hoc",
      sequenceIdx: 3,
      kindOrdinal: 3,
      plannedNote: ADDED_WORKOUT_SET_NOTE,
      plannedLoad: null,
      plannedLoadUnit: null,
    };
    const previousComparable = current.previousComparable;
    if (previousComparable?.status !== "available") {
      throw new Error("Expected available previous-comparable fixture");
    }
    const extraRowHtml = renderToStaticMarkup(cloneElement(card, {
      exercise: {
        ...current,
        targetLoad: null,
        targetLoadUnit: null,
        previousComparable: {
          ...previousComparable,
          sets: [
            previousComparable.sets[0],
            {
              ...previousComparable.sets[0],
              setId: "00000000-0000-4000-8000-000000000063",
              setNo: 3,
              weight: 130,
            },
          ],
        },
      },
      activeOccurrence: {
        ...currentOccurrence,
        plannedLoad: null,
        plannedLoadUnit: null,
      },
      workingOccurrences: [currentOccurrence, extraOccurrence],
    }));
    const extraRowStart = extraRowHtml.indexOf(
      `id="added-set-entry-${current.id}-${extraOccurrence.id}"`,
    );
    expect(extraRowStart).toBeGreaterThan(-1);
    const extraRowEnd = extraRowHtml.indexOf("</li>", extraRowStart);
    const extraRow = extraRowHtml.slice(extraRowStart, extraRowEnd);
    expect(extraRow).toContain("130 lb × 7 reps · source set 3");
    expect(extraRow).not.toContain("100 lb × 7 reps · source set 1");

    const replacementExerciseId = "00000000-0000-4000-8000-000000000069";
    const substitutedWithStaleEvidence = renderToStaticMarkup(cloneElement(card, {
      exercise: {
        ...current,
        exerciseId: replacementExerciseId,
        name: "Dumbbell Floor Press",
        loadType: "dumbbell",
        loadSemantics: "per_implement",
        modificationType: "substituted",
        substitutedForExerciseId: current.exerciseId,
        targetLoad: null,
        targetLoadUnit: null,
      },
      activeOccurrence: {
        ...currentOccurrence,
        plannedExerciseId: current.exerciseId,
        plannedLoad: 95,
        plannedLoadUnit: "lb",
      },
    }));
    expect(substitutedWithStaleEvidence).toContain(
      'data-comparison-state="unavailable"',
    );
    expect(substitutedWithStaleEvidence).not.toContain(
      "100 lb × 7 reps · source set 1",
    );
    expect(substitutedWithStaleEvidence).not.toContain('value="95"');

    const restoredSetId = "00000000-0000-4000-8000-000000000064";
    const restoredOccurrence = {
      ...currentOccurrence,
      id: "00000000-0000-4000-8000-000000000065",
      outcome: "completed" as const,
      completedSetId: restoredSetId,
    };
    const restoredHtml = renderToStaticMarkup(cloneElement(card, {
      exercise: {
        ...current,
        sets: [{
          id: restoredSetId,
          clientKey: "00000000-0000-4000-8000-000000000066",
          occurrenceId: restoredOccurrence.id,
          setNo: 1,
          weight: 95,
          weightUnit: "lb",
          reps: 8,
          rpe: null,
          note: null,
          saveState: "saved",
        }],
        versionEvidenceBySetId: {
          [restoredSetId]: { state: "snapshot_restored", count: 2 },
        },
      },
      activeOccurrence: null,
      workingOccurrences: [restoredOccurrence],
    }));
    expect(restoredHtml).toContain("Latest: Snapshot restored · 2 changes");

    const savedOccurrence = workingOccurrenceFor(current, 0, {
      outcome: "completed",
      completedSetId: "00000000-0000-4000-8000-000000000071",
      revision: 1,
    });
    const nextOccurrence = workingOccurrenceFor(current, 1);
    const afterSavedSet = renderToStaticMarkup(cloneElement(card, {
      exercise: {
        ...current,
        sets: [{
          id: savedOccurrence.completedSetId!,
          clientKey: "00000000-0000-4000-8000-000000000072",
          occurrenceId: savedOccurrence.id,
          setNo: 1,
          weight: 95,
          weightUnit: "lb" as const,
          reps: 8,
          rpe: null,
          note: null,
          saveState: "saved" as const,
        }],
      },
      activeOccurrence: nextOccurrence,
      workingOccurrences: [savedOccurrence, nextOccurrence],
    }));
    expect(afterSavedSet).not.toContain(
      'data-testid="replace-current-exercise"',
    );
  });

  it("keeps the planned occurrence number after an earlier set is skipped", () => {
    const afterSkippedSecond = {
      ...exercise,
      sets: [
        { id: "saved-first", clientKey: "first-key", setNo: 1, weight: 95, weightUnit: "lb" as const, reps: 8, rpe: null, note: null, saveState: "saved" as const },
      ],
    };
    const occurrences = [
      workingOccurrenceFor(afterSkippedSecond, 0, {
        outcome: "completed",
        completedSetId: "saved-first",
      }),
      workingOccurrenceFor(afterSkippedSecond, 1, {
        outcome: "skipped",
        outcomeReason: "time_limit_reached",
      }),
      workingOccurrenceFor(afterSkippedSecond, 2, {
        id: "00000000-0000-4000-8000-000000000004",
      }),
    ];
    const renderCard = (
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
        isCurrentExercise
        workingOccurrences={occurrences}
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

    expect(html).toContain('data-set-row-state="saved"');
    expect(html).toContain('data-set-row-state="skipped"');
    expect(html).toContain('data-set-row-state="current_editable"');
    expect(html).toContain("Set 3");
    expect(html).not.toContain("active-set-save-receipt");
    expect(html).toContain("Completed sets");
    expect(html).toContain("1 completed");
    expect(html).toContain("Acknowledged by Repbook");
    expect(html).toContain("Correct set");
    expect(html).toContain(
      `id="set-entry-${afterSkippedSecond.id}-00000000-0000-4000-8000-000000000004"`,
    );
    expect(html).not.toContain("Upcoming");

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
        occurrenceId: "60000000-0000-4000-8000-000000000002",
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
    const failedOccurrence: SessionOccurrenceData = {
      ...blockerOccurrence,
      id: "60000000-0000-4000-8000-000000000002",
      sequenceIdx: 1,
      kindOrdinal: 1,
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
      workingOccurrences: [blockerOccurrence, failedOccurrence],
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

    const acknowledgedBlocker = renderToStaticMarkup(
      <ExerciseCard
        {...baseProps}
        exercise={{
          ...failedAttempt,
          sets: [
            {
              id: "saved-blocker",
              clientKey: "saved-blocker-key",
              setNo: 1,
              weight: 95,
              weightUnit: "lb",
              reps: 8,
              rpe: null,
              note: null,
              saveState: "saved",
            },
            failedAttempt.sets[0],
          ],
        }}
        activeOccurrence={{
          ...blockerOccurrence,
          id: "60000000-0000-4000-8000-000000000002",
          sequenceIdx: 1,
          kindOrdinal: 1,
        }}
        workingOccurrences={[
          { ...blockerOccurrence, outcome: "completed", completedSetId: "saved-blocker" },
          {
            ...blockerOccurrence,
            id: "60000000-0000-4000-8000-000000000002",
            sequenceIdx: 1,
            kindOrdinal: 1,
          },
        ]}
        onRefreshWorkout={() => undefined}
      />,
    );
    expect(acknowledgedBlocker).not.toContain("active-set-save-receipt");
    expect(acknowledgedBlocker).toContain("Completed sets");
    expect(acknowledgedBlocker).toContain("1 completed");
    expect(acknowledgedBlocker).toContain("Acknowledged by Repbook");
    expect(acknowledgedBlocker).toContain("Save failed");

    const failedSkipRecovery = renderToStaticMarkup(
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
        skipConfirmationError="Repbook did not confirm the equipment skip."
        onRefreshWorkout={() => undefined}
      />,
    );
    expect(failedSkipRecovery).toContain("Skip was not confirmed");
    expect(failedSkipRecovery).toContain(
      "Resolve the exercise skip before logging sets.",
    );
    expect(failedSkipRecovery).not.toContain(
      'data-testid="active-log-set"',
    );

    const mismatched = renderToStaticMarkup(
      <ExerciseCard
        {...baseProps}
        exercise={{
          ...failedAttempt,
          sets: [{ ...failedAttempt.sets[0], occurrenceId: null }],
        }}
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
    expect(mismatched).toContain('data-testid="current-set-entry"');
    expect(mismatched).toContain(
      "Resolve the retained device copy for this set before logging again.",
    );
    expect(
      mismatched.match(
        /<button[^>]*data-testid="active-log-set"[^>]*>/,
      )?.[0],
    ).toMatch(/\sdisabled(?:=|>|\s)/);

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
      saved.indexOf("Completed sets"),
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
