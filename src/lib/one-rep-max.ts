export const EST_ONE_RM_MAX_REPS = 12;

/** Epley, defined only for 1..EST_ONE_RM_MAX_REPS working reps; null otherwise. */
export function estimateOneRepMax(weight: number, reps: number): number | null {
  if (
    !Number.isFinite(weight) ||
    !Number.isFinite(reps) ||
    reps < 1 ||
    reps > EST_ONE_RM_MAX_REPS
  ) {
    return null;
  }
  return weight * (1 + reps / 30);
}
