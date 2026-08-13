export function activeWorkoutScrollBehavior(
  motionPreference: Pick<Window, "matchMedia"> | null =
    typeof window === "undefined" ? null : window,
): ScrollBehavior {
  return motionPreference?.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
