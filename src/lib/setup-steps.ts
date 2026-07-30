/** Guided setup wizard steps (plan §4). Order is the canonical flow. */

export const SETUP_STEPS = [
  { slug: "profile", title: "Profile" },
  { slug: "equipment", title: "Equipment" },
  { slug: "constraints", title: "Constraints" },
  { slug: "routine", title: "Routine" },
  { slug: "coaching", title: "Coaching" },
  { slug: "review", title: "Review" },
] as const;

export type SetupStepSlug = (typeof SETUP_STEPS)[number]["slug"];

export function isSetupStep(slug: string): slug is SetupStepSlug {
  return SETUP_STEPS.some((s) => s.slug === slug);
}

export function stepIndex(slug: SetupStepSlug): number {
  return SETUP_STEPS.findIndex((s) => s.slug === slug);
}

export function nextStep(slug: SetupStepSlug): SetupStepSlug | null {
  const idx = stepIndex(slug);
  return idx < SETUP_STEPS.length - 1 ? SETUP_STEPS[idx + 1].slug : null;
}

/** First step the user has not completed yet — where /setup resumes. */
export function firstIncompleteStep(completed: string[]): SetupStepSlug {
  return (
    SETUP_STEPS.find((s) => !completed.includes(s.slug))?.slug ?? "review"
  );
}

export const AGE_RANGES = ["18-29", "30-39", "40-49", "50-59", "60+"] as const;

export const GOALS = [
  { id: "strength", label: "Get stronger" },
  { id: "tone", label: "Muscle tone" },
  { id: "consistency", label: "Stay consistent" },
] as const;

/**
 * Body region → movement patterns it plausibly affects (plan §4 step 3).
 * Constraints only ever map to these patterns — never invented exercise bans.
 */
export const BODY_REGION_PATTERNS: Record<string, string[]> = {
  shoulder: ["vertical_push", "horizontal_push", "isolation_shoulders"],
  elbow: ["isolation_arms", "horizontal_push", "vertical_push"],
  wrist: ["horizontal_push", "isolation_arms", "carry"],
  back: ["hinge", "squat", "core"],
  hip: ["hinge", "squat", "lunge"],
  knee: ["squat", "lunge", "isolation_legs"],
};

export const PATTERN_LABELS: Record<string, string> = {
  squat: "Squat",
  hinge: "Hinge (deadlifts)",
  horizontal_push: "Horizontal push (bench, push-ups)",
  vertical_push: "Vertical push (overhead press)",
  horizontal_pull: "Horizontal pull (rows)",
  vertical_pull: "Vertical pull (pull-ups)",
  lunge: "Lunges & split squats",
  carry: "Carries",
  core: "Core",
  isolation_arms: "Arm isolation",
  isolation_shoulders: "Shoulder isolation",
  isolation_legs: "Leg isolation",
  conditioning: "Conditioning",
};

/** Common plate denominations to prefill the checklist, per unit. */
export const DEFAULT_PLATE_DENOMS: Record<"lb" | "kg", number[]> = {
  lb: [45, 35, 25, 10, 5, 2.5],
  kg: [20, 15, 10, 5, 2.5, 1.25],
};

/** Standard bar weights, per unit. */
export const DEFAULT_BAR_WEIGHT: Record<"lb" | "kg", number> = {
  lb: 45,
  kg: 20,
};
export const DEFAULT_EZ_BAR_WEIGHT: Record<"lb" | "kg", number> = {
  lb: 25,
  kg: 10,
};
