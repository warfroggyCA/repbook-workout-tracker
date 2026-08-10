import { describe, expect, it } from "vitest";
import {
  acknowledgeEquipmentSelectionOutboxEntry,
  discardQuarantinedEquipmentSelectionOutboxEntry,
  EQUIPMENT_SELECTION_OUTBOX_STORAGE_KEY,
  enqueueEquipmentSelectionOutboxEntry,
  equipmentSelectionComparisonState,
  hasPendingEquipmentSelection,
  markEquipmentSelectionTransientFailure,
  nextWorkoutCommand,
  parseEquipmentSelectionOutbox,
  readEquipmentSelectionOutbox,
  removeEquipmentSelectionOutboxEntry,
  type NewEquipmentSelectionOutboxEntry,
} from "@/lib/equipment-selection-outbox";
import {
  bindWorkoutSetEntriesToEquipmentSelection,
  EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_STORAGE_KEY,
  enqueueWorkoutSetOutboxEntry,
  readWorkoutSetOutbox,
  WORKOUT_SET_OUTBOX_STORAGE_KEY,
  type WorkoutSetOutboxStorage,
} from "@/lib/workout-set-outbox";

class MemoryStorage implements WorkoutSetOutboxStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const ids = {
  owner: "10000000-0000-4000-8000-000000000001",
  session: "10000000-0000-4000-8000-000000000002",
  exercise: "10000000-0000-4000-8000-000000000003",
  performedExercise: "10000000-0000-4000-8000-000000000010",
  equipmentA: "10000000-0000-4000-8000-000000000004",
  equipmentB: "10000000-0000-4000-8000-000000000005",
  selectionA: "10000000-0000-4000-8000-000000000006",
  setA: "10000000-0000-4000-8000-000000000007",
  selectionB: "10000000-0000-4000-8000-000000000008",
  snapshotA: "10000000-0000-4000-8000-000000000009",
};

function pendingSet(
  overrides: { weight?: number; createdAtISO?: string } = {},
): Parameters<typeof enqueueWorkoutSetOutboxEntry>[1] {
  return {
    clientKey: ids.setA,
    ownerId: ids.owner,
    sessionId: ids.session,
    sessionExerciseId: ids.exercise,
    performedExerciseId: ids.performedExercise,
    performedSemanticsVersion: 1,
    performedLoadType: "ez_bar",
    performedLoadSemantics: "total",
    exerciseName: "Curl",
    setNo: 1,
    metricType: "weight_reps",
    weight: 38,
    weightUnit: "lb",
    reps: 10,
    distanceKm: null,
    durationSeconds: null,
    rpe: null,
    note: null,
    equipmentSnapshotId: null,
    equipmentSelectionClientKey: ids.selectionA,
    loadEntryMeaning: "total_system",
    createdAtISO: new Date(1001).toISOString(),
    ...overrides,
  };
}

function selection(
  clientKey: string,
  equipmentItemId: string,
  predecessorSelectionClientKey: string | null,
): NewEquipmentSelectionOutboxEntry {
  return {
    clientKey, ownerId: ids.owner, sessionId: ids.session,
    sessionExerciseId: ids.exercise, operation: "select", equipmentItemId,
    attachmentItemId: null, expectedCurrentSnapshotId: null,
    predecessorSelectionClientKey, provenance: "user_selected",
    equipmentLabel: "EZ curl bar", attachmentLabel: null,
  };
}

describe("equipment selection browser outbox", () => {
  it("withholds a same-meaning comparison through different-equipment delayed or failed acknowledgement", () => {
    const storage = new MemoryStorage();
    const identity = {
      ownerId: ids.owner,
      sessionId: ids.session,
      sessionExerciseId: ids.exercise,
    };
    expect(equipmentSelectionComparisonState(
      readEquipmentSelectionOutbox(storage),
      identity,
    )).toBe("safe");

    enqueueEquipmentSelectionOutboxEntry(
      storage,
      selection(ids.selectionA, ids.equipmentB, null),
      1000,
    );
    expect(equipmentSelectionComparisonState(
      readEquipmentSelectionOutbox(storage),
      identity,
    )).toBe("pending_or_failed");

    markEquipmentSelectionTransientFailure(
      storage,
      ids.selectionA,
      "Delayed acknowledgement",
      new Date(2000),
    );
    expect(equipmentSelectionComparisonState(
      readEquipmentSelectionOutbox(storage),
      identity,
    )).toBe("pending_or_failed");

    acknowledgeEquipmentSelectionOutboxEntry(
      storage,
      ids.selectionA,
      ids.snapshotA,
    );
    expect(equipmentSelectionComparisonState(
      readEquipmentSelectionOutbox(storage),
      identity,
    )).toBe("safe");
  });
  it("keeps corrupt local data quarantined instead of silently deleting it", () => {
    const snapshot = parseEquipmentSelectionOutbox(JSON.stringify({
      version: 1,
      entries: [{ clientKey: "not-a-uuid" }],
    }));
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.quarantined).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("invalid") }),
    ]);
  });

  it("retains selection A, set A, selection B order and binds set A only to A", () => {
    const storage = new MemoryStorage();
    enqueueEquipmentSelectionOutboxEntry(storage, selection(ids.selectionA, ids.equipmentA, null), 1000);
    enqueueWorkoutSetOutboxEntry(storage, pendingSet({ weight: 43 }));
    enqueueEquipmentSelectionOutboxEntry(storage, selection(ids.selectionB, ids.equipmentB, ids.selectionA), 1002);

    let selections = readEquipmentSelectionOutbox(storage).entries;
    let sets = readWorkoutSetOutbox(storage).entries;
    expect(nextWorkoutCommand(ids.owner, sets, selections)?.entry.clientKey).toBe(ids.selectionA);

    expect(bindWorkoutSetEntriesToEquipmentSelection(storage, ids.selectionA, ids.snapshotA).ok).toBe(true);
    expect(acknowledgeEquipmentSelectionOutboxEntry(storage, ids.selectionA, ids.snapshotA).ok).toBe(true);
    selections = readEquipmentSelectionOutbox(storage).entries;
    sets = readWorkoutSetOutbox(storage).entries;
    expect(sets[0]).toMatchObject({
      clientKey: ids.setA,
      equipmentSnapshotId: ids.snapshotA,
      equipmentSelectionClientKey: null,
    });
    expect(selections[0]).toMatchObject({
      clientKey: ids.selectionB,
      expectedCurrentSnapshotId: ids.snapshotA,
      predecessorSelectionClientKey: null,
    });
    expect(nextWorkoutCommand(ids.owner, sets, selections)?.entry.clientKey).toBe(ids.setA);
  });

  it("binds a set enqueued just after its equipment selection was acknowledged", () => {
    const storage = new MemoryStorage();
    enqueueEquipmentSelectionOutboxEntry(
      storage,
      selection(ids.selectionA, ids.equipmentA, null),
      1000,
    );

    expect(
      acknowledgeEquipmentSelectionOutboxEntry(
        storage,
        ids.selectionA,
        ids.snapshotA,
      ).ok,
    ).toBe(true);
    expect(
      enqueueWorkoutSetOutboxEntry(storage, pendingSet()),
    ).toMatchObject({
      ok: true,
      entry: {
        equipmentSelectionClientKey: null,
        equipmentSnapshotId: ids.snapshotA,
      },
    });
    expect(nextWorkoutCommand(
      ids.owner,
      readWorkoutSetOutbox(storage).entries,
      readEquipmentSelectionOutbox(storage).entries,
    )?.entry.clientKey).toBe(ids.setA);
  });

  it("refuses an expired equipment acknowledgement instead of binding stale setup truth", () => {
    const storage = new MemoryStorage();
    storage.setItem(EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [{
        clientKey: ids.selectionA,
        ownerId: ids.owner,
        sessionId: ids.session,
        sessionExerciseId: ids.exercise,
        snapshotId: ids.snapshotA,
        acknowledgedAtISO: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      }],
    }));

    expect(enqueueWorkoutSetOutboxEntry(storage, pendingSet({
      createdAtISO: "2026-07-22T12:00:00.000Z",
    }), true)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("equipment choice changed"),
    });
  });

  it("does not retain a set whose captured equipment dependency vanished without acknowledgement", () => {
    const storage = new MemoryStorage();
    const result = enqueueWorkoutSetOutboxEntry(storage, pendingSet(), true);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("equipment choice changed"),
    });
    expect(readWorkoutSetOutbox(storage).entries).toEqual([]);
  });

  it("uses one monotonic sequence even when two tabs enqueue in the same millisecond", () => {
    const storage = new MemoryStorage();
    enqueueEquipmentSelectionOutboxEntry(storage, selection(ids.selectionA, ids.equipmentA, null), 5000);
    enqueueEquipmentSelectionOutboxEntry(storage, selection(ids.selectionB, ids.equipmentB, ids.selectionA), 5000);
    const entries = readEquipmentSelectionOutbox(storage).entries;
    expect(Date.parse(entries[1].createdAtISO)).toBe(Date.parse(entries[0].createdAtISO) + 1);
  });

  it("rejects UUID reuse with changed values and backs off before needs-attention", () => {
    const storage = new MemoryStorage();
    expect(enqueueEquipmentSelectionOutboxEntry(
      storage, selection(ids.selectionA, ids.equipmentA, null), 5000,
    ).ok).toBe(true);
    expect(enqueueEquipmentSelectionOutboxEntry(
      storage, selection(ids.selectionA, ids.equipmentB, null), 5001,
    )).toMatchObject({ ok: false, reason: expect.stringContaining("different values") });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      markEquipmentSelectionTransientFailure(
        storage, ids.selectionA, "Offline", new Date(6000 + attempt * 1000),
      );
    }
    expect(readEquipmentSelectionOutbox(storage).entries[0]).toMatchObject({
      status: "needs_attention",
      attemptCount: 6,
      nextAttemptAtISO: null,
      lastError: "Automatic retry paused after repeated connection failures.",
    });
  });

  it("recognizes an already queued selection for the same workout exercise", () => {
    const storage = new MemoryStorage();
    enqueueEquipmentSelectionOutboxEntry(
      storage,
      selection(ids.selectionA, ids.equipmentA, null),
      1000,
    );
    const snapshot = readEquipmentSelectionOutbox(storage);

    expect(hasPendingEquipmentSelection(snapshot, {
      ownerId: ids.owner,
      sessionId: ids.session,
      sessionExerciseId: ids.exercise,
    })).toBe(true);
    expect(hasPendingEquipmentSelection(snapshot, {
      ownerId: ids.owner,
      sessionId: ids.session,
      sessionExerciseId: "10000000-0000-4000-8000-000000000099",
    })).toBe(false);
  });

  it("atomically coalesces duplicate automatic choices but preserves explicit ordering", () => {
    const storage = new MemoryStorage();
    const first = {
      ...selection(ids.selectionA, ids.equipmentA, null),
      provenance: "auto_unique" as const,
    };
    const duplicate = {
      ...selection(ids.selectionB, ids.equipmentA, null),
      provenance: "auto_unique" as const,
    };

    expect(enqueueEquipmentSelectionOutboxEntry(storage, first, 1000))
      .toMatchObject({ ok: true, entry: { clientKey: ids.selectionA } });
    expect(enqueueEquipmentSelectionOutboxEntry(storage, duplicate, 1001))
      .toMatchObject({ ok: true, entry: { clientKey: ids.selectionA } });
    expect(readEquipmentSelectionOutbox(storage).entries).toHaveLength(1);

    expect(enqueueEquipmentSelectionOutboxEntry(
      storage,
      selection(ids.selectionB, ids.equipmentB, ids.selectionA),
      1002,
    )).toMatchObject({ ok: true, entry: { clientKey: ids.selectionB } });
    expect(readEquipmentSelectionOutbox(storage).entries.map((entry) => entry.clientKey))
      .toEqual([ids.selectionA, ids.selectionB]);
  });

  it("refuses to discard a selection while a set or later selection depends on it", () => {
    const storage = new MemoryStorage();
    enqueueEquipmentSelectionOutboxEntry(
      storage,
      selection(ids.selectionA, ids.equipmentA, null),
      1000,
    );
    enqueueWorkoutSetOutboxEntry(storage, pendingSet());

    expect(removeEquipmentSelectionOutboxEntry(storage, ids.selectionA))
      .toMatchObject({ ok: false, reason: expect.stringContaining("saved set") });

    const noSetStorage = new MemoryStorage();
    enqueueEquipmentSelectionOutboxEntry(
      noSetStorage,
      selection(ids.selectionA, ids.equipmentA, null),
      1000,
    );
    enqueueEquipmentSelectionOutboxEntry(
      noSetStorage,
      selection(ids.selectionB, ids.equipmentB, ids.selectionA),
      1001,
    );
    expect(removeEquipmentSelectionOutboxEntry(noSetStorage, ids.selectionA))
      .toMatchObject({ ok: false, reason: expect.stringContaining("later equipment") });
    expect(removeEquipmentSelectionOutboxEntry(noSetStorage, ids.selectionB).ok).toBe(true);
    expect(removeEquipmentSelectionOutboxEntry(noSetStorage, ids.selectionA).ok).toBe(true);
    expect(readEquipmentSelectionOutbox(noSetStorage).entries).toEqual([]);
  });

  it("discards only the exact quarantined equipment copy and protects possible set dependencies", () => {
    const raw = { clientKey: ids.selectionA };
    const storage = new MemoryStorage();
    storage.setItem("workout-tracker:equipment-selection-outbox:v1", JSON.stringify({
      version: 1,
      entries: [raw],
    }));
    enqueueWorkoutSetOutboxEntry(storage, pendingSet());
    const quarantined = readEquipmentSelectionOutbox(storage).quarantined[0];

    expect(discardQuarantinedEquipmentSelectionOutboxEntry(
      storage,
      quarantined.quarantineKey,
      quarantined.raw,
    )).toMatchObject({ ok: false, reason: expect.stringContaining("saved set") });

    const independent = new MemoryStorage();
    independent.setItem(EQUIPMENT_SELECTION_OUTBOX_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [{ clientKey: "not-a-uuid" }],
    }));
    const independentCopy = readEquipmentSelectionOutbox(independent).quarantined[0];
    expect(discardQuarantinedEquipmentSelectionOutboxEntry(
      independent,
      independentCopy.quarantineKey,
      { clientKey: "changed" },
    )).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
    expect(discardQuarantinedEquipmentSelectionOutboxEntry(
      independent,
      independentCopy.quarantineKey,
      independentCopy.raw,
    ).ok).toBe(true);
    expect(readEquipmentSelectionOutbox(independent).quarantined).toEqual([]);
  });

  it("fails closed when unreadable set copies prevent dependency verification", () => {
    const storage = new MemoryStorage();
    enqueueEquipmentSelectionOutboxEntry(
      storage,
      selection(ids.selectionA, ids.equipmentA, null),
      1000,
    );
    storage.setItem(WORKOUT_SET_OUTBOX_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [{ clientKey: "unreadable" }],
    }));

    expect(removeEquipmentSelectionOutboxEntry(storage, ids.selectionA))
      .toMatchObject({ ok: false, reason: expect.stringContaining("unreadable saved set") });
  });
});
