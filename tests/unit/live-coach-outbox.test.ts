import { describe, expect, it } from "vitest";
import {
  LIVE_COACH_OUTBOX_MAX_AUTO_ATTEMPTS,
  LIVE_COACH_OUTBOX_MAX_ENTRIES,
  LIVE_COACH_OUTBOX_STORAGE_KEY,
  discardLiveCoachOutboxQuarantinedEntry,
  enqueueLiveCoachOutboxEntry,
  markLiveCoachOutboxNeedsAttention,
  markLiveCoachOutboxTransientFailure,
  parseLiveCoachOutbox,
  readLiveCoachOutbox,
  removeLiveCoachOutboxEntry,
  retryLiveCoachOutboxEntry,
  type LiveCoachOutboxStorage,
  type NewLiveCoachOutboxEntry,
} from "@/lib/live-coach-outbox";
import { startLiveCoachTurnSchema } from "@/lib/live-coach-validation";

class MemoryStorage implements LiveCoachOutboxStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function queuedInput(index = 1): NewLiveCoachOutboxEntry {
  return {
    clientKey: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ownerId: "20000000-0000-4000-8000-000000000001",
    sessionId: "30000000-0000-4000-8000-000000000001",
    sessionExerciseId: "40000000-0000-4000-8000-000000000001",
    exerciseName: "Bench Press",
    completedSetId: null,
    messageKind: "question",
    inputMode: "text",
    content: `Queued workout question ${index}`,
    activeRestTimerSeconds: 120,
    createdAtISO: new Date(Date.UTC(2026, 6, 12, 12, 0, index)).toISOString(),
  };
}

describe("Live Coach device outbox", () => {
  it("stores the complete message under one stable identity before sync", () => {
    const storage = new MemoryStorage();
    const input = queuedInput();
    const queued = enqueueLiveCoachOutboxEntry(storage, input);
    if (!queued.ok) throw new Error(queued.reason);

    expect(queued).toMatchObject({
      ok: true,
      entry: {
        clientKey: input.clientKey,
        content: input.content,
        status: "queued",
        attemptCount: 0,
      },
    });
    expect(readLiveCoachOutbox(storage).entries).toEqual([queued.entry]);

    const repeated = enqueueLiveCoachOutboxEntry(storage, input);
    expect(repeated).toMatchObject({
      ok: true,
      entry: { clientKey: input.clientKey },
    });
    expect(readLiveCoachOutbox(storage).entries).toHaveLength(1);
  });

  it("does not let a stable identity drift to different text", () => {
    const storage = new MemoryStorage();
    const input = queuedInput();
    enqueueLiveCoachOutboxEntry(storage, input);

    expect(
      enqueueLiveCoachOutboxEntry(storage, {
        ...input,
        content: "Different text under the same identity",
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining("different") });
    expect(readLiveCoachOutbox(storage).entries[0]?.content).toBe(input.content);
  });

  it("keeps one stable identity for confirmed dictation across repeated delivery", () => {
    const storage = new MemoryStorage();
    const input = { ...queuedInput(), inputMode: "dictation" as const };
    const first = enqueueLiveCoachOutboxEntry(storage, input);
    const retry = enqueueLiveCoachOutboxEntry(storage, input);

    expect(first).toMatchObject({
      ok: true,
      entry: { clientKey: input.clientKey, inputMode: "dictation" },
    });
    expect(retry).toMatchObject({
      ok: true,
      entry: { clientKey: input.clientKey, inputMode: "dictation" },
    });
    expect(readLiveCoachOutbox(storage).entries).toHaveLength(1);
  });

  it("allows reviewed dictation through the message contract but keeps realtime voice reserved", () => {
    const input = queuedInput();
    expect(
      startLiveCoachTurnSchema.safeParse({ ...input, inputMode: "dictation" })
        .success
    ).toBe(true);
    expect(
      startLiveCoachTurnSchema.safeParse({
        ...input,
        inputMode: "realtime_voice",
      }).success
    ).toBe(false);
  });

  it("backs off transient failures, then pauses instead of retrying forever", () => {
    const storage = new MemoryStorage();
    const input = queuedInput();
    enqueueLiveCoachOutboxEntry(storage, input);

    for (let attempt = 1; attempt <= LIVE_COACH_OUTBOX_MAX_AUTO_ATTEMPTS; attempt += 1) {
      markLiveCoachOutboxTransientFailure(
        storage,
        input.clientKey,
        "Connection unavailable",
        new Date(Date.UTC(2026, 6, 12, 12, 0, attempt))
      );
    }
    expect(readLiveCoachOutbox(storage).entries[0]).toMatchObject({
      content: input.content,
      status: "needs_attention",
      attemptCount: LIVE_COACH_OUTBOX_MAX_AUTO_ATTEMPTS,
      nextAttemptAtISO: null,
      lastError: expect.stringContaining("paused"),
    });

    retryLiveCoachOutboxEntry(storage, input.clientKey);
    expect(readLiveCoachOutbox(storage).entries[0]).toMatchObject({
      status: "queued",
      attemptCount: 0,
      lastError: null,
    });
  });

  it("keeps permanent failures visible until an explicit recovery or removal", () => {
    const storage = new MemoryStorage();
    const input = queuedInput();
    enqueueLiveCoachOutboxEntry(storage, input);

    markLiveCoachOutboxNeedsAttention(
      storage,
      input.clientKey,
      "Sign in again, then retry this saved Coach message."
    );
    expect(readLiveCoachOutbox(storage).entries[0]).toMatchObject({
      status: "needs_attention",
      content: input.content,
      lastError: expect.stringContaining("Sign in again"),
    });

    removeLiveCoachOutboxEntry(storage, input.clientKey);
    expect(readLiveCoachOutbox(storage).entries).toHaveLength(0);
  });

  it("refuses new entries at its bound without pruning older messages", () => {
    const storage = new MemoryStorage();
    for (let index = 1; index <= LIVE_COACH_OUTBOX_MAX_ENTRIES; index += 1) {
      expect(enqueueLiveCoachOutboxEntry(storage, queuedInput(index)).ok).toBe(true);
    }
    const overflow = enqueueLiveCoachOutboxEntry(
      storage,
      queuedInput(LIVE_COACH_OUTBOX_MAX_ENTRIES + 1)
    );
    expect(overflow).toMatchObject({
      ok: false,
      reason: expect.stringContaining("full"),
    });
    expect(readLiveCoachOutbox(storage).entries).toHaveLength(
      LIVE_COACH_OUTBOX_MAX_ENTRIES
    );
  });

  it("leaves unreadable device data unchanged", () => {
    const storage = new MemoryStorage();
    storage.setItem(LIVE_COACH_OUTBOX_STORAGE_KEY, "{not-json");

    expect(parseLiveCoachOutbox(storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY))).toMatchObject({
      entries: [],
      error: expect.stringContaining("left unchanged"),
    });
    expect(enqueueLiveCoachOutboxEntry(storage, queuedInput())).toMatchObject({
      ok: false,
    });
    expect(storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY)).toBe("{not-json");
  });

  it("keeps valid messages available while preserving a corrupt entry", () => {
    const storage = new MemoryStorage();
    const first = queuedInput(1);
    const second = queuedInput(2);
    const corrupt = { clientKey: "not-a-uuid", content: "Keep this raw value" };
    const firstEntry = {
      ...first,
      status: "queued",
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    };
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [firstEntry, corrupt] })
    );

    expect(readLiveCoachOutbox(storage)).toMatchObject({
      entries: [{ clientKey: first.clientKey }],
      quarantined: [{ quarantineKey: "entries:1", raw: corrupt }],
      error: null,
    });

    expect(enqueueLiveCoachOutboxEntry(storage, second).ok).toBe(true);
    expect(readLiveCoachOutbox(storage)).toMatchObject({
      entries: [
        { clientKey: first.clientKey },
        { clientKey: second.clientKey },
      ],
      quarantined: [{ raw: corrupt }],
      error: null,
    });
    expect(
      JSON.parse(storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY) ?? "").entries
    ).toContainEqual({
      quarantine: "live-coach-outbox-entry-v1",
      raw: corrupt,
      reason: "This saved Coach message is incomplete or invalid.",
    });
  });

  it("quarantines only the later duplicate identity", () => {
    const storage = new MemoryStorage();
    const first = {
      ...queuedInput(),
      status: "queued",
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    };
    const later = { ...first, content: "A later duplicate message" };
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [first, later] })
    );

    const snapshot = readLiveCoachOutbox(storage);
    expect(snapshot.entries).toEqual([first]);
    expect(snapshot.quarantined).toEqual([
      {
        quarantineKey: "entries:1",
        raw: later,
        reason: expect.stringContaining("earlier identity"),
      },
    ]);
  });

  it("explicitly discards only the selected quarantined entry", () => {
    const storage = new MemoryStorage();
    const valid = {
      ...queuedInput(),
      status: "queued",
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    };
    const firstCorrupt = { content: "first corrupt value" };
    const secondCorrupt = { content: "second corrupt value" };
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: [firstCorrupt, valid, secondCorrupt],
      })
    );

    const initial = readLiveCoachOutbox(storage);
    expect(initial.quarantined.map((entry) => entry.raw)).toEqual([
      firstCorrupt,
      secondCorrupt,
    ]);
    expect(
      discardLiveCoachOutboxQuarantinedEntry(
        storage,
        initial.quarantined[0]!.quarantineKey,
        initial.quarantined[0]!.raw
      )
    ).toEqual({
      ok: true,
      entry: null,
    });
    const snapshot = readLiveCoachOutbox(storage);
    expect(snapshot.entries).toEqual([valid]);
    expect(snapshot.quarantined).toHaveLength(1);
    expect(snapshot.quarantined[0]?.raw).toEqual(secondCorrupt);
    expect(
      JSON.parse(storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY) ?? "")
        .entries.slice(1)
    ).toEqual([
      {
        quarantine: "live-coach-outbox-entry-v1",
        raw: secondCorrupt,
        reason: "This saved Coach message is incomplete or invalid.",
      },
    ]);
  });

  it("keeps a later duplicate quarantined after the first message is removed", () => {
    const storage = new MemoryStorage();
    const first = {
      ...queuedInput(),
      status: "queued",
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    };
    const later = { ...first, content: "Do not reactivate this duplicate" };
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [first, later] })
    );

    removeLiveCoachOutboxEntry(storage, first.clientKey);
    const snapshot = readLiveCoachOutbox(storage);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.quarantined).toMatchObject([{ raw: later }]);
  });

  it("fails closed when a stale discard selection now names different raw data", () => {
    const storage = new MemoryStorage();
    const firstCorrupt = { content: "first corrupt value" };
    const replacement = { content: "replacement corrupt value" };
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [firstCorrupt] })
    );
    const stale = readLiveCoachOutbox(storage).quarantined[0]!;
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [replacement] })
    );

    expect(
      discardLiveCoachOutboxQuarantinedEntry(
        storage,
        stale.quarantineKey,
        stale.raw
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
    expect(readLiveCoachOutbox(storage).quarantined[0]?.raw).toEqual(replacement);
  });

  it("fails closed when a discard selection cannot be compared safely", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [{ marker: "preserve-me" }] })
    );
    const selected = readLiveCoachOutbox(storage).quarantined[0]!;
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const storedRaw = storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY);

    expect(
      discardLiveCoachOutboxQuarantinedEntry(
        storage,
        selected.quarantineKey,
        cyclic
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
    expect(storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY)).toBe(storedRaw);
  });

  it("counts quarantined values toward the device storage bound", () => {
    const storage = new MemoryStorage();
    const entries = Array.from(
      { length: LIVE_COACH_OUTBOX_MAX_ENTRIES - 1 },
      (_, index) => ({
        ...queuedInput(index + 1),
        status: "queued",
        attemptCount: 0,
        nextAttemptAtISO: null,
        lastAttemptAtISO: null,
        lastError: null,
      })
    );
    const corrupt = { content: "This stored value also consumes capacity" };
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [...entries, corrupt] })
    );

    expect(
      enqueueLiveCoachOutboxEntry(
        storage,
        queuedInput(LIVE_COACH_OUTBOX_MAX_ENTRIES)
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining("full") });
    expect(readLiveCoachOutbox(storage).quarantined[0]?.raw).toEqual(corrupt);
  });

  it("never trusts a stored quarantine reason as text for the interface", () => {
    const storage = new MemoryStorage();
    const hostileReason = "Private Coach text that must never be rendered";
    const forgedWrapper = {
      quarantine: "live-coach-outbox-entry-v1",
      raw: { marker: "preserve-me" },
      reason: hostileReason,
    };
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [forgedWrapper] })
    );

    const snapshot = readLiveCoachOutbox(storage);
    expect(snapshot.quarantined).toEqual([
      {
        quarantineKey: "entries:0",
        raw: forgedWrapper,
        reason: "This saved Coach message is incomplete or invalid.",
      },
    ]);
    expect(snapshot.quarantined[0]?.reason).not.toContain(hostileReason);

    expect(enqueueLiveCoachOutboxEntry(storage, queuedInput(1)).ok).toBe(true);
    expect(readLiveCoachOutbox(storage).quarantined[0]).toMatchObject({
      raw: forgedWrapper,
      reason: "This saved Coach message is incomplete or invalid.",
    });
  });

  it("makes a quarantine rewrite fail closed for an older whole-envelope writer", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LIVE_COACH_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [{ marker: "preserve-me" }] })
    );
    expect(enqueueLiveCoachOutboxEntry(storage, queuedInput(1)).ok).toBe(true);
    const rewritten = storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY);

    const parsed = JSON.parse(rewritten ?? "null") as {
      version?: unknown;
      entries?: unknown;
    };
    const acceptedByLegacyWholeEnvelopeParser =
      parsed.version === 1 &&
      Array.isArray(parsed.entries) &&
      parsed.entries.every(
        (entry) =>
          entry != null &&
          typeof entry === "object" &&
          "clientKey" in entry &&
          typeof entry.clientKey === "string"
      );
    if (acceptedByLegacyWholeEnvelopeParser) {
      storage.setItem(LIVE_COACH_OUTBOX_STORAGE_KEY, "legacy-writer-mutated");
    }

    expect(acceptedByLegacyWholeEnvelopeParser).toBe(false);
    expect(storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY)).toBe(rewritten);
  });
});
