import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXTUAL_NOTE_OUTBOX_LOCK_NAME,
  CONTEXTUAL_NOTE_OUTBOX_CHANNEL,
  CONTEXTUAL_NOTE_OUTBOX_MAX_AUTO_ATTEMPTS,
  CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY,
  confirmedContextualNoteDictation,
  discardContextualNoteQuarantinedEntry,
  enqueueContextualNoteOutboxEntry,
  hashContextualNotePayload,
  markContextualNoteOutboxNeedsAttention,
  markContextualNoteOutboxSyncing,
  markContextualNoteOutboxTransientFailure,
  parseContextualNoteOutbox,
  readContextualNoteOutbox,
  removeContextualNoteOutboxEntry,
  retryContextualNoteOutboxEntry,
  subscribeToContextualNoteOutbox,
  withContextualNoteOutboxLock,
  type ContextualNoteOutboxStorage,
  type NewContextualNoteOutboxEntry,
} from "@/lib/contextual-note-outbox";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_OWNER_ID = "10000000-0000-4000-8000-000000000002";

class MemoryStorage implements ContextualNoteOutboxStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function input(index = 1): NewContextualNoteOutboxEntry {
  const clientKey = `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    clientKey,
    ownerId: OWNER_ID,
    createdAtISO: `2026-07-22T19:00:${String(index).padStart(2, "0")}.000Z`,
    payload: {
      clientKey,
      body: `Reviewed observation ${index}`,
      coachVisible: true,
      inputMode: "typed",
      recordedAt: `2026-07-22T19:00:${String(index).padStart(2, "0")}.000Z`,
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

describe("contextual note outbox", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores a versioned owner-scoped envelope with a stable identity and payload hash", () => {
    const storage = new MemoryStorage();
    const first = enqueueContextualNoteOutboxEntry(storage, input());
    expect(first).toMatchObject({
      ok: true,
      entry: {
        clientKey: input().clientKey,
        ownerId: OWNER_ID,
        status: "queued",
        payloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    const entry = first.ok ? first.entry! : null;
    expect(entry?.payloadHash).toBe(
      hashContextualNotePayload(entry!.payload)
    );
    expect(enqueueContextualNoteOutboxEntry(storage, input())).toEqual(first);

    const envelope = JSON.parse(
      storage.getItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY) ?? "null"
    );
    expect(envelope).toMatchObject({ version: 1, ownerId: OWNER_ID });
    expect(envelope.entries).toHaveLength(1);
  });

  it("rejects reusing an identity for changed content", () => {
    const storage = new MemoryStorage();
    expect(enqueueContextualNoteOutboxEntry(storage, input()).ok).toBe(true);
    const changed = input();
    changed.payload = { ...changed.payload, body: "Different content" };
    expect(enqueueContextualNoteOutboxEntry(storage, changed)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("different content"),
    });
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries[0]?.payload.body).toBe(
      "Reviewed observation 1"
    );
  });

  it("quarantines a payload changed behind its hash and preserves it on later writes", () => {
    const storage = new MemoryStorage();
    expect(enqueueContextualNoteOutboxEntry(storage, input()).ok).toBe(true);
    const envelope = JSON.parse(
      storage.getItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY) ?? "null"
    );
    envelope.entries[0].payload.body = "Changed without a new identity";
    storage.setItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY, JSON.stringify(envelope));

    const corrupted = readContextualNoteOutbox(storage, OWNER_ID);
    expect(corrupted.entries).toEqual([]);
    expect(corrupted.quarantined[0]).toMatchObject({
      raw: expect.objectContaining({
        payload: expect.objectContaining({ body: "Changed without a new identity" }),
      }),
      reason: expect.stringContaining("payload hash"),
    });

    expect(enqueueContextualNoteOutboxEntry(storage, input(2)).ok).toBe(true);
    expect(readContextualNoteOutbox(storage, OWNER_ID)).toMatchObject({
      entries: [{ clientKey: input(2).clientKey }],
      quarantined: [{ reason: expect.stringContaining("payload hash") }],
    });
  });

  it("fails closed without rewriting corrupt or foreign-owner storage", () => {
    const corrupt = new MemoryStorage();
    corrupt.setItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY, "not-json");
    expect(enqueueContextualNoteOutboxEntry(corrupt, input())).toMatchObject({
      ok: false,
      reason: expect.stringContaining("left unchanged"),
    });
    expect(corrupt.getItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY)).toBe("not-json");

    const foreign = new MemoryStorage();
    foreign.setItem(
      CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, ownerId: OTHER_OWNER_ID, entries: [] })
    );
    const before = foreign.getItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY);
    expect(enqueueContextualNoteOutboxEntry(foreign, input())).toMatchObject({
      ok: false,
      reason: expect.stringContaining("another account"),
    });
    expect(foreign.getItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY)).toBe(before);
  });

  it("requires an exact reviewed corrupt value before explicit removal", () => {
    const storage = new MemoryStorage();
    const invalid = { rawAudio: "preserve until explicitly removed" };
    storage.setItem(
      CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, ownerId: OWNER_ID, entries: [invalid] })
    );
    const selected = readContextualNoteOutbox(storage, OWNER_ID).quarantined[0]!;
    expect(
      discardContextualNoteQuarantinedEntry(
        storage,
        OWNER_ID,
        selected.quarantineKey,
        { different: true }
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
    expect(readContextualNoteOutbox(storage, OWNER_ID).quarantined).toHaveLength(1);
    expect(
      discardContextualNoteQuarantinedEntry(
        storage,
        OWNER_ID,
        selected.quarantineKey,
        selected.raw
      )
    ).toEqual({ ok: true, entry: null });
    expect(readContextualNoteOutbox(storage, OWNER_ID).quarantined).toEqual([]);
  });

  it("exposes truthful syncing, queued retry, needs-attention, retry, and guarded removal states", () => {
    const storage = new MemoryStorage();
    const queued = enqueueContextualNoteOutboxEntry(storage, input());
    if (!queued.ok || !queued.entry) throw new Error("fixture did not enqueue");
    const hash = queued.entry.payloadHash;
    const now = new Date("2026-07-22T20:00:00.000Z");

    expect(
      markContextualNoteOutboxSyncing(storage, OWNER_ID, input().clientKey, hash, now)
    ).toMatchObject({ ok: true, entry: { status: "syncing" } });
    expect(
      markContextualNoteOutboxTransientFailure(
        storage,
        OWNER_ID,
        input().clientKey,
        hash,
        "Offline",
        now
      )
    ).toMatchObject({
      ok: true,
      entry: {
        status: "queued",
        attemptCount: 1,
        nextAttemptAtISO: "2026-07-22T20:00:01.000Z",
        lastError: "Offline",
      },
    });
    expect(
      markContextualNoteOutboxNeedsAttention(
        storage,
        OWNER_ID,
        input().clientKey,
        hash,
        "Review required",
        now
      )
    ).toMatchObject({ ok: true, entry: { status: "needs_attention" } });
    expect(
      retryContextualNoteOutboxEntry(storage, OWNER_ID, input().clientKey, hash)
    ).toMatchObject({
      ok: true,
      entry: { status: "queued", attemptCount: 0, lastError: null },
    });
    expect(
      removeContextualNoteOutboxEntry(
        storage,
        OWNER_ID,
        input().clientKey,
        `sha256:${"0".repeat(64)}`
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries).toHaveLength(1);
    expect(
      removeContextualNoteOutboxEntry(storage, OWNER_ID, input().clientKey, hash)
    ).toMatchObject({ ok: true, entry: { payloadHash: hash } });
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries).toEqual([]);
  });

  it("pauses automatic retry after the bounded attempt count", () => {
    const storage = new MemoryStorage();
    const queued = enqueueContextualNoteOutboxEntry(storage, input());
    if (!queued.ok || !queued.entry) throw new Error("fixture did not enqueue");
    for (let attempt = 0; attempt < CONTEXTUAL_NOTE_OUTBOX_MAX_AUTO_ATTEMPTS; attempt += 1) {
      markContextualNoteOutboxTransientFailure(
        storage,
        OWNER_ID,
        input().clientKey,
        queued.entry.payloadHash,
        "Offline"
      );
    }
    expect(readContextualNoteOutbox(storage, OWNER_ID).entries[0]).toMatchObject({
      status: "needs_attention",
      attemptCount: CONTEXTUAL_NOTE_OUTBOX_MAX_AUTO_ATTEMPTS,
      nextAttemptAtISO: null,
      lastError: expect.stringContaining("Automatic retry paused"),
    });
  });

  it("serializes cross-tab mutations under the named browser lock", async () => {
    const requested: string[] = [];
    let tail = Promise.resolve();
    vi.stubGlobal("navigator", {
      locks: {
        request: <T>(name: string, _options: unknown, task: () => T | Promise<T>) => {
          requested.push(name);
          const run = tail.then(task);
          tail = run.then(() => undefined, () => undefined);
          return run;
        },
      },
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const first = withContextualNoteOutboxLock(async () => {
      order.push("first-start");
      await hold;
      order.push("first-end");
    });
    await expect.poll(() => order).toEqual(["first-start"]);
    const second = withContextualNoteOutboxLock(() => order.push("second"));
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(requested).toEqual([
      CONTEXTUAL_NOTE_OUTBOX_LOCK_NAME,
      CONTEXTUAL_NOTE_OUTBOX_LOCK_NAME,
    ]);
  });

  it("fails closed instead of mutating without cross-tab lock support", async () => {
    vi.stubGlobal("navigator", {});
    const task = vi.fn();

    await expect(withContextualNoteOutboxLock(task)).rejects.toThrow(
      "Safe cross-tab note coordination is unavailable",
    );
    expect(task).not.toHaveBeenCalled();
  });

  it("subscribes to storage and owner-scoped broadcast changes and cleans up", () => {
    const fakeWindow = new EventTarget();
    class FakeBroadcastChannel extends EventTarget {
      static instances: FakeBroadcastChannel[] = [];
      closed = false;
      constructor(readonly name: string) {
        super();
        FakeBroadcastChannel.instances.push(this);
      }
      postMessage() {}
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const changed = vi.fn();
    const unsubscribe = subscribeToContextualNoteOutbox(OWNER_ID, changed);
    const channel = FakeBroadcastChannel.instances[0]!;
    expect(channel.name).toBe(CONTEXTUAL_NOTE_OUTBOX_CHANNEL);

    channel.dispatchEvent(
      new MessageEvent("message", {
        data: { version: 1, ownerId: OTHER_OWNER_ID },
      })
    );
    expect(changed).not.toHaveBeenCalled();
    channel.dispatchEvent(
      new MessageEvent("message", { data: { version: 1, ownerId: OWNER_ID } })
    );
    fakeWindow.dispatchEvent(
      Object.assign(new Event("storage"), {
        key: CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY,
      })
    );
    expect(changed).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(channel.closed).toBe(true);
    channel.dispatchEvent(
      new MessageEvent("message", { data: { version: 1, ownerId: OWNER_ID } })
    );
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("persists only a user-confirmed reviewed transcript and rejects audio-bearing inputs", () => {
    const clientKey = input().clientKey;
    expect(confirmedContextualNoteDictation({ type: "cancel" })).toBeNull();
    expect(confirmedContextualNoteDictation({
      type: "confirm",
      reviewed: false,
      clientKey,
      reviewedTranscript: "Not reviewed",
    })).toBeNull();
    expect(confirmedContextualNoteDictation({
      type: "confirm",
      reviewed: true,
      clientKey,
      reviewedTranscript: "Reviewed text",
      rawAudio: new Uint8Array([1, 2, 3]),
    })).toBeNull();
    expect(confirmedContextualNoteDictation({
      type: "confirm",
      reviewed: true,
      clientKey,
      reviewedTranscript: "  Reviewed text only.  ",
    })).toEqual({
      clientKey,
      body: "Reviewed text only.",
      inputMode: "reviewed_dictation",
    });
  });

  it("rejects payloads with raw audio or unreviewed transcript fields", () => {
    const storage = new MemoryStorage();
    const withAudio = input() as NewContextualNoteOutboxEntry & {
      payload: NewContextualNoteOutboxEntry["payload"] & { rawAudio: Uint8Array };
    };
    withAudio.payload = { ...withAudio.payload, rawAudio: new Uint8Array([1]) };
    expect(enqueueContextualNoteOutboxEntry(storage, withAudio)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("safe device storage"),
    });
    expect(parseContextualNoteOutbox(null, OWNER_ID).entries).toEqual([]);
  });
});
