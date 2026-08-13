export type WorkoutExerciseOptionsMode = "alternative" | "replacement";

export class WorkoutExerciseOptionsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "WorkoutExerciseOptionsRequestError";
  }
}

export async function fetchWorkoutExerciseOptions<T>(
  mode: WorkoutExerciseOptionsMode,
  sessionExerciseId: string,
  signal: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<T> {
  const query = new URLSearchParams({ mode, sessionExerciseId });
  const response = await fetchImplementation(
    `/api/session/exercise-options?${query.toString()}`,
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    },
  );
  const payload = await response.json().catch(() => null) as unknown;
  if (
    !response.ok ||
    payload == null ||
    typeof payload !== "object" ||
    !("ok" in payload) ||
    payload.ok !== true ||
    !("options" in payload) ||
    payload.options == null ||
    typeof payload.options !== "object"
  ) {
    const message = payload != null &&
        typeof payload === "object" &&
        "message" in payload &&
        typeof payload.message === "string"
      ? payload.message
      : "The exercise catalog could not be loaded.";
    throw new WorkoutExerciseOptionsRequestError(message, response.status);
  }
  return payload.options as T;
}
