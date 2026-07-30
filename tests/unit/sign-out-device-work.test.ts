import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIGN_OUT_DEVICE_STORE_KINDS,
  buildSignOutDeviceWorkSnapshot,
  describeSignOutDeviceStore,
  discardSignOutDeviceWorkWithAdapter,
  readSignOutDeviceWorkSources,
  type SignOutDeviceWorkDiscardAdapter,
  type SignOutDeviceWorkSources,
} from "@/lib/sign-out-device-work";

const OWNER_A = "10000000-0000-4000-8000-000000000001";
const OWNER_B = "10000000-0000-4000-8000-000000000002";

afterEach(() => {
  vi.unstubAllGlobals();
});

function entry(
  ownerId: string,
  clientKey: string,
  status: "queued" | "syncing" | "needs_attention",
  createdAtISO = "2026-07-28T12:00:00.000Z",
) {
  return {
    ownerId,
    clientKey,
    status,
    createdAtISO,
    payloadHash: `sha256:${"a".repeat(64)}`,
  };
}

function sources(ownerId = OWNER_A): SignOutDeviceWorkSources {
  return {
    workoutSets: { entries: [], quarantined: [], error: null },
    occurrenceMutations: { entries: [], error: null },
    equipmentSelections: { entries: [], quarantined: [], error: null },
    contextualNotes: {
      ownerId,
      entries: [],
      quarantined: [],
      error: null,
    },
    liveCoach: { entries: [], quarantined: [], error: null },
  };
}

function populatedSources(): SignOutDeviceWorkSources {
  const state = sources();
  state.workoutSets.entries = [
    entry(OWNER_A, "set-a", "queued") as never,
    entry(OWNER_B, "set-b", "needs_attention") as never,
  ];
  state.occurrenceMutations.entries = [
    entry(OWNER_A, "occurrence-a", "needs_attention") as never,
    entry(OWNER_B, "occurrence-b", "queued") as never,
  ];
  state.equipmentSelections.entries = [
    entry(
      OWNER_A,
      "equipment-earlier",
      "queued",
      "2026-07-28T12:00:00.000Z",
    ) as never,
    entry(
      OWNER_A,
      "equipment-later",
      "needs_attention",
      "2026-07-28T12:01:00.000Z",
    ) as never,
    entry(OWNER_B, "equipment-b", "queued") as never,
  ];
  state.contextualNotes.entries = [
    entry(OWNER_A, "note-a", "syncing") as never,
  ];
  state.liveCoach.entries = [
    entry(OWNER_A, "coach-a", "queued") as never,
    entry(OWNER_B, "coach-b", "queued") as never,
  ];
  return state;
}

describe("sign-out device-work inventory", () => {
  it("classifies all five owner-scoped stores and every actionable state", () => {
    const state = populatedSources();
    state.workoutSets.quarantined = [{ raw: "unreadable" } as never];
    state.liveCoach.error = "Coach storage could not be read.";

    const snapshot = buildSignOutDeviceWorkSnapshot(OWNER_A, state);

    expect(snapshot.stores.map((store) => store.kind)).toEqual(
      SIGN_OUT_DEVICE_STORE_KINDS,
    );
    expect(snapshot.ownerEntryCount).toBe(6);
    expect(snapshot.quarantinedCount).toBe(1);
    expect(snapshot.errorCount).toBe(1);
    expect(snapshot.needsReview).toBe(true);
    expect(snapshot.canDiscardOwnerCopies).toBe(false);
    expect(
      snapshot.stores.find((store) => store.kind === "contextual_notes"),
    ).toMatchObject({ syncingCount: 1, ownerEntryCount: 1 });
    expect(
      snapshot.stores.find((store) => store.kind === "equipment_selections"),
    ).toMatchObject({ queuedCount: 1, needsAttentionCount: 1 });
    expect(
      describeSignOutDeviceStore(snapshot.stores[0]),
    ).toContain("not safe for bulk discard");
  });

  it("keeps foreign work separate across sign-out, account change, and re-auth", () => {
    const state = populatedSources();
    const untouched = structuredClone(state);

    const ownerA = buildSignOutDeviceWorkSnapshot(OWNER_A, state);
    const accountBState = structuredClone(state);
    accountBState.contextualNotes = {
      ownerId: OWNER_B,
      entries: [],
      quarantined: [],
      error:
        "Saved notes on this device belong to a different signed-in account.",
    };
    const ownerB = buildSignOutDeviceWorkSnapshot(OWNER_B, accountBState);
    const ownerAAfterReauth = buildSignOutDeviceWorkSnapshot(OWNER_A, state);

    expect(ownerA.ownerEntryCount).toBe(6);
    expect(ownerA.stores[0].foreignEntryCount).toBe(1);
    expect(ownerB.ownerEntryCount).toBe(4);
    expect(ownerB.errorCount).toBe(1);
    expect(ownerB.canDiscardOwnerCopies).toBe(false);
    expect(ownerAAfterReauth).toEqual(ownerA);
    expect(state).toEqual(untouched);
  });

  it("blocks sign-out when browser storage cannot be inspected", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new DOMException("Storage is blocked.", "SecurityError");
      },
    });

    const snapshot = buildSignOutDeviceWorkSnapshot(
      OWNER_A,
      readSignOutDeviceWorkSources(OWNER_A),
    );

    expect(snapshot).toMatchObject({
      needsReview: true,
      canDiscardOwnerCopies: false,
      errorCount: 1,
    });
    expect(snapshot.stores[0].error).toContain(
      "Saved device work could not be inspected",
    );
  });
});

describe("sign-out device-work discard", () => {
  function adapterFor(
    initial: SignOutDeviceWorkSources,
    events: string[],
  ): {
    adapter: SignOutDeviceWorkDiscardAdapter;
    state: SignOutDeviceWorkSources;
    reads: () => number;
  } {
    const state = structuredClone(initial);
    let readCount = 0;
    const adapter: SignOutDeviceWorkDiscardAdapter = {
      read: () => {
        readCount += 1;
        return state;
      },
      discardWorkoutSet: (ownerId, clientKey) => {
        events.push(`workout:${clientKey}`);
        state.workoutSets.entries = state.workoutSets.entries.filter(
          (item) =>
            item.ownerId !== ownerId || item.clientKey !== clientKey,
        );
        return { ok: true };
      },
      discardOccurrenceMutation: (_ownerId, clientKey) => {
        events.push(`occurrence:${clientKey}`);
        state.occurrenceMutations.entries =
          state.occurrenceMutations.entries.filter(
            (item) => item.clientKey !== clientKey,
          );
        return { ok: true };
      },
      discardContextualNote: (_ownerId, clientKey) => {
        events.push(`note:${clientKey}`);
        state.contextualNotes.entries =
          state.contextualNotes.entries.filter(
            (item) => item.clientKey !== clientKey,
          );
        return { ok: true };
      },
      discardLiveCoachMessage: (_ownerId, clientKey) => {
        events.push(`coach:${clientKey}`);
        state.liveCoach.entries = state.liveCoach.entries.filter(
          (item) => item.clientKey !== clientKey,
        );
        return { ok: true };
      },
      discardEquipmentSelection: (_ownerId, clientKey) => {
        events.push(`equipment:${clientKey}`);
        state.equipmentSelections.entries =
          state.equipmentSelections.entries.filter(
            (item) => item.clientKey !== clientKey,
          );
        return { ok: true };
      },
    };
    return { adapter, state, reads: () => readCount };
  }

  it("re-reads, removes only the current owner's copies, and removes sets before equipment", async () => {
    const events: string[] = [];
    const fixture = adapterFor(populatedSources(), events);

    const result = await discardSignOutDeviceWorkWithAdapter(
      OWNER_A,
      fixture.adapter,
    );

    expect(result).toMatchObject({
      ok: true,
      snapshot: { ownerEntryCount: 0 },
    });
    expect(fixture.reads()).toBe(2);
    expect(events).toEqual([
      "workout:set-a",
      "occurrence:occurrence-a",
      "note:note-a",
      "coach:coach-a",
      "equipment:equipment-later",
      "equipment:equipment-earlier",
    ]);
    expect(fixture.state.workoutSets.entries.map((item) => item.ownerId)).toEqual([
      OWNER_B,
    ]);
    expect(
      fixture.state.occurrenceMutations.entries.map((item) => item.ownerId),
    ).toEqual([OWNER_B]);
    expect(
      fixture.state.equipmentSelections.entries.map((item) => item.ownerId),
    ).toEqual([OWNER_B]);
    expect(fixture.state.liveCoach.entries.map((item) => item.ownerId)).toEqual([
      OWNER_B,
    ]);
  });

  it("blocks bulk discard before mutation when ownership or storage is unsafe", async () => {
    const state = populatedSources();
    state.equipmentSelections.quarantined = [{ raw: "unknown" } as never];
    const events: string[] = [];
    const fixture = adapterFor(state, events);

    const result = await discardSignOutDeviceWorkWithAdapter(
      OWNER_A,
      fixture.adapter,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("cannot be attributed or read safely"),
    });
    expect(events).toEqual([]);
    expect(fixture.state).toEqual(state);
  });

  it("preserves foreign work that depends on this account's equipment choice", async () => {
    const state = sources();
    state.equipmentSelections.entries = [
      {
        ...entry(OWNER_A, "equipment-a", "queued"),
        predecessorSelectionClientKey: null,
      } as never,
    ];
    state.workoutSets.entries = [
      {
        ...entry(OWNER_B, "set-b", "queued"),
        equipmentSelectionClientKey: "equipment-a",
      } as never,
    ];
    const events: string[] = [];
    const fixture = adapterFor(state, events);

    const result = await discardSignOutDeviceWorkWithAdapter(
      OWNER_A,
      fixture.adapter,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Another account's saved work depends"),
    });
    expect(events).toEqual([]);
    expect(fixture.state).toEqual(state);
  });

  it("stays signed in when new work arrives during discard", async () => {
    const state = sources();
    state.workoutSets.entries = [
      entry(OWNER_A, "set-a", "queued") as never,
    ];
    let reads = 0;
    const adapter: SignOutDeviceWorkDiscardAdapter = {
      read: () => {
        reads += 1;
        if (reads === 2) {
          state.liveCoach.entries = [
            entry(OWNER_A, "coach-arrived-late", "queued") as never,
          ];
        }
        return state;
      },
      discardWorkoutSet: () => {
        state.workoutSets.entries = [];
        return { ok: true };
      },
      discardOccurrenceMutation: () => ({ ok: true }),
      discardContextualNote: () => ({ ok: true }),
      discardLiveCoachMessage: () => ({ ok: true }),
      discardEquipmentSelection: () => ({ ok: true }),
    };

    const result = await discardSignOutDeviceWorkWithAdapter(OWNER_A, adapter);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("changed while"),
      snapshot: { ownerEntryCount: 1 },
    });
  });

  it("preserves owner work that arrives after review but before a reviewed set is removed", async () => {
    const state = sources();
    state.workoutSets.entries = [
      entry(OWNER_A, "set-reviewed", "queued") as never,
    ];
    const adapter: SignOutDeviceWorkDiscardAdapter = {
      read: () => state,
      discardWorkoutSet: (ownerId, clientKey) => {
        state.workoutSets.entries = [
          ...state.workoutSets.entries,
          entry(OWNER_A, "set-arrived-during-discard", "queued") as never,
        ].filter(
          (item) =>
            item.ownerId !== ownerId || item.clientKey !== clientKey,
        );
        return { ok: true };
      },
      discardOccurrenceMutation: () => ({ ok: true }),
      discardContextualNote: () => ({ ok: true }),
      discardLiveCoachMessage: () => ({ ok: true }),
      discardEquipmentSelection: () => ({ ok: true }),
    };

    const result = await discardSignOutDeviceWorkWithAdapter(OWNER_A, adapter);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("changed while"),
      snapshot: { ownerEntryCount: 1 },
    });
    expect(state.workoutSets.entries.map((item) => item.clientKey)).toEqual([
      "set-arrived-during-discard",
    ]);
  });

  it("re-reads after a partial discard failure and reports remaining truth", async () => {
    const events: string[] = [];
    const fixture = adapterFor(populatedSources(), events);
    fixture.adapter.discardOccurrenceMutation = () => ({
      ok: false,
      reason: "The workout-item copy changed.",
    });

    const result = await discardSignOutDeviceWorkWithAdapter(
      OWNER_A,
      fixture.adapter,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "The workout-item copy changed.",
      snapshot: { ownerEntryCount: 5 },
    });
    expect(fixture.reads()).toBe(2);
    expect(events).toEqual(["workout:set-a"]);
    expect(fixture.state.workoutSets.entries).toHaveLength(1);
    expect(fixture.state.workoutSets.entries[0].ownerId).toBe(OWNER_B);
  });
});
