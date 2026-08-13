import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { enqueueWorkoutSetOutboxEntry, readWorkoutSetOutbox, type WorkoutSetOutboxStorage } from "@/lib/workout-set-outbox";
import {
  enqueueEquipmentSelectionOutboxEntry,
  readEquipmentSelectionOutbox,
} from "@/lib/equipment-selection-outbox";

const actionMocks = vi.hoisted(() => ({
  logSet: vi.fn(),
  setSessionEquipmentSelection: vi.fn(),
}));
vi.mock("@/app/actions/sessions", () => actionMocks);
import {
  EquipmentSelectionOutboxTray,
  syncNextEntry,
} from "@/components/session/workout-set-outbox-sync";

class MemoryStorage implements WorkoutSetOutboxStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const owner = "10000000-0000-4000-8000-000000000021";
const session = "10000000-0000-4000-8000-000000000022";
const exercise = "10000000-0000-4000-8000-000000000023";
const selectionA = "10000000-0000-4000-8000-000000000024";
const setA = "10000000-0000-4000-8000-000000000025";
const selectionB = "10000000-0000-4000-8000-000000000026";
const snapshotA = "10000000-0000-4000-8000-000000000027";
const snapshotB = "10000000-0000-4000-8000-000000000028";
const secondExercise = "10000000-0000-4000-8000-000000000029";
const occurrence = "10000000-0000-4000-8000-000000000030";
const performedExercise = "10000000-0000-4000-8000-000000000033";

describe("equipment and set command sync", () => {
  let storage: MemoryStorage;
  let dispatched: Event[];
  beforeEach(() => {
    storage = new MemoryStorage();
    dispatched = [];
    const events = new EventTarget();
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: (event: Event) => {
        dispatched.push(event);
        return events.dispatchEvent(event);
      },
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("CustomEvent", class<T> extends Event {
      detail: T;
      constructor(type: string, init?: { detail?: T }) { super(type); this.detail = init?.detail as T; }
    });
    actionMocks.logSet.mockReset();
    actionMocks.setSessionEquipmentSelection.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("replays selection A, set A, then selection B without rebinding the set", async () => {
    enqueueEquipmentSelectionOutboxEntry(storage, {
      clientKey: selectionA, ownerId: owner, sessionId: session, sessionExerciseId: exercise,
      operation: "select", equipmentItemId: "10000000-0000-4000-8000-000000000031",
      attachmentItemId: null, expectedCurrentSnapshotId: null,
      predecessorSelectionClientKey: null, provenance: "user_selected",
      equipmentLabel: "18 lb EZ curl bar", attachmentLabel: null,
    }, 1000);
    enqueueWorkoutSetOutboxEntry(storage, {
      clientKey: setA, ownerId: owner, sessionId: session, sessionExerciseId: exercise,
      performedExerciseId: performedExercise, performedSemanticsVersion: 1,
      performedLoadType: "ez_bar", performedLoadSemantics: "total",
      exerciseName: "Curl", setNo: 1, metricType: "weight_reps",
      occurrenceId: occurrence, expectedOccurrenceRevision: 0,
      weight: 43, weightUnit: "lb", reps: 10,
      distanceKm: null, durationSeconds: null,
      rpe: null, note: null, equipmentSnapshotId: null,
      equipmentSelectionClientKey: selectionA, loadEntryMeaning: "total_system",
      createdAtISO: new Date(1001).toISOString(),
    });
    enqueueEquipmentSelectionOutboxEntry(storage, {
      clientKey: selectionB, ownerId: owner, sessionId: session, sessionExerciseId: exercise,
      operation: "select", equipmentItemId: "10000000-0000-4000-8000-000000000032",
      attachmentItemId: null, expectedCurrentSnapshotId: null,
      predecessorSelectionClientKey: selectionA, provenance: "user_selected",
      equipmentLabel: "Other bar", attachmentLabel: null,
    }, 1002);
    actionMocks.setSessionEquipmentSelection
      .mockResolvedValueOnce({
        outcome: "applied",
        snapshotId: snapshotA,
        occurrenceStates: [{
          id: occurrence, outcome: "pending", outcomeReason: null,
          outcomeNote: null, revision: 1, resolvedAt: null, completedSetId: null,
        }],
      })
      .mockResolvedValueOnce({ outcome: "applied", snapshotId: snapshotB, occurrenceStates: [] });
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "saved",
      setId: "50000000-0000-4000-8000-000000000001",
      occurrenceId: "60000000-0000-4000-8000-000000000001",
      occurrenceRevision: 2,
    });

    await syncNextEntry(owner);
    expect(dispatched.map((event) => (event as CustomEvent).detail).filter(Boolean))
      .toContainEqual(expect.objectContaining({
        type: "saved",
        sessionExerciseId: exercise,
        occurrenceStates: [expect.objectContaining({ id: occurrence, revision: 1 })],
      }));
    expect(readWorkoutSetOutbox(storage).entries[0].equipmentSnapshotId).toBe(snapshotA);
    expect(readWorkoutSetOutbox(storage).entries[0].expectedOccurrenceRevision).toBe(1);
    expect(readEquipmentSelectionOutbox(storage).entries[0].expectedCurrentSnapshotId).toBe(snapshotA);
    await syncNextEntry(owner);
    expect(actionMocks.logSet).toHaveBeenCalledWith(expect.objectContaining({
      equipmentSnapshotId: snapshotA,
      occurrenceId: occurrence,
      expectedOccurrenceRevision: 1,
    }));
    await syncNextEntry(owner);

    expect(actionMocks.setSessionEquipmentSelection.mock.invocationCallOrder[0])
      .toBeLessThan(actionMocks.logSet.mock.invocationCallOrder[0]);
    expect(actionMocks.logSet.mock.invocationCallOrder[0])
      .toBeLessThan(actionMocks.setSessionEquipmentSelection.mock.invocationCallOrder[1]);
    expect(readWorkoutSetOutbox(storage).entries).toEqual([]);
    expect(readEquipmentSelectionOutbox(storage).entries).toEqual([]);
  });

  it("drains ready automatic selections for several exercises after the first save finishes", async () => {
    enqueueEquipmentSelectionOutboxEntry(storage, {
      clientKey: selectionA, ownerId: owner, sessionId: session,
      sessionExerciseId: exercise, operation: "select",
      equipmentItemId: "10000000-0000-4000-8000-000000000031",
      attachmentItemId: null, expectedCurrentSnapshotId: null,
      predecessorSelectionClientKey: null, provenance: "auto_unique",
      equipmentLabel: "Olympic bar", attachmentLabel: null,
    }, 1000);
    enqueueEquipmentSelectionOutboxEntry(storage, {
      clientKey: selectionB, ownerId: owner, sessionId: session,
      sessionExerciseId: secondExercise, operation: "select",
      equipmentItemId: "10000000-0000-4000-8000-000000000032",
      attachmentItemId: null, expectedCurrentSnapshotId: null,
      predecessorSelectionClientKey: null, provenance: "auto_unique",
      equipmentLabel: "18 lb EZ curl bar", attachmentLabel: null,
    }, 1001);
    actionMocks.setSessionEquipmentSelection
      .mockResolvedValueOnce({ outcome: "applied", snapshotId: snapshotA, occurrenceStates: [] })
      .mockResolvedValueOnce({ outcome: "applied", snapshotId: snapshotB, occurrenceStates: [] });

    await syncNextEntry(owner, true);

    expect(actionMocks.setSessionEquipmentSelection).toHaveBeenCalledTimes(2);
    expect(actionMocks.setSessionEquipmentSelection.mock.calls.map(([input]) =>
      input.sessionExerciseId,
    )).toEqual([exercise, secondExercise]);
    expect(readEquipmentSelectionOutbox(storage).entries).toEqual([]);
  });

  it("advertises a failed equipment queue separately from workout sets", () => {
    enqueueEquipmentSelectionOutboxEntry(storage, {
      clientKey: selectionA, ownerId: owner, sessionId: session,
      sessionExerciseId: exercise, operation: "select",
      equipmentItemId: "10000000-0000-4000-8000-000000000031",
      attachmentItemId: null, expectedCurrentSnapshotId: null,
      predecessorSelectionClientKey: null, provenance: "auto_unique",
      equipmentLabel: "18 lb EZ curl bar", attachmentLabel: null,
    }, 1000);
    const snapshot = readEquipmentSelectionOutbox(storage);
    snapshot.entries[0] = {
      ...snapshot.entries[0],
      status: "needs_attention",
      lastError: "The equipment setup changed elsewhere.",
    };

    const html = renderToStaticMarkup(createElement(EquipmentSelectionOutboxTray, {
      entries: snapshot.entries,
      quarantined: [],
      storageError: null,
      onWake: () => undefined,
    }));

    expect(html).toContain("Equipment changes need attention");
    expect(html).toContain('aria-label="Open equipment changes"');
    expect(html).not.toContain("Sets need attention");
    expect(html).not.toMatch(/class="[^"]*\bfixed\b/);
  });
});
