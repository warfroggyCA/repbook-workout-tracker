"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowUpFromLine } from "lucide-react";
import {
  getWorkoutSetOutboxSnapshot,
  subscribeToWorkoutSetOutbox,
} from "@/lib/workout-set-outbox";
import {
  getOccurrenceMutationOutboxSnapshot,
  subscribeToOccurrenceMutationOutbox,
} from "@/lib/occurrence-mutation-outbox";
import {
  describeSessionDeviceWork,
  sessionDeviceWorkIsClear,
  summarizeSessionDeviceWork,
  UNAVAILABLE_SESSION_DEVICE_WORK,
  type SessionDeviceWork,
} from "@/lib/resume-device-work";

export type ResumeUpNext = {
  title: string;
  detail: string | null;
};

/** Server render and pre-hydration: nothing has been read, so claim nothing. */
const NOT_READ = "not-read";

/**
 * Reads this device's recorded-work queues for one session. Exported so the
 * fail-closed paths can be exercised without a browser.
 */
export function readSessionDeviceWork(
  ownerId: string,
  sessionId: string,
  readers: {
    storageAvailable: () => boolean;
    sets: typeof getWorkoutSetOutboxSnapshot;
    changes: typeof getOccurrenceMutationOutboxSnapshot;
  } = {
    storageAvailable: () => {
      try {
        return window.localStorage != null;
      } catch {
        return false;
      }
    },
    sets: getWorkoutSetOutboxSnapshot,
    changes: getOccurrenceMutationOutboxSnapshot,
  },
): SessionDeviceWork {
  try {
    // The queue readers return an empty snapshot when storage is refused;
    // that must read as unknown here, never as nothing waiting.
    if (!readers.storageAvailable()) return UNAVAILABLE_SESSION_DEVICE_WORK;
    return summarizeSessionDeviceWork({
      ownerId,
      sessionId,
      sets: readers.sets(),
      changes: readers.changes(),
    });
  } catch {
    return UNAVAILABLE_SESSION_DEVICE_WORK;
  }
}

/**
 * Resume-card status for recorded work this device may still hold, plus the
 * next saved step. Up next is shown only when every recorded-work queue was
 * read and holds nothing for this workout.
 */
export function ResumeWorkoutStatus({
  ownerId,
  sessionId,
  upNext,
  positionVersion,
}: {
  ownerId: string;
  sessionId: string;
  upNext: ResumeUpNext | null;
  positionVersion: string;
}) {
  const router = useRouter();
  const [invalidatedVersion, setInvalidatedVersion] = useState<string | null>(null);
  const subscribe = useCallback((listener: () => void) => {
    const onChange = () => {
      // Queue changes can make the server-rendered position stale. Keep it
      // hidden until a fresh server render arrives, including failed refreshes.
      setInvalidatedVersion(positionVersion);
      listener();
      if (sessionDeviceWorkIsClear(readSessionDeviceWork(ownerId, sessionId))) {
        router.refresh();
      }
    };
    const unsubscribers = [
      subscribeToWorkoutSetOutbox(onChange),
      subscribeToOccurrenceMutationOutbox(onChange),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [ownerId, sessionId, positionVersion, router]);
  const getSnapshot = useCallback(
    () => JSON.stringify(readSessionDeviceWork(ownerId, sessionId)),
    [ownerId, sessionId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => NOT_READ);
  if (snapshot === NOT_READ) return null;

  const work = JSON.parse(snapshot) as SessionDeviceWork;
  const status = describeSessionDeviceWork(work);
  const clear = sessionDeviceWorkIsClear(work);
  const alert = status.state === "attention" || status.state === "unknown";

  return (
    <div className="flex flex-col gap-2" data-testid="resume-workout-status">
      <div
        role="status"
        data-testid="resume-device-work"
        data-device-work={status.state}
        className={
          alert
            ? "ui-state px-3 py-2 text-sm"
            : "rounded-lg bg-muted/60 px-3 py-2 text-sm"
        }
        data-ui-state={alert ? "attention" : undefined}
      >
        <p className="flex items-start gap-2 font-medium leading-snug">
          {alert ? (
            <AlertCircle
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
            />
          ) : status.state === "saving" ? (
            <ArrowUpFromLine
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
          ) : null}
          <span className={clear ? "text-xs font-normal text-muted-foreground" : undefined}>
            {status.title}
          </span>
        </p>
        {status.detail && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {status.detail}
          </p>
        )}
      </div>
      {clear && invalidatedVersion !== positionVersion && upNext && (
        <div
          data-testid="resume-up-next"
          className="flex flex-col gap-0.5 border-t pt-2"
        >
          <p className="ui-metadata">Up next</p>
          <p className="font-semibold leading-snug">{upNext.title}</p>
          {upNext.detail && (
            <p className="text-sm text-muted-foreground">{upNext.detail}</p>
          )}
        </div>
      )}
    </div>
  );
}
