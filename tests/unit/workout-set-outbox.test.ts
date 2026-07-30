import { describe, expect, it } from "vitest";
import {
  WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS,
  WORKOUT_SET_OUTBOX_MAX_ENTRIES,
  WORKOUT_SET_OUTBOX_STORAGE_KEY,
  discardQuarantinedWorkoutSetOutboxEntry,
  enqueueWorkoutSetOutboxEntry,
  markWorkoutSetNeedsAttention,
  markWorkoutSetTransientFailure,
  nextWorkoutSetOutboxEntry,
  parseWorkoutSetOutbox,
  readWorkoutSetOutbox,
  releaseQueuedWorkoutSetBackoffForOwner,
  removeWorkoutSetOutboxEntry,
  removeWorkoutSetOutboxEntriesForOwner,
  retryWorkoutSetOutboxEntry,
  type NewWorkoutSetOutboxEntry,
  type WorkoutSetOutboxStorage,
} from "@/lib/workout-set-outbox";

class MemoryStorage implements WorkoutSetOutboxStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function setInput(index: number): NewWorkoutSetOutboxEntry {
  return {
    clientKey: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ownerId: "20000000-0000-4000-8000-000000000001",
    sessionId: "30000000-0000-4000-8000-000000000001",
    sessionExerciseId: "40000000-0000-4000-8000-000000000001",
    exerciseName: "Bench Press",
    setNo: index,
    weight: 100 + index * 5,
    weightUnit: "lb",
    reps: 8,
    rpe: 8,
    note: index === 1 ? "First set" : null,
    equipmentSnapshotId: null,
    loadEntryMeaning: "legacy_unknown",
    createdAtISO: new Date(Date.UTC(2026, 6, 13, 12, 0, index)).toISOString(),
  };
}

describe("workout set device queue", () => {
  it("persists the complete set before delivery under one stable identity", () => {
    const storage = new MemoryStorage();
    const input = setInput(1);
    expect(enqueueWorkoutSetOutboxEntry(storage, input)).toMatchObject({
      ok: true,
      entry: {
        clientKey: input.clientKey,
        setNo: 1,
        weight: 105,
        status: "queued",
        attemptCount: 0,
      },
    });
    expect(readWorkoutSetOutbox(storage).entries).toEqual([
      expect.objectContaining(input),
    ]);

    expect(enqueueWorkoutSetOutboxEntry(storage, input)).toMatchObject({
      ok: true,
      entry: { clientKey: input.clientKey },
    });
    expect(readWorkoutSetOutbox(storage).entries).toHaveLength(1);
  });

  it("keeps acknowledged equipment evidence immutable with the queued command", () => {
    const storage = new MemoryStorage();
    const exact = {
      ...setInput(1),
      equipmentSnapshotId: "50000000-0000-4000-8000-000000000001",
      loadEntryMeaning: "total_system" as const,
    };
    expect(enqueueWorkoutSetOutboxEntry(storage, exact)).toMatchObject({
      ok: true,
      entry: {
        equipmentSnapshotId: exact.equipmentSnapshotId,
        loadEntryMeaning: "total_system",
      },
    });
    expect(enqueueWorkoutSetOutboxEntry(storage, {
      ...exact,
      loadEntryMeaning: "per_loading_point",
    })).toMatchObject({ ok: false, reason: expect.stringContaining("different") });
    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({
      equipmentSnapshotId: exact.equipmentSnapshotId,
      loadEntryMeaning: "total_system",
    });
  });

  it("rejects identity drift and a second queued identity for the same set number", () => {
    const storage = new MemoryStorage();
    const input = setInput(1);
    enqueueWorkoutSetOutboxEntry(storage, input);

    expect(
      enqueueWorkoutSetOutboxEntry(storage, { ...input, reps: 3 })
    ).toMatchObject({ ok: false, reason: expect.stringContaining("different") });
    expect(
      enqueueWorkoutSetOutboxEntry(storage, {
        ...input,
        clientKey: crypto.randomUUID(),
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already waiting"),
    });
    expect(readWorkoutSetOutbox(storage).entries[0]).toMatchObject({ reps: 8 });
  });

  it("never releases a later set before the earlier set is resolved", () => {
    const storage = new MemoryStorage();
    const first = setInput(1);
    const second = setInput(2);
    enqueueWorkoutSetOutboxEntry(storage, second);
    enqueueWorkoutSetOutboxEntry(storage, first);

    let entries = readWorkoutSetOutbox(storage).entries;
    expect(nextWorkoutSetOutboxEntry(entries, first.ownerId)?.clientKey).toBe(
      first.clientKey
    );

    markWorkoutSetNeedsAttention(storage, first.clientKey, "Rejected set");
    entries = readWorkoutSetOutbox(storage).entries;
    expect(nextWorkoutSetOutboxEntry(entries, first.ownerId)).toBeNull();

    retryWorkoutSetOutboxEntry(storage, first.clientKey);
    entries = readWorkoutSetOutbox(storage).entries;
    expect(nextWorkoutSetOutboxEntry(entries, first.ownerId)?.clientKey).toBe(
      first.clientKey
    );

    removeWorkoutSetOutboxEntry(storage, first.clientKey);
    entries = readWorkoutSetOutbox(storage).entries;
    expect(nextWorkoutSetOutboxEntry(entries, first.ownerId)?.clientKey).toBe(
      second.clientKey
    );
  });

  it("lets another exercise drain past a needs-attention head", () => {
    const storage = new MemoryStorage();
    const first = setInput(1);
    const sameExercise = setInput(2);
    const otherExercise = {
      ...setInput(3),
      sessionExerciseId: "40000000-0000-4000-8000-000000000002",
      setNo: 1,
    };
    enqueueWorkoutSetOutboxEntry(storage, first);
    enqueueWorkoutSetOutboxEntry(storage, sameExercise);
    enqueueWorkoutSetOutboxEntry(storage, otherExercise);
    markWorkoutSetNeedsAttention(storage, first.clientKey, "Review required");

    const entries = readWorkoutSetOutbox(storage).entries;
    expect(nextWorkoutSetOutboxEntry(entries, first.ownerId)?.clientKey).toBe(
      otherExercise.clientKey
    );
    expect(
      entries.find((entry) => entry.clientKey === sameExercise.clientKey)
    ).toMatchObject({ status: "queued" });
  });

  it("treats a delayed head like a per-exercise block", () => {
    const storage = new MemoryStorage();
    const first = setInput(1);
    const sameExercise = setInput(2);
    const otherExercise = {
      ...setInput(3),
      sessionExerciseId: "40000000-0000-4000-8000-000000000002",
      setNo: 1,
    };
    enqueueWorkoutSetOutboxEntry(storage, first);
    enqueueWorkoutSetOutboxEntry(storage, sameExercise);
    enqueueWorkoutSetOutboxEntry(storage, otherExercise);
    markWorkoutSetTransientFailure(
      storage,
      first.clientKey,
      "Temporary failure",
      new Date("2026-07-18T12:00:00.000Z")
    );

    const entries = readWorkoutSetOutbox(storage).entries;
    expect(
      nextWorkoutSetOutboxEntry(
        entries,
        first.ownerId,
        new Date("2026-07-18T12:00:00.500Z")
      )?.clientKey
    ).toBe(otherExercise.clientKey);
  });

  it("keeps strict order across three sets of one exercise", () => {
    const storage = new MemoryStorage();
    const sets = [setInput(3), setInput(1), setInput(2)];
    for (const entry of sets) enqueueWorkoutSetOutboxEntry(storage, entry);

    for (const expectedSetNo of [1, 2, 3]) {
      const entries = readWorkoutSetOutbox(storage).entries;
      const next = nextWorkoutSetOutboxEntry(entries, sets[0].ownerId);
      expect(next?.setNo).toBe(expectedSetNo);
      removeWorkoutSetOutboxEntry(storage, next!.clientKey);
    }
  });

  it("releases every queued owner backoff without retrying attention entries", () => {
    const storage = new MemoryStorage();
    const first = setInput(1);
    const second = {
      ...setInput(2),
      sessionExerciseId: "40000000-0000-4000-8000-000000000002",
      setNo: 1,
    };
    const attention = {
      ...setInput(3),
      sessionExerciseId: "40000000-0000-4000-8000-000000000003",
      setNo: 1,
    };
    for (const entry of [first, second, attention]) {
      enqueueWorkoutSetOutboxEntry(storage, entry);
    }
    markWorkoutSetTransientFailure(storage, first.clientKey, "Temporary");
    markWorkoutSetTransientFailure(storage, second.clientKey, "Temporary");
    markWorkoutSetNeedsAttention(storage, attention.clientKey, "Review");

    expect(releaseQueuedWorkoutSetBackoffForOwner(storage, first.ownerId).ok).toBe(
      true
    );
    const entries = readWorkoutSetOutbox(storage).entries;
    expect(
      entries.filter((entry) => entry.status === "queued")
    ).toEqual([
      expect.objectContaining({ nextAttemptAtISO: null, attemptCount: 1 }),
      expect.objectContaining({ nextAttemptAtISO: null, attemptCount: 1 }),
    ]);
    expect(entries.find((entry) => entry.clientKey === attention.clientKey)).toMatchObject({
      status: "needs_attention",
      attemptCount: 1,
    });
  });

  it("backs off connection failures and leaves every later set recoverable", () => {
    const storage = new MemoryStorage();
    const first = setInput(1);
    const second = setInput(2);
    enqueueWorkoutSetOutboxEntry(storage, first);
    enqueueWorkoutSetOutboxEntry(storage, second);

    for (
      let attempt = 1;
      attempt <= WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS;
      attempt += 1
    ) {
      markWorkoutSetTransientFailure(
        storage,
        first.clientKey,
        "Connection unavailable",
        new Date(Date.UTC(2026, 6, 13, 12, 0, attempt))
      );
    }
    const entries = readWorkoutSetOutbox(storage).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      clientKey: first.clientKey,
      status: "needs_attention",
      attemptCount: WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS,
    });
    expect(entries[1]).toMatchObject({
      clientKey: second.clientKey,
      status: "queued",
      attemptCount: 0,
    });
  });

  it("keeps another account's recovery copies when one owner discards", () => {
    const storage = new MemoryStorage();
    const first = setInput(1);
    const second = {
      ...setInput(2),
      ownerId: "20000000-0000-4000-8000-000000000002",
    };
    enqueueWorkoutSetOutboxEntry(storage, first);
    enqueueWorkoutSetOutboxEntry(storage, second);

    expect(removeWorkoutSetOutboxEntriesForOwner(storage, first.ownerId).ok).toBe(
      true
    );
    const remaining = readWorkoutSetOutbox(storage).entries;
    expect(remaining).toEqual([
      expect.objectContaining({ ownerId: second.ownerId }),
    ]);
    expect(nextWorkoutSetOutboxEntry(remaining, first.ownerId)).toBeNull();
    expect(nextWorkoutSetOutboxEntry(remaining, second.ownerId)?.clientKey).toBe(
      second.clientKey
    );
  });

  it("leaves an unreadable device copy untouched", () => {
    const storage = new MemoryStorage();
    storage.setItem(WORKOUT_SET_OUTBOX_STORAGE_KEY, "{not-json");
    expect(parseWorkoutSetOutbox("{not-json")).toMatchObject({
      entries: [],
      error: expect.stringContaining("left unchanged"),
    });
    expect(enqueueWorkoutSetOutboxEntry(storage, setInput(1))).toMatchObject({
      ok: false,
    });
    expect(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY)).toBe("{not-json");
  });

  it("migrates a valid version-one set to explicit legacy evidence without losing it", () => {
    const current = {
      ...setInput(1),
      status: "queued" as const,
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    };
    const {
      equipmentSnapshotId: _equipmentSnapshotId,
      loadEntryMeaning: _loadEntryMeaning,
      ...versionOne
    } = current;
    void _equipmentSnapshotId;
    void _loadEntryMeaning;
    const storage = new MemoryStorage();
    storage.setItem(
      WORKOUT_SET_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [versionOne] }),
    );

    expect(readWorkoutSetOutbox(storage)).toMatchObject({
      entries: [{
        ...versionOne,
        equipmentSnapshotId: null,
        loadEntryMeaning: "legacy_unknown",
      }],
      quarantined: [],
      error: null,
    });

    markWorkoutSetTransientFailure(storage, current.clientKey, "Offline");
    const persisted = JSON.parse(
      storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY) ?? "null",
    );
    expect(persisted).toMatchObject({
      version: 3,
      entries: [expect.objectContaining({
        clientKey: current.clientKey,
        equipmentSnapshotId: null,
        loadEntryMeaning: "legacy_unknown",
      })],
    });
  });

  it("keeps version-two retries but leaves their observed completion unknown", () => {
    const retained = {
      ...setInput(1),
      status: "queued" as const,
      attemptCount: 1,
      nextAttemptAtISO: null,
      lastAttemptAtISO: "2026-07-13T12:01:00.000Z",
      lastError: "Offline",
    };
    expect(parseWorkoutSetOutbox(JSON.stringify({
      version: 2,
      entries: [retained],
    }))).toMatchObject({
      entries: [{
        ...retained,
        observedCompletedAtISO: null,
      }],
      quarantined: [],
      error: null,
    });
  });

  it("drains valid sets while preserving a corrupt entry through later writes", () => {
    const storage = new MemoryStorage();
    const first = {
      ...setInput(1),
      status: "queued",
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    };
    const corrupt = { clientKey: "not-a-uuid", untouched: { value: 7 } };
    storage.setItem(
      WORKOUT_SET_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [first, corrupt] })
    );

    const snapshot = readWorkoutSetOutbox(storage);
    expect(snapshot.entries).toEqual([
      { ...first, observedCompletedAtISO: null },
    ]);
    expect(snapshot.quarantined).toEqual([
      expect.objectContaining({ quarantineKey: "entries:1", raw: corrupt }),
    ]);
    expect(nextWorkoutSetOutboxEntry(snapshot.entries, first.ownerId)).toEqual({
      ...first,
      observedCompletedAtISO: null,
    });

    markWorkoutSetTransientFailure(
      storage,
      first.clientKey,
      "Connection unavailable",
      new Date("2026-07-13T12:01:00.000Z")
    );
    const afterWrite = readWorkoutSetOutbox(storage);
    expect(afterWrite.entries[0]).toMatchObject({ attemptCount: 1 });
    expect(afterWrite.quarantined).toEqual([
      expect.objectContaining({ raw: corrupt }),
    ]);
    expect(
      JSON.parse(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY) ?? "null").entries
    ).toContainEqual(
      expect.objectContaining({
        quarantine: "workout-set-outbox-entry-v1",
        raw: corrupt,
      })
    );
  });

  it("keeps the first set and quarantines only a later duplicate slot", () => {
    const first = {
      ...setInput(1),
      status: "queued",
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    };
    const later = {
      ...first,
      clientKey: "10000000-0000-4000-8000-000000000099",
      reps: 5,
    };

    const snapshot = parseWorkoutSetOutbox(
      JSON.stringify({ version: 1, entries: [first, later] })
    );
    expect(snapshot.entries).toEqual([
      { ...first, observedCompletedAtISO: null },
    ]);
    expect(snapshot.quarantined).toEqual([
      expect.objectContaining({
        quarantineKey: "entries:1",
        raw: later,
        reason: expect.stringContaining("set number"),
      }),
    ]);

    const storage = new MemoryStorage();
    storage.setItem(
      WORKOUT_SET_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [first, later] })
    );
    expect(removeWorkoutSetOutboxEntry(storage, first.clientKey).ok).toBe(true);
    const afterFirstIsRemoved = readWorkoutSetOutbox(storage);
    expect(afterFirstIsRemoved.entries).toEqual([]);
    expect(afterFirstIsRemoved.quarantined).toEqual([
      expect.objectContaining({ raw: later }),
    ]);
  });

  it("quarantines the later duplicate identity even when its set number differs", () => {
    const first = {
      ...setInput(1),
      status: "queued",
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    };
    const later = { ...first, setNo: 2 };
    const snapshot = parseWorkoutSetOutbox(
      JSON.stringify({ version: 1, entries: [first, later] })
    );
    expect(snapshot.entries).toEqual([
      { ...first, observedCompletedAtISO: null },
    ]);
    expect(snapshot.quarantined).toEqual([
      expect.objectContaining({
        raw: later,
        reason: expect.stringContaining("identity"),
      }),
    ]);
  });

  it("explicitly discards only the selected quarantined entry", () => {
    const storage = new MemoryStorage();
    const valid = {
      ...setInput(1),
      status: "queued",
      attemptCount: 0,
      nextAttemptAtISO: null,
      lastAttemptAtISO: null,
      lastError: null,
    };
    const firstCorrupt = { marker: "first-corrupt" };
    const secondCorrupt = { marker: "second-corrupt" };
    storage.setItem(
      WORKOUT_SET_OUTBOX_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: [firstCorrupt, valid, secondCorrupt],
      })
    );

    expect(
      discardQuarantinedWorkoutSetOutboxEntry(
        storage,
        "entries:0",
        firstCorrupt
      )
    ).toMatchObject({ ok: true });
    const snapshot = readWorkoutSetOutbox(storage);
    expect(snapshot.entries).toEqual([
      { ...valid, observedCompletedAtISO: null },
    ]);
    expect(snapshot.quarantined).toEqual([
      expect.objectContaining({ raw: secondCorrupt }),
    ]);
    expect(
      JSON.parse(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY) ?? "null")
    ).toEqual({
      version: 3,
      entries: [
        { ...valid, observedCompletedAtISO: null },
        {
          quarantine: "workout-set-outbox-entry-v1",
          raw: secondCorrupt,
          reason: "This saved workout set is incomplete or invalid.",
        },
      ],
    });
  });

  it("fails closed when a quarantined entry changes before discard", () => {
    const storage = new MemoryStorage();
    const original = { marker: "original" };
    storage.setItem(
      WORKOUT_SET_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [original] })
    );
    const snapshot = readWorkoutSetOutbox(storage);
    const replacement = { marker: "replacement" };
    const replacementRaw = JSON.stringify({ version: 1, entries: [replacement] });
    storage.setItem(WORKOUT_SET_OUTBOX_STORAGE_KEY, replacementRaw);

    expect(
      discardQuarantinedWorkoutSetOutboxEntry(
        storage,
        snapshot.quarantined[0].quarantineKey,
        snapshot.quarantined[0].raw
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
    expect(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY)).toBe(replacementRaw);
  });

  it("counts quarantined entries toward the device queue limit", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      WORKOUT_SET_OUTBOX_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: Array.from(
          { length: WORKOUT_SET_OUTBOX_MAX_ENTRIES },
          (_, index) => ({ corrupt: index })
        ),
      })
    );
    expect(enqueueWorkoutSetOutboxEntry(storage, setInput(1))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("full"),
    });
  });

  it("never trusts a stored quarantine reason as text for the interface", () => {
    const storage = new MemoryStorage();
    const hostileReason = "Private note that must never be rendered";
    const forgedWrapper = {
      quarantine: "workout-set-outbox-entry-v1",
      raw: { marker: "preserve-me" },
      reason: hostileReason,
    };
    storage.setItem(
      WORKOUT_SET_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [forgedWrapper] })
    );

    const snapshot = readWorkoutSetOutbox(storage);
    expect(snapshot.quarantined).toEqual([
      {
        quarantineKey: "entries:0",
        raw: forgedWrapper,
        reason: "This saved workout set is incomplete or invalid.",
      },
    ]);
    expect(snapshot.quarantined[0]?.reason).not.toContain(hostileReason);

    expect(enqueueWorkoutSetOutboxEntry(storage, setInput(1)).ok).toBe(true);
    expect(readWorkoutSetOutbox(storage).quarantined[0]).toMatchObject({
      raw: forgedWrapper,
      reason: "This saved workout set is incomplete or invalid.",
    });
  });

  it("makes a quarantine rewrite fail closed for an older whole-envelope writer", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      WORKOUT_SET_OUTBOX_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [{ marker: "preserve-me" }] })
    );
    expect(enqueueWorkoutSetOutboxEntry(storage, setInput(1)).ok).toBe(true);
    const rewritten = storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY);

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
      storage.setItem(WORKOUT_SET_OUTBOX_STORAGE_KEY, "legacy-writer-mutated");
    }

    expect(acceptedByLegacyWholeEnvelopeParser).toBe(false);
    expect(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY)).toBe(rewritten);
  });
});
