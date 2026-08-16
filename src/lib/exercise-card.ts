import {
  nearestAchievableBounds,
  solvePlates,
  type PlateMathConfig,
} from "@/engine/plate-math";

function formatNearestBounds(
  target: number,
  config: PlateMathConfig,
  unit: string,
) {
  const bounds = nearestAchievableBounds(target, config);
  const parts = [
    bounds.lower ? `lower ${bounds.lower.totalLoad} ${unit}` : null,
    bounds.upper ? `upper ${bounds.upper.totalLoad} ${unit}` : null,
  ].filter((part): part is string => part != null);
  return parts.length > 0 ? parts.join(" · ") : "no achievable load";
}

export const SET_NOTE_MAX_LENGTH = 500;

export const EXERCISE_SWIPE_REVEAL_THRESHOLD_PX = 64;

export function exerciseSwipeRevealsRemove(input: {
  deltaX: number;
  deltaY: number;
}) {
  return input.deltaX <= -EXERCISE_SWIPE_REVEAL_THRESHOLD_PX &&
    Math.abs(input.deltaX) > Math.abs(input.deltaY) * 1.25;
}
export const EXERCISE_NOTE_MAX_LENGTH = 1000;

export function exerciseUsesTotalBarLoad(input: {
  loadType: string;
  loadSemantics: string;
  plateConfig?: PlateMathConfig;
}): boolean {
  return (
    input.plateConfig != null &&
    input.loadSemantics === "total" &&
    (input.loadType === "barbell" ||
      input.loadType === "ez_bar" ||
      input.loadType === "trap_bar")
  );
}

/**
 * The persistent next-set dock states the loading it can fit on one compact
 * line, so it leads with the per-side plates and names the bare base only when
 * no plates apply. The expanded card's guidance below always states the base.
 * Both live here so the two surfaces cannot drift apart independently.
 */
export function formatCompactPlateLoadGuidance(
  weight: number | null,
  plateConfig: PlateMathConfig | undefined,
  unit: string
): string | null {
  if (!plateConfig || weight == null) return null;
  const solution = solvePlates(weight, plateConfig);
  if (solution) {
    return solution.perSide.length
      ? `Per side: ${solution.perSide.join(" + ")} ${unit}`
      : `Empty bar and collars: ${plateConfig.barWeight + plateConfig.collarWeight} ${unit}`;
  }
  return `Not loadable · nearest ${formatNearestBounds(weight, plateConfig, unit)}`;
}

export function formatPlateLoadGuidance(
  weight: number | null,
  plateConfig: PlateMathConfig | undefined,
  unit: string
): string | null {
  if (!plateConfig || weight == null) return null;
  const base = plateConfig.barWeight + plateConfig.collarWeight;
  const solution = solvePlates(weight, plateConfig);
  if (solution) {
    return solution.perSide.length
      ? `Empty bar and collars: ${base} ${unit} · Per side: ${solution.perSide.join(" + ")} ${unit}`
      : `Empty bar: ${base} ${unit} including collars`;
  }
  return `Empty bar and collars: ${base} ${unit} · Not loadable — nearest ${formatNearestBounds(weight, plateConfig, unit)}`;
}

export function setSaveStateLabel(
  state: "pending" | "saving" | "retrying" | "failed" | "saved"
): string {
  return {
    pending: "Pending on this device",
    saving: "Saving…",
    retrying: "Retrying…",
    failed: "Save failed",
    saved: "Saved",
  }[state];
}

export function targetResultLabel(input: {
  isWarmup: boolean;
  targetMet: boolean | null;
}): "Warm-up" | "Target met" | "Below target" | null {
  if (input.isWarmup) return "Warm-up";
  if (input.targetMet === true) return "Target met";
  if (input.targetMet === false) return "Below target";
  return null;
}
