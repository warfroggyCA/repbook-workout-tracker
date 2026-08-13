import "server-only";

export type WorkoutExerciseOptionsUnavailableCode =
  | "workout_not_active"
  | "planned_exercise_unavailable";

export class WorkoutExerciseOptionsUnavailableError extends Error {
  constructor(
    public readonly code: WorkoutExerciseOptionsUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkoutExerciseOptionsUnavailableError";
  }
}
