"use client";

import { useEffect, useMemo, useReducer, useState, useSyncExternalStore } from "react";
import { AlertTriangle, CloudUpload, RotateCcw, Trash2 } from "lucide-react";
import { mutateOccurrence } from "@/app/actions/sessions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  discardUnreadableOccurrenceMutationOutbox,
  getOccurrenceMutationOutboxServerSnapshot,
  getOccurrenceMutationOutboxSnapshot,
  markOccurrenceMutationNeedsAttentionUnlocked,
  markOccurrenceMutationTransientFailureUnlocked,
  nextOccurrenceMutationOutboxEntry,
  publishOccurrenceMutationOutboxEvent,
  releaseOccurrenceMutationBackoff,
  removeOccurrenceMutation,
  removeOccurrenceMutationUnlocked,
  retryOccurrenceMutation,
  subscribeToOccurrenceMutationOutbox,
  withOccurrenceMutationOutboxLock,
  type OccurrenceMutationOutboxEntry,
} from "@/lib/occurrence-mutation-outbox";

const activeOwners = new Set<string>();
const TRANSIENT_FAILURE =
  "We couldn't save this yet. We'll keep trying when you're back online.";

function operationLabel(operation: OccurrenceMutationOutboxEntry["operation"]) {
  if (operation === "complete") return "Mark done";
  if (operation === "skip") return "Skip";
  if (operation === "restore") return "Restore";
  return "Update note";
}

export async function syncNextOccurrenceMutation(ownerId: string) {
  if (activeOwners.has(ownerId)) return;
  activeOwners.add(ownerId);
  try {
    await withOccurrenceMutationOutboxLock(async () => {
      const entry = nextOccurrenceMutationOutboxEntry(
        getOccurrenceMutationOutboxSnapshot().entries,
        ownerId,
      );
      if (!entry || (typeof navigator !== "undefined" && !navigator.onLine)) {
        return;
      }
      publishOccurrenceMutationOutboxEvent({
        type: "saving",
        clientKey: entry.clientKey,
        sessionId: entry.sessionId,
        retrying: entry.attemptCount > 0 || entry.lastAttemptAtISO != null,
      });
      try {
        const result = await mutateOccurrence({
          occurrenceId: entry.occurrenceId,
          clientKey: entry.clientKey,
          expectedRevision: entry.expectedRevision,
          operation: entry.operation,
          reason: entry.reason,
          note: entry.note,
        });
        if (result.outcome === "saved" || result.outcome === "replayed") {
          const removed = removeOccurrenceMutationUnlocked(entry.clientKey);
          if (!removed.ok) {
            markOccurrenceMutationNeedsAttentionUnlocked(
              entry.clientKey,
              removed.reason,
            );
            return;
          }
          publishOccurrenceMutationOutboxEvent({
            type: "saved",
            clientKey: entry.clientKey,
            sessionId: entry.sessionId,
            occurrence: result.occurrence,
          });
          return;
        }
        const reason =
          result.outcome === "workout_not_active"
            ? "This workout has ended. Check this change before removing it."
            : result.outcome === "not_found"
              ? "We couldn't find this workout item."
              : "This item changed somewhere else before your update was saved.";
        markOccurrenceMutationNeedsAttentionUnlocked(entry.clientKey, reason);
        publishOccurrenceMutationOutboxEvent({
          type: "failed",
          clientKey: entry.clientKey,
          sessionId: entry.sessionId,
        });
      } catch {
        markOccurrenceMutationTransientFailureUnlocked(
          entry.clientKey,
          TRANSIENT_FAILURE,
        );
        publishOccurrenceMutationOutboxEvent({
          type: "failed",
          clientKey: entry.clientKey,
          sessionId: entry.sessionId,
        });
      }
    });
  } finally {
    activeOwners.delete(ownerId);
  }
}

export function OccurrenceMutationOutboxSync({ ownerId }: { ownerId: string }) {
  const snapshot = useSyncExternalStore(
    subscribeToOccurrenceMutationOutbox,
    getOccurrenceMutationOutboxSnapshot,
    getOccurrenceMutationOutboxServerSnapshot,
  );
  const entries = useMemo(
    () => snapshot.entries.filter((entry) => entry.ownerId === ownerId),
    [ownerId, snapshot.entries],
  );
  const [wakeCounter, wake] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    const onWake = () => wake();
    const onOnline = () => {
      void releaseOccurrenceMutationBackoff(ownerId).then(() => wake());
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ownerId]);

  useEffect(() => {
    const retryAt = entries.reduce<number | null>((earliest, entry) => {
      if (entry.status !== "queued" || !entry.nextAttemptAtISO) return earliest;
      const candidate = Date.parse(entry.nextAttemptAtISO);
      return earliest == null || candidate < earliest ? candidate : earliest;
    }, null);
    if (retryAt == null || retryAt <= Date.now()) return;
    const timer = window.setTimeout(
      () => wake(),
      Math.min(retryAt - Date.now(), 300_000),
    );
    return () => window.clearTimeout(timer);
  }, [entries]);

  useEffect(() => {
    void syncNextOccurrenceMutation(ownerId);
  }, [entries, ownerId, wakeCounter]);

  return (
    <OccurrenceMutationOutboxTray
      entries={entries}
      storageError={snapshot.error}
      onWake={wake}
    />
  );
}

export function OccurrenceMutationOutboxTray({
  entries,
  storageError,
  onWake,
}: {
  entries: OccurrenceMutationOutboxEntry[];
  storageError: string | null;
  onWake: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const attentionCount = entries.filter(
    (entry) => entry.status === "needs_attention",
  ).length;
  if (entries.length === 0 && !storageError) return null;

  async function discard(entry: OccurrenceMutationOutboxEntry) {
    const removed = await removeOccurrenceMutation(entry.clientKey);
    if (!removed.ok) return;
    publishOccurrenceMutationOutboxEvent({
      type: "discarded",
      clientKey: entry.clientKey,
      sessionId: entry.sessionId,
    });
    setConfirmRemove(null);
  }

  return (
    <>
      <Button
        type="button"
        variant={attentionCount > 0 || storageError ? "destructive" : "secondary"}
        className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)] left-3 z-30 min-h-11 max-w-[calc(100vw-1.5rem)] shadow-lg lg:bottom-3"
        onClick={() => setOpen(true)}
        aria-label="Open unsaved workout changes"
      >
        {attentionCount > 0 || storageError ? (
          <AlertTriangle className="size-4" />
        ) : (
          <CloudUpload className="size-4" />
        )}
        {storageError || attentionCount > 0
          ? "Workout changes need attention"
          : `${entries.length} change${entries.length === 1 ? "" : "s"} saving`}
      </Button>
      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerContent className="[--drawer-content-max-height:calc(100dvh-2rem)]">
          <DrawerHeader>
            <DrawerTitle>Changes waiting to save</DrawerTitle>
            <DrawerDescription>
              If you lose your connection, these changes stay here and try
              again. Save or discard each one before finishing your workout.
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {storageError && (
              <div role="alert" className="rounded-xl border border-destructive/40 p-3 text-sm">
                <p>{storageError}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="mt-3 min-h-11"
                  onClick={() => {
                    if (discardUnreadableOccurrenceMutationOutbox().ok) onWake();
                  }}
                >
                  <Trash2 className="size-4" /> Discard unreadable queue
                </Button>
              </div>
            )}
            <ol className="mt-3 flex flex-col gap-3">
              {entries.map((entry) => (
                <li key={entry.clientKey} className="rounded-xl border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{entry.label}</p>
                    <Badge variant={entry.status === "needs_attention" ? "destructive" : "secondary"}>
                      {entry.status === "needs_attention" ? "Needs attention" : "Saving"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {operationLabel(entry.operation)}
                  </p>
                  {entry.lastError && (
                    <p role="alert" className="mt-2 text-sm text-destructive">
                      {entry.lastError}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {entry.status === "needs_attention" && (
                      <Button
                        type="button"
                        size="sm"
                        className="min-h-11"
                        variant="outline"
                        onClick={() => void retryOccurrenceMutation(entry.clientKey).then(onWake)}
                      >
                        <RotateCcw className="size-4" /> Retry
                      </Button>
                    )}
                    {confirmRemove === entry.clientKey ? (
                      <>
                        <Button type="button" size="sm" className="min-h-11" variant="destructive" onClick={() => void discard(entry)}>
                          Discard change
                        </Button>
                        <Button type="button" size="sm" className="min-h-11" variant="ghost" onClick={() => setConfirmRemove(null)}>
                          Keep it
                        </Button>
                      </>
                    ) : (
                      <Button type="button" size="sm" className="min-h-11" variant="ghost" onClick={() => setConfirmRemove(entry.clientKey)}>
                        <Trash2 className="size-4" /> Discard
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
