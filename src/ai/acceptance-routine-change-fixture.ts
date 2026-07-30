import type { RoutineBuildResult } from "@/ai/tasks/routine-build/schema";

type AvailableExercise = {
  exerciseId: string;
  name: string;
  movementPattern: string;
};

type CurrentExercise = {
  exerciseId: string;
  name: string;
  sets: number;
  repMin: number;
  repMax: number;
  restSec: number;
  group: string | null;
};

type RoutineChangeInput = {
  request?: string;
  availableExercises?: AvailableExercise[];
  currentProgram?: {
    name: string;
    days: Array<{
      lineageId: string;
      name: string;
      exercises: CurrentExercise[];
    }>;
  } | null;
};

type ExerciseSpec = {
  name: string;
  requestedName?: string;
  sets: number;
  repMin: number;
  repMax: number;
  restSec?: number;
  supersetGroup?: string | null;
  targetLoad?: number | null;
};

const DAY_SPECS: Record<number, ExerciseSpec[]> = {
  1: [
    { name: "Barbell Bench Press", sets: 4, repMin: 5, repMax: 8 },
    { name: "Incline Dumbbell Curl", sets: 3, repMin: 8, repMax: 12, restSec: 75 },
    { name: "Bulgarian Split Squat", sets: 2, repMin: 8, repMax: 10 },
    { name: "Cable Face Pull", requestedName: "Face Pull", sets: 2, repMin: 15, repMax: 20, restSec: 60, targetLoad: null },
  ],
  2: [
    { name: "Barbell Back Squat", sets: 4, repMin: 5, repMax: 8 },
    { name: "Romanian Deadlift", sets: 3, repMin: 8, repMax: 10 },
    { name: "Cable Rear Delt Fly", sets: 2, repMin: 12, repMax: 15, supersetGroup: "A" },
    { name: "Zottman Curl", sets: 2, repMin: 10, repMax: 12, restSec: 60, supersetGroup: "A" },
    { name: "Overhead Cable Triceps Extension", sets: 2, repMin: 10, repMax: 15, restSec: 60, supersetGroup: "A", targetLoad: null },
  ],
  3: [
    { name: "Lat Pulldown", sets: 3, repMin: 10, repMax: 15 },
    { name: "Incline Barbell Bench Press", sets: 3, repMin: 8, repMax: 12 },
    { name: "Barbell Overhead Press", sets: 3, repMin: 6, repMax: 10 },
    { name: "Overhead Cable Triceps Extension", sets: 3, repMin: 10, repMax: 15, restSec: 75, supersetGroup: "A", targetLoad: null },
    { name: "EZ-Bar Curl", sets: 3, repMin: 10, repMax: 15, supersetGroup: "A" },
    { name: "Dumbbell Lateral Raise", sets: 2, repMin: 15, repMax: 25 },
  ],
};

const PROVIDER_CONTEXT =
  "This is one day from a larger update to the user's current Program. Return exactly one complete updated day. Apply every requested change for this day, resolve references such as 'current curl' and 'it' from currentProgram, and preserve every current exercise and prescription that the user did not ask to change. Preserve optional status and requested supersets or tri-sets.";

const REQUIRED_REQUEST_LINES = {
  1: [
    "- Bench Press: standardize to 4×5–8",
    "- Replace EZ Bar Curl with Incline Dumbbell Curl — 3×8–12",
    "- Keep Bulgarian Split Squat at 2 sets for now",
    "- Optional: Face Pull — 1–2×15–20",
  ],
  2: [
    "- Squat: standardize to 4×5–8",
    "- Romanian Deadlift: change to 3×8–10",
    "- Replace current curl with Zottman Curl — 2×10–12",
    "- Add Overhead Cable Triceps Extension — 2×10–15",
    "- Run rear-delt fly, Zottman curl, and overhead triceps extension as a 2-round tri-set",
  ],
  3: [
    "- Lat Pulldown: increase from 1 set to 3×10–15",
    "- Keep Incline Bench at 3×8–12",
    "- Keep Overhead Press at 3×6–10",
    "- Replace Triceps Pushdown with Overhead Cable Triceps Extension — 3×10–15",
    "- Superset it with EZ Bar Curl — 3×10–15",
    "- Keep Lateral Raise at 2×15–25",
  ],
} as const;

export const BA_ROUTINE_CHANGE_PROVIDER_REQUESTS = {
  1: `${PROVIDER_CONTEXT}\n\nDay 1\n\n${REQUIRED_REQUEST_LINES[1].join("\n")}`,
  2: `${PROVIDER_CONTEXT}\n\nDay 2\n\n${REQUIRED_REQUEST_LINES[2].join("\n")}`,
  3: `${PROVIDER_CONTEXT}\n\nDay 3\n\n${REQUIRED_REQUEST_LINES[3].join("\n")}`,
} as const;

function requestedDay(input: RoutineChangeInput): number {
  const match = /\bDay\s+([123])\b/i.exec(input.request ?? "");
  if (!match) {
    throw new Error("The BA routine-change fixture received a request without Day 1, Day 2, or Day 3.");
  }
  return Number(match[1]);
}

export function buildBaRoutineChangeFixture(input: RoutineChangeInput): RoutineBuildResult {
  const dayNumber = requestedDay(input);
  const expectedRequest =
    BA_ROUTINE_CHANGE_PROVIDER_REQUESTS[
      dayNumber as keyof typeof BA_ROUTINE_CHANGE_PROVIDER_REQUESTS
    ];
  if (input.request !== expectedRequest) {
    throw new Error(
      `The BA routine-change fixture requires the exact Day ${dayNumber} provider request block.`,
    );
  }
  const currentDay = input.currentProgram?.days.find(
    (day) => day.name.toLocaleLowerCase("en") === `day ${dayNumber}`,
  );
  if (!currentDay) {
    throw new Error(`The BA routine-change fixture could not find current Day ${dayNumber}.`);
  }

  const availableByName = new Map(
    (input.availableExercises ?? []).map((exercise) => [exercise.name, exercise]),
  );
  const currentByName = new Map(
    currentDay.exercises.map((exercise) => [exercise.name, exercise]),
  );
  const exercises = DAY_SPECS[dayNumber]!.map((spec) => {
    const available = availableByName.get(spec.name);
    if (!available) {
      throw new Error(`The BA routine-change fixture is missing available exercise: ${spec.name}.`);
    }
    const current = currentByName.get(spec.name);
    return {
      requestedName: spec.requestedName ?? spec.name,
      exerciseId: available.exerciseId,
      sets: spec.sets,
      repMin: spec.repMin,
      repMax: spec.repMax,
      targetLoad: spec.targetLoad ?? null,
      restSec: spec.restSec ?? current?.restSec ?? 90,
      supersetGroup: spec.supersetGroup ?? null,
      notes:
        dayNumber === 1 && spec.name === "Cable Face Pull"
          ? "Optional accessory: one set is the minimum; a second set is ideal when time and recovery allow."
          : null,
      warmup: null,
      setNotes: Array.from({ length: spec.sets }, () => null),
    };
  });

  return {
    data: {
      programName: null,
      days: [{
        name: currentDay.name,
        notes: null,
        warmupNotes: null,
        exercises,
      }],
      rationale: `Deterministic BA routine-change fixture for Day ${dayNumber}.`,
    },
    confidence: 1,
    ambiguities: [],
    clarifyingQuestions: [],
    unparsed: [],
  };
}
