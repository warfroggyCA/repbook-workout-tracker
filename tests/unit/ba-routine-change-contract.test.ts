import { describe, expect, it } from "vitest";
import {
  BA_ROUTINE_CHANGE_BASELINE,
  BA_ROUTINE_CHANGE_ORACLE,
  BA_ROUTINE_CHANGE_REQUEST,
  BA_ROUTINE_CHANGE_SEMANTIC_DIGEST,
} from "../fixtures/ba-routine-change-contract";

describe("BA routine-change acceptance contract", () => {
  it("retains the exact three-day request and all fifteen traceable instructions", () => {
    expect(BA_ROUTINE_CHANGE_REQUEST).toBe(`Day 1

- Bench Press: standardize to 4×5–8
- Replace EZ Bar Curl with Incline Dumbbell Curl — 3×8–12
- Keep Bulgarian Split Squat at 2 sets for now
- Optional: Face Pull — 1–2×15–20

Day 2

- Squat: standardize to 4×5–8
- Romanian Deadlift: change to 3×8–10
- Replace current curl with Zottman Curl — 2×10–12
- Add Overhead Cable Triceps Extension — 2×10–15
- Run rear-delt fly, Zottman curl, and overhead triceps extension as a 2-round tri-set

Day 3

- Lat Pulldown: increase from 1 set to 3×10–15
- Keep Incline Bench at 3×8–12
- Keep Overhead Press at 3×6–10
- Replace Triceps Pushdown with Overhead Cable Triceps Extension — 3×10–15
- Superset it with EZ Bar Curl — 3×10–15
- Keep Lateral Raise at 2×15–25`);
    expect(BA_ROUTINE_CHANGE_ORACLE).toHaveLength(15);
    expect(new Set(BA_ROUTINE_CHANGE_ORACLE.map((item) => item.id)).size).toBe(15);
    for (const item of BA_ROUTINE_CHANGE_ORACLE) {
      expect(BA_ROUTINE_CHANGE_REQUEST).toContain(item.request);
    }
  });

  it("defines every required source exercise and one old-version workout", () => {
    expect(BA_ROUTINE_CHANGE_BASELINE.program.days.map((day) => day.name)).toEqual([
      "Day 1",
      "Day 2",
      "Day 3",
    ]);
    expect(BA_ROUTINE_CHANGE_BASELINE.program.days[0].exercises.map((item) => item.name)).toEqual([
      "Barbell Bench Press",
      "EZ-Bar Curl",
      "Bulgarian Split Squat",
    ]);
    expect(BA_ROUTINE_CHANGE_BASELINE.program.days[1].exercises.map((item) => item.name)).toEqual([
      "Barbell Back Squat",
      "Romanian Deadlift",
      "Dumbbell Curl",
      "Cable Rear Delt Fly",
    ]);
    expect(BA_ROUTINE_CHANGE_BASELINE.program.days[2].exercises.map((item) => item.name)).toEqual([
      "Lat Pulldown",
      "Incline Barbell Bench Press",
      "Barbell Overhead Press",
      "Triceps Pushdown",
      "EZ-Bar Curl",
      "Dumbbell Lateral Raise",
    ]);
    expect(BA_ROUTINE_CHANGE_BASELINE.history).toMatchObject({
      completedWorkouts: 1,
      completedDay: "Day 3",
      completedVersion: 1,
      expectedTodayDay: "Day 1",
    });
    expect(BA_ROUTINE_CHANGE_SEMANTIC_DIGEST).toBe(
      "24d431057e923be5e9f328159cbc90bed1b8183a4b7961c776584cdc38562812",
    );
  });

  it("is recursively immutable", () => {
    expect(Object.isFrozen(BA_ROUTINE_CHANGE_BASELINE)).toBe(true);
    expect(Object.isFrozen(BA_ROUTINE_CHANGE_BASELINE.program.days)).toBe(true);
    expect(Object.isFrozen(BA_ROUTINE_CHANGE_ORACLE)).toBe(true);
    expect(Object.isFrozen(BA_ROUTINE_CHANGE_ORACLE[0].result)).toBe(true);
  });
});
