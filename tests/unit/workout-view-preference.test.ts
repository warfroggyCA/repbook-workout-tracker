import { describe, expect, it, vi } from "vitest";
import { createWorkoutViewStore, workoutViewServerSnapshot } from "@/lib/workout-view-preference";

describe("workout view preference", () => {
  it("retains only the selected view through unmount/remount and reload in the same tab", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const first = createWorkoutViewStore(() => storage);
    const listener = vi.fn();
    const unsubscribe = first.subscribe("synthetic-owner:session-a", listener);
    first.setView("synthetic-owner:session-a", "overview");
    unsubscribe();
    expect(listener).toHaveBeenCalledOnce();
    expect(first.getSnapshot("synthetic-owner:session-a")).toBe("overview");
    const reloaded = createWorkoutViewStore(() => storage);
    expect(reloaded.getSnapshot("synthetic-owner:session-a")).toBe("overview");
    expect([...data.values()]).toEqual(["overview"]);
    first.setView("synthetic-owner:session-a", "focused");
    expect(listener).toHaveBeenCalledOnce();
  });
  it("keeps sessions and owners separate and never changes the SSR snapshot", () => {
    const store = createWorkoutViewStore(() => null);
    store.setView("owner-a:session-a", "overview");
    expect(store.getSnapshot("owner-a:session-b")).toBe("focused");
    expect(store.getSnapshot("owner-b:session-a")).toBe("focused");
    expect(workoutViewServerSnapshot()).toBe("focused");
  });
  it("retains the selection in memory when preference storage is blocked", () => {
    const store = createWorkoutViewStore(() => { throw new Error("blocked"); });
    expect(store.getSnapshot("owner:session")).toBe("focused");
    expect(() => store.setView("owner:session", "overview")).not.toThrow();
    expect(store.getSnapshot("owner:session")).toBe("overview");
  });
  it("ignores corrupt stored values without touching other browser data", () => {
    const setItem = vi.fn();
    const store = createWorkoutViewStore(() => ({ getItem: () => '{"workout":"not a view"}', setItem }));
    expect(store.getSnapshot("owner:session")).toBe("focused");
    expect(setItem).not.toHaveBeenCalled();
  });
});
