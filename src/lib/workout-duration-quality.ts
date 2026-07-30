export const MAX_ANALYTICS_WORKOUT_DURATION_MINUTES = 180;
export const LONG_WORKOUT_DURATION_FLAG = "workout_duration_over_3h";

export function recordedWorkoutDurationMinutes(
  startedAt: Date,
  finishedAt: Date | null,
): number | null {
  if (!finishedAt) return null;
  return (finishedAt.getTime() - startedAt.getTime()) / 60_000;
}

export function shouldExcludeWorkoutDuration(
  startedAt: Date,
  finishedAt: Date | null,
  explicitlyExcluded = false,
): boolean {
  const duration = recordedWorkoutDurationMinutes(startedAt, finishedAt);
  return (
    explicitlyExcluded ||
    duration == null ||
    duration < 0 ||
    duration > MAX_ANALYTICS_WORKOUT_DURATION_MINUTES
  );
}

export function analyticsWorkoutDurationMinutes(
  startedAt: Date,
  finishedAt: Date | null,
  explicitlyExcluded = false,
): number | null {
  if (shouldExcludeWorkoutDuration(startedAt, finishedAt, explicitlyExcluded)) {
    return null;
  }
  return recordedWorkoutDurationMinutes(startedAt, finishedAt);
}
