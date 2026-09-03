import { describe, expect, it } from "vitest";
import {
  retainedSkipReasonForSubstitution,
  skipReasonLabel,
  substitutionReasonLabel,
} from "@/lib/session-exercise-decision-evidence";

const exercise = {
  id: "session-exercise",
  exerciseId: "replacement-exercise",
  modificationType: "substituted",
  skipReason: null,
  substitutedForExerciseId: "planned-exercise",
  substitutionReason: "equipment_unavailable_incompatible" as const,
};

describe("session exercise decision evidence", () => {
  it("prefers the reason retained on the current row", () => {
    expect(retainedSkipReasonForSubstitution(
      { ...exercise, skipReason: "pain_discomfort" },
      [{
        entityId: exercise.id,
        beforeData: { skip_reason: "technical_app_issue" },
        afterData: {
          exercise_id: exercise.exerciseId,
          substituted_for_exercise_id: exercise.substitutedForExerciseId,
          substitution_reason: exercise.substitutionReason,
        },
      }],
    )).toBe("pain_discomfort");
  });

  it("reads the earlier skip only from the matching substitution version", () => {
    expect(retainedSkipReasonForSubstitution(exercise, [
      {
        entityId: exercise.id,
        beforeData: { skip_reason: "technical_app_issue" },
        afterData: {
          exercise_id: "different-replacement",
          substituted_for_exercise_id: exercise.substitutedForExerciseId,
          substitution_reason: exercise.substitutionReason,
        },
      },
      {
        entityId: exercise.id,
        beforeData: { skip_reason: "equipment_unavailable_incompatible" },
        afterData: {
          exercise_id: exercise.exerciseId,
          substituted_for_exercise_id: exercise.substitutedForExerciseId,
          substitution_reason: exercise.substitutionReason,
        },
      },
    ])).toBe("equipment_unavailable_incompatible");
  });

  it("keeps unmatched or absent historical causes unknown", () => {
    expect(retainedSkipReasonForSubstitution(exercise, [{
      entityId: exercise.id,
      beforeData: { skip_reason: "equipment_unavailable_incompatible" },
      afterData: {
        exercise_id: exercise.exerciseId,
        substituted_for_exercise_id: exercise.substitutedForExerciseId,
        substitution_reason: "equipment_busy",
      },
    }])).toBeNull();
  });

  it("presents busy and unavailable or incompatible as distinct causes", () => {
    expect(substitutionReasonLabel("equipment_busy")).toBe("equipment busy");
    expect(
      substitutionReasonLabel("equipment_unavailable_incompatible"),
    ).toBe("equipment unavailable or incompatible");
    expect(skipReasonLabel("technical_app_issue")).toBe(
      "technical or app issue",
    );
  });
});
