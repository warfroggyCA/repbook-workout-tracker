import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import {
  WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS,
  enqueueWorkoutSetOutboxEntry,
  markWorkoutSetTransientFailure,
  readWorkoutSetOutbox,
  retryWorkoutSet,
  type NewWorkoutSetOutboxEntry,
  type WorkoutSetOutboxStorage,
} from "@/lib/workout-set-outbox";

const actionMocks = vi.hoisted(() => ({ logSet: vi.fn() }));
vi.mock("@/app/actions/sessions", () => ({ logSet: actionMocks.logSet }));

import {
  syncNextEntry,
  WORKOUT_DEVICE_STATUS_CLASS_NAME,
  WorkoutSetOutboxTray,
} from "@/components/session/workout-set-outbox-sync";
import {
  REST_TIMER_STORAGE_KEY,
  createRestTimer,
  readRestTimer,
  writeRestTimer,
} from "@/lib/rest-timer";
import { deploymentRecoveryRequired } from "@/lib/deployment-recovery";

class MemoryStorage implements WorkoutSetOutboxStorage {
  values = new Map<string, string>();
  rejectRestWrites = false;

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.rejectRestWrites && key === REST_TIMER_STORAGE_KEY) {
      throw new Error("rest storage unavailable");
    }
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function entry(): Extract<
  NewWorkoutSetOutboxEntry,
  { metricType: "weight_reps" }
> {
  return {
    clientKey: "10000000-0000-4000-8000-000000000001",
    ownerId: "20000000-0000-4000-8000-000000000001",
    sessionId: "30000000-0000-4000-8000-000000000001",
    sessionExerciseId: "40000000-0000-4000-8000-000000000001",
    performedExerciseId: "50000000-0000-4000-8000-000000000001",
    performedSemanticsVersion: 1,
    performedLoadType: "barbell",
    performedLoadSemantics: "total",
    workoutName: "Day 3",
    exerciseName: "Bench Press",
    setNo: 1,
    metricType: "weight_reps",
    weight: 100,
    weightUnit: "lb",
    reps: 8,
    distanceKm: null,
    durationSeconds: null,
    rpe: 8,
    note: null,
    equipmentSnapshotId: null,
    loadEntryMeaning: "legacy_unknown",
    createdAtISO: "2026-07-18T12:00:00.000Z",
  };
}

const savedSetId = "50000000-0000-4000-8000-000000000001";
const savedOccurrenceId = "60000000-0000-4000-8000-000000000001";

describe("workout set outbox sync classification", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    const events = new EventTarget();
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
      }
    );
    actionMocks.logSet.mockReset();
    enqueueWorkoutSetOutboxEntry(storage, entry());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps recovery reachable in its own safe slot without fixing the trigger itself", () => {
    const snapshot = readWorkoutSetOutbox(storage);
    const html = renderToStaticMarkup(createElement(WorkoutSetOutboxTray, {
      entries: snapshot.entries,
      quarantined: [],
      storageError: null,
      onWake: () => undefined,
    }));

    expect(html).toContain('aria-label="Open sets waiting to save"');
    expect(html).toContain('data-slot="drawer-trigger"');
    expect(html).toContain("1 set saving");
    expect(html).not.toMatch(/class="[^"]*\bfixed\b/);
    expect(WORKOUT_DEVICE_STATUS_CLASS_NAME).toContain("fixed");
    expect(WORKOUT_DEVICE_STATUS_CLASS_NAME).toContain(
      "bottom-[calc(7.5rem+env(safe-area-inset-bottom))]",
    );
    expect(WORKOUT_DEVICE_STATUS_CLASS_NAME).toContain(
      "lg:bottom-[5.75rem]",
    );
    expect(WORKOUT_DEVICE_STATUS_CLASS_NAME).toContain("z-30");
  });

  it("treats every thrown action failure as transient with fixed copy", async () => {
    actionMocks.logSet.mockRejectedValueOnce(new Error("masked digest garbage"));
    await syncNextEntry(entry().ownerId);

    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      status: "queued",
      attemptCount: 1,
      lastError:
        "We couldn't save this set yet. We'll keep trying when you're back online.",
    });
  });

  it("retains a stale-build set and stops retrying until the app reloads", async () => {
    actionMocks.logSet.mockRejectedValueOnce(
      new UnrecognizedActionError("old action"),
    );
    await syncNextEntry(entry().ownerId);

    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      status: "queued",
      attemptCount: 1,
      lastError:
        "Repbook was updated. This set is safe on this device and will retry after you reload.",
    });
    expect(deploymentRecoveryRequired()).toBe(true);

    await syncNextEntry(entry().ownerId);
    expect(actionMocks.logSet).toHaveBeenCalledOnce();
  });

  it("parks a named workout-not-active outcome for explicit review", async () => {
    actionMocks.logSet.mockResolvedValueOnce({ outcome: "workout_not_active" });
    await syncNextEntry(entry().ownerId);

    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      status: "needs_attention",
      lastError: "This workout has ended. Check this set before removing it.",
    });
  });

  it("persists the exact authoritative blocker and disables blind retry", async () => {
    const blocker = {
      occurrenceId: "60000000-0000-4000-8000-000000000002",
      occurrenceRevision: 1,
      sessionExerciseId: "40000000-0000-4000-8000-000000000002",
      exerciseName: "Cable Pushdown",
      setNo: 2,
      groupRound: 2,
      origin: "planned",
      isAddedSet: false,
      label: "Cable Pushdown · round 2, set 2",
    };
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "set_order_conflict",
      blocker,
    });
    await syncNextEntry(entry().ownerId);

    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      status: "needs_attention",
      lastError: expect.stringContaining(blocker.label),
      orderBlocker: blocker,
    });
    await expect(retryWorkoutSet(entry().clientKey)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining(blocker.label),
    });
  });

  it("sends an exact occurrence fence for new commands while legacy entries remain valid", async () => {
    storage.values.clear();
    const occurrenceId = "60000000-0000-4000-8000-000000000003";
    enqueueWorkoutSetOutboxEntry(storage, {
      ...entry(),
      occurrenceId,
      expectedOccurrenceRevision: 4,
    });
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "saved",
      setId: savedSetId,
      occurrenceId,
      occurrenceRevision: 5,
    });

    await syncNextEntry(entry().ownerId);

    expect(actionMocks.logSet).toHaveBeenCalledWith(expect.objectContaining({
      occurrenceId,
      expectedOccurrenceRevision: 4,
    }));
    expect(readWorkoutSetOutbox(storage).entries).toEqual([]);
  });

  it("sends the captured evidence and parks a stale selection for review", async () => {
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "equipment_selection_conflict",
    });
    await syncNextEntry(entry().ownerId);

    expect(actionMocks.logSet).toHaveBeenCalledWith(expect.objectContaining({
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown",
    }));
    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      status: "needs_attention",
      lastError: expect.stringContaining("equipment changed"),
    });
  });

  it("retries a corrected server-rule failure with the same durable identity", async () => {
    actionMocks.logSet
      .mockResolvedValueOnce({ outcome: "equipment_selection_required" })
      .mockResolvedValueOnce({
        outcome: "saved",
        setId: savedSetId,
        occurrenceId: savedOccurrenceId,
        occurrenceRevision: 1,
      });

    await syncNextEntry(entry().ownerId);
    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      status: "needs_attention",
    });

    await retryWorkoutSet(entry().clientKey);
    await syncNextEntry(entry().ownerId);

    expect(actionMocks.logSet).toHaveBeenCalledTimes(2);
    expect(actionMocks.logSet.mock.calls[0]?.[0].clientKey).toBe(
      entry().clientKey,
    );
    expect(actionMocks.logSet.mock.calls[1]?.[0].clientKey).toBe(
      entry().clientKey,
    );
    expect(readWorkoutSetOutbox(storage).entries).toEqual([]);
  });

  it("starts rest only after the server acknowledges the exact set", async () => {
    storage.values.clear();
    enqueueWorkoutSetOutboxEntry(storage, { ...entry(), restAfterSec: 90 });
    let acknowledge!: (value: { outcome: "saved"; setId: string; occurrenceId: string; occurrenceRevision: number }) => void;
    actionMocks.logSet.mockReturnValueOnce(new Promise((resolve) => {
      acknowledge = resolve;
    }));

    const syncing = syncNextEntry(entry().ownerId);
    await vi.waitFor(() => expect(actionMocks.logSet).toHaveBeenCalledTimes(1));
    const identity = { ownerId: entry().ownerId, sessionId: entry().sessionId };
    expect(readRestTimer(storage, identity).timer).toBeNull();

    acknowledge({ outcome: "saved", setId: savedSetId, occurrenceId: savedOccurrenceId, occurrenceRevision: 1 });
    await syncing;

    expect(readRestTimer(storage, identity).timer).toMatchObject({
      ownerId: entry().ownerId,
      sessionId: entry().sessionId,
      totalSec: 90,
      phase: "running",
      sourceSessionExerciseId: entry().sessionExerciseId,
      sourceOccurrenceId: savedOccurrenceId,
      sourceCompletedSetId: savedSetId,
    });
  });

  it("keeps an acknowledged set recoverable when its rest timer cannot be retained", async () => {
    storage.values.clear();
    enqueueWorkoutSetOutboxEntry(storage, { ...entry(), restAfterSec: 90 });
    storage.rejectRestWrites = true;
    actionMocks.logSet.mockResolvedValueOnce({ outcome: "saved", setId: savedSetId, occurrenceId: savedOccurrenceId, occurrenceRevision: 1 });

    await syncNextEntry(entry().ownerId);

    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      status: "queued",
      attemptCount: 1,
      lastError: expect.stringContaining("could not retain its rest timer"),
    });
  });

  it("keeps the acknowledged set and prior timer when no secure timer identity can be created", async () => {
    storage.values.clear();
    const identity = { ownerId: entry().ownerId, sessionId: entry().sessionId };
    const priorTimer = createRestTimer({
      ...identity,
      generationId: "70000000-0000-4000-8000-000000000001",
      now: 1_000,
      seconds: 30,
    })!;
    await writeRestTimer(storage, priorTimer);
    enqueueWorkoutSetOutboxEntry(storage, { ...entry(), restAfterSec: 90 });
    vi.stubGlobal("crypto", {
      getRandomValues: () => {
        throw new Error("secure randomness unavailable");
      },
    });
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "saved",
      setId: savedSetId,
      occurrenceId: savedOccurrenceId,
      occurrenceRevision: 1,
    });

    await syncNextEntry(entry().ownerId);

    expect(readRestTimer(storage, identity).timer).toMatchObject({
      generationId: priorTimer.generationId,
      ownerId: priorTimer.ownerId,
      sessionId: priorTimer.sessionId,
      sourceCompletedSetId: null,
    });
    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      status: "queued",
      lastError: expect.stringContaining("could not retain its rest timer"),
    });
  });

  it("clears a prior timer for zero rest only after acknowledgement", async () => {
    storage.values.clear();
    const identity = { ownerId: entry().ownerId, sessionId: entry().sessionId };
    await writeRestTimer(storage, createRestTimer({ ...identity, now: 1_000, seconds: 90 })!);
    enqueueWorkoutSetOutboxEntry(storage, { ...entry(), restAfterSec: 0 });
    let acknowledge!: (value: { outcome: "saved"; setId: string; occurrenceId: string; occurrenceRevision: number }) => void;
    actionMocks.logSet.mockReturnValueOnce(new Promise((resolve) => {
      acknowledge = resolve;
    }));

    const syncing = syncNextEntry(entry().ownerId);
    await vi.waitFor(() => expect(actionMocks.logSet).toHaveBeenCalledTimes(1));
    expect(readRestTimer(storage, identity).timer).not.toBeNull();
    acknowledge({ outcome: "saved", setId: savedSetId, occurrenceId: savedOccurrenceId, occurrenceRevision: 1 });
    await syncing;

    expect(readRestTimer(storage, identity).timer).toBeNull();
  });

  it("clears a prior timer for explicitly unknown rest without claiming zero", async () => {
    storage.values.clear();
    const identity = { ownerId: entry().ownerId, sessionId: entry().sessionId };
    await writeRestTimer(storage, createRestTimer({ ...identity, now: 1_000, seconds: 90 })!);
    enqueueWorkoutSetOutboxEntry(storage, { ...entry(), restAfterSec: null });
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "saved",
      setId: savedSetId,
      occurrenceId: savedOccurrenceId,
      occurrenceRevision: 1,
    });

    await syncNextEntry(entry().ownerId);

    expect(readRestTimer(storage, identity).timer).toBeNull();
  });

  it("leaves a prior timer untouched for a retained legacy command with no rest field", async () => {
    storage.values.clear();
    const identity = { ownerId: entry().ownerId, sessionId: entry().sessionId };
    const prior = createRestTimer({ ...identity, now: 1_000, seconds: 90 })!;
    await writeRestTimer(storage, prior);
    enqueueWorkoutSetOutboxEntry(storage, entry());
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "saved",
      setId: savedSetId,
      occurrenceId: savedOccurrenceId,
      occurrenceRevision: 1,
    });

    await syncNextEntry(entry().ownerId);

    expect(readRestTimer(storage, identity).timer).toMatchObject({
      generationId: prior.generationId,
      totalSec: 90,
    });
  });

  it("parks a thrown failure after the automatic retry cap", async () => {
    for (let attempt = 1; attempt < WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS; attempt += 1) {
      markWorkoutSetTransientFailure(
        storage,
        entry().clientKey,
        "Temporary",
        new Date(`2026-07-18T11:5${attempt}:00.000Z`)
      );
    }
    actionMocks.logSet.mockRejectedValueOnce(new Error("server failure"));
    await syncNextEntry(entry().ownerId);

    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      status: "needs_attention",
      attemptCount: WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS,
      lastError: "Automatic retry paused after repeated connection failures.",
    });
  });
});
