import { describe, expect, it } from "vitest";
import {
  OCCURRENCE_MUTATION_OUTBOX_MAX_AUTO_ATTEMPTS,
  OCCURRENCE_MUTATION_OUTBOX_MAX_DISPLAY_LABEL_LENGTH,
  enqueueOccurrenceMutationOutboxEntry,
  markOccurrenceMutationNeedsAttention,
  markOccurrenceMutationTransientFailure,
  nextOccurrenceMutationOutboxEntry,
  occurrenceMutationFinishIsBlocked,
  parseOccurrenceMutationOutbox,
  readOccurrenceMutationOutbox,
  removeOccurrenceMutationOutboxEntry,
  retryOccurrenceMutationOutboxEntry,
  type NewOccurrenceMutationOutboxEntry,
  type OccurrenceMutationOutboxStorage,
} from "@/lib/occurrence-mutation-outbox";

class MemoryStorage implements OccurrenceMutationOutboxStorage {
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

function mutation(
  index: number,
  overrides: Partial<NewOccurrenceMutationOutboxEntry> = {},
): NewOccurrenceMutationOutboxEntry {
  return {
    clientKey: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ownerId: "20000000-0000-4000-8000-000000000001",
    sessionId: "30000000-0000-4000-8000-000000000001",
    occurrenceId: "40000000-0000-4000-8000-000000000001",
    label: "Band pull-aparts",
    expectedRevision: index - 1,
    operation: "skip",
    reason: "user_skipped",
    note: null,
    createdAtISO: new Date(Date.UTC(2026, 6, 21, 12, 0, index)).toISOString(),
    ...overrides,
  };
}

describe("occurrence mutation device queue", () => {
  it("persists a validated mutation under one stable client identity", () => {
    const storage = new MemoryStorage();
    const input = mutation(1);
    expect(enqueueOccurrenceMutationOutboxEntry(storage, input)).toMatchObject({
      ok: true,
      entry: { clientKey: input.clientKey, status: "queued", attemptCount: 0 },
    });
    expect(enqueueOccurrenceMutationOutboxEntry(storage, input)).toMatchObject({
      ok: true,
      entry: { clientKey: input.clientKey },
    });
    expect(readOccurrenceMutationOutbox(storage).entries).toHaveLength(1);
  });

  it("bounds display-only generated labels without rejecting the mutation", () => {
    const storage = new MemoryStorage();
    const generatedLabel =
      "Generated warm-up: " +
      "controlled movement through a comfortable range of motion, ".repeat(8);
    const input = mutation(1, { label: generatedLabel });

    expect(enqueueOccurrenceMutationOutboxEntry(storage, input)).toMatchObject({
      ok: true,
      entry: {
        clientKey: input.clientKey,
        occurrenceId: input.occurrenceId,
        operation: input.operation,
      },
    });
    const saved = readOccurrenceMutationOutbox(storage).entries[0];
    expect(saved.label).toHaveLength(
      OCCURRENCE_MUTATION_OUTBOX_MAX_DISPLAY_LABEL_LENGTH,
    );
    expect(saved.label.endsWith("…")).toBe(true);
    expect(saved.clientKey).toBe(input.clientKey);
    expect(saved.reason).toBe(input.reason);
  });

  it("rejects identity drift and malformed local data without overwriting it", () => {
    const storage = new MemoryStorage();
    const input = mutation(1);
    enqueueOccurrenceMutationOutboxEntry(storage, input);
    expect(
      enqueueOccurrenceMutationOutboxEntry(storage, {
        ...input,
        operation: "restore",
        reason: null,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("different") });
    expect(parseOccurrenceMutationOutbox('{"version":1,"entries":[{}]}')).toEqual({
      entries: [],
      error: expect.stringContaining("invalid"),
    });
  });

  it("rejects operation fields that the authoritative mutation cannot accept", () => {
    const storage = new MemoryStorage();
    expect(enqueueOccurrenceMutationOutboxEntry(storage, mutation(1, {
      operation: "complete",
      reason: "time",
    }))).toMatchObject({ ok: false });
    expect(enqueueOccurrenceMutationOutboxEntry(storage, mutation(2, {
      operation: "restore",
      reason: null,
      note: "A restore cannot write a note",
    }))).toMatchObject({ ok: false });
    expect(enqueueOccurrenceMutationOutboxEntry(storage, mutation(3, {
      operation: "note",
      reason: "pain",
    }))).toMatchObject({ ok: false });
    expect(enqueueOccurrenceMutationOutboxEntry(storage, mutation(4, {
      operation: "skip",
      reason: "",
    }))).toMatchObject({ ok: false });
    expect(readOccurrenceMutationOutbox(storage)).toEqual({
      entries: [],
      error: null,
    });
  });

  it("replays skip then restore in order for one occurrence", () => {
    const storage = new MemoryStorage();
    const skip = mutation(1);
    const restore = mutation(2, {
      operation: "restore",
      reason: null,
      expectedRevision: 1,
      createdAtISO: skip.createdAtISO,
    });
    enqueueOccurrenceMutationOutboxEntry(storage, restore);
    enqueueOccurrenceMutationOutboxEntry(storage, skip);

    let entries = readOccurrenceMutationOutbox(storage).entries;
    expect(nextOccurrenceMutationOutboxEntry(entries, skip.ownerId)?.clientKey).toBe(
      skip.clientKey,
    );
    removeOccurrenceMutationOutboxEntry(storage, skip.clientKey);
    entries = readOccurrenceMutationOutbox(storage).entries;
    expect(nextOccurrenceMutationOutboxEntry(entries, skip.ownerId)?.clientKey).toBe(
      restore.clientKey,
    );
  });

  it("blocks finish for queued, attention, and unreadable device changes", () => {
    const storage = new MemoryStorage();
    const input = mutation(1);
    expect(occurrenceMutationFinishIsBlocked([], { error: null })).toBe(false);
    enqueueOccurrenceMutationOutboxEntry(storage, input);
    expect(
      occurrenceMutationFinishIsBlocked(
        readOccurrenceMutationOutbox(storage).entries,
        { error: null },
      ),
    ).toBe(true);
    markOccurrenceMutationNeedsAttention(storage, input.clientKey, "Review");
    expect(
      occurrenceMutationFinishIsBlocked(
        readOccurrenceMutationOutbox(storage).entries,
        { error: null },
      ),
    ).toBe(true);
    expect(
      occurrenceMutationFinishIsBlocked([], { error: "Unreadable queue" }),
    ).toBe(true);
  });

  it("does not let a later change pass an attention-blocked earlier change", () => {
    const storage = new MemoryStorage();
    const skip = mutation(1);
    const restore = mutation(2, { operation: "restore", reason: null });
    enqueueOccurrenceMutationOutboxEntry(storage, skip);
    enqueueOccurrenceMutationOutboxEntry(storage, restore);
    markOccurrenceMutationNeedsAttention(storage, skip.clientKey, "Conflict");
    expect(
      nextOccurrenceMutationOutboxEntry(
        readOccurrenceMutationOutbox(storage).entries,
        skip.ownerId,
      ),
    ).toBeNull();
    retryOccurrenceMutationOutboxEntry(storage, skip.clientKey);
    expect(
      nextOccurrenceMutationOutboxEntry(
        readOccurrenceMutationOutbox(storage).entries,
        skip.ownerId,
      )?.clientKey,
    ).toBe(skip.clientKey);
  });

  it("backs off transient failures and eventually requires explicit attention", () => {
    const storage = new MemoryStorage();
    const input = mutation(1);
    enqueueOccurrenceMutationOutboxEntry(storage, input);
    for (
      let attempt = 1;
      attempt <= OCCURRENCE_MUTATION_OUTBOX_MAX_AUTO_ATTEMPTS;
      attempt += 1
    ) {
      markOccurrenceMutationTransientFailure(
        storage,
        input.clientKey,
        "Offline",
        new Date(Date.UTC(2026, 6, 21, 12, 0, attempt)),
      );
    }
    expect(readOccurrenceMutationOutbox(storage).entries[0]).toMatchObject({
      status: "needs_attention",
      attemptCount: OCCURRENCE_MUTATION_OUTBOX_MAX_AUTO_ATTEMPTS,
      nextAttemptAtISO: null,
    });
  });

  it("lets another occurrence drain while one occurrence is delayed", () => {
    const storage = new MemoryStorage();
    const first = mutation(1);
    const other = mutation(2, {
      occurrenceId: "40000000-0000-4000-8000-000000000002",
      expectedRevision: 0,
    });
    enqueueOccurrenceMutationOutboxEntry(storage, first);
    enqueueOccurrenceMutationOutboxEntry(storage, other);
    markOccurrenceMutationTransientFailure(
      storage,
      first.clientKey,
      "Offline",
      new Date("2026-07-21T12:00:00.000Z"),
    );
    expect(
      nextOccurrenceMutationOutboxEntry(
        readOccurrenceMutationOutbox(storage).entries,
        first.ownerId,
        new Date("2026-07-21T12:00:00.500Z"),
      )?.clientKey,
    ).toBe(other.clientKey);
  });
});
