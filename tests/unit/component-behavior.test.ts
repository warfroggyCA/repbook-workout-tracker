import { describe, expect, it } from "vitest";
import type {
  SessionExerciseData,
  SessionOccurrenceData,
} from "@/components/session/types";
import {
  EXERCISE_NOTE_MAX_LENGTH,
  SET_NOTE_MAX_LENGTH,
  exerciseUsesTotalBarLoad,
  formatPlateLoadGuidance,
  setSaveStateLabel,
  targetResultLabel,
} from "@/lib/exercise-card";
import { exercisePickerSelectionState } from "@/lib/exercise-picker";
import { canCreateSuperset } from "@/lib/program-editor-client";
import { fitRoutineSetNotes, moveRoutineItem } from "@/lib/routine-builder";
import {
  nextIncompleteExerciseId,
  mergeEquipmentSelectionOccurrenceStates,
  workoutSaveQueueMessage,
  workoutFinishIsBlocked,
} from "@/lib/session-runner";

const occurrenceState: SessionOccurrenceData = {
  id: "00000000-0000-4000-8000-000000000099",
  sessionExerciseId: "00000000-0000-4000-8000-000000000098",
  kind: "working_set",
  origin: "planned",
  sequenceIdx: 0,
  kindOrdinal: 0,
  label: null,
  plannedExerciseId: null,
  plannedNote: null,
  plannedRepsMin: null,
  plannedRepsMax: null,
  plannedLoad: null,
  plannedLoadUnit: null,
  plannedLoadPercent: null,
  plannedLoadText: null,
  plannedRestSec: 60,
  groupSnapshotId: null,
  groupRound: null,
  groupMemberOrderIdx: null,
  outcome: "pending",
  outcomeReason: null,
  outcomeNote: null,
  revision: 2,
  resolvedAt: null,
  completedSetId: null,
  restAfterSec: 60,
};

const plateConfig = {
  barWeight: 45,
  collarWeight: 5,
  plates: [{ denomination: 25, countPerSide: 1 }],
};

function exercise(
  id: string,
  patch: Partial<SessionExerciseData> = {}
): SessionExerciseData {
  return {
    id,
    exerciseId: id,
    name: id,
    family: null,
    loadType: "barbell",
    loadSemantics: "total",
    movementPattern: "squat",
    orderIdx: 0,
    supersetKey: null,
    restSec: 90,
    modificationType: "as_planned",
    skipReason: null,
    substitutedForExerciseId: null,
    substitutionReason: null,
    substitutedAt: null,
    plannedExerciseName: null,
    targetSets: 2,
    targetRepsMin: 6,
    targetRepsMax: 8,
    targetLoad: 100,
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

describe("exercise-card presentation rules", () => {
  it("names equipment blockers truthfully instead of reporting zero sets", () => {
    expect(workoutSaveQueueMessage({
      equipmentError: null,
      occurrenceError: null,
      setError: null,
      occurrenceCount: 0,
      occurrenceQuarantineCount: 0,
      equipmentCount: 1,
      equipmentQuarantineCount: 0,
      setCount: 0,
      setQuarantineCount: 0,
    })).toContain("1 equipment choice is still saving");
    expect(workoutSaveQueueMessage({
      equipmentError: null,
      occurrenceError: null,
      setError: null,
      occurrenceCount: 0,
      occurrenceQuarantineCount: 0,
      equipmentCount: 0,
      equipmentQuarantineCount: 2,
      setCount: 0,
      setQuarantineCount: 0,
    })).toContain("can't read 2 saved equipment choices");
  });

  it("labels assembled barbell entry as Total weight and explains the empty base", () => {
    expect(
      exerciseUsesTotalBarLoad({
        loadType: "barbell",
        loadSemantics: "total",
        plateConfig,
      })
    ).toBe(true);
    expect(
      exerciseUsesTotalBarLoad({
        loadType: "trap_bar",
        loadSemantics: "total",
        plateConfig,
      })
    ).toBe(true);
    expect(formatPlateLoadGuidance(50, plateConfig, "lb")).toBe(
      "Empty bar: 50 lb including collars"
    );
    expect(formatPlateLoadGuidance(100, plateConfig, "lb")).toContain(
      "Empty bar and collars: 50 lb"
    );
  });

  it("presents pending and failed device-set states with stable guidance", () => {
    expect(setSaveStateLabel("pending")).toBe("Pending on this device");
    expect(setSaveStateLabel("failed")).toBe("Save failed");
  });

  it("keeps warm-ups outside target-met presentation", () => {
    expect(targetResultLabel({ isWarmup: true, targetMet: true })).toBe("Warm-up");
    expect(targetResultLabel({ isWarmup: false, targetMet: true })).toBe("Target met");
    expect(targetResultLabel({ isWarmup: false, targetMet: false })).toBe("Below target");
  });

  it("disables an unavailable substitution with its exact reason", () => {
    expect(
      exercisePickerSelectionState({
        available: false,
        permitted: true,
        unavailableReason: "Your saved equipment does not support this exercise.",
      })
    ).toEqual({
      selectable: false,
      reason: "Your saved equipment does not support this exercise.",
    });
  });

  it("pins the set and exercise note length caps", () => {
    expect(SET_NOTE_MAX_LENGTH).toBe(500);
    expect(EXERCISE_NOTE_MAX_LENGTH).toBe(1000);
  });
});

describe("routine-builder editing rules", () => {
  it("gates superset creation until two ungrouped exercises are selected", () => {
    const slots: Array<{ id: string; supersetKey: string | null }> = [
      { id: "one", supersetKey: null },
      { id: "two", supersetKey: null },
    ];
    const day = (exercises: typeof slots) => ({ exercises, supersets: [] }) as never;
    expect(canCreateSuperset(day(slots))).toBe(true);
    expect(canCreateSuperset(day(slots.slice(0, 1)))).toBe(false);
    expect(canCreateSuperset(day([{ ...slots[0], supersetKey: "A" }, slots[1]]))).toBe(false);
  });

  it("resizes set notes without losing surviving values", () => {
    expect(fitRoutineSetNotes(["brace", "drive", "finish"], 2)).toEqual([
      "brace",
      "drive",
    ]);
    expect(fitRoutineSetNotes(["brace"], 3)).toEqual(["brace", null, null]);
  });

  it("moves slots up and down without changing their identities", () => {
    const source = ["one", "two", "three"];
    expect(moveRoutineItem(source, 2, 0)).toEqual(["three", "one", "two"]);
    expect(moveRoutineItem(source, 0, 2)).toEqual(["two", "three", "one"]);
    expect(source).toEqual(["one", "two", "three"]);
  });
});

describe("session-runner workflow rules", () => {
  it("merges authoritative equipment occurrence state without rolling back a newer revision", () => {
    const received = {
      id: occurrenceState.id,
      outcome: "skipped",
      outcomeReason: "equipment",
      outcomeNote: "local note",
      revision: 3,
      resolvedAt: "2026-07-22T12:00:00.000Z",
      completedSetId: null,
    };
    expect(
      mergeEquipmentSelectionOccurrenceStates([occurrenceState], [received])[0],
    ).toMatchObject({
      outcome: "skipped",
      outcomeReason: "equipment",
      revision: 3,
    });

    const newer = { ...occurrenceState, outcome: "completed" as const, revision: 4 };
    expect(
      mergeEquipmentSelectionOccurrenceStates([newer], [received])[0],
    ).toBe(newer);
  });

  it("blocks finish while any device-only or unreadable set remains", () => {
    const outbox = { quarantined: [], error: null };
    expect(workoutFinishIsBlocked([], outbox)).toBe(false);
    expect(workoutFinishIsBlocked([{} as never], outbox)).toBe(true);
    expect(
      workoutFinishIsBlocked([], {
        quarantined: [{ quarantineKey: "q", raw: null, reason: "invalid" }],
        error: null,
      })
    ).toBe(true);
  });

  it("advances to the next unfinished non-skipped exercise in order", () => {
    const exercises = [
      exercise("one", { sets: [{ id: "s", clientKey: null, setNo: 1, weight: 100, weightUnit: "lb", reps: 8, rpe: null, note: null }] }),
      exercise("two", { modificationType: "skipped" }),
      exercise("three"),
    ];
    expect(nextIncompleteExerciseId(exercises, "one")).toBe("three");
    expect(nextIncompleteExerciseId(exercises, "three")).toBeNull();
  });

});
