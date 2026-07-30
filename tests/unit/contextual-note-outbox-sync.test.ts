import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueContextualNoteOutboxEntry,
  markContextualNoteOutboxSyncing,
  readContextualNoteOutbox,
  type ContextualNoteOutboxEntry,
  type ContextualNoteOutboxStorage,
  type NewContextualNoteOutboxEntry,
} from "@/lib/contextual-note-outbox";

vi.mock("@/app/actions/contextual-notes", () => ({
  createContextualNoteAction: vi.fn(),
}));

import {
  parseContextualNoteSaveResult,
  registerContextualNoteOutboxWakeListeners,
  syncContextualNoteEntry,
} from "@/components/contextual-notes/contextual-note-outbox-sync";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";

class MemoryStorage implements ContextualNoteOutboxStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class FakeBroadcastChannel extends EventTarget {
  postMessage() {}
  close() {}
}

function input(): NewContextualNoteOutboxEntry {
  const clientKey = "20000000-0000-4000-8000-000000000001";
  return {
    clientKey,
    ownerId: OWNER_ID,
    createdAtISO: "2026-07-22T20:00:00.000Z",
    payload: {
      clientKey,
      body: "Reviewed observation",
      coachVisible: true,
      inputMode: "typed",
      recordedAt: "2026-07-22T20:00:00.000Z",
      attachmentKind: "general",
      capturedContext: {
        schemaVersion: 1,
        destination: "today",
        workflow: null,
        workoutPhase: null,
        originatedFromSimulation: false,
        programDay: null,
        plannedExercise: null,
        performedExercise: null,
        occurrence: null,
        loadRepetitions: null,
        restContext: null,
        reviewContext: null,
      },
    },
  };
}

function queued(storage: MemoryStorage) {
  const result = enqueueContextualNoteOutboxEntry(storage, input());
  if (!result.ok || !result.entry) throw new Error("fixture did not enqueue");
  return result.entry;
}

describe("contextual note outbox sync", () => {
  let storage: MemoryStorage;
  let fakeWindow: EventTarget & { localStorage: MemoryStorage };
  let fakeDocument: EventTarget & { visibilityState: "visible" | "hidden" };

  beforeEach(() => {
    storage = new MemoryStorage();
    fakeWindow = Object.assign(new EventTarget(), { localStorage: storage });
    fakeDocument = Object.assign(new EventTarget(), {
      visibilityState: "visible" as const,
    });
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    vi.stubGlobal("navigator", {
      onLine: true,
      locks: {
        request: <T>(
          _name: string,
          _options: unknown,
          task: () => T | Promise<T>
        ) => task(),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("removes a device entry only after the exact client key and payload hash are acknowledged", async () => {
    const entry = queued(storage);
    const save = vi.fn(async (payload: ContextualNoteOutboxEntry["payload"]) => {
      expect(payload).toEqual(entry.payload);
      return {
        ok: true,
        clientKey: entry.clientKey,
        payloadHash: entry.payloadHash,
      };
    });
    await syncContextualNoteEntry(OWNER_ID, entry, save);
    expect(save).toHaveBeenCalledOnce();
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries).toEqual([]);
  });

  it("keeps the entry and requires attention when the acknowledgement names different content", async () => {
    const entry = queued(storage);
    await syncContextualNoteEntry(OWNER_ID, entry, async () => ({
      ok: true,
      clientKey: entry.clientKey,
      payloadHash: `sha256:${"0".repeat(64)}`,
    }));
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries[0]).toMatchObject({
      status: "needs_attention",
      payloadHash: entry.payloadHash,
      lastError: expect.stringContaining("different note content"),
    });
  });

  it("queues retryable failures with backoff and pauses permanent or malformed failures", async () => {
    const retryable = queued(storage);
    await syncContextualNoteEntry(OWNER_ID, retryable, async () => ({
      ok: false,
      reason: "Temporarily unavailable",
      retryable: true,
    }));
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries[0]).toMatchObject({
      status: "queued",
      attemptCount: 1,
      nextAttemptAtISO: expect.any(String),
      lastError: "Temporarily unavailable",
    });

    storage = new MemoryStorage();
    fakeWindow.localStorage = storage;
    const permanent = queued(storage);
    await syncContextualNoteEntry(OWNER_ID, permanent, async () => ({
      ok: false,
      reason: "Attachment is gone",
      retryable: false,
    }));
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries[0]).toMatchObject({
      status: "needs_attention",
      lastError: "Attachment is gone",
    });

    expect(parseContextualNoteSaveResult({ ok: true })).toEqual({
      ok: false,
      malformed: true,
    });
  });

  it("recovers an interrupted syncing state under the shared lock", async () => {
    const entry = queued(storage);
    const syncing = markContextualNoteOutboxSyncing(
      storage,
      OWNER_ID,
      entry.clientKey,
      entry.payloadHash
    );
    if (!syncing.ok || !syncing.entry) throw new Error("fixture did not sync");
    await syncContextualNoteEntry(OWNER_ID, syncing.entry, async () => ({
      ok: true,
      clientKey: entry.clientKey,
      payloadHash: entry.payloadHash,
    }));
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries).toEqual([]);
  });

  it("does not start a duplicate save for the same owner and client identity", async () => {
    const entry = queued(storage);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const save = vi.fn(async () => {
      await hold;
      return {
        ok: true,
        clientKey: entry.clientKey,
        payloadHash: entry.payloadHash,
      };
    });
    const first = syncContextualNoteEntry(OWNER_ID, entry, save);
    await expect.poll(() => save).toHaveBeenCalledOnce();
    await syncContextualNoteEntry(OWNER_ID, entry, save);
    expect(save).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it("keeps the device copy and sends nothing when cross-tab locks are unavailable", async () => {
    const entry = queued(storage);
    const save = vi.fn();
    vi.stubGlobal("navigator", { onLine: true });

    await syncContextualNoteEntry(OWNER_ID, entry, save);

    expect(save).not.toHaveBeenCalled();
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries).toEqual([entry]);
  });

  it("wakes on online, focus, pageshow, and visible-page changes, then cleans up", () => {
    const wake = vi.fn();
    const unregister = registerContextualNoteOutboxWakeListeners(wake);
    fakeWindow.dispatchEvent(new Event("online"));
    fakeWindow.dispatchEvent(new Event("focus"));
    fakeWindow.dispatchEvent(new Event("pageshow"));
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    expect(wake).toHaveBeenCalledTimes(4);

    fakeDocument.visibilityState = "hidden";
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    expect(wake).toHaveBeenCalledTimes(4);
    unregister();
    fakeWindow.dispatchEvent(new Event("online"));
    expect(wake).toHaveBeenCalledTimes(4);
  });
});
