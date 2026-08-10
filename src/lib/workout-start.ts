export type WorkoutStartState =
  | { status: "idle" }
  | {
      status: "error";
      code: "not_created" | "request_conflict";
      message: string;
      workoutCreated: false;
      startRequestKey: string | null;
    }
  | {
      status: "error";
      code: "status_unknown";
      message: string;
      workoutCreated: null;
      startRequestKey: string;
    };

export const INITIAL_WORKOUT_START_STATE: WorkoutStartState = {
  status: "idle",
};

export function retainedWorkoutStartRequestKey(
  renderedKey: string,
  state: WorkoutStartState,
) {
  return state.status === "error" && state.startRequestKey != null
    ? state.startRequestKey
    : renderedKey;
}
