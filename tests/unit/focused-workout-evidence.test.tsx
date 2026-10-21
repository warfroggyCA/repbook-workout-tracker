import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/sessions", () => ({
  correctAcknowledgedSet: vi.fn(), archiveSet: vi.fn(), confirmExerciseUnskipped: vi.fn(),
  skipExercise: vi.fn(), logPain: vi.fn(), saveExerciseNote: vi.fn(), getAlternativeOptions: vi.fn(),
  getReplacementOptions: vi.fn(), substituteExercise: vi.fn(), replaceExercise: vi.fn(), undoExerciseSubstitution: vi.fn(),
}));
vi.mock("@/app/actions/archive", () => ({ restoreArchiveOperation: vi.fn() }));
import type { SessionEquipmentSetup } from "@/components/session/types";
import { ExerciseCard } from "@/components/session/exercise-card";
import { ActiveSetLedger } from "@/components/session/active-set-ledger";
import { projectActiveSetRows, type ActiveSetRowProjectionInput } from "@/lib/active-set-row-projection";
import { projectSessionGuidance } from "@/lib/session-guidance";
import { projectActiveWorkoutViewModel } from "@/lib/active-workout-view-model";
import { activeSetEvidenceNeedsReview, exerciseVisibleInWorkoutView } from "@/lib/focused-workout";
import { SET_ROW_STATE_FIXTURES } from "../fixtures/active-workout-north-star";

function twoExerciseWorkout(source: ActiveSetRowProjectionInput) {
  const earlier = structuredClone(source);
  earlier.exercise = { ...earlier.exercise, targetSets: 1, restSec: 0, orderIdx: 0 };
  earlier.occurrences = earlier.occurrences.map((item) => ({ ...item, sequenceIdx: 0, plannedRestSec: 0 }));
  const next = structuredClone(SET_ROW_STATE_FIXTURES.current_editable.input);
  next.exercise = { ...next.exercise, id: "next-exercise", exerciseId: "next-library-exercise", name: "Next exercise", targetSets: 1, sets: [], orderIdx: 1 };
  next.occurrences = next.occurrences.map((item) => ({
    ...item, id: "next-occurrence", sessionExerciseId: next.exercise.id,
    plannedExerciseId: next.exercise.exerciseId, sequenceIdx: 10,
  }));
  const exercises = [earlier.exercise, next.exercise];
  const occurrences = [...earlier.occurrences, ...next.occurrences];
  const equipmentSetups = Object.fromEntries(exercises.map((exercise) => [exercise.id, {
    sourceExerciseId: exercise.exerciseId, sourceTargetLoad: exercise.targetLoad,
    sourceTargetLoadUnit: exercise.targetLoadUnit, exact: true, decisionState: "ready",
    status: "available", selectionRequired: false, currentSnapshotId: `setup-${exercise.id}`,
    currentEquipmentLabel: "Configured rack", currentAttachmentLabel: null,
    currentGuidance: "Ready", currentGuidanceByLoadEntryMeaning: {},
    currentSelectionAvailable: true, loadEntryMeaning: "total_system",
    loadEntryMeaningChoices: [], options: [],
  } satisfies SessionEquipmentSetup]));
  const before = structuredClone({ exercises, occurrences });
  const guidance = projectSessionGuidance({ exercises, occurrences, equipmentSetups, exerciseGroups: [] });
  const model = projectActiveWorkoutViewModel({
    guidance, exercises, occurrences, unit: "lb",
    loadEntryMeaningByExerciseId: {}, comparisonUnavailableByExerciseId: {},
  });
  const projections = exercises.map((exercise) => projectActiveSetRows({
    exercise, occurrences, currentOccurrenceId: model.currentAction?.occurrenceId ?? null,
    versionEvidenceBySetId: exercise.versionEvidenceBySetId,
  }));
  const visible = exercises.filter((exercise, index) => exerciseVisibleInWorkoutView({
    view: "focused", exerciseId: exercise.id,
    currentExerciseId: model.currentAction?.sessionExerciseId ?? null,
    recoveryExerciseId: null, needsEquipmentDecision: false,
    needsSaveRecovery: exercise.sets.some((set) => set.saveState != null && set.saveState !== "saved"),
    ledgerProjection: projections[index],
  }));
  return { earlier, next, exercises, occurrences, before, model, guidance, projections, visible };
}

function renderEarlierCard(result: ReturnType<typeof twoExerciseWorkout>, expanded: boolean) {
  return renderToStaticMarkup(<ExerciseCard focused
        exercise={result.earlier.exercise} historyRevision={0}
        progress={result.guidance.exercises.find((item) => item.sessionExerciseId === result.earlier.exercise.id)!}
        expanded={expanded} warmupResolved
        workingOccurrences={result.earlier.occurrences} activeOccurrence={null} isCurrentExercise={false}
        onToggle={() => undefined} plateConfigs={{}} incrementals={{}} unit="lb"
        onPatch={() => undefined} onQueueSet={async () => true}
        onRetrySet={async () => undefined} onDiscardSet={async () => undefined}
        onSkipComplete={() => undefined} onOpenCoach={() => undefined}
        adjustIntent={null} onAdjustIntentChange={() => undefined} />);
}

describe("focused workout evidence across exercise handoff", () => {
  for (const [state, warning] of [
    ["completed_without_result", "Needs review"],
    ["unknown_legacy", "Unknown"],
  ] as const) {
    it(`keeps an earlier ${state} exercise and its warning available when the next exercise is current`, () => {
      const result = twoExerciseWorkout(SET_ROW_STATE_FIXTURES[state].input);
      expect(result.model.currentAction?.sessionExerciseId).toBe(result.next.exercise.id);
      expect(result.model.equipmentAttention).toEqual([]);
      expect(result.earlier.exercise.sets.every((set) => set.saveState == null || set.saveState === "saved")).toBe(true);
      expect(result.projections[0].rows[0].state).toBe(state);
      expect(result.visible.map((exercise) => exercise.id)).toEqual([result.earlier.exercise.id, result.next.exercise.id]);
      expect(activeSetEvidenceNeedsReview(result.projections[0])).toBe(true);
      const html = renderToStaticMarkup(<ActiveSetLedger focused
        exerciseId={result.earlier.exercise.id} exerciseName={result.earlier.exercise.name}
        metricType="weight_reps" rows={result.projections[0].rows}
        diagnostics={result.projections[0].diagnostics} renderCurrentRow={() => null} />);
      expect(html).toContain(warning);
      expect(html).not.toContain("<details");
      const card = renderEarlierCard(result, true);
      expect(card).toContain('data-testid="active-set-ledger"');
      expect(card).toContain(`data-set-row-state="${state}"`);
      expect(card).toContain(warning);
      expect(card).not.toContain('data-testid="focused-set-history"');
      const collapsed = renderEarlierCard(result, false);
      expect(collapsed).toContain('data-testid="focused-evidence-review-warning"');
      expect(collapsed).toContain("Some set records need review");
      expect(collapsed).not.toContain('data-testid="active-set-ledger"');
      expect({ exercises: result.exercises, occurrences: result.occurrences }).toEqual(result.before);
    });
  }

  it("keeps an earlier exercise with an unlinked acknowledged result visible even when its linked row is saved", () => {
    const input = structuredClone(SET_ROW_STATE_FIXTURES.saved.input);
    input.exercise.sets.push({ ...input.exercise.sets[0], id: "orphan-result", clientKey: null, occurrenceId: null });
    const result = twoExerciseWorkout(input);
    expect(result.model.currentAction?.sessionExerciseId).toBe(result.next.exercise.id);
    expect(result.model.equipmentAttention).toEqual([]);
    expect(result.projections[0].rows[0].state).toBe("saved");
    expect(result.projections[0].diagnostics.unlinkedSetIds).toEqual(["orphan-result"]);
    expect(result.visible).toHaveLength(2);
    expect(renderEarlierCard(result, false)).toContain('data-testid="focused-evidence-review-warning"');
    expect(activeSetEvidenceNeedsReview(result.projections[0])).toBe(true);
  });

  it("keeps duplicate result diagnostics visible across the handoff", () => {
    const input = structuredClone(SET_ROW_STATE_FIXTURES.saved.input);
    input.exercise.sets.push({ ...input.exercise.sets[0], id: "duplicate-result", clientKey: "duplicate-client", occurrenceId: input.occurrences[0].id });
    const result = twoExerciseWorkout(input);
    expect(result.model.currentAction?.sessionExerciseId).toBe(result.next.exercise.id);
    expect(result.projections[0].diagnostics.duplicateSetIds).toEqual(["duplicate-result"]);
    expect(result.visible).toHaveLength(2);
    expect(renderEarlierCard(result, false)).toContain('data-testid="focused-evidence-review-warning"');
  });

  it("keeps a contradictory skipped/result record visible without changing its evidence", () => {
    const input = structuredClone(SET_ROW_STATE_FIXTURES.saved.input);
    input.occurrences[0].outcome = "skipped";
    const result = twoExerciseWorkout(input);
    expect(result.model.currentAction?.sessionExerciseId).toBe(result.next.exercise.id);
    expect(result.projections[0].diagnostics.contradictoryOccurrenceIds).toEqual([input.occurrences[0].id]);
    expect(result.visible).toHaveLength(2);
    expect(renderEarlierCard(result, false)).toContain('data-testid="focused-evidence-review-warning"');
    expect({ exercises: result.exercises, occurrences: result.occurrences }).toEqual(result.before);
  });

  it("still hides an earlier fully acknowledged exercise with no uncertain evidence", () => {
    const result = twoExerciseWorkout(SET_ROW_STATE_FIXTURES.saved.input);
    expect(result.model.currentAction?.sessionExerciseId).toBe(result.next.exercise.id);
    expect(activeSetEvidenceNeedsReview(result.projections[0])).toBe(false);
    expect(result.visible.map((exercise) => exercise.id)).toEqual([result.next.exercise.id]);
    expect(renderEarlierCard(result, false)).not.toContain('data-testid="focused-evidence-review-warning"');
  });
});
