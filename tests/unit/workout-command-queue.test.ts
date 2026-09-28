import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKOUT_SET_OUTBOX_STORAGE_KEY } from "@/lib/workout-set-outbox";
import {
  nextQueuedWorkoutCommand,
  deliverNextWorkoutCommand,
  readWorkoutCommandQueue,
  type WorkoutCommand,
} from "@/lib/workout-command-queue";
import {
  enqueueOccurrenceMutationOutboxEntry,
  removeOccurrenceMutationOutboxEntry,
  type NewOccurrenceMutationOutboxEntry,
} from "@/lib/occurrence-mutation-outbox";

const owner = "10000000-0000-4000-8000-000000000001";
function command(
  kind: WorkoutCommand["kind"],
  n: number,
  extra: Record<string, unknown> = {},
): WorkoutCommand {
  return {
    kind,
    entry: {
      ownerId: owner,
      clientKey: `command-${n}`,
      createdAtISO: new Date(n * 1000).toISOString(),
      sessionId: "workout",
      sessionExerciseId: "exercise",
      occurrenceId: `occurrence-${n}`,
      status: "queued",
      nextAttemptAtISO: null,
      ...extra,
    },
  } as WorkoutCommand;
}
const next = (commands: WorkoutCommand[]) =>
  nextQueuedWorkoutCommand(owner, commands, new Date(100_000));

describe("unified workout command selection", () => {
  it("orders every kind together instead of starting five independent streams", () => {
    const commands = [
      command("coach", 5),
      command("note", 4),
      command("occurrence", 3),
      command("set", 2),
      command("selection", 1),
    ];
    const kinds = [];
    while (commands.length) {
      const selected = next(commands)!;
      kinds.push(selected.kind);
      commands.splice(commands.indexOf(selected), 1);
    }
    expect(kinds).toEqual(["selection", "set", "occurrence", "note", "coach"]);
  });
  it("a retrying set fences a later skip but does not stop unrelated observations", () => {
    const set = command("set", 1, {
      nextAttemptAtISO: new Date(200_000).toISOString(),
    });
    const skip = command("occurrence", 2, { operation: "skip" });
    const note = command("note", 3);
    expect(next([skip, note, set])).toBe(note);
    expect(next([skip, set])).toBeNull();
  });
  it("an unresolved occurrence prevents later sets and equipment changes overtaking it", () => {
    const occurrence = command("occurrence", 1, { status: "needs_attention" });
    expect(next([command("set", 2), occurrence])).toBeNull();
    expect(next([command("selection", 2), occurrence])).toBeNull();
    const other = command("set", 3, { sessionId: "other-workout" });
    expect(next([occurrence, other])).toBe(other);
  });
  it("does not starve another workout when the earliest set is fenced by an occurrence", () => {
    const mutation = command("occurrence", 1, { status: "needs_attention" });
    const blocked = command("set", 2);
    const unrelated = command("set", 3, {
      sessionId: "other-workout",
      sessionExerciseId: "other-exercise",
    });
    expect(next([mutation, blocked, unrelated])).toBe(unrelated);
  });
  it("permits the exact occurrence recovery required by a retained later set", () => {
    const set = command("set", 1, {
      status: "needs_attention",
      orderBlocker: { occurrenceId: "blocker" },
    });
    const skip = command("occurrence", 2, {
      occurrenceId: "blocker",
      operation: "skip",
    });
    expect(next([set, skip])).toBe(skip);
    expect(
      next([
        set,
        {
          ...skip,
          entry: { ...skip.entry, operation: "note" },
        } as WorkoutCommand,
      ]),
    ).toBeNull();
  });
  it("keeps exact blocker set recovery and its equipment dependency chain", () => {
    const blocked = command("set", 1, {
      status: "needs_attention",
      orderBlocker: { occurrenceId: "blocker" },
    });
    const selection = command("selection", 2);
    const recovery = command("set", 3, {
      occurrenceId: "blocker",
      equipmentSelectionClientKey: selection.entry.clientKey,
    });
    expect(next([blocked, selection, recovery])).toBe(selection);
    expect(
      next([blocked, command("set", 3, { occurrenceId: "blocker" })])?.entry
        .clientKey,
    ).toBe("command-3");
  });
  it("does not allow a later same-occurrence mutation to pass a failed earlier one", () => {
    expect(
      next([
        command("occurrence", 1, {
          status: "needs_attention",
          occurrenceId: "same",
        }),
        command("occurrence", 2, { occurrenceId: "same" }),
      ]),
    ).toBeNull();
  });
  it("filters foreign owners and recovers an interrupted note without changing its payload", () => {
    const foreign = command("set", 1, { ownerId: "someone-else" });
    const note = command("note", 2, {
      status: "syncing",
      nextAttemptAtISO: new Date(200_000).toISOString(),
    });
    expect(next([foreign, note])).toBe(note);
  });
  it("is deterministic for legacy equal timestamps and does not mutate the input", () => {
    const a = command("note", 1, { clientKey: "a" });
    const b = command("coach", 1, { clientKey: "b" });
    const input = [b, a];
    expect(next(input)).toBe(a);
    expect(input).toEqual([b, a]);
  });
});

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
function retained(n: number): NewOccurrenceMutationOutboxEntry {
  return {
    clientKey: `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ownerId: owner,
    sessionId: "30000000-0000-4000-8000-000000000001",
    occurrenceId: "40000000-0000-4000-8000-000000000001",
    label: "Synthetic warm-up",
    expectedRevision: 0,
    operation: "skip",
    reason: "user_skipped",
    note: null,
    createdAtISO: new Date(n * 1000).toISOString(),
  };
}
function browser(storage: MemoryStorage) {
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
  vi.stubGlobal("navigator", {
    onLine: true,
    locks: {
      request: (
        key: string,
        _options: unknown,
        task: () => Promise<unknown>,
      ) => {
        const result = (tails.get(key) ?? Promise.resolve()).then(task);
        tails.set(
          key,
          result.catch(() => {}),
        );
        return result;
      },
    },
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("shared delivery lock", () => {
  it("reselects after a competing tab acknowledges instead of delivering the same stale copy", async () => {
    const storage = new MemoryStorage();
    browser(storage);
    enqueueOccurrenceMutationOutboxEntry(storage, retained(1));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const first = deliverNextWorkoutCommand(
      owner,
      () => true,
      async (command) => {
        calls.push(command.entry.clientKey);
        await gate;
        removeOccurrenceMutationOutboxEntry(storage, command.entry.clientKey);
      },
    );
    const second = deliverNextWorkoutCommand(
      owner,
      () => true,
      async (command) => {
        calls.push(command.entry.clientKey);
      },
    );
    await Promise.resolve();
    expect(calls).toEqual([retained(1).clientKey]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual([retained(1).clientKey]);
    expect(readWorkoutCommandQueue(owner)).toEqual([]);
  });
  it("does not send or alter legacy durable bytes when locks are unavailable", async () => {
    const storage = new MemoryStorage();
    browser(storage);
    enqueueOccurrenceMutationOutboxEntry(storage, retained(1));
    const before = [...storage.values];
    vi.stubGlobal("navigator", { onLine: true });
    const send = vi.fn();
    await deliverNextWorkoutCommand(owner, () => true, send);
    expect(send).not.toHaveBeenCalled();
    expect([...storage.values]).toEqual(before);
  });
  it("keeps unreadable mutation bytes and pauses later kinds until recovery", async () => {
    const storage = new MemoryStorage();
    browser(storage);
    enqueueOccurrenceMutationOutboxEntry(storage, retained(1));
    storage.setItem(WORKOUT_SET_OUTBOX_STORAGE_KEY, "unreadable retained copy");
    const before = [...storage.values];
    const send = vi.fn();
    await deliverNextWorkoutCommand(owner, () => true, send);
    expect(send).not.toHaveBeenCalled();
    expect([...storage.values]).toEqual(before);
  });
  it("refuses an out-of-order direct transport call", async () => {
    const storage = new MemoryStorage();
    browser(storage);
    enqueueOccurrenceMutationOutboxEntry(storage, retained(1));
    const send = vi.fn();
    await deliverNextWorkoutCommand(
      owner,
      (command) => command.kind === "set",
      send,
    );
    expect(send).not.toHaveBeenCalled();
    expect(readWorkoutCommandQueue(owner)).toHaveLength(1);
  });
});
