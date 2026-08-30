export const ACTIVE_WORKOUT_OVERLAY_BOTTOM_VARIABLE =
  "--active-workout-overlay-bottom";

export const WORKOUT_SET_OUTBOX_OFFSET_CLASS_NAME =
  "bottom-[var(--active-workout-overlay-bottom,calc(7.5rem+env(safe-area-inset-bottom)))] lg:bottom-[var(--active-workout-overlay-bottom,5.75rem)]";

export const OCCURRENCE_OUTBOX_OFFSET_CLASS_NAME =
  "bottom-[calc(var(--active-workout-overlay-bottom,calc(1.25rem+env(safe-area-inset-bottom)))+3.5rem)] lg:bottom-[calc(var(--active-workout-overlay-bottom,2.25rem)+3.5rem)]";

export const LIVE_COACH_OUTBOX_OFFSET_CLASS_NAME =
  "bottom-[calc(var(--active-workout-overlay-bottom,-2rem)+7rem)] lg:bottom-[calc(var(--active-workout-overlay-bottom,-6rem)+7rem)]";
