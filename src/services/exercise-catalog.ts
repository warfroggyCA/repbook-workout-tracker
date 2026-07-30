import type { SeedExercise } from "@/db/seed/exercise-library";

export function catalogKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const FAMILY_RULES: Array<[RegExp, string]> = [
  [/romanian|stiff-leg/i, "Romanian Deadlift"],
  [/deadlift|rack pull/i, "Deadlift"],
  [/hip thrust/i, "Hip Thrust"],
  [/glute bridge|frog pump/i, "Glute Bridge"],
  [/good morning/i, "Good Morning"],
  [/back extension|hyperextension/i, "Back Extension"],
  [/goblet squat/i, "Goblet Squat"],
  [/bulgarian split squat/i, "Bulgarian Split Squat"],
  [/split squat/i, "Split Squat"],
  [/squat/i, "Squat"],
  [/bench press|floor press/i, "Bench Press"],
  [/chest press/i, "Chest Press"],
  [/chest fly|cable fly|dumbbell fly|pec deck/i, "Chest Fly"],
  [/push-up|pushup/i, "Push-Up"],
  [/overhead press|shoulder press|push press|z press|landmine press|arnold press|pike push-up/i, "Overhead Press"],
  [/pulldown/i, "Lat Pulldown"],
  [/pull-up|pullup/i, "Pull-Up"],
  [/chin-up|chinup/i, "Chin-Up"],
  [/row/i, "Row"],
  [/lunge/i, "Lunge"],
  [/step-up|step up/i, "Step-Up"],
  [/carry|farmer/i, "Loaded Carry"],
  [/plank/i, "Plank"],
  [/curl/i, "Biceps Curl"],
  [/skull crusher|skullcrusher/i, "Skull Crusher"],
  [/pushdown|pressdown/i, "Triceps Pushdown"],
  [/triceps extension|kickback/i, "Triceps Extension"],
  [/dip/i, "Dip"],
  [/lateral raise|front raise|lu raise|scaption/i, "Shoulder Raise"],
  [/rear delt|reverse fly|t raise|y raise/i, "Rear Delt Fly"],
  [/face pull/i, "Face Pull"],
  [/shrug/i, "Shrug"],
  [/calf raise/i, "Calf Raise"],
  [/leg curl/i, "Leg Curl"],
  [/leg extension|knee extension/i, "Knee Extension"],
  [/jump rope/i, "Jump Rope"],
  [/elliptical/i, "Elliptical"],
  [/burpee/i, "Burpee"],
];

export function exerciseFamilyName(exercise: SeedExercise): string {
  if (exercise.family) return exercise.family;
  return FAMILY_RULES.find(([pattern]) => pattern.test(exercise.name))?.[1] ?? exercise.name;
}

export function exerciseActivityClass(
  exercise: SeedExercise
): NonNullable<SeedExercise["activityClass"]> {
  if (exercise.activityClass) return exercise.activityClass;
  if (exercise.pattern === "conditioning" || exercise.pattern === "locomotion" || exercise.pattern === "plyometric") {
    return "conditioning";
  }
  if (exercise.pattern === "mobility") return "mobility";
  if (exercise.pattern === "stretch") return "stretch";
  return "strength";
}

export function exerciseMetricType(
  exercise: SeedExercise
): NonNullable<SeedExercise["metricType"]> {
  if (exercise.metricType) return exercise.metricType;
  if (/plank|hold|wall sit/i.test(exercise.name)) return "duration";
  if (/elliptical|rowing machine|running|walking|carry/i.test(exercise.name)) {
    return "distance_duration";
  }
  if (exercise.activityClass === "stretch" || exercise.pattern === "stretch") {
    return "duration";
  }
  if (exercise.loadType === "bodyweight") return "reps";
  return "weight_reps";
}

export function exerciseLoadSemantics(
  exercise: SeedExercise
): NonNullable<SeedExercise["loadSemantics"]> {
  if (exercise.loadSemantics) return exercise.loadSemantics;
  switch (exercise.loadType) {
    case "barbell":
    case "ez_bar":
    case "trap_bar":
      return "total";
    case "dumbbell":
    case "kettlebell":
      return "per_implement";
    case "band":
      return "resistance_band";
    case "bodyweight":
      return "bodyweight";
    default:
      return "machine_stack";
  }
}

export function exerciseVariantKey(exercise: SeedExercise): string {
  return exercise.variantKey ?? catalogKey(exercise.name);
}
