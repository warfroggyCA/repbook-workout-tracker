export type WorkoutStartState =
  | { status: "idle" }
  | {
      status: "error";
      code: "not_created";
      message: string;
      workoutCreated: false;
    }
  | {
      status: "error";
      code: "status_unknown";
      message: string;
      workoutCreated: null;
    };

export const INITIAL_WORKOUT_START_STATE: WorkoutStartState = {
  status: "idle",
};
