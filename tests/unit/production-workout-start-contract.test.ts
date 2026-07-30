import { describe, expect, it } from "vitest";
import { PRODUCTION_WORKOUT_START_PROGRAM } from "../fixtures/production-workout-start-contract";

describe("production-shaped workout-start fixture", () => {
  it("preserves the inspected production structure and its legacy ramp conflict", () => {
    expect(PRODUCTION_WORKOUT_START_PROGRAM.days.map((day) => day.name)).toEqual([
      "Day 1 — Heavy chest + lat width + arms",
      "Day 2 — Squat + hinge + back thickness",
      "Day 3 — Chest / shoulders / lats / arms",
    ]);
    expect(PRODUCTION_WORKOUT_START_PROGRAM.days.map((day) => day.exercises.length)).toEqual([
      7,
      6,
      7,
    ]);

    expect(PRODUCTION_WORKOUT_START_PROGRAM.days.map((day) =>
      day.exercises.map((exercise) => exercise.name),
    )).toEqual([
      [
        "Barbell Bench Press",
        "Lat Pulldown",
        "Bulgarian Split Squat",
        "Dumbbell Lateral Raise",
        "Triceps Pushdown",
        "EZ-Bar Curl",
        "Cable Face Pull",
      ],
      [
        "Barbell Back Squat",
        "Romanian Deadlift",
        "Seated Cable Row",
        "Dumbbell Rear Delt Fly",
        "Hammer Curl",
        "Side Plank",
      ],
      [
        "Incline Barbell Bench Press",
        "Barbell Overhead Press",
        "Lat Pulldown",
        "Triceps Pushdown",
        "EZ-Bar Curl",
        "Dumbbell Lateral Raise",
        "Cable Face Pull",
      ],
    ]);

    const warmups = PRODUCTION_WORKOUT_START_PROGRAM.days.flatMap((day) =>
      day.exercises.flatMap((exercise) =>
        "warmupSets" in exercise ? [...exercise.warmupSets] : [],
      ),
    );
    expect(warmups).toHaveLength(25);
    expect(
      warmups.filter((set) => set.loadPercent != null && set.loadText != null),
    ).toHaveLength(7);

    for (const day of PRODUCTION_WORKOUT_START_PROGRAM.days) {
      const first = day.exercises[0];
      expect("warmupSets" in first).toBe(true);
      const conflicting = "warmupSets" in first
        ? first.warmupSets.filter(
            (set) => set.loadPercent != null && set.loadText?.includes("work weight"),
          )
        : [];
      expect(conflicting.length).toBeGreaterThanOrEqual(2);
    }
  });
});
