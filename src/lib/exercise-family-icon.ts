export type ExerciseFamilyIconKey =
  | "bench_press"
  | "horizontal_press"
  | "push"
  | "fly"
  | "squat"
  | "lunge"
  | "step"
  | "hinge"
  | "bridge"
  | "row"
  | "vertical_pull"
  | "curl"
  | "triceps"
  | "raise"
  | "legs"
  | "core"
  | "rotation"
  | "carry"
  | "olympic_lift"
  | "jump"
  | "locomotion"
  | "cycling"
  | "swimming"
  | "conditioning"
  | "mobility"
  | "stretch"
  | "default";

const FAMILY_RULES: Array<{
  key: ExerciseFamilyIconKey;
  terms: string[];
}> = [
  { key: "stretch", terms: ["stretch"] },
  { key: "bench_press", terms: ["bench press", "incline dumbbell press"] },
  { key: "horizontal_press", terms: ["chest press"] },
  { key: "push", terms: ["push-up", "dip"] },
  { key: "fly", terms: ["fly", "pull-apart"] },
  { key: "squat", terms: ["squat", "wall sit"] },
  { key: "lunge", terms: ["lunge", "split squat"] },
  { key: "step", terms: ["step-up", "stair climbing"] },
  {
    key: "hinge",
    terms: [
      "deadlift",
      "romanian deadlift",
      "good morning",
      "hip hinge",
      "pull-through",
      "kettlebell swing",
    ],
  },
  {
    key: "bridge",
    terms: ["glute bridge", "hip thrust", "hip extension", "back extension"],
  },
  {
    key: "row",
    terms: ["row", "face pull", "upright row", "high pull"],
  },
  {
    key: "vertical_pull",
    terms: ["pull-up", "chin-up", "pulldown", "pullover"],
  },
  { key: "curl", terms: ["curl"] },
  {
    key: "triceps",
    terms: ["triceps", "skull crusher", "pushdown"],
  },
  {
    key: "legs",
    terms: [
      "leg press",
      "leg curl",
      "knee extension",
      "hip abduction",
      "hip adduction",
      "tibialis",
      "calf",
    ],
  },
  {
    key: "core",
    terms: [
      "plank",
      "crunch",
      "sit-up",
      "leg raise",
      "knee raise",
      "rollout",
      "dead bug",
      "bird dog",
      "hollow hold",
      "isometric core",
      "mountain climber",
    ],
  },
  {
    key: "raise",
    terms: ["raise", "shrug", "overhead press", "dumbbell press", "kettlebell press"],
  },
  {
    key: "rotation",
    terms: ["rotation", "woodchop", "russian twist", "pallof", "windmill"],
  },
  { key: "carry", terms: ["carry", "sled"] },
  {
    key: "olympic_lift",
    terms: ["clean", "jerk", "snatch", "medicine ball throw"],
  },
  {
    key: "jump",
    terms: ["jump", "burpee", "battle ropes", "jump rope"],
  },
  { key: "cycling", terms: ["cycling"] },
  { key: "swimming", terms: ["swimming"] },
  {
    key: "locomotion",
    terms: ["walking", "running", "crawl", "elliptical", "ski erg"],
  },
  {
    key: "mobility",
    terms: ["mobility", "soft tissue", "scapular control", "activation"],
  },
];

const MOVEMENT_FALLBACKS: Record<string, ExerciseFamilyIconKey> = {
  squat: "squat",
  hinge: "hinge",
  horizontal_push: "horizontal_press",
  vertical_push: "raise",
  horizontal_pull: "row",
  vertical_pull: "vertical_pull",
  lunge: "lunge",
  carry: "carry",
  core: "core",
  isolation_arms: "curl",
  isolation_shoulders: "raise",
  isolation_legs: "legs",
  conditioning: "conditioning",
  rotation: "rotation",
  locomotion: "locomotion",
  olympic_lift: "olympic_lift",
  plyometric: "jump",
  mobility: "mobility",
  stretch: "stretch",
};

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export function iconKeyForExerciseFamily(input: {
  family?: string | null;
  exerciseName: string;
  movementPattern: string;
}): ExerciseFamilyIconKey {
  const family = normalize(input.family);
  const name = normalize(input.exerciseName);

  for (const rule of FAMILY_RULES) {
    if (
      rule.terms.some(
        (term) => family.includes(term) || (!family && name.includes(term))
      )
    ) {
      return rule.key;
    }
  }

  return MOVEMENT_FALLBACKS[input.movementPattern] ?? "default";
}
