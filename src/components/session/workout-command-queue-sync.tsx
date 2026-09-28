"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  nextQueuedWorkoutCommand,
  readWorkoutCommandQueue,
  subscribeToWorkoutCommandQueue,
  registerWorkoutCommandQueueWakeListeners,
  workoutCommandQueuePauseReason,
} from "@/lib/workout-command-queue";
import { deploymentRecoveryRequired } from "@/lib/deployment-recovery";
import {
  releaseQueuedWorkoutSetBackoff,
  workoutCommandDeliveryLockSupported,
} from "@/lib/workout-set-outbox";
import { releaseQueuedEquipmentSelectionBackoff } from "@/lib/equipment-selection-outbox";
import { releaseOccurrenceMutationBackoff } from "@/lib/occurrence-mutation-outbox";
import {
  getLiveCoachOutboxSnapshot,
  retryLiveCoachMessage,
} from "@/lib/live-coach-outbox";
import { syncNextEntry } from "@/components/session/workout-set-outbox-sync";
import { syncNextOccurrenceMutation } from "@/components/session/occurrence-mutation-outbox-sync";
import { syncContextualNoteEntry } from "@/components/contextual-notes/contextual-note-outbox-sync";
import { syncLiveCoachEntry } from "@/components/session/live-coach-outbox-sync";

/** One lifecycle/retry driver. Domain components retain their recovery trays;
 * only this component starts automatic delivery. Transports reselect under the
 * shared owner lock, so another tab cannot send a stale snapshot.
 */
export function WorkoutCommandQueueSync({ ownerId }: { ownerId: string }) {
  const router = useRouter();
  const subscribe = useCallback(
    (listener: () => void) => subscribeToWorkoutCommandQueue(ownerId, listener),
    [ownerId],
  );
  const getPauseReason = useCallback(
    () => workoutCommandQueuePauseReason(ownerId),
    [ownerId],
  );
  const pauseReason = useSyncExternalStore(
    subscribe,
    getPauseReason,
    () => null,
  );
  useEffect(() => {
    let stopped = false;
    let running = false;
    let requested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshHistory = (sessionId: string) => {
      if (!stopped && window.location.pathname === `/history/${sessionId}`)
        router.refresh();
    };
    function schedule() {
      clearTimeout(timer);
      if (
        stopped ||
        deploymentRecoveryRequired() ||
        !navigator.onLine ||
        !workoutCommandDeliveryLockSupported() ||
        workoutCommandQueuePauseReason(ownerId)
      )
        return;
      const next = readWorkoutCommandQueue(ownerId)
        .filter(
          (command) =>
            command.entry.status === "queued" && command.entry.nextAttemptAtISO,
        )
        .map((command) => Date.parse(command.entry.nextAttemptAtISO!))
        .filter((time) => time > Date.now())
        .sort((a, b) => a - b)[0];
      if (next != null)
        timer = setTimeout(
          wake,
          Math.min(Math.max(next - Date.now(), 1), 300_000),
        );
    }
    async function drain() {
      if (running || stopped) return;
      running = true;
      const attempted = new Set<string>();
      try {
        for (let count = 0; count < 100 && !stopped; count++) {
          requested = false;
          if (
            deploymentRecoveryRequired() ||
            !navigator.onLine ||
            !workoutCommandDeliveryLockSupported() ||
            workoutCommandQueuePauseReason(ownerId)
          )
            break;
          const before = readWorkoutCommandQueue(ownerId);
          const command = nextQueuedWorkoutCommand(ownerId, before);
          if (!command) break;
          const identity = `${command.kind}:${command.entry.clientKey}`;
          if (attempted.has(identity)) break;
          attempted.add(identity);
          if (command.kind === "set" || command.kind === "selection")
            await syncNextEntry(ownerId);
          else if (command.kind === "occurrence")
            await syncNextOccurrenceMutation(ownerId);
          else if (command.kind === "note")
            await syncContextualNoteEntry(ownerId, command.entry);
          else await syncLiveCoachEntry(ownerId, command.entry, refreshHistory);
          // A storage failure or competing direct caller must not create a hot
          // loop. The durable copy remains available to the next lifecycle wake.
          if (
            JSON.stringify(before) ===
            JSON.stringify(readWorkoutCommandQueue(ownerId))
          ) {
            requested = false;
            break;
          }
          requested = true;
        }
      } catch {
        // Storage/transport exceptions do not remove data. Retry on a later
        // lifecycle wake, without an unhandled rejection or a busy loop.
        requested = false;
      } finally {
        running = false;
        schedule();
        if (requested && !stopped) {
          clearTimeout(timer);
          timer = setTimeout(wake, 0);
        }
      }
    }
    function wake() {
      requested = true;
      void drain();
    }
    async function online() {
      await Promise.all([
        releaseQueuedWorkoutSetBackoff(ownerId),
        releaseQueuedEquipmentSelectionBackoff(ownerId),
        releaseOccurrenceMutationBackoff(ownerId),
        ...getLiveCoachOutboxSnapshot()
          .entries.filter(
            (entry) => entry.ownerId === ownerId && entry.status === "queued",
          )
          .map((entry) => retryLiveCoachMessage(entry.clientKey)),
      ]);
      wake();
    }
    const unsubscribe = subscribeToWorkoutCommandQueue(ownerId, wake);
    const unregisterWake = registerWorkoutCommandQueueWakeListeners(
      wake,
      () => {
        void online().catch(wake);
      },
    );
    wake();
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
      unregisterWake();
    };
  }, [ownerId, router]);
  return pauseReason ? (
    <div
      role="status"
      className="m-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <p className="font-medium">Device saves paused</p>
      <p>{pauseReason}</p>
    </div>
  ) : null;
}
