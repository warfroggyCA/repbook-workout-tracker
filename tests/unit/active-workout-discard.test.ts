import { describe, expect, it, vi } from "vitest";
import {
  activeWorkoutDiscardDialogOpenState,
  discardSessionCopiesAndAbandon,
} from "@/lib/active-workout-discard";
import {
  enqueueOccurrenceMutationOutboxEntry,
  OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY,
  readOccurrenceMutationOutbox,
} from "@/lib/occurrence-mutation-outbox";
import {
  enqueueWorkoutSetOutboxEntry,
  getWorkoutRestIntentReceipt,
  readWorkoutSetOutbox,
  recordWorkoutRestIntentReceipt,
  WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY,
  WORKOUT_SET_OUTBOX_STORAGE_KEY,
} from "@/lib/workout-set-outbox";

const ownerId = "20000000-0000-4000-8000-000000000001";
const sessionId = "30000000-0000-4000-8000-000000000001";
const setClientKey = "10000000-0000-4000-8000-000000000001";
const occurrenceClientKey = "10000000-0000-4000-8000-000000000002";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  failOnceForKey: string | null = null;
  readonly length = 0;

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key() {
    return null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    if (this.failOnceForKey === key) {
      this.failOnceForKey = null;
      throw new Error("Injected storage failure");
    }
    this.values.set(key, value);
  }
}

function seed(storage: MemoryStorage) {
  const set = {
    clientKey: setClientKey,
    ownerId,
    sessionId,
    sessionExerciseId: "40000000-0000-4000-8000-000000000001",
    performedExerciseId: "50000000-0000-4000-8000-000000000001",
    performedSemanticsVersion: 1 as const,
    performedLoadType: "barbell",
    performedLoadSemantics: "total" as const,
    exerciseName: "Bench Press",
    setNo: 1,
    metricType: "weight_reps" as const,
    weight: 100,
    weightUnit: "lb" as const,
    reps: 8,
    distanceKm: null,
    durationSeconds: null,
    rpe: null,
    note: null,
    equipmentSnapshotId: null,
    loadEntryMeaning: "legacy_unknown" as const,
    createdAtISO: "2026-08-13T12:00:00.000Z",
  };
  const occurrence = {
    clientKey: occurrenceClientKey,
    ownerId,
    sessionId,
    occurrenceId: "60000000-0000-4000-8000-000000000001",
    label: "Warm-up item",
    expectedRevision: 0,
    operation: "complete" as const,
    reason: null,
    note: null,
    createdAtISO: "2026-08-13T12:00:01.000Z",
  };
  expect(enqueueWorkoutSetOutboxEntry(storage, set)).toMatchObject({ ok: true });
  expect(enqueueOccurrenceMutationOutboxEntry(storage, occurrence)).toMatchObject({
    ok: true,
  });
}

describe("active workout destructive exit", () => {
  it("keeps a pending destructive dialog open until success or rollback settles", () => {
    expect(activeWorkoutDiscardDialogOpenState({
      currentOpen: true,
      requestedOpen: false,
      pending: true,
    })).toBe(true);
    expect(activeWorkoutDiscardDialogOpenState({
      currentOpen: true,
      requestedOpen: false,
      pending: false,
    })).toBe(false);
  });

  it("removes exact owner-session copies only after server abandonment succeeds", async () => {
    const storage = new MemoryStorage();
    seed(storage);
    expect(recordWorkoutRestIntentReceipt(storage, {
      ...readWorkoutSetOutbox(storage).entries[0]!,
      clientKey: "10000000-0000-4000-8000-000000000003",
      createdAtISO: "2026-08-13T12:00:02.000Z",
      restAfterSec: null,
    })).toMatchObject({ ok: true });
    const abandon = vi.fn().mockResolvedValue({ ok: true });

    await expect(discardSessionCopiesAndAbandon({
      storage,
      ownerId,
      sessionId,
      abandon,
    })).resolves.toEqual({ ok: true });
    expect(abandon).toHaveBeenCalledOnce();
    expect(readWorkoutSetOutbox(storage).entries).toEqual([]);
    expect(readOccurrenceMutationOutbox(storage).entries).toEqual([]);
    expect(getWorkoutRestIntentReceipt(storage, { ownerId, sessionId })).toEqual({
      ok: true,
      receipt: null,
    });
  });

  it("rolls back a partial local deletion and never abandons", async () => {
    const storage = new MemoryStorage();
    seed(storage);
    const originalSets = storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY);
    const originalOccurrences = storage.getItem(
      OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY,
    );
    storage.failOnceForKey = OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY;
    const abandon = vi.fn().mockResolvedValue({ ok: true });

    await expect(discardSessionCopiesAndAbandon({
      storage,
      ownerId,
      sessionId,
      abandon,
    })).resolves.toMatchObject({ ok: false });
    expect(abandon).not.toHaveBeenCalled();
    expect(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY)).toBe(originalSets);
    expect(storage.getItem(OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY)).toBe(
      originalOccurrences,
    );
  });

  it("does not abandon when a rest receipt cannot be cleaned", async () => {
    const storage = new MemoryStorage();
    seed(storage);
    expect(recordWorkoutRestIntentReceipt(storage, {
      ...readWorkoutSetOutbox(storage).entries[0]!,
      clientKey: "10000000-0000-4000-8000-000000000003",
      createdAtISO: "2026-08-13T12:00:02.000Z",
      restAfterSec: null,
    })).toMatchObject({ ok: true });
    const originalSets = storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY);
    const originalRestIntents = storage.getItem(
      WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY,
    );
    const originalOccurrences = storage.getItem(
      OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY,
    );
    storage.failOnceForKey = WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY;
    const abandon = vi.fn().mockResolvedValue({ ok: true });

    await expect(discardSessionCopiesAndAbandon({
      storage,
      ownerId,
      sessionId,
      abandon,
    })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("Nothing was discarded"),
    });
    expect(abandon).not.toHaveBeenCalled();
    expect(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY)).toBe(originalSets);
    expect(storage.getItem(WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY)).toBe(
      originalRestIntents,
    );
    expect(storage.getItem(OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY)).toBe(
      originalOccurrences,
    );
  });

  it("restores both queues when server abandonment fails", async () => {
    const storage = new MemoryStorage();
    seed(storage);
    expect(recordWorkoutRestIntentReceipt(storage, {
      ...readWorkoutSetOutbox(storage).entries[0]!,
      clientKey: "10000000-0000-4000-8000-000000000003",
      createdAtISO: "2026-08-13T12:00:02.000Z",
      restAfterSec: null,
    })).toMatchObject({ ok: true });
    const originalSets = storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY);
    const originalRestIntents = storage.getItem(
      WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY,
    );
    const originalOccurrences = storage.getItem(
      OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY,
    );

    await expect(discardSessionCopiesAndAbandon({
      storage,
      ownerId,
      sessionId,
      abandon: async () => {
        throw new Error("Injected server failure");
      },
    })).resolves.toEqual({
      ok: false,
      reason:
        "Repbook did not confirm the workout was abandoned. The device copies were restored.",
    });
    expect(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY)).toBe(originalSets);
    expect(storage.getItem(WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY)).toBe(
      originalRestIntents,
    );
    expect(storage.getItem(OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY)).toBe(
      originalOccurrences,
    );
  });

  it("restores both queues when the server reports that abandonment was rejected", async () => {
    const storage = new MemoryStorage();
    seed(storage);
    const originalSets = storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY);
    const originalOccurrences = storage.getItem(
      OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY,
    );

    await expect(discardSessionCopiesAndAbandon({
      storage,
      ownerId,
      sessionId,
      abandon: async () => ({ ok: false }),
    })).resolves.toEqual({
      ok: false,
      reason:
        "Repbook did not confirm the workout was abandoned. The device copies were restored.",
    });
    expect(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY)).toBe(originalSets);
    expect(storage.getItem(OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY)).toBe(
      originalOccurrences,
    );
  });

  it("preserves a copy that does not match the owner-session pair", async () => {
    const storage = new MemoryStorage();
    seed(storage);
    const originalSets = storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY);
    const abandon = vi.fn().mockResolvedValue({ ok: true });

    await expect(discardSessionCopiesAndAbandon({
      storage,
      ownerId: "20000000-0000-4000-8000-000000000099",
      sessionId,
      abandon,
    })).resolves.toEqual({ ok: true });
    expect(abandon).toHaveBeenCalledOnce();
    expect(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY)).toBe(originalSets);
  });

  it("re-reads both queues after confirmation and removes newly queued current-workout copies", async () => {
    const storage = new MemoryStorage();
    seed(storage);
    const foreignOwner = "20000000-0000-4000-8000-000000000099";
    const foreignSession = "30000000-0000-4000-8000-000000000099";
    const foreignSet = {
      ...readWorkoutSetOutbox(storage).entries[0]!,
      clientKey: "10000000-0000-4000-8000-000000000099",
      ownerId: foreignOwner,
      sessionId: foreignSession,
      sessionExerciseId: "40000000-0000-4000-8000-000000000099",
    };
    const foreignOccurrence = {
      ...readOccurrenceMutationOutbox(storage).entries[0]!,
      clientKey: "10000000-0000-4000-8000-000000000098",
      ownerId: foreignOwner,
      sessionId: foreignSession,
      occurrenceId: "60000000-0000-4000-8000-000000000099",
    };
    expect(enqueueWorkoutSetOutboxEntry(storage, foreignSet)).toMatchObject({
      ok: true,
    });
    expect(
      enqueueOccurrenceMutationOutboxEntry(storage, foreignOccurrence),
    ).toMatchObject({ ok: true });

    await expect(discardSessionCopiesAndAbandon({
      storage,
      ownerId,
      sessionId,
      abandon: async () => ({ ok: true }),
    })).resolves.toEqual({ ok: true });
    expect(readWorkoutSetOutbox(storage).entries).toEqual([foreignSet]);
    expect(readOccurrenceMutationOutbox(storage).entries).toEqual([
      foreignOccurrence,
    ]);
  });
});
