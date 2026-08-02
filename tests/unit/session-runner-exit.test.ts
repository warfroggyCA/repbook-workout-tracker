import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  equipmentSyncPending,
  exitRequiresDeviceCopyAcknowledgement,
  finishBlockedByRecordedWork,
  nextPendingWorkingOccurrence,
  resolveSetLoggingEquipment,
  retainedRecordedWorkCount,
  type WorkoutExitQueues,
} from "@/lib/session-runner";
import type { SessionOccurrenceData } from "@/components/session/types";

const EMPTY: WorkoutExitQueues = {
  unsyncedSetCount: 0,
  quarantinedSetCount: 0,
  setHasError: false,
  unsyncedOccurrenceCount: 0,
  occurrenceHasError: false,
  unsyncedEquipmentCount: 0,
  quarantinedEquipmentCount: 0,
  equipmentHasError: false,
};

describe("workout exit readiness", () => {
  it("does not block finishing when every queue is clear", () => {
    expect(finishBlockedByRecordedWork(EMPTY)).toBe(false);
    expect(equipmentSyncPending(EMPTY)).toBe(false);
    expect(exitRequiresDeviceCopyAcknowledgement(EMPTY)).toBe(false);
  });

  // Day 3 field incident reproduction: an equipment setup command was stuck
  // ("awaiting information"), but no recorded set/occurrence work was pending.
  // The previous gate blocked Finish on any equipment-queue activity, trapping
  // the workout. Finishing and exiting must both remain available.
  it("never blocks finishing or exiting on stuck equipment guidance alone", () => {
    const equipmentStuck: WorkoutExitQueues = {
      ...EMPTY,
      unsyncedEquipmentCount: 1,
      equipmentHasError: true,
    };
    expect(equipmentSyncPending(equipmentStuck)).toBe(true);
    expect(finishBlockedByRecordedWork(equipmentStuck)).toBe(false);
    expect(exitRequiresDeviceCopyAcknowledgement(equipmentStuck)).toBe(false);

    const equipmentQuarantined: WorkoutExitQueues = {
      ...EMPTY,
      quarantinedEquipmentCount: 2,
    };
    expect(equipmentSyncPending(equipmentQuarantined)).toBe(true);
    expect(finishBlockedByRecordedWork(equipmentQuarantined)).toBe(false);
    expect(exitRequiresDeviceCopyAcknowledgement(equipmentQuarantined)).toBe(false);
  });

  it("treats unsynced recorded work as a resolvable finish blocker", () => {
    const pendingSet: WorkoutExitQueues = { ...EMPTY, unsyncedSetCount: 1 };
    expect(retainedRecordedWorkCount(pendingSet)).toBe(1);
    expect(finishBlockedByRecordedWork(pendingSet)).toBe(true);
    expect(exitRequiresDeviceCopyAcknowledgement(pendingSet)).toBe(true);

    const pendingOccurrence: WorkoutExitQueues = {
      ...EMPTY,
      unsyncedOccurrenceCount: 1,
    };
    expect(finishBlockedByRecordedWork(pendingOccurrence)).toBe(true);
    // A warm-up change is still an owner decision held only on this device, so
    // terminalizing the workout requires retry or explicit discard.
    expect(exitRequiresDeviceCopyAcknowledgement(pendingOccurrence)).toBe(true);

    const quarantinedSet: WorkoutExitQueues = {
      ...EMPTY,
      quarantinedSetCount: 1,
    };
    expect(finishBlockedByRecordedWork(quarantinedSet)).toBe(true);
    expect(exitRequiresDeviceCopyAcknowledgement(quarantinedSet)).toBe(true);
  });

  it("counts set and occurrence errors as recorded-work blockers", () => {
    expect(finishBlockedByRecordedWork({ ...EMPTY, setHasError: true })).toBe(true);
    expect(
      finishBlockedByRecordedWork({ ...EMPTY, occurrenceHasError: true }),
    ).toBe(true);
    // ...but an equipment error still never blocks finishing.
    expect(
      finishBlockedByRecordedWork({ ...EMPTY, equipmentHasError: true }),
    ).toBe(false);
  });
});

describe("occurrence discard continuity", () => {
  it("removes the unsaved command without reloading or navigating the workout", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    expect(source).toContain('type: "discarded"');
    expect(source).not.toContain("window.location.reload");
  });
});

describe("set logging equipment resolution", () => {
  it("logs with the resolved snapshot context when a setup is confirmed", () => {
    expect(
      resolveSetLoggingEquipment({
        hasSetup: true,
        hasSnapshot: true,
        hasPendingSelection: false,
        optionCount: 1,
        effectiveLoadMeaning: "displayed_stack",
      }),
    ).toEqual({ status: "log_with_snapshot", loadEntryMeaning: "displayed_stack" });
  });

  it("logs with a pending selection's meaning before the snapshot syncs", () => {
    expect(
      resolveSetLoggingEquipment({
        hasSetup: true,
        hasSnapshot: false,
        hasPendingSelection: true,
        optionCount: 2,
        effectiveLoadMeaning: "per_stack",
      }),
    ).toEqual({ status: "log_with_snapshot", loadEntryMeaning: "per_stack" });
  });

  it("asks the user to choose when reviewed physical options remain", () => {
    expect(
      resolveSetLoggingEquipment({
        hasSetup: true,
        hasSnapshot: false,
        hasPendingSelection: false,
        optionCount: 2,
        effectiveLoadMeaning: null,
      }),
    ).toEqual({ status: "choose_setup" });
  });

  it("asks for the load meaning when a snapshot exists but none is chosen", () => {
    expect(
      resolveSetLoggingEquipment({
        hasSetup: true,
        hasSnapshot: true,
        hasPendingSelection: false,
        optionCount: 1,
        effectiveLoadMeaning: null,
      }),
    ).toEqual({ status: "await_meaning" });
  });

  // Day 3 field incident: the Lat Pulldown carried a reviewed exact requirement,
  // but no saved equipment configuration matched, so there were zero options to
  // choose and no snapshot could form. Logging must NOT be trapped — it records
  // the displayed load honestly with no equipment snapshot.
  it("records displayed load when no setup can be resolved at all", () => {
    expect(
      resolveSetLoggingEquipment({
        hasSetup: true,
        hasSnapshot: false,
        hasPendingSelection: false,
        optionCount: 0,
        effectiveLoadMeaning: null,
      }),
    ).toEqual({ status: "log_displayed_unknown" });
  });

  it("records displayed load when the exercise has no equipment setup", () => {
    expect(
      resolveSetLoggingEquipment({
        hasSetup: false,
        hasSnapshot: false,
        hasPendingSelection: false,
        optionCount: 0,
        effectiveLoadMeaning: "legacy_unknown",
      }),
    ).toEqual({ status: "log_displayed_unknown" });
  });
});

describe("inline occurrence handoff", () => {
  const occurrence = (
    id: string,
    exerciseId: string | null,
    kind: SessionOccurrenceData["kind"] = "working_set",
    outcome: SessionOccurrenceData["outcome"] = "pending",
  ): SessionOccurrenceData => ({
    id,
    sessionExerciseId: exerciseId,
    kind,
    origin: "planned",
    sequenceIdx: Number(id),
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
    outcome,
    outcomeReason: null,
    outcomeNote: null,
    revision: 0,
    resolvedAt: null,
    completedSetId: null,
  });

  it("reveals the next exact working member and ignores warm-up controls", () => {
    const occurrences = [
      occurrence("1", null, "day_warmup"),
      occurrence("2", "deadlift"),
      occurrence("3", "press"),
      occurrence("4", "pulldown"),
    ];

    expect(nextPendingWorkingOccurrence(occurrences, "2")?.sessionExerciseId)
      .toBe("press");
    const afterDeadlift = [
      occurrence("1", null, "day_warmup"),
      occurrence("2", "deadlift", "working_set", "completed"),
      occurrence("3", "press"),
      occurrence("4", "pulldown"),
    ];
    expect(nextPendingWorkingOccurrence(afterDeadlift, "3")?.sessionExerciseId)
      .toBe("pulldown");
  });

  it("finishes an ungrouped exercise's added set before revealing another exercise", () => {
    const occurrences = [
      occurrence("set-1", "deadlift", "working_set", "completed"),
      occurrence("set-2", "deadlift", "working_set", "completed"),
      occurrence("set-3", "deadlift", "working_set", "completed"),
      occurrence("press-1", "press"),
      {
        ...occurrence("set-4-added", "deadlift"),
        origin: "ad_hoc" as const,
        kindOrdinal: 3,
        sequenceIdx: 99,
        plannedNote: "Added during this workout",
      },
    ];

    expect(nextPendingWorkingOccurrence(occurrences, "set-3")?.id)
      .toBe("set-4-added");
  });
});
