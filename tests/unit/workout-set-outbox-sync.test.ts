import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import {
  WORKOUT_SET_OUTBOX_STATUS_EVENT,
  WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS,
  discardWorkoutSetDeviceCopy,
  enqueueWorkoutSetOutboxEntry,
  markWorkoutSetNeedsAttention,
  markWorkoutSetTransientFailure,
  readWorkoutSetOutbox,
  retryWorkoutSet,
  type NewWorkoutSetOutboxEntry,
  type WorkoutSetOutboxClientEvent,
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
  completeRestTimer,
  continueAfterRest,
  createRestTimer,
  readRestTimer,
  writeRestTimer,
} from "@/lib/rest-timer";
import {
  deploymentRecoveryRequired,
  documentRecoveryReason,
} from "@/lib/deployment-recovery";

class MemoryStorage implements WorkoutSetOutboxStorage {
  values = new Map<string, string>();
  rejectRestWrites = false;
  rejectRestRemovals = false;

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
    if (this.rejectRestRemovals && key === REST_TIMER_STORAGE_KEY) {
      throw new Error("rest storage unavailable");
    }
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
  let statusEvents: WorkoutSetOutboxClientEvent[];

  beforeEach(() => {
    storage = new MemoryStorage();
    const events = new EventTarget();
    statusEvents = [];
    events.addEventListener(WORKOUT_SET_OUTBOX_STATUS_EVENT, (event) => {
      statusEvents.push(
        (event as CustomEvent<WorkoutSetOutboxClientEvent>).detail,
      );
    });
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
    expect(statusEvents.at(-1)).toEqual({
      type: "failed",
      clientKey: entry().clientKey,
      sessionId: entry().sessionId,
    });

    const snapshot = readWorkoutSetOutbox(storage);
    const html = renderToStaticMarkup(createElement(WorkoutSetOutboxTray, {
      entries: snapshot.entries,
      quarantined: [],
      storageError: null,
      onWake: () => undefined,
    }));
    expect(html).toContain("1 set waiting to retry");
    expect(html).not.toContain(">Retrying<");
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

  it("releases a never-settling save and replays its exact identity only in a new document", async () => {
    actionMocks.logSet.mockReturnValueOnce(new Promise(() => undefined));

    await syncNextEntry(entry().ownerId, false, 0, 5);

    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      clientKey: entry().clientKey,
      ownerId: entry().ownerId,
      sessionId: entry().sessionId,
      sessionExerciseId: entry().sessionExerciseId,
      setNo: entry().setNo,
      weight: entry().weight,
      reps: entry().reps,
      status: "queued",
      attemptCount: 1,
      lastError:
        "Repbook did not confirm this set in time. It is safe on this device. Reload and retry safely.",
    });
    expect(documentRecoveryReason()).toBe("action_timeout");
    const firstCommand = actionMocks.logSet.mock.calls[0]?.[0];

    await expect(retryWorkoutSet(entry().clientKey)).resolves.toMatchObject({
      ok: true,
    });
    await syncNextEntry(entry().ownerId, false, 0, 5);
    expect(actionMocks.logSet).toHaveBeenCalledOnce();

    const nextEvents = new EventTarget();
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: nextEvents.dispatchEvent.bind(nextEvents),
    });
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "saved",
      setId: savedSetId,
      occurrenceId: savedOccurrenceId,
      occurrenceRevision: 1,
    });

    await syncNextEntry(entry().ownerId, false, 0, 5);

    expect(actionMocks.logSet).toHaveBeenCalledTimes(2);
    expect(actionMocks.logSet.mock.calls[1]?.[0]).toEqual(firstCommand);
    expect(readWorkoutSetOutbox(storage).entries).toEqual([]);
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

  it("coalesces an exact-blocker wake that arrives while its owner drain unwinds", async () => {
    storage.values.clear();
    const blockerOccurrenceId =
      "60000000-0000-4000-8000-000000000004";
    const retained = {
      ...entry(),
      occurrenceId: "60000000-0000-4000-8000-000000000005",
      expectedOccurrenceRevision: 0,
      setNo: 2,
    };
    enqueueWorkoutSetOutboxEntry(storage, retained);
    markWorkoutSetNeedsAttention(
      storage,
      retained.clientKey,
      "Resolve Bench Press · Set 1 first.",
      new Date("2026-07-18T12:01:00.000Z"),
      {
        occurrenceId: blockerOccurrenceId,
        occurrenceRevision: 0,
        sessionExerciseId: retained.sessionExerciseId,
        exerciseName: retained.exerciseName,
        setNo: 1,
        groupRound: null,
        origin: "planned",
        isAddedSet: false,
        label: "Bench Press · Set 1",
      },
    );
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "saved",
      setId: savedSetId,
      occurrenceId: blockerOccurrenceId,
      occurrenceRevision: 1,
    });

    const dormantPass = syncNextEntry(retained.ownerId);
    const blocker = {
      ...entry(),
      clientKey: "10000000-0000-4000-8000-000000000002",
      occurrenceId: blockerOccurrenceId,
      expectedOccurrenceRevision: 0,
      createdAtISO: "2026-07-18T12:02:00.000Z",
    };
    enqueueWorkoutSetOutboxEntry(storage, blocker);
    const overlappingWake = syncNextEntry(retained.ownerId);

    await Promise.all([dormantPass, overlappingWake]);

    expect(actionMocks.logSet).toHaveBeenCalledOnce();
    expect(actionMocks.logSet).toHaveBeenCalledWith(
      expect.objectContaining({
        clientKey: blocker.clientKey,
        occurrenceId: blockerOccurrenceId,
      }),
    );
    expect(readWorkoutSetOutbox(storage).entries).toEqual([
      expect.objectContaining({
        clientKey: retained.clientKey,
        status: "queued",
        orderBlocker: null,
      }),
    ]);
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

  it("does not restart a dismissed optimistic timer after delayed acknowledgement", async () => {
    storage.values.clear();
    const queued = {
      ...entry(),
      occurrenceId: savedOccurrenceId,
      expectedOccurrenceRevision: 0,
      restAfterSec: 30,
    };
    enqueueWorkoutSetOutboxEntry(storage, queued);
    const optimistic = createRestTimer({
      ownerId: queued.ownerId,
      sessionId: queued.sessionId,
      generationId: "70000000-0000-4000-8000-000000000001",
      now: 1_000,
      seconds: 30,
      sourceSessionExerciseId: queued.sessionExerciseId,
      sourceOccurrenceId: savedOccurrenceId,
      sourceClientKey: queued.clientKey,
    })!;
    const dismissed = continueAfterRest(
      completeRestTimer(optimistic, 31_000, "foreground", {
        sound: "requested",
        vibration: "not_requested",
        completion: "requested",
      }),
      32_000,
    );
    await writeRestTimer(storage, dismissed);
    actionMocks.logSet.mockResolvedValueOnce({
      outcome: "saved",
      setId: savedSetId,
      occurrenceId: savedOccurrenceId,
      occurrenceRevision: 1,
    });

    await syncNextEntry(queued.ownerId);

    expect(readWorkoutSetOutbox(storage).entries).toEqual([]);
    expect(readRestTimer(storage, {
      ownerId: queued.ownerId,
      sessionId: queued.sessionId,
    }).timer).toMatchObject({
      phase: "continued",
      startedAt: 1_000,
      endsAt: 31_000,
      sourceClientKey: queued.clientKey,
      sourceCompletedSetId: savedSetId,
    });
  });

  it("discards only the matching set timer and preserves a later timer", async () => {
    storage.values.clear();
    const queued = { ...entry(), restAfterSec: 30 };
    enqueueWorkoutSetOutboxEntry(storage, queued);
    const matching = createRestTimer({
      ownerId: queued.ownerId,
      sessionId: queued.sessionId,
      generationId: "70000000-0000-4000-8000-000000000001",
      now: 1_000,
      seconds: 30,
      sourceSessionExerciseId: queued.sessionExerciseId,
      sourceOccurrenceId: savedOccurrenceId,
      sourceClientKey: queued.clientKey,
    })!;
    await writeRestTimer(storage, matching);

    await expect(discardWorkoutSetDeviceCopy(storage, queued)).resolves.toMatchObject({ ok: true });
    expect(readWorkoutSetOutbox(storage).entries).toEqual([]);
    expect(readRestTimer(storage, {
      ownerId: queued.ownerId,
      sessionId: queued.sessionId,
    }).timer).toBeNull();

    enqueueWorkoutSetOutboxEntry(storage, queued);
    const laterClientKey = "80000000-0000-4000-8000-000000000008";
    const later = createRestTimer({
      ownerId: queued.ownerId,
      sessionId: queued.sessionId,
      generationId: "90000000-0000-4000-8000-000000000009",
      now: 2_000,
      seconds: 60,
      sourceSessionExerciseId: queued.sessionExerciseId,
      sourceOccurrenceId: "60000000-0000-4000-8000-000000000002",
      sourceClientKey: laterClientKey,
    })!;
    await writeRestTimer(storage, later);

    await expect(discardWorkoutSetDeviceCopy(storage, queued)).resolves.toMatchObject({ ok: true });
    expect(readRestTimer(storage, {
      ownerId: queued.ownerId,
      sessionId: queued.sessionId,
    }).timer).toMatchObject({
      generationId: later.generationId,
      sourceClientKey: laterClientKey,
    });
  });

  it("retains the device copy when its matching timer cannot be cleared", async () => {
    storage.values.clear();
    const queued = { ...entry(), restAfterSec: 30 };
    enqueueWorkoutSetOutboxEntry(storage, queued);
    await writeRestTimer(storage, createRestTimer({
      ownerId: queued.ownerId,
      sessionId: queued.sessionId,
      generationId: "70000000-0000-4000-8000-000000000001",
      now: 1_000,
      seconds: 30,
      sourceSessionExerciseId: queued.sessionExerciseId,
      sourceOccurrenceId: savedOccurrenceId,
      sourceClientKey: queued.clientKey,
    })!);
    storage.rejectRestRemovals = true;

    await expect(discardWorkoutSetDeviceCopy(storage, queued)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("still retained"),
    });
    expect(readWorkoutSetOutbox(storage).entries).toHaveLength(1);
    expect(readRestTimer(storage, {
      ownerId: queued.ownerId,
      sessionId: queued.sessionId,
    }).timer).toMatchObject({ sourceClientKey: queued.clientKey });
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
