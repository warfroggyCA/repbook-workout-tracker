export const WORKOUT_INTERACTION_MARKS = {
  workoutStartSubmit: "repbook:workout-start:submit",
  workoutStartPending: "repbook:workout-start:pending",
  sessionCockpitUsable: "repbook:session:cockpit-usable",
  setLogTap: "repbook:set-log:tap",
  setRetainedLocally: "repbook:set-log:retained-locally",
  setUiAdvanced: "repbook:set-log:ui-advanced",
  setAcknowledged: "repbook:set-log:acknowledged",
  setRecoveryRendered: "repbook:set-log:recovery-rendered",
} as const;

export type WorkoutInteractionMark =
  (typeof WORKOUT_INTERACTION_MARKS)[keyof typeof WORKOUT_INTERACTION_MARKS];

/**
 * Adds a content-free browser timing mark for local diagnostics and tests.
 * Marks carry no workout, exercise, set, load, repetition, pain, or note data.
 */
export function markWorkoutInteraction(mark: WorkoutInteractionMark): boolean {
  if (
    typeof performance === "undefined" ||
    typeof performance.mark !== "function"
  ) {
    return false;
  }
  try {
    performance.mark(mark);
    return true;
  } catch {
    return false;
  }
}
