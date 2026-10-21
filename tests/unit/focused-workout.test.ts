import { describe, expect, it } from "vitest";
import { exerciseVisibleInWorkoutView, handheldLoadPresentation } from "@/lib/focused-workout";
import { projectActiveSetRows } from "@/lib/active-set-row-projection";
import { SET_ROW_STATE_FIXTURES } from "../fixtures/active-workout-north-star";

describe("focused workout presentation", () => {
  const base = {
    view: "focused" as const, exerciseId: "other", currentExerciseId: "current",
    recoveryExerciseId: null, needsEquipmentDecision: false,
    ledgerProjection: projectActiveSetRows({ ...SET_ROW_STATE_FIXTURES.planned.input, occurrences: [], exercise: { ...SET_ROW_STATE_FIXTURES.planned.input.exercise, sets: [] } }),
  };
  it("keeps the current action visible without exposing every future exercise", () => {
    expect(exerciseVisibleInWorkoutView(base)).toBe(false);
    expect(exerciseVisibleInWorkoutView({ ...base, exerciseId: "current" })).toBe(true);
  });
  it("keeps active group members and their navigation visible when the current member advances", () => {
    expect(exerciseVisibleInWorkoutView({ ...base, exerciseId: "first-member", currentExerciseId: "second-member", isActiveGroupMember: true })).toBe(true);
    expect(exerciseVisibleInWorkoutView({ ...base, exerciseId: "second-member", currentExerciseId: "second-member", isActiveGroupMember: true })).toBe(true);
    expect(exerciseVisibleInWorkoutView({ ...base, exerciseId: "outside-group", currentExerciseId: "second-member", isActiveGroupMember: false })).toBe(false);
  });
  it("never hides a recovery target or equipment decision", () => {
    expect(exerciseVisibleInWorkoutView({ ...base, recoveryExerciseId: "other" })).toBe(true);
    expect(exerciseVisibleInWorkoutView({ ...base, needsEquipmentDecision: true })).toBe(true);
    expect(exerciseVisibleInWorkoutView({ ...base, needsSaveRecovery: true })).toBe(true);
  });
  it("retains a complete overview and does not invent a focus before an action exists", () => {
    expect(exerciseVisibleInWorkoutView({ ...base, view: "overview" })).toBe(true);
    expect(exerciseVisibleInWorkoutView({ ...base, currentExerciseId: null })).toBe(true);
  });
});

describe("handheld weight wording", () => {
  it("names a proven per-implement convention without assuming two implements", () => {
    expect(handheldLoadPresentation({ loadType: "dumbbell", loadSemantics: "per_implement" }))
      .toEqual({ label: "Weight per dumbbell", explanation: "Enter one dumbbell’s weight. Do not add a pair together." });
  });
  it("does not change an existing total into per-hand weight", () => {
    expect(handheldLoadPresentation({ loadType: "kettlebell", loadSemantics: "total" })?.label)
      .toBe("Total weight");
  });
  it("keeps ambiguous historical meaning explicit and does not infer it from the equipment", () => {
    expect(handheldLoadPresentation({ loadType: "dumbbell", loadSemantics: "legacy_unknown" })?.explanation)
      .toContain("No per-hand or combined amount is calculated");
    expect(handheldLoadPresentation({ loadType: "barbell", loadSemantics: "total" })).toBeNull();
  });
});
