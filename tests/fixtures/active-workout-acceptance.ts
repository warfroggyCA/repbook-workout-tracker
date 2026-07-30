export type ActiveWorkoutAcceptanceFixture = {
  id: string;
  viewport: { width: number; height: number };
  textSize: "100" | "115" | "130" | "145";
  exerciseNames: string[];
  superset: boolean;
  save: "normal" | "slow" | "failing" | "offline-reconnect";
  adjustment: "none" | "note" | "pain" | "alternative" | "skip" | "coach";
};

export const ACTIVE_WORKOUT_ACCEPTANCE_FIXTURES: ActiveWorkoutAcceptanceFixture[] = [
  {
    id: "normal-workout",
    viewport: { width: 390, height: 844 },
    textSize: "100",
    exerciseNames: ["Fixture squat", "Fixture row"],
    superset: false,
    save: "normal",
    adjustment: "none",
  },
  {
    id: "superset",
    viewport: { width: 390, height: 844 },
    textSize: "115",
    exerciseNames: ["Fixture press", "Fixture pull"],
    superset: true,
    save: "normal",
    adjustment: "none",
  },
  {
    id: "slow-save",
    viewport: { width: 430, height: 932 },
    textSize: "130",
    exerciseNames: ["Fixture hinge"],
    superset: false,
    save: "slow",
    adjustment: "note",
  },
  {
    id: "failing-save",
    viewport: { width: 390, height: 844 },
    textSize: "100",
    exerciseNames: ["Fixture carry"],
    superset: false,
    save: "failing",
    adjustment: "coach",
  },
  {
    id: "offline-reconnect",
    viewport: { width: 390, height: 844 },
    textSize: "115",
    exerciseNames: ["Fixture curl"],
    superset: false,
    save: "offline-reconnect",
    adjustment: "alternative",
  },
  {
    id: "exercise-adjustment",
    viewport: { width: 768, height: 1024 },
    textSize: "130",
    exerciseNames: ["Fixture lunge"],
    superset: false,
    save: "normal",
    adjustment: "pain",
  },
  {
    id: "narrow-enlarged-text",
    viewport: { width: 320, height: 568 },
    textSize: "145",
    exerciseNames: ["Fixture raise"],
    superset: false,
    save: "normal",
    adjustment: "skip",
  },
];
