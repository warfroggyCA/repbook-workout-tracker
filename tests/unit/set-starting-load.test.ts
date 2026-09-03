import { describe, expect, it } from "vitest";
import type {
  SessionExerciseData,
  SessionOccurrenceData,
} from "@/components/session/types";
import { resolveSetStartingLoad } from "@/lib/set-starting-load";

function exercise(
  patch: Partial<SessionExerciseData> = {},
): SessionExerciseData {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    exerciseId: "00000000-0000-4000-8000-000000000002",
    name: "Chest-Supported Dumbbell Reverse Fly",
    family: null,
    loadType: "dumbbell",
    loadSemantics: "per_implement",
    metricType: "weight_reps",
    movementPattern: "pull",
    orderIdx: 0,
    supersetKey: "pair",
    restSec: 75,
    modificationType: "as_planned",
    skipReason: null,
    substitutedForExerciseId: null,
    substitutionReason: null,
    substitutedAt: null,
    plannedExerciseName: null,
    targetSets: 3,
    targetRepsMin: 12,
    targetRepsMax: 20,
    targetLoad: 15,
    targetLoadUnit: "lb",
    notes: null,
    warmupNotes: null,
    warmupSets: [],
    setNotes: [],
    cautionBodyParts: [],
    media: null,
    sets: [],
    last: null,
    ...patch,
  };
}

function occurrence(
  patch: Partial<SessionOccurrenceData> = {},
): SessionOccurrenceData {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    sessionExerciseId: "00000000-0000-4000-8000-000000000001",
    kind: "working_set",
    origin: "planned",
    sequenceIdx: 0,
    kindOrdinal: 0,
    label: null,
    plannedExerciseId: "00000000-0000-4000-8000-000000000002",
    plannedNote: null,
    plannedRepsMin: 12,
    plannedRepsMax: 20,
    plannedLoad: 15,
    plannedLoadUnit: "lb",
    plannedLoadPercent: null,
    plannedLoadText: null,
    plannedRestSec: 75,
    groupSnapshotId: null,
    groupRound: null,
    groupMemberOrderIdx: null,
    outcome: "pending",
    outcomeReason: null,
    outcomeNote: null,
    revision: 0,
    resolvedAt: null,
    completedSetId: null,
    ...patch,
  };
}

describe("set starting load preview", () => {
  it("uses the same performed-set then Program then comparable precedence", () => {
    const base = exercise({
      sets: [{
        id: "set-1",
        clientKey: null,
        setNo: 1,
        weight: 17.5,
        weightUnit: "lb",
        reps: 15,
        rpe: null,
        note: null,
      }],
    });
    expect(resolveSetStartingLoad({
      exercise: base,
      setNumber: 2,
      unit: "lb",
      loadEntryMeaning: "total_system",
    })).toEqual({
      status: "available",
      weight: 17.5,
      unit: "lb",
      source: "Previous set in this workout",
    });

    expect(resolveSetStartingLoad({
      exercise: exercise(),
      setNumber: 1,
      unit: "lb",
      loadEntryMeaning: "total_system",
    })).toMatchObject({
      status: "available",
      weight: 15,
      source: "Program target",
    });
  });

  it("keeps the current session target ahead of a stale occurrence snapshot", () => {
    expect(resolveSetStartingLoad({
      exercise: exercise({ targetLoad: 100, targetLoadUnit: "lb" }),
      setNumber: 1,
      unit: "lb",
      loadEntryMeaning: "total_system",
      occurrence: occurrence({ plannedLoad: 95, plannedLoadUnit: "lb" }),
    })).toMatchObject({
      status: "available",
      weight: 100,
      source: "Program target",
    });
  });

  it("uses only semantically compatible comparable history", () => {
    const comparable = exercise({
      targetLoad: null,
      targetLoadUnit: null,
      previousComparable: {
        status: "available",
        currentSessionExerciseId: "00000000-0000-4000-8000-000000000001",
        exerciseId: "00000000-0000-4000-8000-000000000002",
        semantics: {
          version: 1,
          metricType: "weight_reps",
          loadType: "dumbbell",
          loadSemantics: "per_implement",
          loadEntryMeaning: "total_system",
        },
        source: {
          workoutId: "workout-1",
          localDate: "2026-08-20",
          startedAtISO: "2026-08-20T12:00:00.000Z",
          finishedAtISO: "2026-08-20T13:00:00.000Z",
          historyHref: "/history/workout-1",
          workoutSource: "tracker",
        },
        sets: [{
          setId: "prior-1",
          setNo: 1,
          weight: 20,
          weightUnit: "lb",
          reps: 12,
          distanceKm: null,
          durationSeconds: null,
          rpe: null,
          rir: null,
          observedCompletedAtISO: "2026-08-20T12:10:00.000Z",
          observedCompletionProvenance: "live_client",
          observedCompletionQuality: "trustworthy",
          correctionProvenance: { state: "original", count: 0 },
        }],
      },
    });
    expect(resolveSetStartingLoad({
      exercise: comparable,
      setNumber: 1,
      unit: "lb",
      loadEntryMeaning: "total_system",
    })).toMatchObject({
      status: "available",
      weight: 20,
      source: "Previous comparable set",
    });
    expect(resolveSetStartingLoad({
      exercise: comparable,
      setNumber: 1,
      unit: "lb",
      loadEntryMeaning: "per_loading_point",
    })).toEqual({ status: "unavailable" });
  });

  it("does not inherit load evidence from a different planned exercise", () => {
    const originalExerciseId = "00000000-0000-4000-8000-000000000099";
    const substituted = exercise({
      modificationType: "substituted",
      substitutedForExerciseId: originalExerciseId,
      targetLoad: null,
      targetLoadUnit: null,
      previousComparable: {
        status: "available",
        currentSessionExerciseId: "00000000-0000-4000-8000-000000000001",
        exerciseId: originalExerciseId,
        semantics: {
          version: 1,
          metricType: "weight_reps",
          loadType: "dumbbell",
          loadSemantics: "per_implement",
          loadEntryMeaning: "total_system",
        },
        source: {
          workoutId: "workout-1",
          localDate: "2026-08-20",
          startedAtISO: "2026-08-20T12:00:00.000Z",
          finishedAtISO: "2026-08-20T13:00:00.000Z",
          historyHref: "/history/workout-1",
          workoutSource: "tracker",
        },
        sets: [{
          setId: "prior-1",
          setNo: 1,
          weight: 135,
          weightUnit: "lb",
          reps: 8,
          distanceKm: null,
          durationSeconds: null,
          rpe: null,
          rir: null,
          observedCompletedAtISO: "2026-08-20T12:10:00.000Z",
          observedCompletionProvenance: "live_client",
          observedCompletionQuality: "trustworthy",
          correctionProvenance: { state: "original", count: 0 },
        }],
      },
    });

    expect(resolveSetStartingLoad({
      exercise: substituted,
      setNumber: 1,
      unit: "lb",
      loadEntryMeaning: "total_system",
      occurrence: occurrence({
        plannedExerciseId: originalExerciseId,
        plannedLoad: 95,
        plannedLoadUnit: "lb",
      }),
    })).toEqual({ status: "unavailable" });
  });

  it("distinguishes no weight entry from missing starting-load evidence", () => {
    expect(resolveSetStartingLoad({
      exercise: exercise({ metricType: "reps", targetLoad: null, targetLoadUnit: null }),
      setNumber: 1,
      unit: "lb",
      loadEntryMeaning: null,
    })).toEqual({ status: "not_applicable" });
    expect(resolveSetStartingLoad({
      exercise: exercise({ targetLoad: null, targetLoadUnit: null }),
      setNumber: 1,
      unit: "lb",
      loadEntryMeaning: null,
    })).toEqual({ status: "unavailable" });
  });
});
