import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKOUT_SET_OUTBOX_LOCK_NAME,
  enqueueWorkoutSetOutboxEntry,
  readWorkoutSetOutbox,
  withOutboxLock,
  type NewWorkoutSetOutboxEntry,
  type WorkoutSetOutboxStorage,
} from "@/lib/workout-set-outbox";

class MemoryStorage implements WorkoutSetOutboxStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function input(index: number): NewWorkoutSetOutboxEntry {
  return {
    clientKey: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ownerId: "20000000-0000-4000-8000-000000000001",
    sessionId: "30000000-0000-4000-8000-000000000001",
    sessionExerciseId: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    exerciseName: `Exercise ${index}`,
    setNo: 1,
    weight: 100,
    weightUnit: "lb",
    reps: 8,
    rpe: null,
    note: null,
    equipmentSnapshotId: null,
    loadEntryMeaning: "legacy_unknown",
    createdAtISO: `2026-07-18T12:00:0${index}.000Z`,
  };
}

describe("workout set browser outbox lock", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serializes read-modify-write mutations so a second tab cannot lose an entry", async () => {
    const storage = new MemoryStorage();
    const requestedNames: string[] = [];
    let tail = Promise.resolve();
    const locks = {
      request: <T>(
        name: string,
        _options: { mode: "exclusive" },
        task: () => T | Promise<T>
      ) => {
        requestedNames.push(name);
        const run = tail.then(task);
        tail = run.then(() => undefined, () => undefined);
        return run;
      },
    };
    vi.stubGlobal("navigator", { locks });

    let releaseFirst!: () => void;
    const firstMayWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstRead = false;
    let secondReadCount: number | null = null;
    const first = withOutboxLock(async () => {
      expect(readWorkoutSetOutbox(storage).entries).toHaveLength(0);
      firstRead = true;
      await firstMayWrite;
      enqueueWorkoutSetOutboxEntry(storage, input(1));
    });
    await expect.poll(() => firstRead).toBe(true);

    const second = withOutboxLock(() => {
      secondReadCount = readWorkoutSetOutbox(storage).entries.length;
      enqueueWorkoutSetOutboxEntry(storage, input(2));
    });
    await Promise.resolve();
    expect(secondReadCount).toBeNull();

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondReadCount).toBe(1);
    expect(readWorkoutSetOutbox(storage).entries.map((entry) => entry.clientKey)).toEqual([
      input(1).clientKey,
      input(2).clientKey,
    ]);
    expect(requestedNames).toEqual([
      WORKOUT_SET_OUTBOX_LOCK_NAME,
      WORKOUT_SET_OUTBOX_LOCK_NAME,
    ]);
  });

  it("invokes the mutation directly when Web Locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(withOutboxLock(() => "fallback")).resolves.toBe("fallback");
  });
});
