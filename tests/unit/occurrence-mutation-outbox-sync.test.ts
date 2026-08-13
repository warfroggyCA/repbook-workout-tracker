import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import {
  OCCURRENCE_MUTATION_OUTBOX_STATUS_EVENT,
  enqueueOccurrenceMutationOutboxEntry,
  readOccurrenceMutationOutbox,
  retryOccurrenceMutationOutboxEntry,
  type NewOccurrenceMutationOutboxEntry,
  type OccurrenceMutationOutboxClientEvent,
  type OccurrenceMutationOutboxStorage,
} from "@/lib/occurrence-mutation-outbox";

const actionMocks = vi.hoisted(() => ({ mutateOccurrence: vi.fn() }));
vi.mock("@/app/actions/sessions", () => ({
  mutateOccurrence: actionMocks.mutateOccurrence,
}));

import { syncNextOccurrenceMutation } from "@/components/session/occurrence-mutation-outbox-sync";
import { deploymentRecoveryRequired } from "@/lib/deployment-recovery";

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

function entry(): NewOccurrenceMutationOutboxEntry {
  return {
    clientKey: "10000000-0000-4000-8000-000000000001",
    ownerId: "20000000-0000-4000-8000-000000000001",
    sessionId: "30000000-0000-4000-8000-000000000001",
    occurrenceId: "40000000-0000-4000-8000-000000000001",
    label: "Band pull-aparts",
    expectedRevision: 0,
    operation: "skip",
    reason: "user_skipped",
    note: null,
    createdAtISO: "2026-07-21T12:00:00.000Z",
  };
}

describe("occurrence mutation outbox sync", () => {
  let storage: MemoryStorage;
  let statusEvents: OccurrenceMutationOutboxClientEvent[];

  beforeEach(() => {
    storage = new MemoryStorage();
    const events = new EventTarget();
    statusEvents = [];
    events.addEventListener(
      OCCURRENCE_MUTATION_OUTBOX_STATUS_EVENT,
      (event) => {
        statusEvents.push(
          (event as CustomEvent<OccurrenceMutationOutboxClientEvent>).detail,
        );
      },
    );
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: events.dispatchEvent.bind(events),
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "CustomEvent",
      class<T> extends Event {
        detail: T;
        constructor(type: string, init?: { detail?: T }) {
          super(type);
          this.detail = init?.detail as T;
        }
      },
    );
    actionMocks.mutateOccurrence.mockReset();
    enqueueOccurrenceMutationOutboxEntry(storage, entry());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("delivers the persisted stable key and removes only an acknowledged receipt", async () => {
    actionMocks.mutateOccurrence.mockResolvedValueOnce({
      outcome: "replayed",
      occurrence: {
        id: entry().occurrenceId,
        state: "skipped",
        reason: "user_skipped",
        note: null,
        revision: 1,
        resolvedAt: "2026-07-21T12:00:01.000Z",
      },
    });
    await syncNextOccurrenceMutation(entry().ownerId);

    expect(actionMocks.mutateOccurrence).toHaveBeenCalledWith({
      occurrenceId: entry().occurrenceId,
      clientKey: entry().clientKey,
      expectedRevision: 0,
      operation: "skip",
      reason: "user_skipped",
      note: null,
    });
    expect(readOccurrenceMutationOutbox(storage).entries).toEqual([]);
  });

  it("keeps the exact mutation visible in the queue during a slow acknowledgement", async () => {
    let resolveAction!: (
      value: Awaited<ReturnType<typeof actionMocks.mutateOccurrence>>,
    ) => void;
    actionMocks.mutateOccurrence.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );

    const syncing = syncNextOccurrenceMutation(entry().ownerId);
    await vi.waitFor(() =>
      expect(actionMocks.mutateOccurrence).toHaveBeenCalledTimes(1),
    );
    expect(readOccurrenceMutationOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      occurrenceId: entry().occurrenceId,
      status: "queued",
    });
    expect(statusEvents.at(-1)).toEqual({
      type: "saving",
      clientKey: entry().clientKey,
      sessionId: entry().sessionId,
      retrying: false,
    });

    resolveAction({
      outcome: "saved",
      occurrence: {
        id: entry().occurrenceId,
        state: "skipped",
        reason: "user_skipped",
        note: null,
        revision: 1,
        resolvedAt: "2026-07-21T12:00:01.000Z",
      },
    });
    await syncing;
    expect(readOccurrenceMutationOutbox(storage).entries).toEqual([]);
  });

  it("retains connection failures for automatic reconnect replay", async () => {
    actionMocks.mutateOccurrence.mockRejectedValueOnce(new Error("offline"));
    await syncNextOccurrenceMutation(entry().ownerId);
    expect(readOccurrenceMutationOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      status: "queued",
      attemptCount: 1,
      lastError:
        "We couldn't save this yet. We'll keep trying when you're back online.",
    });
    expect(statusEvents.at(-1)).toEqual({
      type: "failed",
      clientKey: entry().clientKey,
      sessionId: entry().sessionId,
    });
  });

  it("retains a stale-build workout change and waits for reload", async () => {
    actionMocks.mutateOccurrence.mockRejectedValueOnce(
      new UnrecognizedActionError("old action"),
    );
    await syncNextOccurrenceMutation(entry().ownerId);

    expect(readOccurrenceMutationOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      status: "queued",
      attemptCount: 1,
      lastError:
        "Repbook was updated. This workout change is safe on this device and will retry after you reload.",
    });
    expect(deploymentRecoveryRequired()).toBe(true);

    await syncNextOccurrenceMutation(entry().ownerId);
    expect(actionMocks.mutateOccurrence).toHaveBeenCalledOnce();
  });

  it("retains stale or conflicting changes for explicit review instead of rewriting them", async () => {
    actionMocks.mutateOccurrence.mockResolvedValueOnce({ outcome: "conflict" });
    await syncNextOccurrenceMutation(entry().ownerId);
    expect(readOccurrenceMutationOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      status: "needs_attention",
      lastError:
        "This item changed somewhere else before your update was saved.",
    });
  });

  it("retries a failed mutation with the same persisted identity", async () => {
    actionMocks.mutateOccurrence.mockResolvedValueOnce({ outcome: "conflict" });
    await syncNextOccurrenceMutation(entry().ownerId);
    expect(readOccurrenceMutationOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      status: "needs_attention",
    });

    retryOccurrenceMutationOutboxEntry(storage, entry().clientKey);
    actionMocks.mutateOccurrence.mockResolvedValueOnce({
      outcome: "replayed",
      occurrence: {
        id: entry().occurrenceId,
        state: "skipped",
        reason: "user_skipped",
        note: null,
        revision: 1,
        resolvedAt: "2026-07-21T12:00:01.000Z",
      },
    });
    await syncNextOccurrenceMutation(entry().ownerId);

    expect(actionMocks.mutateOccurrence).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientKey: entry().clientKey }),
    );
    expect(readOccurrenceMutationOutbox(storage).entries).toEqual([]);
  });
});
