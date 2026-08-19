import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  equipmentSyncPending,
  exitRequiresDeviceCopyAcknowledgement,
  finishBlockedByRecordedWork,
  nextPendingWorkingOccurrence,
  queuedSetSaveState,
  reconcileServerOccurrences,
  resolveSetLoggingEquipment,
  retainedRecordedWorkCount,
  sessionScopedDeviceCopies,
  skipRecoveryNeedsReconciliation,
  workoutSaveQueueMessage,
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
  it("selects only exact current-session copies for destructive exit", () => {
    const currentSet = { ownerId: "owner", sessionId: "current", clientKey: "current-set" };
    const foreignSet = { ownerId: "owner", sessionId: "foreign", clientKey: "foreign-set" };
    const foreignOwnerSet = { ownerId: "other", sessionId: "current", clientKey: "other-owner-set" };
    const currentOccurrence = {
      ownerId: "owner",
      sessionId: "current",
      clientKey: "current-occurrence",
    };
    const foreignOccurrence = {
      ownerId: "owner",
      sessionId: "foreign",
      clientKey: "foreign-occurrence",
    };
    expect(sessionScopedDeviceCopies({
      ownerId: "owner",
      sessionId: "current",
      setCopies: [foreignSet, foreignOwnerSet, currentSet],
      occurrenceCopies: [currentOccurrence, foreignOccurrence],
    })).toEqual({
      setCopies: [currentSet],
      occurrenceCopies: [currentOccurrence],
    });

    const discardSource = readFileSync(
      "src/components/session/active-workout-actions.tsx",
      "utf8",
    );
    expect(discardSource).not.toContain("discardQuarantinedWorkoutSet");
    expect(discardSource).not.toContain(
      "discardUnreadableOccurrenceMutationOutbox",
    );
    expect(discardSource).toContain("At confirmation, Repbook");
    expect(discardSource).toContain(
      "workout-item copies found then are permanently removed",
    );
    expect(discardSource).toContain("showCloseButton={!pending}");
  });

  it("does not block finishing when every queue is clear", () => {
    expect(finishBlockedByRecordedWork(EMPTY)).toBe(false);
    expect(equipmentSyncPending(EMPTY)).toBe(false);
    expect(exitRequiresDeviceCopyAcknowledgement(EMPTY)).toBe(false);
  });

  it("names the current set blocker instead of an unrelated quarantine", () => {
    expect(workoutSaveQueueMessage({
      equipmentError: null,
      occurrenceError: null,
      setError: null,
      occurrenceCount: 0,
      occurrenceQuarantineCount: 0,
      equipmentCount: 0,
      equipmentQuarantineCount: 0,
      setCount: 1,
      setQuarantineCount: 0,
    })).toBe("1 set is still saving. Try again or remove it before finishing.");
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

    const positivelyScopedQuarantinedSet: WorkoutExitQueues = {
      ...EMPTY,
      quarantinedSetCount: 1,
    };
    expect(finishBlockedByRecordedWork(positivelyScopedQuarantinedSet)).toBe(true);
    expect(exitRequiresDeviceCopyAcknowledgement(positivelyScopedQuarantinedSet)).toBe(true);
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

  it("does not let the runner downgrade unreadable recorded work to a non-blocking foreign copy", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    expect(source).toContain(
      "quarantinedSetCount: latestSetQueue.quarantined.length",
    );
    expect(source).toContain(
      "occurrenceHasError: latestOccurrenceQueue.error != null",
    );
    expect(source).toContain(
      "Finish is blocked so it cannot silently",
    );
    expect(source).not.toContain(
      "separate or unreadable device copy",
    );
  });

  it("retains and replays the exact extra-set command across an unconfirmed action", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    const retain = source.indexOf("!writeAppendSetRecovery(");
    const dispatch = source.indexOf("appendWorkoutSet(command)");
    expect(retain).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(retain);
    expect(source).toContain(
      "withDocumentActionDeadline(\n        appendWorkoutSet(command)",
    );
    expect(source).toContain("reportDocumentActionTimeout()");
    expect(source).toMatch(
      /retained\.sessionExerciseId,\s+retained\.occurrenceId,\s+retained\.expectedSetNo/,
    );
    expect(source).toContain("appendRecoveryMarker != null ||");
    expect(source).toContain(
      "Reload Repbook to retry the retained extra set safely.",
    );
  });
});

describe("queued set save presentation", () => {
  it("does not let a stale saving event hide durable retry metadata", () => {
    expect(queuedSetSaveState({
      status: "queued",
      attemptCount: 1,
      lastAttemptAtISO: "2026-08-16T18:00:00.000Z",
    }, "saving")).toBe("retrying");

    expect(queuedSetSaveState({
      status: "queued",
      attemptCount: 0,
      lastAttemptAtISO: null,
    }, "saving")).toBe("saving");

    expect(queuedSetSaveState({
      status: "needs_attention",
      attemptCount: 3,
      lastAttemptAtISO: "2026-08-16T18:00:00.000Z",
    }, "retrying")).toBe("failed");
  });
});

describe("occurrence discard continuity", () => {
  it("keeps the fixed dock in checking mode through skip revision settlement", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    expect(source).toContain(
      "skipRecoveryExerciseId != null && historyRevision > props.historyRevision",
    );
    expect(source).toContain(
      "skipRecoverySettlementPending ||\n            skipRecoveryExerciseId == null",
    );
    expect(source).toContain(
      "skipConfirmationExerciseId ?? skipRecoveryExerciseId",
    );
  });

  it("removes the unsaved command without reloading or navigating the workout", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    expect(source).toContain('type: "discarded"');
    expect(source).not.toContain("window.location.reload");
  });
});

describe("interrupted skip recovery", () => {
  it("reconciles legacy and prior-runner markers but not this runner's request", () => {
    expect(skipRecoveryNeedsReconciliation({
      markerRunnerInstanceId: null,
      currentRunnerInstanceId: "runner-2",
    })).toBe(true);
    expect(skipRecoveryNeedsReconciliation({
      markerRunnerInstanceId: "runner-1",
      currentRunnerInstanceId: "runner-2",
    })).toBe(true);
    expect(skipRecoveryNeedsReconciliation({
      markerRunnerInstanceId: "runner-2",
      currentRunnerInstanceId: "runner-2",
    })).toBe(false);
  });

  it("invalidates async recovery callbacks when the workout runner unmounts", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    expect(source).toContain("runnerActiveRef.current = false");
    expect(source).toContain("if (!runnerActiveRef.current) return;");
    expect(source).toContain("if (!runnerActiveRef.current) return;\n              patchExercise");
  });

  it("bounds un-skip reconciliation so its retained marker cannot trap the document", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    expect(source).toContain(
      "withDocumentActionDeadline(\n        confirmExerciseUnskipped({",
    );
    expect(source).toContain("reportDocumentActionTimeout()");
    expect(source).toContain(
      "Reload to reconcile the retained request safely.",
    );
  });

  it("keeps both workout-header exits independent of a pending App Router action", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    expect(source).not.toContain('import Link from "next/link"');
    expect(source.match(/<a\s+href="\/today"/g)).toHaveLength(2);
  });
});

describe("atomic finish handoff", () => {
  it("rechecks both durable recorded-work queues while their enqueue locks are held", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    expect(source).toContain("withOutboxLock(() =>");
    expect(source).toContain("withOccurrenceMutationOutboxLock(async () =>");
    expect(source).toContain("const latestSetQueue = getWorkoutSetOutboxSnapshot()");
    expect(source).toContain(
      "const latestOccurrenceQueue = getOccurrenceMutationOutboxSnapshot()",
    );
    expect(source.indexOf("finishBlockedByRecordedWork(freshExitQueues)")).toBeLessThan(
      source.indexOf("completeSession(completionInput)"),
    );
  });

  it("retains an exact finish command before a bounded completion action", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    const retain = source.indexOf("!writeFinishRecovery(");
    const dispatch = source.indexOf("completeSession(completionInput)");
    expect(retain).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(retain);
    expect(source).toContain(
      "withDocumentActionDeadline(\n            completeSession(completionInput)",
    );
    expect(source).toContain("readFinishRecovery(");
    expect(source).toContain("workout-tracker:finish-recovery:v2:");
    expect(source).toContain("workout-tracker:finish-recovery:v1:");
    expect(source).toContain("readLegacyFinishRecovery(");
    expect(source).toContain("!finishRecoveryHydrated ||");
    expect(source).toContain(
      "Your exact finish details are retained. Reload to retry safely.",
    );
  });
});

describe("refreshed occurrence reconciliation", () => {
  const occurrence = (
    revision: number,
    outcome: SessionOccurrenceData["outcome"],
    completedSetId: string | null = null,
  ): SessionOccurrenceData => ({
    id: "occurrence-1",
    sessionExerciseId: "exercise-1",
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
    outcome,
    outcomeReason: null,
    outcomeNote: null,
    revision,
    resolvedAt: outcome === "pending" ? null : "2026-08-12T12:00:00.000Z",
    completedSetId,
  });

  it("accepts a newer server occurrence revision after refresh", () => {
    const merged = reconcileServerOccurrences({
      current: [occurrence(0, "pending")],
      server: [occurrence(1, "skipped")],
      previousServerIds: new Set(["occurrence-1"]),
      pendingMutationOccurrenceIds: new Set(),
      acknowledgedOccurrenceIds: new Set(),
    });

    expect(merged[0]).toMatchObject({ revision: 1, outcome: "skipped" });
  });

  it("preserves a newer optimistic occurrence while its durable command exists", () => {
    const merged = reconcileServerOccurrences({
      current: [occurrence(1, "skipped")],
      server: [occurrence(0, "pending")],
      previousServerIds: new Set(["occurrence-1"]),
      pendingMutationOccurrenceIds: new Set(["occurrence-1"]),
      acknowledgedOccurrenceIds: new Set(),
    });

    expect(merged[0]).toMatchObject({ revision: 1, outcome: "skipped" });
  });

  it("does not expose a newer action re-render before device acknowledgement", () => {
    const merged = reconcileServerOccurrences({
      current: [occurrence(0, "pending")],
      server: [occurrence(1, "skipped")],
      previousServerIds: new Set(["occurrence-1"]),
      pendingMutationOccurrenceIds: new Set(["occurrence-1"]),
      acknowledgedOccurrenceIds: new Set(),
    });

    expect(merged[0]).toMatchObject({ revision: 0, outcome: "pending" });
  });

  it("keeps pending command ownership exact to its occurrence", () => {
    const secondCurrent = {
      ...occurrence(0, "pending"),
      id: "occurrence-2",
      sequenceIdx: 1,
    };
    const secondServer = {
      ...occurrence(1, "skipped"),
      id: "occurrence-2",
      sequenceIdx: 1,
    };
    const merged = reconcileServerOccurrences({
      current: [occurrence(0, "pending"), secondCurrent],
      server: [occurrence(1, "skipped"), secondServer],
      previousServerIds: new Set(["occurrence-1", "occurrence-2"]),
      pendingMutationOccurrenceIds: new Set(["occurrence-1"]),
      acknowledgedOccurrenceIds: new Set(),
    });

    expect(merged).toMatchObject([
      { id: "occurrence-1", revision: 0, outcome: "pending" },
      { id: "occurrence-2", revision: 1, outcome: "skipped" },
    ]);
  });

  it("restores server truth after an optimistic occurrence command is discarded", () => {
    const merged = reconcileServerOccurrences({
      current: [occurrence(1, "skipped")],
      server: [occurrence(0, "pending")],
      previousServerIds: new Set(["occurrence-1"]),
      pendingMutationOccurrenceIds: new Set(),
      acknowledgedOccurrenceIds: new Set(),
    });

    expect(merged[0]).toMatchObject({ revision: 0, outcome: "pending" });
  });

  it("keeps a just-acknowledged saved set until refreshed props catch up", () => {
    const merged = reconcileServerOccurrences({
      current: [occurrence(1, "completed", "set-1")],
      server: [occurrence(0, "pending")],
      previousServerIds: new Set(["occurrence-1"]),
      pendingMutationOccurrenceIds: new Set(),
      acknowledgedOccurrenceIds: new Set(),
    });

    expect(merged[0]).toMatchObject({
      revision: 1,
      outcome: "completed",
      completedSetId: "set-1",
    });
  });
});

describe("active-workout disclosure ownership", () => {
  it("invalidates queued automatic handoffs after a manual exercise toggle", () => {
    const source = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    expect(source).toContain("exerciseDisclosureGenerationRef.current += 1");
    expect(source.match(
      /exerciseDisclosureGenerationRef\.current !== disclosureGeneration/g,
    )).toHaveLength(3);
    expect(source.indexOf("exerciseDisclosureGenerationRef.current += 1"))
      .toBeLessThan(source.indexOf(
        "setExpandedId(expandedId === exercise.id ? null : exercise.id)",
      ));
    const handoffConsumption = [
      "previousCurrentActionIdRef.current = currentActionId;",
      "previousCurrentActionKindRef.current = currentActionKind;",
    ];
    for (const assignment of handoffConsumption) {
      expect(source.lastIndexOf(assignment)).toBeGreaterThan(
        source.indexOf("exerciseDisclosureGenerationRef.current += 1"),
      );
    }
    expect(
      source.indexOf(
        "previousCurrentActionIdRef.current = currentActionId;",
        source.indexOf("const revealCurrentAction = () =>"),
      ),
    ).toBeGreaterThan(
      source.indexOf("focusTarget.focus({ preventScroll: true });"),
    );
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
