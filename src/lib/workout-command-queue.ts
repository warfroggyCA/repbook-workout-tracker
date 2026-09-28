import {
  getWorkoutSetOutboxSnapshot,
  subscribeToWorkoutSetOutbox,
  withWorkoutCommandDeliveryLock,
  workoutCommandDeliveryLockSupported,
  type WorkoutSetOutboxEntry,
} from "@/lib/workout-set-outbox";
import {
  getEquipmentSelectionOutboxSnapshot,
  nextWorkoutCommand,
  subscribeToEquipmentSelectionOutbox,
  type EquipmentSelectionOutboxEntry,
} from "@/lib/equipment-selection-outbox";
import {
  getOccurrenceMutationOutboxSnapshot,
  subscribeToOccurrenceMutationOutbox,
  type OccurrenceMutationOutboxEntry,
} from "@/lib/occurrence-mutation-outbox";
import {
  getContextualNoteOutboxSnapshot,
  subscribeToContextualNoteOutbox,
  type ContextualNoteOutboxEntry,
} from "@/lib/contextual-note-outbox";
import {
  getLiveCoachOutboxSnapshot,
  subscribeToLiveCoachOutbox,
  type LiveCoachOutboxEntry,
} from "@/lib/live-coach-outbox";
import { deploymentRecoveryRequired } from "@/lib/deployment-recovery";

/** One delivery queue over the existing durable, versioned storage adapters.
 * Reading this union never migrates, rewrites or discards a retained command.
 */
export type WorkoutCommand =
  | { kind: "set"; entry: WorkoutSetOutboxEntry }
  | { kind: "selection"; entry: EquipmentSelectionOutboxEntry }
  | { kind: "occurrence"; entry: OccurrenceMutationOutboxEntry }
  | { kind: "note"; entry: ContextualNoteOutboxEntry }
  | { kind: "coach"; entry: LiveCoachOutboxEntry };

function compare(a: WorkoutCommand, b: WorkoutCommand) {
  return (
    Date.parse(a.entry.createdAtISO) - Date.parse(b.entry.createdAtISO) ||
    a.entry.clientKey.localeCompare(b.entry.clientKey) ||
    a.kind.localeCompare(b.kind)
  );
}

export function readWorkoutCommandQueue(ownerId: string): WorkoutCommand[] {
  return [
    ...getWorkoutSetOutboxSnapshot().entries.map((entry) => ({
      kind: "set" as const,
      entry,
    })),
    ...getEquipmentSelectionOutboxSnapshot().entries.map((entry) => ({
      kind: "selection" as const,
      entry,
    })),
    ...getOccurrenceMutationOutboxSnapshot().entries.map((entry) => ({
      kind: "occurrence" as const,
      entry,
    })),
    ...getContextualNoteOutboxSnapshot(ownerId).entries.map((entry) => ({
      kind: "note" as const,
      entry,
    })),
    ...getLiveCoachOutboxSnapshot().entries.map((entry) => ({
      kind: "coach" as const,
      entry,
    })),
  ]
    .filter((command) => command.entry.ownerId === ownerId)
    .sort(compare);
}

function ready(command: WorkoutCommand, now: number) {
  return (
    command.entry.status !== "needs_attention" &&
    (command.entry.status === "syncing" ||
      !command.entry.nextAttemptAtISO ||
      Date.parse(command.entry.nextAttemptAtISO) <= now)
  );
}

function isWorkoutMutation(
  command: WorkoutCommand,
): command is Extract<
  WorkoutCommand,
  { kind: "set" | "selection" | "occurrence" }
> {
  return (
    command.kind === "set" ||
    command.kind === "selection" ||
    command.kind === "occurrence"
  );
}

/** Preserve equipment dependencies and exact planned-order recovery. Across
 * mutation kinds, an earlier unresolved command fences the same workout.
 * Notes and Coach observations append evidence independently; their failures
 * cannot prevent the athlete from recording work.
 */
export function nextQueuedWorkoutCommand(
  ownerId: string,
  input: WorkoutCommand[],
  now = new Date(),
): WorkoutCommand | null {
  const commands = input
    .filter((command) => command.entry.ownerId === ownerId)
    .sort(compare);
  const exerciseIds = new Set(
    commands.flatMap((command) =>
      command.kind === "set" || command.kind === "selection"
        ? [command.entry.sessionExerciseId]
        : [],
    ),
  );
  const workoutCandidates = [...exerciseIds].flatMap((exerciseId) => {
    const selected = nextWorkoutCommand(
      ownerId,
      commands.flatMap((command) =>
        command.kind === "set" && command.entry.sessionExerciseId === exerciseId
          ? [command.entry]
          : [],
      ),
      commands.flatMap((command) =>
        command.kind === "selection" &&
        command.entry.sessionExerciseId === exerciseId
          ? [command.entry]
          : [],
      ),
      now,
    );
    return selected ? [selected] : [];
  });
  for (const command of commands) {
    if (!ready(command, now.getTime())) continue;
    if (
      (command.kind === "set" || command.kind === "selection") &&
      !workoutCandidates.some(
        (candidate) =>
          candidate.kind === command.kind &&
          candidate.entry.clientKey === command.entry.clientKey,
      )
    )
      continue;
    if (isWorkoutMutation(command)) {
      const blocked = commands.some((earlier) => {
        if (
          compare(earlier, command) >= 0 ||
          !isWorkoutMutation(earlier) ||
          earlier.entry.sessionId !== command.entry.sessionId
        )
          return false;
        // The established set/equipment selector owns ordering within its stream.
        if (command.kind !== "occurrence" && earlier.kind !== "occurrence")
          return false;
        // A retained later set explicitly requires this earlier occurrence to
        // resolve. Never deadlock the recovery action behind that retained set.
        if (
          command.kind === "occurrence" &&
          earlier.kind === "set" &&
          earlier.entry.orderBlocker?.occurrenceId ===
            command.entry.occurrenceId &&
          (command.entry.operation === "complete" ||
            command.entry.operation === "skip")
        )
          return false;
        if (command.kind === "occurrence" && earlier.kind === "occurrence") {
          return earlier.entry.occurrenceId === command.entry.occurrenceId;
        }
        return true;
      });
      if (blocked) continue;
    }
    return command;
  }
  return null;
}

/** Unknown mutation envelopes cannot be ordered safely. Keep their recovery
 * trays and raw bytes intact instead of sending later writes around them. */
export function workoutCommandQueuePauseReason(ownerId: string): string | null {
  const sets = getWorkoutSetOutboxSnapshot();
  const selections = getEquipmentSelectionOutboxSnapshot();
  const occurrences = getOccurrenceMutationOutboxSnapshot();
  if (
    sets.error ||
    selections.error ||
    occurrences.error ||
    sets.quarantined.length ||
    selections.quarantined.length
  ) {
    return "Review the saved changes on this device before more changes can be sent. Unreadable copies have been kept for recovery.";
  }
  if (
    !workoutCommandDeliveryLockSupported() &&
    readWorkoutCommandQueue(ownerId).length
  ) {
    return "This browser cannot safely coordinate device saves across tabs. Your saved copies are still on this device.";
  }
  return null;
}

/** Called by every transport, including direct retry callers. The candidate is
 * re-read after acquiring the real cross-tab lock, never from a React snapshot.
 */
export async function deliverNextWorkoutCommand<T>(
  ownerId: string,
  accepts: (command: WorkoutCommand) => boolean,
  deliver: (command: WorkoutCommand) => Promise<T>,
): Promise<T | null> {
  if (
    !workoutCommandDeliveryLockSupported() ||
    deploymentRecoveryRequired() ||
    !navigator.onLine ||
    workoutCommandQueuePauseReason(ownerId)
  )
    return null;
  return withWorkoutCommandDeliveryLock(ownerId, async () => {
    if (
      deploymentRecoveryRequired() ||
      !navigator.onLine ||
      workoutCommandQueuePauseReason(ownerId)
    )
      return null;
    const command = nextQueuedWorkoutCommand(
      ownerId,
      readWorkoutCommandQueue(ownerId),
    );
    if (!command || !accepts(command)) return null;
    return deliver(command);
  });
}

export const WORKOUT_COMMAND_QUEUE_WAKE = "workout-command-queue-wake";
export function wakeWorkoutCommandQueue() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(WORKOUT_COMMAND_QUEUE_WAKE));
}

export function subscribeToWorkoutCommandQueue(
  ownerId: string,
  wake: () => void,
) {
  const unsubscribers = [
    subscribeToWorkoutSetOutbox(wake),
    subscribeToEquipmentSelectionOutbox(wake),
    subscribeToOccurrenceMutationOutbox(wake),
    subscribeToContextualNoteOutbox(ownerId, wake),
    subscribeToLiveCoachOutbox(wake),
  ];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

export function registerWorkoutCommandQueueWakeListeners(
  wake: () => void,
  online: () => void = wake,
) {
  const visible = () => {
    if (document.visibilityState === "visible") wake();
  };
  window.addEventListener(WORKOUT_COMMAND_QUEUE_WAKE, wake);
  window.addEventListener("online", online);
  window.addEventListener("focus", wake);
  window.addEventListener("pageshow", wake);
  document.addEventListener("visibilitychange", visible);
  return () => {
    window.removeEventListener(WORKOUT_COMMAND_QUEUE_WAKE, wake);
    window.removeEventListener("online", online);
    window.removeEventListener("focus", wake);
    window.removeEventListener("pageshow", wake);
    document.removeEventListener("visibilitychange", visible);
  };
}
