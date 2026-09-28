import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueOccurrenceMutation,
  enqueueOccurrenceMutationOutboxEntry,
  readOccurrenceMutationOutbox,
  type NewOccurrenceMutationOutboxEntry,
} from "@/lib/occurrence-mutation-outbox";
import {
  enqueueWorkoutSetOutboxEntry,
  type NewWorkoutSetOutboxEntry,
} from "@/lib/workout-set-outbox";
import {
  enqueueContextualNote,
  readContextualNoteOutbox,
  type NewContextualNoteOutboxEntry,
} from "@/lib/contextual-note-outbox";
import {
  enqueueLiveCoachMessage,
  readLiveCoachOutbox,
} from "@/lib/live-coach-outbox";
import { deploymentRecoveryRequired } from "@/lib/deployment-recovery";
const actions = vi.hoisted(() => ({
  logSet: vi.fn(),
  mutateOccurrence: vi.fn(),
  stream: vi.fn(),
}));
vi.mock("@/app/actions/sessions", () => ({
  logSet: actions.logSet,
  mutateOccurrence: actions.mutateOccurrence,
}));
vi.mock("@/app/actions/contextual-notes", () => ({
  createContextualNoteAction: vi.fn(),
}));
vi.mock("@/lib/live-coach-client", () => ({
  publishLiveCoachClientEvent: vi.fn(),
  streamLiveCoachResponse: actions.stream,
}));
import { syncNextEntry } from "@/components/session/workout-set-outbox-sync";
import { syncNextOccurrenceMutation } from "@/components/session/occurrence-mutation-outbox-sync";
import { syncContextualNoteEntry } from "@/components/contextual-notes/contextual-note-outbox-sync";
import { syncLiveCoachEntry } from "@/components/session/live-coach-outbox-sync";

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1),
  session = id(2);
class MemoryStorage {
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function occurrence(n = 10): NewOccurrenceMutationOutboxEntry {
  return {
    clientKey: id(n),
    ownerId: owner,
    sessionId: session,
    occurrenceId: id(3),
    label: "Synthetic warm-up",
    expectedRevision: 0,
    operation: "skip",
    reason: "user_skipped",
    note: null,
    createdAtISO: new Date(n * 1000).toISOString(),
  };
}
function set(): NewWorkoutSetOutboxEntry {
  return {
    clientKey: id(9),
    ownerId: owner,
    sessionId: session,
    sessionExerciseId: id(4),
    performedExerciseId: id(5),
    performedSemanticsVersion: 1,
    performedLoadType: "barbell",
    performedLoadSemantics: "total",
    workoutName: "Synthetic workout",
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
    createdAtISO: new Date(9000).toISOString(),
  };
}
function note(n = 20): NewContextualNoteOutboxEntry {
  return {
    clientKey: id(n),
    ownerId: owner,
    createdAtISO: new Date(n * 1000).toISOString(),
    payload: {
      clientKey: id(n),
      body: "Synthetic observation",
      coachVisible: true,
      inputMode: "typed",
      recordedAt: new Date(n * 1000).toISOString(),
      attachmentKind: "general",
      capturedContext: {
        schemaVersion: 1,
        destination: "today",
        workflow: null,
        workoutPhase: null,
        originatedFromSimulation: false,
        programDay: null,
        plannedExercise: null,
        performedExercise: null,
        occurrence: null,
        loadRepetitions: null,
        restContext: null,
        reviewContext: null,
      },
    },
  };
}
let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { localStorage: storage }),
  );
  vi.stubGlobal("navigator", {
    onLine: true,
    locks: {
      request: (key: string, _options: unknown, task: () => unknown) => {
        const result = (tails.get(key) ?? Promise.resolve()).then(task);
        tails.set(
          key,
          result.catch(() => {}),
        );
        return result;
      },
    },
  });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      postMessage() {}
      close() {}
      addEventListener() {}
    },
  );
  actions.logSet.mockReset();
  actions.mutateOccurrence.mockReset();
  actions.stream.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mixed command transports", () => {
  it("holds a later skip until the earlier set is acknowledged, including competing callers", async () => {
    expect(enqueueWorkoutSetOutboxEntry(storage, set()).ok).toBe(true);
    expect(enqueueOccurrenceMutationOutboxEntry(storage, occurrence()).ok).toBe(
      true,
    );
    const saved = deferred<unknown>();
    actions.logSet.mockReturnValue(saved.promise);
    actions.mutateOccurrence.mockResolvedValue({
      outcome: "saved",
      occurrence: {},
    });
    const setDelivery = syncNextEntry(owner);
    await vi.waitFor(() => expect(actions.logSet).toHaveBeenCalledOnce());
    const skipDelivery = syncNextOccurrenceMutation(owner);
    await Promise.resolve();
    expect(actions.mutateOccurrence).not.toHaveBeenCalled();
    saved.resolve({
      outcome: "saved",
      setId: id(6),
      occurrenceId: id(7),
      occurrenceRevision: 1,
    });
    await Promise.all([setDelivery, skipDelivery]);
    expect(actions.mutateOccurrence).toHaveBeenCalledOnce();
    expect(readOccurrenceMutationOutbox(storage).entries).toEqual([]);
  });
  it("can retain another occurrence while a save is waiting, without reusing its timestamp", async () => {
    expect((await enqueueOccurrenceMutation(occurrence())).ok).toBe(true);
    const saved = deferred<unknown>();
    actions.mutateOccurrence.mockReturnValue(saved.promise);
    const delivery = syncNextOccurrenceMutation(owner);
    await vi.waitFor(() =>
      expect(actions.mutateOccurrence).toHaveBeenCalledOnce(),
    );
    const second = await enqueueOccurrenceMutation(occurrence(11));
    expect(second.ok).toBe(true);
    expect(readOccurrenceMutationOutbox(storage).entries).toHaveLength(2);
    const [first, later] = readOccurrenceMutationOutbox(storage).entries;
    expect(Date.parse(later.createdAtISO)).toBeGreaterThan(
      Date.parse(first.createdAtISO),
    );
    saved.resolve({ outcome: "saved", occurrence: {} });
    await delivery;
    expect(
      readOccurrenceMutationOutbox(storage).entries.map(
        (entry) => entry.clientKey,
      ),
    ).toEqual([id(11)]);
  });
  it("retains another note while a note acknowledgement is delayed", async () => {
    await enqueueContextualNote(note());
    const original = readContextualNoteOutbox(storage, owner).entries[0];
    const saved = deferred<unknown>();
    const save = vi.fn(() => saved.promise);
    const delivery = syncContextualNoteEntry(owner, original, save);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect((await enqueueContextualNote(note(21))).ok).toBe(true);
    saved.resolve({
      ok: true,
      clientKey: original.clientKey,
      payloadHash: original.payloadHash,
    });
    await delivery;
    expect(
      readContextualNoteOutbox(storage, owner).entries.map(
        (entry) => entry.clientKey,
      ),
    ).toEqual([id(21)]);
  });
  it("releases delivery after saving a Coach question while its optional AI response is still streaming", async () => {
    const input = {
      clientKey: id(30),
      ownerId: owner,
      sessionId: session,
      sessionExerciseId: id(4),
      exerciseName: "Synthetic exercise",
      completedSetId: null,
      messageKind: "question" as const,
      inputMode: "text" as const,
      content: "Synthetic question",
      activeRestTimerSeconds: 60,
      createdAtISO: new Date(1000).toISOString(),
    };
    await enqueueLiveCoachMessage(input);
    const message = {
      ...input,
      id: id(31),
      author: "user",
      responseStatus: "saved",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            userMessage: message,
            pendingResponse: {
              id: id(32),
              sessionId: session,
              author: "assistant",
              responseStatus: "pending",
            },
          }),
        ),
      ),
    );
    const streaming = deferred<void>();
    actions.stream.mockReturnValue(streaming.promise);
    await syncLiveCoachEntry(
      owner,
      readLiveCoachOutbox(storage).entries[0],
      vi.fn(),
    );
    expect(actions.stream).toHaveBeenCalledOnce();
    enqueueOccurrenceMutationOutboxEntry(storage, occurrence());
    actions.mutateOccurrence.mockResolvedValue({
      outcome: "saved",
      occurrence: {},
    });
    await syncNextOccurrenceMutation(owner);
    expect(actions.mutateOccurrence).toHaveBeenCalledOnce();
    streaming.resolve();
  });
  it("pauses the entire document after an uncertain note timeout and retains its stable identity", async () => {
    await enqueueContextualNote(note());
    const original = readContextualNoteOutbox(storage, owner).entries[0];
    vi.useFakeTimers();
    const save = vi.fn(() => new Promise<never>(() => {}));
    const delivery = syncContextualNoteEntry(owner, original, save);
    await vi.advanceTimersByTimeAsync(15_001);
    await delivery;
    expect(deploymentRecoveryRequired()).toBe(true);
    expect(readContextualNoteOutbox(storage, owner).entries[0].clientKey).toBe(
      original.clientKey,
    );
    enqueueOccurrenceMutationOutboxEntry(storage, occurrence());
    await syncNextOccurrenceMutation(owner);
    expect(actions.mutateOccurrence).not.toHaveBeenCalled();
  });
});
