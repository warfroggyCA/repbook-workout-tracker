const BINDINGS = {
  dumbbell_overhead_triceps_extension: { key: "seated-overhead-triceps-extension-v155", load: "dumbbell" },
  single_dumbbell_overhead_triceps_extension: { key: "seated-overhead-triceps-extension-v155", load: "dumbbell" },
  incline_dumbbell_curl: { key: "incline-dumbbell-curl-v102", load: "dumbbell" },
  incline_barbell_bench_press: { key: "incline-press-v107", load: "barbell" },
  wide_grip_lat_pulldown: { key: "lat-pulldown-v107", load: "external" },
  kettlebell_goblet_squat: { key: "goblet-squat-v107", load: "kettlebell" },
  romanian_deadlift: { key: "romanian-deadlift-v107", load: "barbell" },
  barbell_bench_press: { key: "barbell-bench-v108", load: "barbell" },
  barbell_back_squat: { key: "back-squat-v108", load: "barbell" },
  barbell_overhead_press: { key: "overhead-press-v108", load: "barbell" },
  barbell_row: { key: "barbell-row-v108", load: "barbell" },
  bulgarian_split_squat: { key: "bulgarian-split-squat-v109", load: "dumbbell", unilateral: true },
  ez_bar_curl: { key: "ez-bar-curl-v109", load: "ez_bar" },
  cable_leg_curl: { key: "standing-cable-leg-curl-v117", load: "external", unilateral: true },
  triceps_pushdown: { key: "rope-pushdown-v117", load: "external" },
  chest_supported_dumbbell_row: { key: "chest-supported-row-v117", load: "dumbbell" },
  chest_supported_dumbbell_reverse_fly: { key: "chest-supported-reverse-fly-v117", load: "dumbbell" },
  single_leg_dumbbell_calf_raise: { key: "single-leg-dumbbell-calf-raise-v133", load: "dumbbell", unilateral: true },
  dead_bug: { key: "dead-bug-v133", load: "bodyweight" },
  zottman_curl: { key: "zottman-curl-v133", load: "dumbbell" },
  kettlebell_suitcase_carry: { key: "kettlebell-suitcase-carry-v133", load: "kettlebell", unilateral: true, allowMigratedEmptyAttributes: true },
  dumbbell_lateral_raise: { key: "standing-dumbbell-lateral-raise-v138", load: "dumbbell" },
  dumbbell_bench_press: { key: "flat-dumbbell-bench-press-v138", load: "dumbbell" },
} as const;
export type FroggyDemoKey = typeof BINDINGS[keyof typeof BINDINGS]["key"];

/** Presentation metadata only; never persisted onto a plan or performed set. */
export type FroggyFormDemo = {
  key: FroggyDemoKey;
  exerciseId: string;
};

export type FroggyCatalogIdentity = {
  id: string;
  userId: string | null;
  variantKey: string;
  catalogReviewed: boolean;
  loadType: string;
  isUnilateral: boolean;
  variantAttributes: Record<string, unknown>;
};

/** No display-name matching or cross-database exercise UUID assumptions. */
export function matchFroggyFormDemo(
  exercise: FroggyCatalogIdentity,
  enabled: boolean,
): FroggyFormDemo | null {
  if (!enabled || !exercise.id || exercise.userId !== null ||
      !exercise.catalogReviewed || !exercise.variantAttributes ||
      typeof exercise.variantAttributes !== "object" || Array.isArray(exercise.variantAttributes)) return null;
  const binding = Object.entries(BINDINGS).find(([variant]) => variant === exercise.variantKey)?.[1];
  if (!binding || exercise.loadType !== binding.load) return null;
  const unilateral = "unilateral" in binding && binding.unilateral;
  if (exercise.isUnilateral !== unilateral) return null;
  const attributes = Object.keys(exercise.variantAttributes);
  // Migration 0087 stores carry laterality only in is_unilateral. Do not require
  // rewriting that reviewed catalog record to match the newer seed representation.
  const migratedEmptyAttributes = "allowMigratedEmptyAttributes" in binding &&
    binding.allowMigratedEmptyAttributes && attributes.length === 0;
  if (unilateral ? !migratedEmptyAttributes && (attributes.length !== 1 || exercise.variantAttributes.laterality !== "unilateral") : attributes.length !== 0) return null;
  return { key: binding.key, exerciseId: exercise.id };
}

/** A client-side substitution must never retain the previous exercise's demo. */
export function hasFroggyFormDemo(
  demo: FroggyFormDemo | null | undefined,
  exerciseId: string,
): demo is FroggyFormDemo {
  return !!demo && Object.values(BINDINGS).some(binding => binding.key === demo.key) && demo.exerciseId === exerciseId;
}

export const FROGGY_CURL_MEDIA = "/exercise-media/froggy/incline-curl-v102";
export const FROGGY_CURL_CUES = [
  { kind: "DO", text: "Keep your back on the pad." },
  { kind: "DO", text: "Keep your upper arms steady." },
  { kind: "AVOID", text: "Dropping the weights." },
] as const;
