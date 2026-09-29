import { describe, expect, it } from "vitest";
import { resumeUpNext } from "@/lib/resume-workout-position";
import type { TodayData } from "@/services/today";

const occurrence: TodayData["inProgressOccurrences"][number] = {
  id: "set-1", sequenceIdx: 0, kind: "working_set", outcome: "pending",
  label: null, plannedExerciseId: "squat", plannedExerciseName: "Barbell squat",
  currentExerciseId: "squat", currentExerciseName: "Barbell squat", kindOrdinal: 1,
  plannedRepsMin: 6, plannedRepsMax: 8, plannedLoad: 95, plannedLoadUnit: "lb",
  plannedLoadPercent: null, plannedLoadText: null, plannedRestSec: 90,
  groupRound: null, groupMemberOrderIdx: null,
};

describe("Resume saved position", () => {
  it("shows the original movement's frozen targets when identity still matches", () => {
    expect(resumeUpNext(occurrence)).toEqual({
      title: "Barbell squat · set 2", detail: "6–8 reps · 95 lb",
    });
  });
  it("names the accepted replacement without borrowing the original targets", () => {
    expect(resumeUpNext({ ...occurrence, currentExerciseId: "press", currentExerciseName: "Leg press" })).toEqual({
      title: "Leg press · set 2", detail: null,
    });
    expect(occurrence.plannedLoad).toBe(95);
  });
  it("does not claim targets when the current exercise cannot be resolved", () => {
    expect(resumeUpNext({ ...occurrence, currentExerciseId: null, currentExerciseName: null }).detail).toBeNull();
  });
  it("retains a day warm-up label and its exercise-independent prescription", () => {
    expect(resumeUpNext({ ...occurrence, kind: "day_warmup", label: "Easy movement", currentExerciseId: null, plannedExerciseId: null, plannedLoad: null, plannedLoadUnit: null })).toEqual({
      title: "Easy movement", detail: "6–8 reps",
    });
  });
});
