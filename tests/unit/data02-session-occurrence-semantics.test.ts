import { describe, expect, it } from "vitest";

import {
  abandonPendingOccurrences,
  applyOccurrenceMutation,
  countPerformedWorkingSets,
  type SessionOccurrence,
} from "@/lib/session-occurrences";

type OccurrenceOverrides = Partial<SessionOccurrence> &
  Pick<SessionOccurrence, "id">;

function occurrence(
  overrides: OccurrenceOverrides,
): SessionOccurrence {
  return {
    sessionId: "session-data-02",
    sessionExerciseId: "session-exercise-data-02",
    kind: "working_set",
    origin: "planned",
    sequenceIdx: 1,
    kindOrdinal: 1,
    label: null,
    plannedExerciseId: "exercise-planned",
    plannedRepsMin: 8,
    plannedRepsMax: 10,
    plannedLoad: 100,
    plannedLoadUnit: "lb",
    plannedLoadPercent: null,
    plannedLoadText: null,
    plannedRestSec: 90,
    plannedNote: null,
    groupSnapshotId: null,
    groupRound: null,
    groupMemberOrderIdx: null,
    outcome: "pending",
    outcomeReason: null,
    outcomeNote: null,
    revision: 1,
    resolvedAt: null,
    createdAt: "2026-07-21T12:00:00.000Z",
    completedSetId: null,
    ...overrides,
  };
}

describe("DATA-02 durable workout occurrence semantics", () => {
  it("keeps a completed zero-rep attempt completed and counts it as performed work", () => {
    const completed = applyOccurrenceMutation(
      { occurrence: occurrence({ id: "occurrence-zero-reps" }), receipts: [] },
      {
        clientKey: "complete-zero-reps-key",
        operation: "complete",
        expectedRevision: 1,
        completedSet: {
          id: "completed-set-zero-reps",
          performedExerciseId: "exercise-planned",
          reps: 0,
          load: 100,
          loadUnit: "lb",
        },
        resolvedAt: "2026-07-21T12:00:00.000Z",
      },
    );

    expect(completed.status).toBe("saved");
    expect(completed.occurrence).toMatchObject({
      outcome: "completed",
      completedSetId: "completed-set-zero-reps",
    });
    expect(countPerformedWorkingSets([completed.occurrence])).toBe(1);
  });

  it("persists an explicit skip reason and note on the occurrence", () => {
    const result = applyOccurrenceMutation(
      { occurrence: occurrence({ id: "occurrence-skip" }), receipts: [] },
      {
        clientKey: "skip-key",
        operation: "skip",
        expectedRevision: 1,
        reason: "pain",
        note: "Left knee discomfort during setup",
        resolvedAt: "2026-07-21T12:01:00.000Z",
      },
    );

    expect(result.status).toBe("saved");
    expect(result.occurrence).toMatchObject({
      outcome: "skipped",
      outcomeReason: "pain",
      outcomeNote: "Left knee discomfort during setup",
      revision: 2,
      resolvedAt: "2026-07-21T12:01:00.000Z",
    });
  });

  it("resolves every remaining pending occurrence to abandoned when a workout finishes early", () => {
    const finished = abandonPendingOccurrences(
      [
        occurrence({ id: "pending-working" }),
        occurrence({ id: "pending-warmup", kind: "exercise_warmup" }),
        occurrence({ id: "already-skipped", outcome: "skipped", revision: 2 }),
        occurrence({
          id: "already-completed",
          outcome: "completed",
          revision: 2,
          completedSetId: "completed-set-existing",
        }),
      ],
      {
        resolvedAt: "2026-07-21T12:05:00.000Z",
        outcomeReason: "finished_early",
      },
    );

    expect(finished.map(({ id, outcome, revision }) => ({ id, outcome, revision }))).toEqual([
      { id: "pending-working", outcome: "abandoned", revision: 2 },
      { id: "pending-warmup", outcome: "abandoned", revision: 2 },
      { id: "already-skipped", outcome: "skipped", revision: 2 },
      { id: "already-completed", outcome: "completed", revision: 2 },
    ]);
  });

  it("counts only completed working occurrences linked to an active performed result", () => {
    const completedWorking = occurrence({
      id: "completed-working",
      outcome: "completed",
      completedSetId: "completed-set-working",
    });
    const excluded = [
      occurrence({ id: "pending", outcome: "pending" }),
      occurrence({ id: "skipped", outcome: "skipped" }),
      occurrence({ id: "abandoned", outcome: "abandoned" }),
      occurrence({ id: "legacy", outcome: "legacy_unrecorded" }),
      occurrence({
        id: "completed-warmup",
        kind: "exercise_warmup",
        outcome: "completed",
        completedSetId: null,
      }),
      occurrence({ id: "completed-without-result", outcome: "completed" }),
    ];

    expect(countPerformedWorkingSets([completedWorking, ...excluded])).toBe(1);
  });

  it("replays the same key and payload, conflicts on changed payload, and never reapplies a stale skip after restore", () => {
    const initial = { occurrence: occurrence({ id: "occurrence-replay" }), receipts: [] };
    const skip = {
      clientKey: "durable-skip-key",
      operation: "skip" as const,
      expectedRevision: 1,
      reason: "fatigue",
      note: "Stopped with form intact",
      resolvedAt: "2026-07-21T12:10:00.000Z",
    };

    const first = applyOccurrenceMutation(initial, skip);
    const duplicate = applyOccurrenceMutation(first, skip);

    expect(first.status).toBe("saved");
    expect(duplicate.status).toBe("replayed");
    expect(duplicate.receipt).toEqual(first.receipt);
    expect(duplicate.occurrence).toEqual(first.occurrence);

    const changedPayload = applyOccurrenceMutation(first, {
      ...skip,
      note: "A different payload must not reuse the receipt",
    });

    expect(changedPayload.status).toBe("conflict");
    expect(changedPayload.occurrence).toEqual(first.occurrence);
    expect(changedPayload.receipts).toEqual(first.receipts);

    const restored = applyOccurrenceMutation(first, {
      clientKey: "restore-key",
      operation: "restore",
      expectedRevision: 2,
      resolvedAt: "2026-07-21T12:11:00.000Z",
    });
    expect(restored).toMatchObject({
      status: "saved",
      occurrence: {
        outcome: "pending",
        outcomeReason: null,
        outcomeNote: "Stopped with form intact",
        revision: 3,
        resolvedAt: null,
      },
    });

    const staleSkipReplay = applyOccurrenceMutation(restored, skip);
    expect(staleSkipReplay.status).toBe("replayed");
    expect(staleSkipReplay.receipt).toEqual(first.receipt);
    expect(staleSkipReplay.occurrence).toEqual(restored.occurrence);
    expect(staleSkipReplay.occurrence.outcome).toBe("pending");
    expect(staleSkipReplay.occurrence.revision).toBe(3);
  });
});
