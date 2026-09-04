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
import {
  deploymentRecoveryRequired,
  documentRecoveryReason,
} from "@/lib/deployment-recovery";

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

  it("drains a command enqueued while the owner sync is still unwinding", async () => {
    let resolveFirst!: (
      value: Awaited<ReturnType<typeof actionMocks.mutateOccurrence>>,
    ) => void;
    actionMocks.mutateOccurrence.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const firstSync = syncNextOccurrenceMutation(entry().ownerId);
    await vi.waitFor(() =>
      expect(actionMocks.mutateOccurrence).toHaveBeenCalledTimes(1),
    );

    const later = {
      ...entry(),
      clientKey: "10000000-0000-4000-8000-000000000002",
      occurrenceId: "40000000-0000-4000-8000-000000000002",
      label: "Activation ramp",
      createdAtISO: "2026-07-21T12:00:01.000Z",
    };
    enqueueOccurrenceMutationOutboxEntry(storage, later);
    actionMocks.mutateOccurrence.mockResolvedValueOnce({
      outcome: "saved",
      occurrence: {
        id: later.occurrenceId,
        state: "skipped",
        reason: "user_skipped",
        note: null,
        revision: 1,
        resolvedAt: "2026-07-21T12:00:03.000Z",
      },
    });
    const overlappingWake = syncNextOccurrenceMutation(entry().ownerId);

    resolveFirst({
      outcome: "saved",
      occurrence: {
        id: entry().occurrenceId,
        state: "skipped",
        reason: "user_skipped",
        note: null,
        revision: 1,
        resolvedAt: "2026-07-21T12:00:02.000Z",
      },
    });
    await Promise.all([firstSync, overlappingWake]);

    expect(actionMocks.mutateOccurrence).toHaveBeenCalledTimes(2);
    expect(actionMocks.mutateOccurrence).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientKey: later.clientKey }),
    );
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

  it("releases a never-settling mutation and replays its exact identity only in a new document", async () => {
    actionMocks.mutateOccurrence.mockReturnValueOnce(
      new Promise(() => undefined),
    );

    await syncNextOccurrenceMutation(entry().ownerId, 0, 5);

    expect(readOccurrenceMutationOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      ownerId: entry().ownerId,
      sessionId: entry().sessionId,
      occurrenceId: entry().occurrenceId,
      expectedRevision: entry().expectedRevision,
      operation: entry().operation,
      status: "queued",
      attemptCount: 1,
      lastError:
        "Repbook did not confirm this workout change in time. It is safe on this device. Reload and retry safely.",
    });
    expect(documentRecoveryReason()).toBe("action_timeout");
    const firstCommand = actionMocks.mutateOccurrence.mock.calls[0]?.[0];

    expect(
      retryOccurrenceMutationOutboxEntry(storage, entry().clientKey),
    ).toMatchObject({ ok: true });
    await syncNextOccurrenceMutation(entry().ownerId, 0, 5);
    expect(actionMocks.mutateOccurrence).toHaveBeenCalledOnce();

    const nextEvents = new EventTarget();
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: nextEvents.dispatchEvent.bind(nextEvents),
    });
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

    await syncNextOccurrenceMutation(entry().ownerId, 0, 5);

    expect(actionMocks.mutateOccurrence).toHaveBeenCalledTimes(2);
    expect(actionMocks.mutateOccurrence.mock.calls[1]?.[0]).toEqual(
      firstCommand,
    );
    expect(readOccurrenceMutationOutbox(storage).entries).toEqual([]);
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

  it.each([
    [
      "equipment_reason_unverified",
      "Repbook could not verify that equipment was unavailable or incompatible. Review this skip before retrying.",
    ],
    [
      "equipment_source_conflict",
      "Your available equipment changed before this skip was saved. Review the current setup before retrying.",
    ],
  ] as const)(
    "keeps an equipment skip visible when the server returns %s",
    async (outcome, expectedError) => {
      storage.values.clear();
      const equipmentEntry = {
        ...entry(),
        reason: "equipment_unavailable_incompatible",
        reasonCode: "equipment_unavailable_incompatible" as const,
      };
      enqueueOccurrenceMutationOutboxEntry(storage, equipmentEntry);
      actionMocks.mutateOccurrence.mockResolvedValueOnce({ outcome });

      await syncNextOccurrenceMutation(equipmentEntry.ownerId);

      expect(readOccurrenceMutationOutbox(storage).entries[0]).toMatchObject({
        clientKey: equipmentEntry.clientKey,
        status: "needs_attention",
        lastError: expectedError,
      });
      expect(statusEvents.at(-1)).toEqual({
        type: "failed",
        clientKey: equipmentEntry.clientKey,
        sessionId: equipmentEntry.sessionId,
      });
    },
  );

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
