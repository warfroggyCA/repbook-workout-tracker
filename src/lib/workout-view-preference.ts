export type WorkoutView = "focused" | "overview";
type ViewStorage = Pick<Storage, "getItem" | "setItem">;

/** Only a display preference. Never store workout evidence or change its meaning. */
export function createWorkoutViewStore(storage: () => ViewStorage | null) {
  const views = new Map<string, WorkoutView>();
  const listeners = new Map<string, Set<() => void>>();
  const storageKey = (key: string) => "workout-tracker:workout-view:v1:" + key;
  return {
    getSnapshot(key: string): WorkoutView {
      const cached = views.get(key);
      if (cached) return cached;
      let value: WorkoutView = "focused";
      try {
        if (storage()?.getItem(storageKey(key)) === "overview") value = "overview";
      } catch { /* A blocked preference store must not block logging. */ }
      views.set(key, value);
      return value;
    },
    setView(key: string, value: WorkoutView) {
      views.set(key, value);
      try { storage()?.setItem(storageKey(key), value); }
      catch { /* Keep this tab's choice in memory when storage is unavailable. */ }
      for (const listener of listeners.get(key) ?? []) listener();
    },
    subscribe(key: string, listener: () => void) {
      const subscribers = listeners.get(key) ?? new Set<() => void>();
      subscribers.add(listener);
      listeners.set(key, subscribers);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(key);
      };
    },
  };
}

export const workoutViewStore = createWorkoutViewStore(
  () => typeof window === "undefined" ? null : window.sessionStorage,
);
export const workoutViewServerSnapshot = (): WorkoutView => "focused";
