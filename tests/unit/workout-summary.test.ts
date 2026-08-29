import { describe, expect, it } from "vitest";
import {
  buildWorkoutSummaryViewModel,
  type WorkoutSummaryInput,
} from "@/lib/workout-summary";

function input(
  overrides: Partial<WorkoutSummaryInput> = {},
): WorkoutSummaryInput {
  return {
    terminalState: "completed",
    terminalLabel: "Completed workout",
    performedExerciseCount: 3,
    workingSetCount: 9,
    warmupCount: 0,
    durationSummary: "Active 45m · wall clock 50m",
    durationExcluded: false,
    targetOutcomes: {
      below: 0,
      at: 3,
      above: 0,
      unknown: 0,
      supported: 3,
    },
    targetDenominatorComplete: true,
    positivePainEvidenceCount: 0,
    explicitNoIssueEvidenceCount: 1,
    painEvidenceUnknown: false,
    correctionLabel: "Original evidence",
    hasCorrections: false,
    provenanceLabel: "Recorded in Repbook",
    showProvenance: false,
    programLinkLabel: null,
    hasMixedWeightUnits: false,
    pendingDecisionCount: 0,
    incompleteReasonLabel: null,
    timingCanBeReviewed: true,
    ...overrides,
  };
}

describe("WorkoutSummaryViewModel", () => {
  it("answers the four post-workout questions from supported completed evidence", () => {
    const summary = buildWorkoutSummaryViewModel(
      input({
        targetOutcomes: {
          below: 0,
          at: 2,
          above: 1,
          unknown: 0,
          supported: 3,
        },
      }),
    );

    expect(summary.happened).toMatchObject({
      value: "Completed workout",
      tone: "positive",
    });
    expect(summary.happened.detail).toContain("3 exercises · 9 working sets");
    expect(summary.changed.value).toBe("Some work finished above target");
    expect(summary.changed.detail).toBe("1 above target · 2 at target.");
    expect(summary.notable.value).toBe("No notable issue was recorded");
    expect(summary.next.value).toBe("Nothing needs a decision");
  });

  it("keeps incomplete-work meaning and the owner-selected reason prominent", () => {
    const summary = buildWorkoutSummaryViewModel(
      input({
        terminalState: "completed_with_remaining_work",
        terminalLabel: "Completed with planned work remaining",
        incompleteReasonLabel: "Session time limit reached",
      }),
    );

    expect(summary.happened.tone).toBe("neutral");
    expect(summary.notable).toMatchObject({
      value: "Planned work remained",
      detail: "Recorded finish reason: Session time limit reached.",
      tone: "attention",
    });
  });

  it("does not turn abandoned evidence into a completed comparison", () => {
    const summary = buildWorkoutSummaryViewModel(
      input({
        terminalState: "abandoned",
        terminalLabel: "Abandoned workout",
      }),
    );

    expect(summary.happened.tone).toBe("attention");
    expect(summary.changed.value).toBe("No completed comparison");
    expect(summary.notable.value).toBe("The workout was abandoned");
  });

  it("makes no-comparable and unknown target evidence explicit", () => {
    const summary = buildWorkoutSummaryViewModel(
      input({
        targetOutcomes: {
          below: 0,
          at: 0,
          above: 0,
          unknown: 4,
          supported: 0,
        },
        targetDenominatorComplete: false,
        explicitNoIssueEvidenceCount: 0,
        painEvidenceUnknown: true,
      }),
    );

    expect(summary.changed).toMatchObject({
      value: "No comparable evidence",
      detail: "4 planned outcomes could not be compared safely.",
    });
    expect(summary.notable.detail).toContain("not evidence");
  });

  it("keeps imported, corrected, mixed-unit, and unknown-duration context visible", () => {
    const summary = buildWorkoutSummaryViewModel(
      input({
        durationSummary: "Time and duration unknown",
        durationExcluded: true,
        correctionLabel: "Restored from recovery snapshot",
        hasCorrections: true,
        provenanceLabel: "Imported evidence",
        showProvenance: true,
        hasMixedWeightUnits: true,
      }),
    );

    expect(summary.happened.detail).toContain("Time and duration unknown");
    expect(summary.notable.value).toBe("Active time is unavailable");
    expect(summary.recordContext).toEqual([
      "Imported evidence",
      "Restored from recovery snapshot",
      "Mixed recorded load units remain separate",
    ]);
  });

  it("surfaces pain evidence while keeping Program decisions user-controlled", () => {
    const summary = buildWorkoutSummaryViewModel(
      input({ positivePainEvidenceCount: 2, pendingDecisionCount: 1 }),
    );

    expect(summary.notable).toMatchObject({
      value: "Pain or limitation was recorded",
      href: "#pain-evidence",
    });
    expect(summary.next).toMatchObject({
      value: "1 Program decision needs review",
      detail: "Nothing changes unless you approve it.",
      href: "/coach",
    });
  });
});
