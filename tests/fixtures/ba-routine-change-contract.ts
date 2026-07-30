import { createHash } from "node:crypto";

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const BA_ROUTINE_CHANGE_EMAIL = "ba.routine-change.e2e@example.com";

export const BA_ROUTINE_CHANGE_REQUEST = `Day 1

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
- Keep Lateral Raise at 2×15–25` as const;

export const BA_ROUTINE_CHANGE_BASELINE = deepFreeze({
  identity: {
    email: BA_ROUTINE_CHANGE_EMAIL,
    name: "BA routine-change acceptance",
    timezone: "America/Toronto",
    unit: "lb" as const,
  },
  program: {
    name: "BA Three-Day Routine Change Baseline",
    version: 1,
    days: [
      {
        name: "Day 1",
        warmupNotes: "Five minutes easy, then prepare each movement without fatigue.",
        exercises: [
          { name: "Barbell Bench Press", sets: 3, repMin: 6, repMax: 8, targetLoad: 115, restSec: 150 },
          { name: "EZ-Bar Curl", sets: 3, repMin: 8, repMax: 12, targetLoad: 38, restSec: 75 },
          { name: "Bulgarian Split Squat", sets: 2, repMin: 8, repMax: 10, targetLoad: 25, restSec: 90 },
        ],
      },
      {
        name: "Day 2",
        warmupNotes: "Ramp the squat and hinge before the work sets.",
        exercises: [
          { name: "Barbell Back Squat", sets: 3, repMin: 6, repMax: 8, targetLoad: 135, restSec: 180 },
          { name: "Romanian Deadlift", sets: 4, repMin: 6, repMax: 8, targetLoad: 115, restSec: 150 },
          { name: "Dumbbell Curl", sets: 3, repMin: 8, repMax: 12, targetLoad: 20, restSec: 75 },
          { name: "Cable Rear Delt Fly", sets: 2, repMin: 12, repMax: 15, targetLoad: 15, restSec: 60 },
        ],
      },
      {
        name: "Day 3",
        warmupNotes: "Prepare the shoulders and ramp the pressing movements.",
        exercises: [
          { name: "Lat Pulldown", sets: 1, repMin: 10, repMax: 15, targetLoad: 70, restSec: 90 },
          { name: "Incline Barbell Bench Press", sets: 3, repMin: 8, repMax: 12, targetLoad: 85, restSec: 120 },
          { name: "Barbell Overhead Press", sets: 3, repMin: 6, repMax: 10, targetLoad: 55, restSec: 120 },
          { name: "Triceps Pushdown", sets: 3, repMin: 10, repMax: 15, targetLoad: 25, restSec: 75 },
          { name: "EZ-Bar Curl", sets: 3, repMin: 10, repMax: 15, targetLoad: 38, restSec: 75 },
          { name: "Dumbbell Lateral Raise", sets: 2, repMin: 15, repMax: 25, targetLoad: 10, restSec: 60 },
        ],
      },
    ],
  },
  history: {
    completedWorkouts: 1,
    completedDay: "Day 3",
    completedVersion: 1,
    expectedTodayDay: "Day 1",
  },
});

export const BA_ROUTINE_CHANGE_ORACLE = deepFreeze([
  { id: "day1-bench", day: 1, request: "Bench Press: standardize to 4×5–8", categories: ["changed"], result: { name: "Barbell Bench Press", sets: 4, repMin: 5, repMax: 8 } },
  { id: "day1-curl-replacement", day: 1, request: "Replace EZ Bar Curl with Incline Dumbbell Curl — 3×8–12", categories: ["added", "removed"], result: { name: "Incline Dumbbell Curl", sets: 3, repMin: 8, repMax: 12 }, removed: "EZ-Bar Curl" },
  { id: "day1-split-squat", day: 1, request: "Keep Bulgarian Split Squat at 2 sets for now", categories: ["unchanged"], result: { name: "Bulgarian Split Squat", sets: 2 } },
  { id: "day1-optional-face-pull", day: 1, request: "Optional: Face Pull — 1–2×15–20", categories: ["added"], result: { requestedName: "Face Pull", name: "Cable Face Pull", minimumSets: 1, idealSets: 2, repMin: 15, repMax: 20, optional: true } },
  { id: "day2-squat", day: 2, request: "Squat: standardize to 4×5–8", categories: ["changed"], result: { name: "Barbell Back Squat", sets: 4, repMin: 5, repMax: 8 } },
  { id: "day2-rdl", day: 2, request: "Romanian Deadlift: change to 3×8–10", categories: ["changed"], result: { name: "Romanian Deadlift", sets: 3, repMin: 8, repMax: 10 } },
  { id: "day2-curl-replacement", day: 2, request: "Replace current curl with Zottman Curl — 2×10–12", categories: ["added", "removed"], result: { name: "Zottman Curl", sets: 2, repMin: 10, repMax: 12 }, removed: "Dumbbell Curl" },
  { id: "day2-triceps-addition", day: 2, request: "Add Overhead Cable Triceps Extension — 2×10–15", categories: ["added"], result: { name: "Overhead Cable Triceps Extension", sets: 2, repMin: 10, repMax: 15 } },
  { id: "day2-triset", day: 2, request: "Run rear-delt fly, Zottman curl, and overhead triceps extension as a 2-round tri-set", categories: ["changed"], result: { members: ["Cable Rear Delt Fly", "Zottman Curl", "Overhead Cable Triceps Extension"], rounds: 2, ordered: true } },
  { id: "day3-pulldown", day: 3, request: "Lat Pulldown: increase from 1 set to 3×10–15", categories: ["changed"], result: { name: "Lat Pulldown", sets: 3, repMin: 10, repMax: 15 } },
  { id: "day3-incline-bench", day: 3, request: "Keep Incline Bench at 3×8–12", categories: ["unchanged"], result: { name: "Incline Barbell Bench Press", sets: 3, repMin: 8, repMax: 12 } },
  { id: "day3-overhead-press", day: 3, request: "Keep Overhead Press at 3×6–10", categories: ["unchanged"], result: { name: "Barbell Overhead Press", sets: 3, repMin: 6, repMax: 10 } },
  { id: "day3-triceps-replacement", day: 3, request: "Replace Triceps Pushdown with Overhead Cable Triceps Extension — 3×10–15", categories: ["added", "removed"], result: { name: "Overhead Cable Triceps Extension", sets: 3, repMin: 10, repMax: 15 }, removed: "Triceps Pushdown" },
  { id: "day3-superset", day: 3, request: "Superset it with EZ Bar Curl — 3×10–15", categories: ["changed"], result: { members: ["Overhead Cable Triceps Extension", "EZ-Bar Curl"], rounds: 3, ordered: true } },
  { id: "day3-lateral-raise", day: 3, request: "Keep Lateral Raise at 2×15–25", categories: ["unchanged"], result: { name: "Dumbbell Lateral Raise", sets: 2, repMin: 15, repMax: 25 } },
]);

export const BA_ROUTINE_CHANGE_SEMANTIC_DIGEST = createHash("sha256")
  .update(JSON.stringify({
    request: BA_ROUTINE_CHANGE_REQUEST,
    oracle: BA_ROUTINE_CHANGE_ORACLE,
    baseline: BA_ROUTINE_CHANGE_BASELINE,
  }))
  .digest("hex");
