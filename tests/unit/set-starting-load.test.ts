import { describe, expect, it } from "vitest";
import type { SessionExerciseData } from "@/components/session/types";
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
