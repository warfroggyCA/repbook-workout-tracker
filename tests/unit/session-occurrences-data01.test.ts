import { describe, expect, it } from "vitest";
import {
  applyOccurrenceMutation,
  buildWarmupOccurrences,
  countPerformedWorkingSets,
  type SessionOccurrence,
} from "@/lib/session-occurrences";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const BENCH_SESSION_EXERCISE_ID = "20000000-0000-4000-8000-000000000001";
const ROW_SESSION_EXERCISE_ID = "20000000-0000-4000-8000-000000000002";
const PRESS_SESSION_EXERCISE_ID = "20000000-0000-4000-8000-000000000003";
const BENCH_EXERCISE_ID = "30000000-0000-4000-8000-000000000001";
const ROW_EXERCISE_ID = "30000000-0000-4000-8000-000000000002";
const PRESS_EXERCISE_ID = "30000000-0000-4000-8000-000000000003";
const CREATED_AT = "2026-07-21T12:00:00.000Z";

function occurrence(
  overrides: Partial<SessionOccurrence> = {},
): SessionOccurrence {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    sessionId: SESSION_ID,
    sessionExerciseId: BENCH_SESSION_EXERCISE_ID,
    kind: "working_set",
    origin: "planned",
    sequenceIdx: 5,
    kindOrdinal: 0,
    label: null,
    plannedExerciseId: BENCH_EXERCISE_ID,
    plannedRepsMin: 8,
    plannedRepsMax: 10,
    plannedLoad: 100,
    plannedLoadUnit: "lb",
    plannedLoadPercent: null,
    plannedLoadText: null,
    plannedRestSec: 90,
    plannedNote: "Controlled pause",
    groupSnapshotId: null,
    groupRound: null,
    groupMemberOrderIdx: null,
    outcome: "pending",
    outcomeReason: null,
    outcomeNote: null,
    revision: 0,
    resolvedAt: null,
    createdAt: CREATED_AT,
    completedSetId: null,
    ...overrides,
  };
}

describe("DATA-01 durable warm-up occurrences", () => {
  it("builds day and exercise warm-ups in deterministic Program order with copied plan snapshots", () => {
    const source = {
      sessionId: SESSION_ID,
      createdAt: CREATED_AT,
      startingSequenceIdx: 0,
      dayWarmups: [
        {
          sourceId: "day-warmup-2",
          orderIdx: 1,
          label: "Band pull-aparts",
          reps: 20,
          load: null,
          loadUnit: null,
          loadPercent: null,
          loadText: "light band",
          note: "Keep ribs down",
        },
        {
          sourceId: "day-warmup-1",
          orderIdx: 0,
          label: "Shoulder circles",
          reps: 10,
          load: null,
          loadUnit: null,
          loadPercent: null,
          loadText: null,
          note: null,
        },
      ],
      exercises: [
        {
          sessionExerciseId: ROW_SESSION_EXERCISE_ID,
          exerciseId: ROW_EXERCISE_ID,
          orderIdx: 1,
          warmupSets: [
            {
              sourceId: "row-warmup-1",
              orderIdx: 0,
              label: "Row rehearsal",
              reps: 8,
              load: 40,
              loadUnit: "lb" as const,
              loadPercent: null,
              loadText: null,
              restSec: 45,
              note: null,
            },
          ],
        },
        {
          sessionExerciseId: BENCH_SESSION_EXERCISE_ID,
          exerciseId: BENCH_EXERCISE_ID,
          orderIdx: 0,
          warmupSets: [
            {
              sourceId: "bench-warmup-2",
              orderIdx: 1,
              label: "Bench ramp 2",
              reps: 5,
              load: null,
              loadUnit: null,
              loadPercent: 60,
              loadText: null,
              restSec: 60,
              note: "Match work-set grip",
            },
            {
              sourceId: "bench-warmup-1",
              orderIdx: 0,
              label: "Empty bar",
              reps: 10,
              load: null,
              loadUnit: null,
              loadPercent: null,
              loadText: "empty bar",
              restSec: 45,
              note: null,
            },
          ],
        },
      ],
      createOccurrenceId: (sequenceIdx: number) => `occurrence-${sequenceIdx}`,
    };

    const built = buildWarmupOccurrences(source);

    expect(built.map((item) => ({
      id: item.id,
      kind: item.kind,
      sequenceIdx: item.sequenceIdx,
      kindOrdinal: item.kindOrdinal,
      sessionExerciseId: item.sessionExerciseId,
      plannedExerciseId: item.plannedExerciseId,
      label: item.label,
    }))).toEqual([
      {
        id: "occurrence-0",
        kind: "day_warmup",
        sequenceIdx: 0,
        kindOrdinal: 0,
        sessionExerciseId: null,
        plannedExerciseId: null,
        label: "Shoulder circles",
      },
      {
        id: "occurrence-1",
        kind: "day_warmup",
        sequenceIdx: 1,
        kindOrdinal: 1,
        sessionExerciseId: null,
        plannedExerciseId: null,
        label: "Band pull-aparts",
      },
      {
        id: "occurrence-2",
        kind: "exercise_warmup",
        sequenceIdx: 2,
        kindOrdinal: 0,
        sessionExerciseId: BENCH_SESSION_EXERCISE_ID,
        plannedExerciseId: BENCH_EXERCISE_ID,
        label: "Empty bar",
      },
      {
        id: "occurrence-3",
        kind: "exercise_warmup",
        sequenceIdx: 3,
        kindOrdinal: 1,
        sessionExerciseId: BENCH_SESSION_EXERCISE_ID,
        plannedExerciseId: BENCH_EXERCISE_ID,
        label: "Bench ramp 2",
      },
      {
        id: "occurrence-4",
        kind: "exercise_warmup",
        sequenceIdx: 4,
        kindOrdinal: 0,
        sessionExerciseId: ROW_SESSION_EXERCISE_ID,
        plannedExerciseId: ROW_EXERCISE_ID,
        label: "Row rehearsal",
      },
    ]);
    expect(built[1]).toMatchObject({
      origin: "planned",
      plannedRepsMin: 20,
      plannedRepsMax: 20,
      plannedLoad: null,
      plannedLoadUnit: null,
      plannedLoadPercent: null,
      plannedLoadText: "light band",
      plannedNote: "Keep ribs down",
      outcome: "pending",
      revision: 0,
      resolvedAt: null,
    });
    expect(built[3]).toMatchObject({
      plannedRepsMin: 5,
      plannedRepsMax: 5,
      plannedLoad: null,
      plannedLoadUnit: null,
      plannedLoadPercent: 60,
      plannedLoadText: null,
      plannedRestSec: 60,
      plannedNote: "Match work-set grip",
    });

    source.dayWarmups[1].label = "Changed after workout creation";
    source.exercises[1].warmupSets[1].note = "Changed Program note";
    expect(built[0].label).toBe("Shoulder circles");
    expect(built[3].plannedNote).toBe("Match work-set grip");
  });

  it("places every anchored and legacy ramp before the first working occurrence", () => {
    const slotLineages = {
      bench: "50000000-0000-4000-8000-000000000001",
      row: "50000000-0000-4000-8000-000000000002",
      press: "50000000-0000-4000-8000-000000000003",
    };
    const groupId = "60000000-0000-4000-8000-000000000001";
    const work = [
      occurrence({ id: "bench-work-1", sessionExerciseId: BENCH_SESSION_EXERCISE_ID, plannedExerciseId: BENCH_EXERCISE_ID, sequenceIdx: 0 }),
      occurrence({ id: "row-work-1", sessionExerciseId: ROW_SESSION_EXERCISE_ID, plannedExerciseId: ROW_EXERCISE_ID, sequenceIdx: 1, groupSnapshotId: groupId, groupRound: 1, groupMemberOrderIdx: 0 }),
      occurrence({ id: "press-work-1", sessionExerciseId: PRESS_SESSION_EXERCISE_ID, plannedExerciseId: PRESS_EXERCISE_ID, sequenceIdx: 2, groupSnapshotId: groupId, groupRound: 1, groupMemberOrderIdx: 1 }),
      occurrence({ id: "row-work-2", sessionExerciseId: ROW_SESSION_EXERCISE_ID, plannedExerciseId: ROW_EXERCISE_ID, sequenceIdx: 3, kindOrdinal: 1, groupSnapshotId: groupId, groupRound: 2, groupMemberOrderIdx: 0 }),
      occurrence({ id: "press-work-2", sessionExerciseId: PRESS_SESSION_EXERCISE_ID, plannedExerciseId: PRESS_EXERCISE_ID, sequenceIdx: 4, kindOrdinal: 1, groupSnapshotId: groupId, groupRound: 2, groupMemberOrderIdx: 1 }),
    ];
    const warmup = (
      sourceId: string,
      orderIdx: number,
      label: string,
      beforeSlotLineageId?: string,
    ) => ({
      sourceId,
      orderIdx,
      label,
      beforeSlotLineageId,
      reps: null,
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: null,
      note: null,
    });
    const built = buildWarmupOccurrences({
      sessionId: SESSION_ID,
      createdAt: CREATED_AT,
      startingSequenceIdx: 0,
      dayWarmups: [
        warmup("general", 0, "General preparation"),
        warmup("bench-anchor", 1, "Bench ramp", slotLineages.bench),
        warmup("press-anchor-1", 2, "Press ramp one", slotLineages.press),
        warmup("press-anchor-2", 3, "Press ramp two", slotLineages.press),
      ],
      exercises: [
        { slotLineageId: slotLineages.bench, sessionExerciseId: BENCH_SESSION_EXERCISE_ID, exerciseId: BENCH_EXERCISE_ID, orderIdx: 0, warmupSets: [] },
        {
          slotLineageId: slotLineages.row,
          sessionExerciseId: ROW_SESSION_EXERCISE_ID,
          exerciseId: ROW_EXERCISE_ID,
          orderIdx: 1,
          warmupSets: [{ ...warmup("row-legacy", 0, "Row legacy ramp"), restSec: 30 }],
        },
        { slotLineageId: slotLineages.press, sessionExerciseId: PRESS_SESSION_EXERCISE_ID, exerciseId: PRESS_EXERCISE_ID, orderIdx: 2, warmupSets: [] },
      ],
      workingOccurrences: work,
      createOccurrenceId: (sequenceIdx) => `warmup-${sequenceIdx}`,
    });

    expect(built.map((item) => ({
      kind: item.kind,
      label: item.label,
      sessionExerciseId: item.sessionExerciseId,
      sequenceIdx: item.sequenceIdx,
      kindOrdinal: item.kindOrdinal,
      groupRound: item.groupRound,
      memberOrder: item.groupMemberOrderIdx,
    }))).toEqual([
      { kind: "day_warmup", label: "General preparation", sessionExerciseId: null, sequenceIdx: 0, kindOrdinal: 0, groupRound: null, memberOrder: null },
      { kind: "exercise_warmup", label: "Bench ramp", sessionExerciseId: BENCH_SESSION_EXERCISE_ID, sequenceIdx: 1, kindOrdinal: 0, groupRound: null, memberOrder: null },
      { kind: "exercise_warmup", label: "Row legacy ramp", sessionExerciseId: ROW_SESSION_EXERCISE_ID, sequenceIdx: 2, kindOrdinal: 0, groupRound: null, memberOrder: null },
      { kind: "exercise_warmup", label: "Press ramp one", sessionExerciseId: PRESS_SESSION_EXERCISE_ID, sequenceIdx: 3, kindOrdinal: 0, groupRound: null, memberOrder: null },
      { kind: "exercise_warmup", label: "Press ramp two", sessionExerciseId: PRESS_SESSION_EXERCISE_ID, sequenceIdx: 4, kindOrdinal: 1, groupRound: null, memberOrder: null },
      { kind: "working_set", label: null, sessionExerciseId: BENCH_SESSION_EXERCISE_ID, sequenceIdx: 5, kindOrdinal: 0, groupRound: null, memberOrder: null },
      { kind: "working_set", label: null, sessionExerciseId: ROW_SESSION_EXERCISE_ID, sequenceIdx: 6, kindOrdinal: 0, groupRound: 1, memberOrder: 0 },
      { kind: "working_set", label: null, sessionExerciseId: PRESS_SESSION_EXERCISE_ID, sequenceIdx: 7, kindOrdinal: 0, groupRound: 1, memberOrder: 1 },
      { kind: "working_set", label: null, sessionExerciseId: ROW_SESSION_EXERCISE_ID, sequenceIdx: 8, kindOrdinal: 1, groupRound: 2, memberOrder: 0 },
      { kind: "working_set", label: null, sessionExerciseId: PRESS_SESSION_EXERCISE_ID, sequenceIdx: 9, kindOrdinal: 1, groupRound: 2, memberOrder: 1 },
    ]);
  });

  it("applies note, completion, skip, and restore as revisioned transitions without changing the plan", () => {
    const pendingWarmup = occurrence({
      kind: "exercise_warmup",
      plannedRepsMin: 5,
      plannedRepsMax: 5,
      plannedLoad: null,
      plannedLoadUnit: null,
      plannedLoadPercent: 60,
      plannedNote: "Match work-set grip",
    });

    const annotated = applyOccurrenceMutation(pendingWarmup, {
      operation: "note",
      note: "Shoulder felt settled",
    });
    expect(annotated).toMatchObject({
      outcome: "pending",
      outcomeNote: "Shoulder felt settled",
      revision: 1,
      resolvedAt: null,
    });
    expect(pendingWarmup.outcomeNote).toBeNull();
    expect(pendingWarmup.revision).toBe(0);

    const completed = applyOccurrenceMutation(annotated, {
      operation: "complete",
      resolvedAt: "2026-07-21T12:03:00.000Z",
    });
    expect(completed).toMatchObject({
      outcome: "completed",
      outcomeReason: null,
      outcomeNote: "Shoulder felt settled",
      revision: 2,
      resolvedAt: "2026-07-21T12:03:00.000Z",
      plannedLoadPercent: 60,
      plannedNote: "Match work-set grip",
    });

    const skipped = applyOccurrenceMutation(pendingWarmup, {
      operation: "skip",
      reason: "Shoulder irritation",
      resolvedAt: "2026-07-21T12:02:00.000Z",
    });
    expect(skipped).toMatchObject({
      outcome: "skipped",
      outcomeReason: "Shoulder irritation",
      revision: 1,
      resolvedAt: "2026-07-21T12:02:00.000Z",
    });

    const restored = applyOccurrenceMutation(skipped, { operation: "restore" });
    expect(restored).toMatchObject({
      outcome: "pending",
      outcomeReason: null,
      revision: 2,
      resolvedAt: null,
      plannedLoadPercent: 60,
      plannedNote: "Match work-set grip",
    });
  });

  it("keeps terminal legacy gaps unknown instead of manufacturing completion or a skip", () => {
    const legacyUnknown = occurrence({
      origin: "legacy",
      outcome: "legacy_unrecorded",
      plannedRepsMin: 0,
      plannedRepsMax: 0,
    });

    expect(() => applyOccurrenceMutation(legacyUnknown, {
      operation: "complete",
      resolvedAt: "2026-07-21T12:03:00.000Z",
    })).toThrow(/legacy_unrecorded.*terminal/i);
    expect(countPerformedWorkingSets([legacyUnknown])).toBe(0);
  });

  it("counts only completed working-set occurrences with linked performed results", () => {
    const occurrences: SessionOccurrence[] = [
      occurrence({
        id: "day-warmup",
        sessionExerciseId: null,
        kind: "day_warmup",
        plannedExerciseId: null,
        outcome: "completed",
        resolvedAt: "2026-07-21T12:01:00.000Z",
      }),
      occurrence({
        id: "exercise-warmup",
        kind: "exercise_warmup",
        outcome: "completed",
        completedSetId: "50000000-0000-4000-8000-000000000001",
        resolvedAt: "2026-07-21T12:02:00.000Z",
      }),
      occurrence({
        id: "completed-working-set",
        kind: "working_set",
        outcome: "completed",
        completedSetId: "50000000-0000-4000-8000-000000000002",
        resolvedAt: "2026-07-21T12:05:00.000Z",
      }),
      occurrence({
        id: "completed-without-result",
        kind: "working_set",
        outcome: "completed",
        completedSetId: null,
        resolvedAt: "2026-07-21T12:06:00.000Z",
      }),
      occurrence({
        id: "skipped-working-set",
        kind: "working_set",
        outcome: "skipped",
        outcomeReason: "Pain",
        resolvedAt: "2026-07-21T12:07:00.000Z",
      }),
      occurrence({ id: "pending-working-set" }),
    ];

    expect(countPerformedWorkingSets(occurrences)).toBe(1);
  });
});
