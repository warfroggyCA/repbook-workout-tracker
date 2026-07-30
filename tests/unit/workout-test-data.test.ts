import { describe, expect, it } from "vitest";
import {
  buildWorkoutTestData,
  TEST_DATA_EXERCISE_NAMES,
  TEST_DATA_PREFIX,
} from "@/services/workout-test-data";

const exercises = TEST_DATA_EXERCISE_NAMES.map((name, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name,
  loadType: name.includes("Barbell") || name === "Romanian Deadlift"
    ? "barbell"
    : "external",
  loadSemantics:
    name.includes("Dumbbell") || name.includes("Split Squat")
      ? ("per_implement" as const)
      : ("total" as const),
  metricType: "weight_reps" as const,
}));

describe("workout test data", () => {
  it("builds a labelled 12-week history with varied reporting signals", () => {
    const data = buildWorkoutTestData({
      userId: "00000000-0000-4000-8000-000000000999",
      unit: "lb",
      exerciseRows: exercises,
      now: new Date("2026-07-12T23:00:00.000Z"),
    });

    expect(data.sessions).toHaveLength(36);
    expect(data.sessions.every((session) =>
      session.templateName?.startsWith(TEST_DATA_PREFIX)
    )).toBe(true);
    expect(data.sessions.filter((session) => session.status === "abandoned")).toHaveLength(1);
    expect(data.sessionExercises).toHaveLength(144);
    expect(data.sessionExercises.some((exercise) => exercise.modificationType === "substituted")).toBe(true);
    expect(data.sessionExercises.some((exercise) => exercise.modificationType === "skipped")).toBe(true);
    expect(data.sets.length).toBeGreaterThan(350);
    expect(data.sets.some((set) => set.targetMet === false)).toBe(true);
    expect(
      data.sets.every(
        (set) =>
          set.performedSemanticsVersion === 1 &&
          set.performedLoadType != null &&
          set.performedLoadSemantics != null,
      ),
    ).toBe(true);
    expect(data.fatigue).toHaveLength(35);
    expect(data.pain.map((entry) => entry.severity)).toEqual([2, 4]);
    expect(data.notes.length).toBeGreaterThan(0);
  });

  it("converts sample loads for metric profiles", () => {
    const pounds = buildWorkoutTestData({
      userId: "00000000-0000-4000-8000-000000000999",
      unit: "lb",
      exerciseRows: exercises,
      now: new Date("2026-07-12T23:00:00.000Z"),
    });
    const kilos = buildWorkoutTestData({
      userId: "00000000-0000-4000-8000-000000000999",
      unit: "kg",
      exerciseRows: exercises,
      now: new Date("2026-07-12T23:00:00.000Z"),
    });

    expect(Number(kilos.sets[0].weight)).toBeLessThan(Number(pounds.sets[0].weight));
    expect(Number(kilos.sets[0].weight) % 2.5).toBe(0);
  });

  it("refuses to create incomplete sample history", () => {
    expect(() =>
      buildWorkoutTestData({
        userId: "00000000-0000-4000-8000-000000000999",
        unit: "lb",
        exerciseRows: exercises.slice(1),
      })
    ).toThrow("Exercise library is missing");
  });
});
