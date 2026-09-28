"use client";

import { useCallback, useSyncExternalStore } from "react";
import { AlertCircle, ArrowUpFromLine } from "lucide-react";
import {
  readWorkoutCommandQueue,
  subscribeToWorkoutCommandQueue,
} from "@/lib/workout-command-queue";
import {
  describeSessionDeviceWork,
  hasSessionDeviceWork,
  summarizeSessionDeviceWork,
  type SessionDeviceWork,
} from "@/lib/resume-device-work";

export type ResumeUpNext = {
  title: string;
  detail: string | null;
};

const UNKNOWN = "unknown";

function encode(work: SessionDeviceWork) {
  return [
    work.savingSets,
    work.attentionSets,
    work.savingChanges,
    work.attentionChanges,
  ].join(":");
}

function decode(snapshot: string): SessionDeviceWork | null {
  if (snapshot === UNKNOWN) return null;
  const [savingSets, attentionSets, savingChanges, attentionChanges] =
    snapshot.split(":").map(Number);
  return { savingSets, attentionSets, savingChanges, attentionChanges };
}

/**
 * Resume-card status for work this device still holds, plus the next saved
 * step. The server cannot see this device's copy, so nothing is claimed until
 * the device queue has been read, and Up next is withheld while local work
 * could make the saved position out of date.
 */
export function ResumeWorkoutStatus({
  ownerId,
  sessionId,
  upNext,
}: {
  ownerId: string;
  sessionId: string;
  upNext: ResumeUpNext | null;
}) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToWorkoutCommandQueue(ownerId, listener),
    [ownerId],
  );
  const getSnapshot = useCallback(() => {
    try {
      return encode(
        summarizeSessionDeviceWork(readWorkoutCommandQueue(ownerId), sessionId),
      );
    } catch {
      return UNKNOWN;
    }
  }, [ownerId, sessionId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => UNKNOWN);
  const work = decode(snapshot);
  if (work == null) return null;

  const status = describeSessionDeviceWork(work);
  const deviceWork = hasSessionDeviceWork(work);

  return (
    <div className="flex flex-col gap-2" data-testid="resume-workout-status">
      <div
        role="status"
        data-testid="resume-device-work"
        data-device-work={deviceWork ? status.tone : "none"}
        className={
          status.tone === "attention"
            ? "ui-state px-3 py-2 text-sm"
            : "rounded-lg bg-muted/60 px-3 py-2 text-sm"
        }
        data-ui-state={status.tone === "attention" ? "attention" : undefined}
      >
        <p className="flex items-start gap-2 font-medium leading-snug">
          {deviceWork &&
            (status.tone === "attention" ? (
              <AlertCircle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
              />
            ) : (
              <ArrowUpFromLine
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
            ))}
          <span className={deviceWork ? undefined : "text-xs font-normal text-muted-foreground"}>
            {status.title}
          </span>
        </p>
        {status.detail && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {status.detail}
          </p>
        )}
      </div>
      {!deviceWork && upNext && (
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
