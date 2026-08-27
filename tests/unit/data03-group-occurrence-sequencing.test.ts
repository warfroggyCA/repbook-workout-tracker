import { describe, expect, it } from "vitest";
import {
  abandonPendingOccurrences,
  buildGroupWorkingOccurrences,
  nextActionableOccurrence,
  restAfterOccurrence,
  summarizeGroupRounds,
  workingSetOccurrenceOrderIsEligible,
  type SessionExerciseGroupSnapshot,
  type SessionOccurrence,
} from "@/lib/session-occurrences";

const ids = {
  session: "00000000-0000-4000-8000-000000000301",
  group: "00000000-0000-4000-8000-000000000302",
  sourceGroup: "00000000-0000-4000-8000-000000000303",
  member1: "00000000-0000-4000-8000-000000000311",
  member2: "00000000-0000-4000-8000-000000000312",
  member3: "00000000-0000-4000-8000-000000000313",
  planned1: "00000000-0000-4000-8000-000000000321",
  planned2: "00000000-0000-4000-8000-000000000322",
  planned3: "00000000-0000-4000-8000-000000000323",
  substitute1: "00000000-0000-4000-8000-000000000324",
};

const group: SessionExerciseGroupSnapshot = {
  id: ids.group,
  sessionId: ids.session,
  sourceGroupId: ids.sourceGroup,
  lineageId: ids.sourceGroup,
  provenance: "program",
  name: "Shoulders tri-set",
  orderIdx: 0,
  plannedRounds: 2,
  memberCount: 3,
  restBetweenMembersSec: 20,
  restBetweenRoundsSec: 90,
  snapshotVersion: 1,
};

function occurrenceId(roundNumber: number, memberOrderIdx: number) {
  return `00000000-0000-4000-8000-${String(330 + roundNumber * 10 + memberOrderIdx).padStart(12, "0")}`;
}

function buildSequence() {
  return buildGroupWorkingOccurrences({
    sessionId: ids.session,
    group,
    firstSequenceIdx: 0,
    createdAt: "2026-07-21T13:55:00.000Z",
    members: [
      {
        sessionExerciseId: ids.member1,
        plannedExerciseId: ids.planned1,
        groupMemberOrderIdx: 0,
        setCount: 2,
        repMin: 8,
        repMax: 10,
        plannedLoad: 20,
        plannedLoadUnit: "lb",
        plannedRestSec: 20,
        plannedNote: "Lead member",
      },
      {
        sessionExerciseId: ids.member2,
        plannedExerciseId: ids.planned2,
        groupMemberOrderIdx: 1,
        setCount: 2,
        repMin: 10,
        repMax: 12,
        plannedLoad: 15,
        plannedLoadUnit: "lb",
        plannedRestSec: 20,
        plannedNote: null,
      },
      {
        sessionExerciseId: ids.member3,
        plannedExerciseId: ids.planned3,
        groupMemberOrderIdx: 2,
        setCount: 2,
        repMin: 12,
        repMax: 15,
        plannedLoad: 10,
        plannedLoadUnit: "lb",
        plannedRestSec: 90,
        plannedNote: "Round closer",
      },
    ],
    createOccurrenceId: ({ roundNumber, groupMemberOrderIdx }) =>
      occurrenceId(roundNumber, groupMemberOrderIdx),
  });
}

function resolve(
  occurrences: SessionOccurrence[],
  id: string,
  outcome: "completed" | "skipped",
  extras: Partial<SessionOccurrence> = {}
) {
  return occurrences.map((occurrence) =>
    occurrence.id === id
      ? {
          ...occurrence,
          outcome,
          revision: occurrence.revision + 1,
          resolvedAt: "2026-07-21T14:00:00.000Z",
          ...extras,
        }
      : occurrence
  );
}

describe("DATA-03 group occurrence sequencing", () => {
  it("offers only group sets that the server order contract can accept", () => {
    const occurrences = buildSequence();

    expect(
      workingSetOccurrenceOrderIsEligible(occurrences[0], occurrences),
    ).toBe(true);
    expect(
      workingSetOccurrenceOrderIsEligible(occurrences[1], occurrences),
    ).toBe(false);

    const afterFirstMember = resolve(
      occurrences,
      occurrences[0].id,
      "completed",
    );
    expect(
      workingSetOccurrenceOrderIsEligible(
        afterFirstMember[1],
        afterFirstMember,
      ),
    ).toBe(true);

    const independentExercise = {
      ...occurrences[1],
      id: "00000000-0000-4000-8000-000000000399",
      sessionExerciseId: "00000000-0000-4000-8000-000000000398",
      groupSnapshotId: null,
      groupRound: null,
      groupMemberOrderIdx: null,
    };
    expect(
      workingSetOccurrenceOrderIsEligible(independentExercise, [
        ...occurrences,
        independentExercise,
      ]),
    ).toBe(true);
  });

  it("does not offer a working set before any opening preparation set", () => {
    const working = {
      ...buildSequence()[0],
      sequenceIdx: 11,
      groupSnapshotId: null,
      groupRound: null,
      groupMemberOrderIdx: null,
    };
    const preparation = {
      ...working,
      id: "00000000-0000-4000-8000-000000000397",
      sessionExerciseId: "00000000-0000-4000-8000-000000000396",
      kind: "exercise_warmup",
      sequenceIdx: 10,
      kindOrdinal: 0,
    };

    expect(
      workingSetOccurrenceOrderIsEligible(working, [preparation, working]),
    ).toBe(false);
    expect(
      workingSetOccurrenceOrderIsEligible(
        working,
        [{ ...preparation, outcome: "skipped" }, working],
      ),
    ).toBe(true);
  });

  it("does not offer any working set before an earlier day warm-up", () => {
    const working = {
      ...buildSequence()[0],
      sequenceIdx: 2,
      groupSnapshotId: null,
      groupRound: null,
      groupMemberOrderIdx: null,
    };
    const dayWarmup = {
      ...working,
      id: "00000000-0000-4000-8000-000000000396",
      sessionExerciseId: null,
      kind: "day_warmup",
      sequenceIdx: 0,
      kindOrdinal: 0,
    };

    expect(
      workingSetOccurrenceOrderIsEligible(working, [dayWarmup, working]),
    ).toBe(false);
    expect(
      workingSetOccurrenceOrderIsEligible(
        working,
        [{ ...dayWarmup, outcome: "skipped" }, working],
      ),
    ).toBe(true);
  });

  it("builds all three members in each round and applies the two explicit rest rules", () => {
    const occurrences = buildSequence();

    expect(
      occurrences.map((occurrence) => ({
        plannedExerciseId: occurrence.plannedExerciseId,
        roundNumber: occurrence.groupRound,
        memberOrderIdx: occurrence.groupMemberOrderIdx,
        outcome: occurrence.outcome,
      }))
    ).toEqual([
      { plannedExerciseId: ids.planned1, roundNumber: 1, memberOrderIdx: 0, outcome: "pending" },
      { plannedExerciseId: ids.planned2, roundNumber: 1, memberOrderIdx: 1, outcome: "pending" },
      { plannedExerciseId: ids.planned3, roundNumber: 1, memberOrderIdx: 2, outcome: "pending" },
      { plannedExerciseId: ids.planned1, roundNumber: 2, memberOrderIdx: 0, outcome: "pending" },
      { plannedExerciseId: ids.planned2, roundNumber: 2, memberOrderIdx: 1, outcome: "pending" },
      { plannedExerciseId: ids.planned3, roundNumber: 2, memberOrderIdx: 2, outcome: "pending" },
    ]);
    expect(occurrences.map((occurrence) => occurrence.sequenceIdx)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(nextActionableOccurrence(occurrences)?.id).toBe(occurrenceId(1, 0));

    expect(restAfterOccurrence(occurrences[0], occurrences, group)).toEqual({
      kind: "between_members",
      seconds: 20,
    });
    expect(restAfterOccurrence(occurrences[1], occurrences, group)).toEqual({
      kind: "between_members",
      seconds: 20,
    });
    expect(restAfterOccurrence(occurrences[2], occurrences, group)).toEqual({
      kind: "between_rounds",
      seconds: 90,
    });
    expect(restAfterOccurrence(occurrences[5], occurrences, group)).toEqual({
      kind: "none",
      seconds: 0,
    });
  });

  it("advances past a skipped member without presenting that round as complete", () => {
    let occurrences = buildSequence();
    occurrences = resolve(occurrences, occurrenceId(1, 0), "completed");
    occurrences = resolve(occurrences, occurrenceId(1, 1), "skipped", {
      outcomeReason: "Pain during movement",
      outcomeNote: "Stopped before attempting the set",
    });

    expect(nextActionableOccurrence(occurrences)?.id).toBe(occurrenceId(1, 2));

    occurrences = resolve(occurrences, occurrenceId(1, 2), "completed");
    expect(summarizeGroupRounds(occurrences, group)).toEqual([
      {
        roundNumber: 1,
        status: "partial",
        planned: 3,
        completed: 2,
        skipped: 1,
        abandoned: 0,
        pending: 0,
      },
      {
        roundNumber: 2,
        status: "pending",
        planned: 3,
        completed: 0,
        skipped: 0,
        abandoned: 0,
        pending: 3,
      },
    ]);
  });

  it("retains planned member identity after substitution and marks an early finish as partial", () => {
    let occurrences = buildSequence();
    occurrences = resolve(occurrences, occurrenceId(1, 0), "completed");
    occurrences = resolve(occurrences, occurrenceId(1, 1), "skipped", {
      outcomeReason: "Pain during movement",
    });
    occurrences = resolve(occurrences, occurrenceId(1, 2), "completed");
    occurrences = resolve(occurrences, occurrenceId(2, 0), "completed", {
      performedExerciseId: ids.substitute1,
      outcomeReason: "Equipment unavailable",
    });

    const substituted = occurrences.find((occurrence) => occurrence.id === occurrenceId(2, 0));
    expect(substituted).toMatchObject({
      plannedExerciseId: ids.planned1,
      performedExerciseId: ids.substitute1,
      groupRound: 2,
      groupMemberOrderIdx: 0,
      outcome: "completed",
    });

    occurrences = abandonPendingOccurrences(occurrences, {
      resolvedAt: "2026-07-21T14:05:00.000Z",
      outcomeReason: "Workout finished early",
    });

    expect(occurrences.slice(4).map((occurrence) => occurrence.outcome)).toEqual([
      "abandoned",
      "abandoned",
    ]);
    expect(nextActionableOccurrence(occurrences)).toBeNull();
    expect(summarizeGroupRounds(occurrences, group)).toEqual([
      expect.objectContaining({ roundNumber: 1, status: "partial", completed: 2, skipped: 1 }),
      expect.objectContaining({ roundNumber: 2, status: "partial", completed: 1, abandoned: 2 }),
    ]);
  });
});
