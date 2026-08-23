import type {
  SessionExerciseData,
  SessionOccurrenceData,
  LoggedSet,
} from "@/components/session/types";
import type { EquipmentSelectionOccurrenceState } from "@/services/session-equipment-selection";
import type {
  WorkoutSetLoadEntryMeaning,
  WorkoutSetOrderBlocker,
  WorkoutSetOutboxEntry,
  WorkoutSetOutboxSnapshot,
} from "@/lib/workout-set-outbox";

export function workoutSetOrderBlockerTargetId(
  blocker: WorkoutSetOrderBlocker,
): string | null {
  if (blocker.kind === "day_warmup" || blocker.kind === "exercise_warmup") {
    return `warmup-occurrence-${blocker.occurrenceId}`;
  }
  if (blocker.sessionExerciseId == null) return null;
  const prefix = blocker.isAddedSet ? "added-set-entry" : "set-entry";
  return `${prefix}-${blocker.sessionExerciseId}-${blocker.occurrenceId}`;
}

export function shouldShowMissingWarmupMessage(input: {
  dayWarmupNotes: string | null;
  hasStructuredWarmup: boolean;
}): boolean {
  return !input.dayWarmupNotes && !input.hasStructuredWarmup;
}

export function restTimerSecondsAfterQueuedSet(input: {
  plannedRestSeconds: number | null | undefined;
  pendingActionCount: number;
}): number | null | undefined {
  return input.pendingActionCount > 1 ? input.plannedRestSeconds : null;
}

export type RuntimeSetSaveState = "saving" | "retrying";

export function queuedSetSaveState(
  entry: Pick<
    WorkoutSetOutboxEntry,
    "status" | "attemptCount" | "lastAttemptAtISO"
  >,
  runtimeState: RuntimeSetSaveState | undefined,
): LoggedSet["saveState"] {
  if (entry.status === "needs_attention") return "failed";
  if (
    runtimeState === "retrying" ||
    (runtimeState === "saving" &&
      (entry.attemptCount > 0 || entry.lastAttemptAtISO != null))
  ) {
    return "retrying";
  }
  return runtimeState ?? "pending";
}

export function skipRecoveryNeedsReconciliation(input: {
  markerRunnerInstanceId: string | null;
  currentRunnerInstanceId: string;
}): boolean {
  return input.markerRunnerInstanceId == null ||
    input.markerRunnerInstanceId !== input.currentRunnerInstanceId;
}

/**
 * Merge a refreshed server occurrence ledger without erasing device work that
 * still has an owning durable command or a just-acknowledged server receipt.
 * A discarded optimistic change has neither, so refreshed server truth wins.
 */
export function reconcileServerOccurrences({
  current,
  server,
  previousServerIds,
  pendingMutationOccurrenceIds,
  acknowledgedOccurrenceIds,
}: {
  current: SessionOccurrenceData[];
  server: SessionOccurrenceData[];
  previousServerIds: ReadonlySet<string>;
  pendingMutationOccurrenceIds: ReadonlySet<string>;
  acknowledgedOccurrenceIds: ReadonlySet<string>;
}): SessionOccurrenceData[] {
  const nextServerIds = new Set(server.map((occurrence) => occurrence.id));
  const currentById = new Map(
    current.map((occurrence) => [occurrence.id, occurrence]),
  );
  const reconciled = server.map((serverOccurrence) => {
    const localOccurrence = currentById.get(serverOccurrence.id);
    // A Server Action response can commit its refreshed RSC tree before the
    // awaiting outbox worker removes the device command and publishes its
    // acknowledgement. Keep that exact device-owned occurrence current until
    // the command is acknowledged or deliberately removed, even when the RSC
    // row already carries the next server revision.
    if (
      localOccurrence != null &&
      pendingMutationOccurrenceIds.has(localOccurrence.id)
    ) {
      return localOccurrence;
    }
    const localRevisionIsStillOwned =
      localOccurrence != null &&
      (
        acknowledgedOccurrenceIds.has(localOccurrence.id) ||
        (
          localOccurrence.kind === "working_set" &&
          localOccurrence.outcome === "completed" &&
          localOccurrence.completedSetId != null
        )
      );
    return localOccurrence &&
        localOccurrence.revision > serverOccurrence.revision &&
        localRevisionIsStillOwned
      ? localOccurrence
      : serverOccurrence;
  });
  for (const localOccurrence of current) {
    if (
      !nextServerIds.has(localOccurrence.id) &&
      !previousServerIds.has(localOccurrence.id)
    ) {
      reconciled.push(localOccurrence);
    }
  }
  return reconciled.sort((left, right) => left.sequenceIdx - right.sequenceIdx);
}

export function mergeEquipmentSelectionOccurrenceStates(
  current: SessionOccurrenceData[],
  received: EquipmentSelectionOccurrenceState[],
): SessionOccurrenceData[] {
  const byId = new Map(received.map((state) => [state.id, state]));
  return current.map((occurrence) => {
    const state = byId.get(occurrence.id);
    if (!state || state.revision < occurrence.revision) return occurrence;
    return {
      ...occurrence,
      outcome: state.outcome as SessionOccurrenceData["outcome"],
      outcomeReason: state.outcomeReason,
      outcomeNote: state.outcomeNote,
      revision: state.revision,
      resolvedAt: state.resolvedAt,
      completedSetId: state.completedSetId,
    };
  });
}

export function mergeSessionOutboxSets(
  exercises: SessionExerciseData[],
  entries: WorkoutSetOutboxEntry[],
  runtimeSaveStates: Record<string, RuntimeSetSaveState>
): SessionExerciseData[] {
  const queuedByExercise = new Map<string, WorkoutSetOutboxEntry[]>();
  for (const entry of entries) {
    const current = queuedByExercise.get(entry.sessionExerciseId) ?? [];
    current.push(entry);
    queuedByExercise.set(entry.sessionExerciseId, current);
  }
  return exercises.map((exercise) => {
    const sets = [...exercise.sets];
    for (const entry of queuedByExercise.get(exercise.id) ?? []) {
      const saveState = queuedSetSaveState(
        entry,
        runtimeSaveStates[entry.clientKey],
      );
      const index = sets.findIndex((set) => set.clientKey === entry.clientKey);
      const queuedSet: LoggedSet = {
        id: `outbox-${entry.clientKey}`,
        clientKey: entry.clientKey,
        occurrenceId: entry.occurrenceId ?? null,
        setNo: entry.setNo,
        weight: entry.weight,
        weightUnit: entry.weightUnit,
        reps: entry.reps,
        metricType: entry.metricType,
        distanceKm: entry.distanceKm,
        durationSeconds: entry.durationSeconds,
        rpe: entry.rpe,
        note: entry.note,
        saveState,
        lastError: entry.lastError,
      };
      if (index < 0) sets.push(queuedSet);
      else sets[index] = { ...sets[index], ...queuedSet };
    }
    sets.sort((left, right) => left.setNo - right.setNo);
    return { ...exercise, sets };
  });
}

export function workoutFinishIsBlocked(
  sessionEntries: WorkoutSetOutboxEntry[],
  _outbox: Pick<WorkoutSetOutboxSnapshot, "quarantined" | "error">
): boolean {
  void _outbox;
  // Quarantined or unreadable storage cannot be attributed to this session.
  // It remains protected in the global review tray, but must not be treated as
  // current-workout data or trap an unrelated workout.
  return sessionEntries.length > 0;
}

export function sessionScopedDeviceCopies<
  SetCopy extends { ownerId: string; sessionId: string },
  OccurrenceCopy extends { ownerId: string; sessionId: string },
>(input: {
  ownerId: string;
  sessionId: string;
  setCopies: readonly SetCopy[];
  occurrenceCopies: readonly OccurrenceCopy[];
}) {
  return {
    setCopies: input.setCopies.filter(
      (entry) =>
        entry.ownerId === input.ownerId && entry.sessionId === input.sessionId,
    ),
    occurrenceCopies: input.occurrenceCopies.filter(
      (entry) =>
        entry.ownerId === input.ownerId && entry.sessionId === input.sessionId,
    ),
  };
}

/**
 * The device-only work queues that can be outstanding when a user tries to
 * finish or exit an active workout. Recorded-work queues (sets and occurrence
 * changes) represent performed or intended results that must not vanish
 * silently. Equipment selection is future-set *guidance*, not recorded work.
 */
export type WorkoutExitQueues = {
  /** Logged sets held only on this device and not confirmed by the server. */
  unsyncedSetCount: number;
  /** Unreadable set copies only when ownership is positively session-scoped. */
  quarantinedSetCount: number;
  setHasError: boolean;
  /** Warm-up/occurrence changes queued on this device and not yet confirmed. */
  unsyncedOccurrenceCount: number;
  occurrenceHasError: boolean;
  /** Equipment-setup selections queued on this device (guidance only). */
  unsyncedEquipmentCount: number;
  quarantinedEquipmentCount: number;
  equipmentHasError: boolean;
};

/**
 * Recorded performed-work or occurrence-truth copies that live only on this
 * device. Finishing or exiting without resolving these would silently drop
 * recorded work, so the finish flow must require an explicit retry or an
 * explicit removal first — but both of those actions stay reachable, so the
 * workout is never trapped.
 */
export function retainedRecordedWorkCount(queues: WorkoutExitQueues): number {
  return (
    queues.unsyncedSetCount +
    queues.quarantinedSetCount +
    queues.unsyncedOccurrenceCount
  );
}

/**
 * Equipment selection is guidance for a future set, not recorded performed
 * work. An unsynced, failed, or unreadable equipment command must never block
 * finishing or exiting the workout — the Day 3 field incident was exactly this
 * over-block. It is surfaced informationally instead.
 */
export function equipmentSyncPending(queues: WorkoutExitQueues): boolean {
  return (
    queues.unsyncedEquipmentCount > 0 ||
    queues.quarantinedEquipmentCount > 0 ||
    queues.equipmentHasError
  );
}

/**
 * Finishing is gated ONLY by unresolved recorded work, never by equipment
 * guidance. Even when this is true the finish flow exposes retry and explicit
 * per-queue discard actions, so the block is always resolvable and the workout
 * is never inescapable.
 */
export function finishBlockedByRecordedWork(queues: WorkoutExitQueues): boolean {
  return (
    retainedRecordedWorkCount(queues) > 0 ||
    queues.setHasError ||
    queues.occurrenceHasError
  );
}

/**
 * Discarding/exiting must always be reachable. Device-only recorded copies are
 * not a reason to trap the user inside the workout: when they remain, the exit
 * flow offers an explicit destructive removal instead of disabling the control.
 * This helper reports whether that explicit acknowledgement is required.
 */
export function exitRequiresDeviceCopyAcknowledgement(
  queues: WorkoutExitQueues,
): boolean {
  return (
    queues.unsyncedSetCount > 0 ||
    queues.quarantinedSetCount > 0 ||
    queues.setHasError ||
    queues.unsyncedOccurrenceCount > 0 ||
    queues.occurrenceHasError
  );
}

export function workoutSaveQueueMessage(input: {
  equipmentError: string | null;
  occurrenceError: string | null;
  setError: string | null;
  occurrenceCount: number;
  occurrenceQuarantineCount: number;
  equipmentCount: number;
  equipmentQuarantineCount: number;
  setCount: number;
  setQuarantineCount: number;
}) {
  if (input.equipmentError) return input.equipmentError;
  if (input.occurrenceError) return input.occurrenceError;
  if (input.setError) return input.setError;
  if (input.occurrenceCount > 0) {
    return `${input.occurrenceCount} workout change${input.occurrenceCount === 1 ? " is" : "s are"} still saving. Try again or discard ${input.occurrenceCount === 1 ? "it" : "them"} under Unsaved workout changes before finishing.`;
  }
  if (input.occurrenceQuarantineCount > 0) {
    return `We can't read ${input.occurrenceQuarantineCount} saved workout change${input.occurrenceQuarantineCount === 1 ? "" : "s"}. Open Unsaved workout changes and discard ${input.occurrenceQuarantineCount === 1 ? "it" : "them"} before finishing.`;
  }
  if (input.equipmentQuarantineCount > 0) {
    return `We can't read ${input.equipmentQuarantineCount} saved equipment choice${input.equipmentQuarantineCount === 1 ? "" : "s"}. Open Equipment changes and discard ${input.equipmentQuarantineCount === 1 ? "it" : "them"} before finishing.`;
  }
  if (input.equipmentCount > 0) {
    return `${input.equipmentCount} equipment choice${input.equipmentCount === 1 ? " is" : "s are"} still saving. Try again or remove ${input.equipmentCount === 1 ? "it" : "them"} under Equipment changes before finishing.`;
  }
  if (input.setQuarantineCount > 0) {
    return `We can't read ${input.setQuarantineCount} set${input.setQuarantineCount === 1 ? "" : "s"} saved on this device. Open Sets waiting to save and discard ${input.setQuarantineCount === 1 ? "it" : "them"} before finishing.`;
  }
  return `${input.setCount} set${input.setCount === 1 ? " is" : "s are"} still saving. Try again or remove ${input.setCount === 1 ? "it" : "them"} before finishing.`;
}

export function previousComparableIsTemporarilyUnavailable(input: {
  equipmentOutboxHydrated: boolean;
  equipmentState: "safe" | "pending_or_failed" | "unreadable";
  awaitingServerRefresh: boolean;
}) {
  return !input.equipmentOutboxHydrated ||
    input.equipmentState !== "safe" ||
    input.awaitingServerRefresh;
}

export type SetLoggingEquipmentDecision =
  | { status: "log_with_snapshot"; loadEntryMeaning: WorkoutSetLoadEntryMeaning }
  | { status: "log_displayed_unknown" }
  | { status: "choose_setup" }
  | { status: "await_meaning" };

/**
 * Decide how a logged set carries its equipment context without ever trapping
 * the workout on missing equipment information.
 *
 * - A resolved snapshot or a pending selection logs with that equipment context.
 * - A setup that still offers reviewed physical choices asks the user to pick.
 * - A setup with a known load meaning but none yet chosen asks for the meaning.
 * - A setup that cannot be resolved at all (no reviewed configuration matches
 *   the owner's saved equipment, so there is nothing to choose) records the
 *   displayed load honestly with no equipment snapshot. This reuses the durable
 *   `legacy_unknown` + null-snapshot shape the schema already allows, so no
 *   migration is required and equipment uncertainty never blocks logging.
 */
export function resolveSetLoggingEquipment(input: {
  hasSetup: boolean;
  hasSnapshot: boolean;
  hasPendingSelection: boolean;
  optionCount: number;
  effectiveLoadMeaning: WorkoutSetLoadEntryMeaning | null;
}): SetLoggingEquipmentDecision {
  if (!input.hasSetup) return { status: "log_displayed_unknown" };
  if (input.hasSnapshot || input.hasPendingSelection) {
    if (input.effectiveLoadMeaning == null) return { status: "await_meaning" };
    return {
      status: "log_with_snapshot",
      loadEntryMeaning: input.effectiveLoadMeaning,
    };
  }
  if (input.optionCount > 0) return { status: "choose_setup" };
  return { status: "log_displayed_unknown" };
}

export function nextIncompleteExerciseId(
  exercises: SessionExerciseData[],
  completedExerciseId: string
): string | null {
  const completedIndex = exercises.findIndex(
    (exercise) => exercise.id === completedExerciseId
  );
  return (
    exercises.slice(completedIndex + 1).find(
      (exercise) =>
        exercise.modificationType !== "skipped" &&
        (exercise.targetSets == null || exercise.sets.length < exercise.targetSets)
    )?.id ?? null
  );
}

/** Keep the inline card in lockstep with durable grouped/ungrouped sequence. */
export function nextPendingWorkingOccurrence(
  occurrences: SessionOccurrenceData[],
  resolvedOccurrenceId: string,
): SessionOccurrenceData | null {
  const resolved = occurrences.find(
    (occurrence) => occurrence.id === resolvedOccurrenceId,
  );
  if (resolved?.sessionExerciseId && resolved.groupSnapshotId == null) {
    const nextForExercise = occurrences.find(
      (occurrence) =>
        occurrence.id !== resolvedOccurrenceId &&
        occurrence.kind === "working_set" &&
        occurrence.outcome === "pending" &&
        occurrence.sessionExerciseId === resolved.sessionExerciseId &&
        occurrence.groupSnapshotId == null,
    );
    if (nextForExercise) return nextForExercise;
  }
  return occurrences.find(
    (occurrence) =>
      occurrence.id !== resolvedOccurrenceId &&
      occurrence.kind === "working_set" &&
      occurrence.outcome === "pending" &&
      occurrence.sessionExerciseId != null,
  ) ?? null;
}
