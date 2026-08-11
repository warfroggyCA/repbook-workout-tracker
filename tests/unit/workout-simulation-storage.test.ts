import { describe, expect, it } from "vitest";
import {
  SIMULATION_MAX_FEEDBACK,
  SIMULATION_MAX_OCCURRENCES,
  SIMULATION_MAX_SETS,
  SIMULATION_NOTE_MAX_LENGTH,
  createSimulationWorkspace,
  simulationWorkspaceSchema,
  startSimulationWorkout,
  type SimulationSourceSnapshot,
  type SimulationWorkspace,
} from "@/lib/workout-simulation";
import {
  SIMULATION_MAX_SERIALIZED_BYTES,
  SIMULATION_MAX_WORKSPACES_PER_OWNER,
  SIMULATION_RETENTION_MS,
  SIMULATION_STORAGE_PREFIX,
  listSimulationWorkspaces,
  readSimulationWorkspace,
  resetSimulationWorkspace,
  simulationStorageKey,
  updateStoredSimulationWorkspace,
  writeSimulationWorkspace,
  type SimulationStorage,
} from "@/lib/workout-simulation-storage";

class MemoryStorage implements SimulationStorage {
  values = new Map<string, string>();
  failReads = false;
  failWrites = false;
  failRemoves = false;
  ignoreRemoves = false;

  get length() {
    return this.values.size;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string) {
    if (this.failReads) throw new Error("unavailable");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("full");
    this.values.set(key, value);
  }

  removeItem(key: string) {
    if (this.failRemoves) throw new Error("unavailable");
    if (!this.ignoreRemoves) this.values.delete(key);
  }
}

function source(
  ownerId = "20000000-0000-4000-8000-000000000001",
): SimulationSourceSnapshot {
  return {
    schemaVersion: 1,
    ownerId,
    sourceDigest: "digest",
    capturedAtISO: "2026-07-22T12:00:00.000Z",
    unit: "lb",
    program: { id: "program", versionId: "version", versionNo: 1, name: "Program" },
    days: [
      {
        id: "day",
        name: "Day",
        orderIdx: 0,
        warmups: [],
        groups: [],
        exercises: [
          {
            id: "slot",
            exerciseId: "exercise",
            name: "Exercise",
            orderIdx: 0,
            groupId: null,
            groupMemberOrderIdx: null,
            sets: 1,
            repsMin: 8,
            repsMax: 10,
            targetLoad: 20,
            targetLoadUnit: "lb",
            restSec: 60,
            note: null,
            warmups: [],
            alternatives: [],
            equipmentOptions: [],
            painGuidance: [],
            loadType: "dumbbell",
            equipmentFit: {
              semanticsVersion: 1,
              status: "compatible",
              reason: "Synthetic owner-reviewed compatible fit.",
              equipmentItemIds: ["synthetic-item"],
            },
          },
        ],
      },
    ],
  };
}

function workspace(
  suffix = "one",
  ownerId = source().ownerId,
  nowISO = "2026-07-22T12:01:00.000Z",
) {
  return createSimulationWorkspace(source(ownerId), {
    createId: () => suffix,
    nowISO,
  });
}

describe("workout simulation storage", () => {
  it("pins the exact privacy, retention, count, and model bounds", () => {
    expect(SIMULATION_STORAGE_PREFIX).toBe("workout-tracker:simulation:v1:");
    expect(SIMULATION_MAX_WORKSPACES_PER_OWNER).toBe(3);
    expect(SIMULATION_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(SIMULATION_MAX_SERIALIZED_BYTES).toBe(1_000_000);
    expect(SIMULATION_MAX_OCCURRENCES).toBe(2_000);
    expect(SIMULATION_MAX_SETS).toBe(1_000);
    expect(SIMULATION_MAX_FEEDBACK).toBe(100);
    expect(SIMULATION_NOTE_MAX_LENGTH).toBe(500);
  });

  it("enforces the occurrence, set, feedback, and note bounds in stored envelopes", () => {
    let value = 0;
    const active = startSimulationWorkout(workspace(), 0, {
      createId: () => String(++value),
      nowISO: "2026-07-22T12:02:00.000Z",
    });
    const workout = active.activeWorkout!;
    const occurrence = workout.occurrences[0];
    const set = {
      id: "sim_set_bound",
      occurrenceId: occurrence.id,
      simulationExerciseId: workout.exercises[0].id,
      reps: 8,
      load: 20,
      loadUnit: "lb" as const,
      rpe: 7,
      note: null,
      revision: 0,
      createdAtISO: "2026-07-22T12:03:00.000Z",
      updatedAtISO: "2026-07-22T12:03:00.000Z",
    };
    const feedback = {
      id: "sim_feedback_bound",
      contextKind: "screen" as const,
      contextKey: "runner",
      screenLabel: null,
      note: "Retained locally",
      createdAtISO: "2026-07-22T12:03:00.000Z",
    };

    expect(
      simulationWorkspaceSchema.safeParse({
        ...active,
        activeWorkout: {
          ...workout,
          occurrences: Array.from({ length: SIMULATION_MAX_OCCURRENCES }, () => occurrence),
          sets: Array.from({ length: SIMULATION_MAX_SETS }, () => set),
        },
        feedback: Array.from({ length: SIMULATION_MAX_FEEDBACK }, () => feedback),
      }).success,
    ).toBe(true);
    expect(
      simulationWorkspaceSchema.safeParse({
        ...active,
        activeWorkout: {
          ...workout,
          occurrences: Array.from(
            { length: SIMULATION_MAX_OCCURRENCES + 1 },
            () => occurrence,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      simulationWorkspaceSchema.safeParse({
        ...active,
        activeWorkout: {
          ...workout,
          sets: Array.from({ length: SIMULATION_MAX_SETS + 1 }, () => set),
        },
      }).success,
    ).toBe(false);
    expect(
      simulationWorkspaceSchema.safeParse({
        ...active,
        feedback: Array.from({ length: SIMULATION_MAX_FEEDBACK + 1 }, () => feedback),
      }).success,
    ).toBe(false);
    expect(
      simulationWorkspaceSchema.safeParse({
        ...active,
        activeWorkout: {
          ...workout,
          occurrences: [
            { ...occurrence, plannedNote: "n".repeat(SIMULATION_NOTE_MAX_LENGTH + 1) },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("round-trips only for the owning account and never lists another owner's copy", () => {
    const storage = new MemoryStorage();
    const first = workspace();
    const other = workspace("other", "30000000-0000-4000-8000-000000000001");
    expect(writeSimulationWorkspace(storage, first)).toEqual({ ok: true });
    expect(writeSimulationWorkspace(storage, other)).toEqual({ ok: true });
    expect(
      readSimulationWorkspace(storage, first.ownerId, first.simulationId).workspace,
    ).toEqual(first);
    expect(
      readSimulationWorkspace(storage, other.ownerId, first.simulationId),
    ).toEqual({ workspace: null, error: "missing" });
    expect(
      listSimulationWorkspaces(
        storage,
        first.ownerId,
        new Date("2026-07-23T00:00:00.000Z").getTime(),
      ),
    ).toEqual([first]);
    expect(storage.getItem(simulationStorageKey(other.ownerId, other.simulationId))).not.toBeNull();
  });

  it("quarantines malformed and mismatched copies without returning their raw content", () => {
    const storage = new MemoryStorage();
    const ownerId = source().ownerId;
    const malformedId = "sim_workspace_malformed";
    const malformedKey = simulationStorageKey(ownerId, malformedId);
    storage.setItem(malformedKey, '{"private":"do not show"}');
    const malformed = readSimulationWorkspace(storage, ownerId, malformedId);
    expect(malformed).toEqual({ workspace: null, error: "malformed" });
    expect(JSON.stringify(malformed)).not.toContain("do not show");
    expect(storage.getItem(malformedKey)).toBeNull();

    const wrongOwnerId = "sim_workspace_wrong_owner";
    const wrongOwnerKey = simulationStorageKey(ownerId, wrongOwnerId);
    const wrongOwner = {
      ...workspace("wrong_owner", "30000000-0000-4000-8000-000000000001"),
      simulationId: wrongOwnerId,
    };
    storage.setItem(wrongOwnerKey, JSON.stringify(wrongOwner));
    expect(readSimulationWorkspace(storage, ownerId, wrongOwnerId)).toEqual({
      workspace: null,
      error: "wrong_owner",
    });
    expect(storage.getItem(wrongOwnerKey)).toBeNull();

    const wrongIdentityKey = simulationStorageKey(ownerId, "sim_workspace_expected");
    storage.setItem(wrongIdentityKey, JSON.stringify(workspace("different")));
    expect(readSimulationWorkspace(storage, ownerId, "sim_workspace_expected")).toEqual({
      workspace: null,
      error: "wrong_identity",
    });
    expect(storage.getItem(wrongIdentityKey)).toBeNull();
  });

  it("refuses but preserves a future-version copy for an app that understands it", () => {
    const storage = new MemoryStorage();
    const value = workspace("future");
    const key = simulationStorageKey(value.ownerId, value.simulationId);
    const raw = JSON.stringify({ ...value, version: 2, private: "never return this" });
    storage.setItem(key, raw);
    const result = readSimulationWorkspace(storage, value.ownerId, value.simulationId);
    expect(result).toEqual({ workspace: null, error: "future_version" });
    expect(JSON.stringify(result)).not.toContain("never return this");
    expect(storage.getItem(key)).toBe(raw);
    expect(listSimulationWorkspaces(storage, value.ownerId)).toEqual([]);
    expect(storage.getItem(key)).toBe(raw);
  });

  it("retains the exact 30-day boundary and deletes an expired copy", () => {
    const storage = new MemoryStorage();
    const updatedAtISO = "2026-06-22T12:00:00.000Z";
    const value = {
      ...workspace("retained", source().ownerId, updatedAtISO),
      status: "completed" as const,
    };
    const key = simulationStorageKey(value.ownerId, value.simulationId);
    expect(writeSimulationWorkspace(storage, value)).toEqual({ ok: true });
    const boundary = Date.parse(updatedAtISO) + SIMULATION_RETENTION_MS;
    expect(listSimulationWorkspaces(storage, value.ownerId, boundary)).toEqual([value]);
    expect(storage.getItem(key)).not.toBeNull();
    expect(listSimulationWorkspaces(storage, value.ownerId, boundary + 1)).toEqual([]);
    expect(storage.getItem(key)).toBeNull();
  });

  it("keeps at most three owner workspaces and deletes any older excess copy", () => {
    const storage = new MemoryStorage();
    const ownerId = source().ownerId;
    const values = ["one", "two", "three", "four"].map((suffix, index) =>
      workspace(
        suffix,
        ownerId,
        new Date(Date.UTC(2026, 6, 22, 12, index)).toISOString(),
      ),
    );
    for (const value of values) {
      storage.values.set(
        simulationStorageKey(value.ownerId, value.simulationId),
        JSON.stringify(value),
      );
    }

    expect(
      listSimulationWorkspaces(storage, ownerId, Date.parse("2026-07-23T00:00:00.000Z")),
    ).toEqual([values[3], values[2], values[1]]);
    expect(storage.getItem(simulationStorageKey(ownerId, values[0].simulationId))).toBeNull();

    const fifth = workspace("five", ownerId, "2026-07-22T13:00:00.000Z");
    expect(writeSimulationWorkspace(storage, fifth)).toEqual({ ok: false, reason: "limit" });
  });

  it("does not advance on storage failure and refuses stale revisions, including a synchronous race", () => {
    const storage = new MemoryStorage();
    const original = workspace();
    const key = simulationStorageKey(original.ownerId, original.simulationId);
    expect(writeSimulationWorkspace(storage, original)).toEqual({ ok: true });

    storage.failWrites = true;
    const failed = updateStoredSimulationWorkspace(
      storage,
      original.ownerId,
      original.simulationId,
      original.revision,
      (current) => ({ ...current, updatedAtISO: "2026-07-22T12:02:00.000Z" }),
    );
    expect(failed).toEqual({ ok: false, reason: "storage_error" });
    storage.failWrites = false;
    expect(readSimulationWorkspace(storage, original.ownerId, original.simulationId).workspace).toEqual(
      original,
    );

    const newer: SimulationWorkspace = {
      ...original,
      revision: original.revision + 1,
      updatedAtISO: "2026-07-22T12:03:00.000Z",
    };
    const raced = updateStoredSimulationWorkspace(
      storage,
      original.ownerId,
      original.simulationId,
      original.revision,
      (current) => {
        storage.values.set(key, JSON.stringify(newer));
        return { ...current, updatedAtISO: "2026-07-22T12:04:00.000Z" };
      },
    );
    expect(raced).toEqual({ ok: false, reason: "stale" });
    expect(readSimulationWorkspace(storage, original.ownerId, original.simulationId).workspace).toEqual(
      newer,
    );
    expect(
      updateStoredSimulationWorkspace(
        storage,
        original.ownerId,
        original.simulationId,
        original.revision,
        (current) => current,
      ),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("distinguishes unavailable storage and verifies reset actually removed only the exact key", () => {
    const storage = new MemoryStorage();
    const value = workspace();
    const key = simulationStorageKey(value.ownerId, value.simulationId);
    storage.setItem(key, JSON.stringify(value));
    storage.setItem("workout-tracker:workout-set-outbox:v1", "keep-live");

    storage.failReads = true;
    expect(readSimulationWorkspace(storage, value.ownerId, value.simulationId)).toEqual({
      workspace: null,
      error: "storage_error",
    });
    storage.failReads = false;

    storage.ignoreRemoves = true;
    expect(resetSimulationWorkspace(storage, value.ownerId, value.simulationId)).toEqual({
      ok: false,
      reason: "storage_error",
    });
    expect(storage.getItem(key)).not.toBeNull();

    storage.ignoreRemoves = false;
    expect(resetSimulationWorkspace(storage, value.ownerId, value.simulationId)).toEqual({
      ok: true,
    });
    expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem("workout-tracker:workout-set-outbox:v1")).toBe("keep-live");
  });
});
