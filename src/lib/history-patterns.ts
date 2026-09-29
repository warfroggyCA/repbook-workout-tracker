/** Repeated skips are observations, never automatic Program recommendations. */
export type PatternWorkout = {
  sessionId: string;
  localDate: string;
  workoutName: string;
  skipped: boolean;
};
export type HistoryPatternRow = PatternWorkout & {
  slotId: string;
  exerciseId: string;
  exerciseName: string;
};
export type HistoryPattern = {
  key: string;
  exerciseId: string;
  exerciseName: string;
  skipped: number;
  workouts: PatternWorkout[];
};
export function buildHistoryPatterns(
  rows: HistoryPatternRow[],
): HistoryPattern[] {
  const groups = new Map<string, HistoryPatternRow[]>();
  for (const row of rows) {
    const key = `${row.slotId}:${row.exerciseId}`;
    const group = groups.get(key) ?? [];
    // Multiple working occurrences must never inflate the workout denominator.
    if (!group.some((item) => item.sessionId === row.sessionId))
      group.push(row);
    groups.set(key, group);
  }
  return [...groups]
    .flatMap(([key, group]) => {
      const workouts = group
        .sort(
          (a, b) =>
            b.localDate.localeCompare(a.localDate) ||
            b.sessionId.localeCompare(a.sessionId),
        )
        .slice(0, 4);
      const skipped = workouts.filter((row) => row.skipped).length;
      // A bounded repeated observation; a single skip never becomes a signal.
      if (workouts.length < 3 || skipped < 3) return [];
      return [
        {
          key,
          exerciseId: workouts[0].exerciseId,
          exerciseName: workouts[0].exerciseName,
          skipped,
          workouts,
        },
      ];
    })
    .sort(
      (a, b) =>
        b.workouts[0].localDate.localeCompare(a.workouts[0].localDate) ||
        a.key.localeCompare(b.key),
    );
}
