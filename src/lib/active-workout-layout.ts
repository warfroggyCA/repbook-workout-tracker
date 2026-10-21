export const ACTIVE_WORKOUT_OVERLAY_BOTTOM_VARIABLE =
  "--active-workout-overlay-bottom";

export function activeSetCommitFormId(
  sessionExerciseId: string,
  occurrenceId: string,
) {
  return `active-set-commit-${sessionExerciseId}-${occurrenceId}`;
}

export const WORKOUT_SET_OUTBOX_OFFSET_CLASS_NAME =
  "bottom-[var(--active-workout-overlay-bottom,calc(7.5rem+env(safe-area-inset-bottom)))] lg:bottom-[var(--active-workout-overlay-bottom,5.75rem)]";

export const OCCURRENCE_OUTBOX_OFFSET_CLASS_NAME =
  "bottom-[calc(var(--active-workout-overlay-bottom,calc(1.25rem+env(safe-area-inset-bottom)))+3.5rem)] lg:bottom-[calc(var(--active-workout-overlay-bottom,2.25rem)+3.5rem)]";

export const LIVE_COACH_OUTBOX_OFFSET_CLASS_NAME =
  "bottom-[calc(var(--active-workout-overlay-bottom,-2rem)+7rem)] lg:bottom-[calc(var(--active-workout-overlay-bottom,-6rem)+7rem)]";

/** Correct focus only when a control can fit fully above the fixed dock. */
export function workoutFocusScrollDelta(input: {
  targetTop: number; targetBottom: number; dockTop: number;
}) {
  const height = input.targetBottom - input.targetTop;
  if (!Object.values(input).every(Number.isFinite) || height <= 0 || height > input.dockTop - 16) return 0;
  return Math.max(0, input.targetBottom - input.dockTop + 8);
}
