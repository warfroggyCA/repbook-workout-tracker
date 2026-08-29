"use client";

import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CloudUpload,
  Copy,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  getLiveCoachOutboxServerSnapshot,
  getLiveCoachOutboxSnapshot,
  discardLiveCoachQuarantinedMessage,
  recordLiveCoachOutboxNeedsAttentionUnlocked,
  recordLiveCoachOutboxTransientFailureUnlocked,
  removeLiveCoachMessage,
  removeLiveCoachMessageUnlocked,
  retryLiveCoachMessage,
  subscribeToLiveCoachOutbox,
  withLiveCoachOutboxLock,
  type LiveCoachOutboxEntry,
  type LiveCoachOutboxQuarantinedEntry,
} from "@/lib/live-coach-outbox";
import {
  publishLiveCoachClientEvent,
  streamLiveCoachResponse,
} from "@/lib/live-coach-client";
import { LIVE_COACH_OUTBOX_OFFSET_CLASS_NAME } from "@/lib/active-workout-layout";
import type { LiveCoachMessage } from "@/services/live-coaching";

type SavedMessageResponse =
  | {
      ok: true;
      userMessage: LiveCoachMessage;
      pendingResponse: LiveCoachMessage | null;
    }
  | { ok: false; reason: string };

const activeSyncs = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isLiveCoachMessage(value: unknown): value is LiveCoachMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    (value.author === "user" || value.author === "assistant") &&
    (value.responseStatus === "saved" ||
      value.responseStatus === "pending" ||
      value.responseStatus === "completed" ||
      value.responseStatus === "failed")
  );
}

function parseSavedMessageResponse(value: unknown): SavedMessageResponse | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (value.ok === false) {
    return typeof value.reason === "string"
      ? { ok: false, reason: value.reason }
      : null;
  }
  if (
    !isLiveCoachMessage(value.userMessage) ||
    (value.pendingResponse != null &&
      !isLiveCoachMessage(value.pendingResponse))
  ) {
    return null;
  }
  return {
    ok: true,
    userMessage: value.userMessage,
    pendingResponse: value.pendingResponse ?? null,
  };
}

function isPermanentSaveStatus(status: number) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isSameDurableMessage(
  entry: LiveCoachOutboxEntry,
  message: LiveCoachMessage
) {
  return (
    message.author === "user" &&
    message.responseStatus === "saved" &&
    message.sessionId === entry.sessionId &&
    message.sessionExerciseId === entry.sessionExerciseId &&
    message.completedSetId === entry.completedSetId &&
    message.messageKind === entry.messageKind &&
    message.inputMode === entry.inputMode &&
    message.content === entry.content
  );
}

async function syncEntry(
  ownerId: string,
  original: LiveCoachOutboxEntry,
  onDurableChange: (sessionId: string) => void
) {
  if (activeSyncs.has(original.clientKey)) return;
  activeSyncs.add(original.clientKey);
  try {
    const stream = await withLiveCoachOutboxLock(async () => {
      const entry = getLiveCoachOutboxSnapshot().entries.find(
        (candidate) =>
          candidate.clientKey === original.clientKey &&
          candidate.ownerId === ownerId
      );
      if (!entry || entry.status !== "queued") return;
      if (
        entry.nextAttemptAtISO &&
        Date.parse(entry.nextAttemptAtISO) > Date.now()
      ) {
        return;
      }
      if (typeof navigator !== "undefined" && !navigator.onLine) return;

      let response: Response;
      try {
        response = await fetch("/api/live-coach/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: entry.sessionId,
            sessionExerciseId: entry.sessionExerciseId,
            completedSetId: entry.completedSetId,
            messageKind: entry.messageKind,
            inputMode: entry.inputMode,
            content: entry.content,
            clientKey: entry.clientKey,
          }),
        });
      } catch {
        recordLiveCoachOutboxTransientFailureUnlocked(
          entry.clientKey,
          "The connection is unavailable. This message remains queued on this device."
        );
        return;
      }

      const payload = parseSavedMessageResponse(
        await response.json().catch(() => null)
      );
      if (!response.ok || !payload?.ok) {
        const reason =
          payload && !payload.ok
            ? payload.reason
            : "Live Coach could not confirm this saved message yet.";
        if (isPermanentSaveStatus(response.status)) {
          recordLiveCoachOutboxNeedsAttentionUnlocked(entry.clientKey, reason);
        } else {
          recordLiveCoachOutboxTransientFailureUnlocked(entry.clientKey, reason);
        }
        return;
      }

      if (!isSameDurableMessage(entry, payload.userMessage)) {
        recordLiveCoachOutboxNeedsAttentionUnlocked(
          entry.clientKey,
          "The server confirmed a different message for this saved identity. The device copy was kept for recovery."
        );
        return;
      }

      const removed = removeLiveCoachMessageUnlocked(entry.clientKey);
      if (!removed.ok) return;
      publishLiveCoachClientEvent({
        type: "saved",
        ownerId,
        sessionId: entry.sessionId,
        clientKey: entry.clientKey,
        userMessage: payload.userMessage,
        pendingResponse: payload.pendingResponse,
      });
      onDurableChange(entry.sessionId);

      if (payload.pendingResponse?.responseStatus !== "pending") return null;
      return {
        responseId: payload.pendingResponse.id,
        sessionId: entry.sessionId,
        activeRestTimerSeconds: entry.activeRestTimerSeconds,
      };
    });
    if (stream) {
      try {
        await streamLiveCoachResponse({
          responseId: stream.responseId,
          activeRestTimerSeconds: stream.activeRestTimerSeconds,
          onEvent: (event) => {
            publishLiveCoachClientEvent({
              type: "stream",
              ownerId,
              sessionId: stream.sessionId,
              responseId: stream.responseId,
              event,
            });
          },
        });
      } catch (error) {
        publishLiveCoachClientEvent({
          type: "stream_error",
          ownerId,
          sessionId: stream.sessionId,
          responseId: stream.responseId,
          reason:
            error instanceof Error
              ? `${error.message} The question is saved and its reply can be resumed.`
              : "The question is saved and its reply can be resumed.",
        });
      }
      onDurableChange(stream.sessionId);
    }
  } finally {
    activeSyncs.delete(original.clientKey);
  }
}

export function LiveCoachOutboxSync({ ownerId }: { ownerId: string }) {
  const snapshot = useSyncExternalStore(
    subscribeToLiveCoachOutbox,
    getLiveCoachOutboxSnapshot,
    getLiveCoachOutboxServerSnapshot
  );
  const entries = snapshot.entries.filter((entry) => entry.ownerId === ownerId);
  const [wakeCounter, wake] = useReducer((value: number) => value + 1, 0);
  const router = useRouter();

  useEffect(() => {
    const onWake = () => wake();
    const onOnline = () => {
      const queued = getLiveCoachOutboxSnapshot().entries.filter(
        (entry) => entry.ownerId === ownerId && entry.status === "queued"
      );
      void Promise.all(
        queued.map((entry) => retryLiveCoachMessage(entry.clientKey))
      ).then(() => wake());
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
    const nextAttempt = entries
      .filter(
        (entry) => entry.status === "queued" && entry.nextAttemptAtISO != null
      )
      .map((entry) => Date.parse(entry.nextAttemptAtISO!))
      .filter((time) => time > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextAttempt == null) return;
    const timer = window.setTimeout(
      () => wake(),
      Math.min(Math.max(nextAttempt - Date.now(), 0), 300_000)
    );
    return () => window.clearTimeout(timer);
  }, [entries]);

  useEffect(() => {
    const refreshHistory = (sessionId: string) => {
      if (window.location.pathname === `/history/${sessionId}`) router.refresh();
    };
    for (const entry of entries) {
      if (entry.status !== "queued") continue;
      if (
        entry.nextAttemptAtISO &&
        Date.parse(entry.nextAttemptAtISO) > Date.now()
      ) {
        continue;
      }
      void syncEntry(ownerId, entry, refreshHistory);
    }
  }, [entries, ownerId, router, wakeCounter]);

  return (
    <LiveCoachOutboxTray
      entries={entries}
      quarantined={snapshot.quarantined}
      storageError={snapshot.error}
      onWake={wake}
    />
  );
}

function LiveCoachOutboxTray({
  entries,
  quarantined,
  storageError,
  onWake,
}: {
  entries: LiveCoachOutboxEntry[];
  quarantined: LiveCoachOutboxQuarantinedEntry[];
  storageError: string | null;
  onWake: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [confirmQuarantine, setConfirmQuarantine] =
    useState<LiveCoachOutboxQuarantinedEntry | null>(null);
  const [quarantineError, setQuarantineError] = useState<string | null>(null);
  const confirmQuarantineButtonRef = useRef<HTMLButtonElement>(null);
  const quarantineDiscardButtonRefs = useRef(
    new Map<string, HTMLButtonElement>()
  );
  const restoreQuarantineFocusKeyRef = useRef<string | null>(null);
  const attentionCount = entries.filter(
    (entry) => entry.status === "needs_attention"
  ).length + quarantined.length;

  useEffect(() => {
    if (confirmQuarantine) {
      confirmQuarantineButtonRef.current?.focus();
      return;
    }
    const restoreKey = restoreQuarantineFocusKeyRef.current;
    if (restoreKey) {
      quarantineDiscardButtonRefs.current.get(restoreKey)?.focus();
      restoreQuarantineFocusKeyRef.current = null;
    }
  }, [confirmQuarantine]);

  if (entries.length === 0 && quarantined.length === 0 && !storageError) return null;

  async function copyEntry(entry: LiveCoachOutboxEntry) {
    try {
      await navigator.clipboard.writeText(entry.content);
      setCopyStatus(entry.clientKey);
    } catch {
      setCopyStatus(null);
    }
  }

  async function discardQuarantine(entry: LiveCoachOutboxQuarantinedEntry) {
    setQuarantineError(null);
    const removed = await discardLiveCoachQuarantinedMessage(
      entry.quarantineKey,
      entry.raw
    );
    if (!removed.ok) {
      setQuarantineError(removed.reason);
      return;
    }
    setConfirmQuarantine(null);
    onWake();
  }

  function keepQuarantine(entry: LiveCoachOutboxQuarantinedEntry) {
    restoreQuarantineFocusKeyRef.current = entry.quarantineKey;
    setConfirmQuarantine(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      restoreQuarantineFocusKeyRef.current = null;
      setConfirmQuarantine(null);
      setQuarantineError(null);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={attentionCount > 0 || storageError ? "destructive" : "secondary"}
        className={`fixed right-3 z-30 max-w-[calc(100vw-1.5rem)] shadow-lg ${LIVE_COACH_OUTBOX_OFFSET_CLASS_NAME}`}
        onClick={() => setOpen(true)}
        aria-label="Open Live Coach outbox"
      >
        {attentionCount > 0 || storageError ? (
          <AlertTriangle className="size-4" />
        ) : (
          <CloudUpload className="size-4" />
        )}
        {storageError || attentionCount > 0
          ? "Coach outbox needs attention"
          : `${entries.length} Coach message${entries.length === 1 ? "" : "s"} queued`}
      </Button>

      <Drawer open={open} onOpenChange={handleOpenChange} showSwipeHandle>
        <DrawerContent className="[--drawer-content-max-height:calc(100dvh-2rem)]">
          <DrawerHeader>
            <DrawerTitle>Live Coach outbox</DrawerTitle>
            <DrawerDescription>
              Messages stay on this device until the server confirms the same
              saved message. Until then, they are not part of History, exports,
              Archive, snapshots, or Recovery.
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {storageError && (
              <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {storageError}
              </p>
            )}
            {quarantineError && (
              <p role="alert" className="mt-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {quarantineError}
              </p>
            )}
            {quarantined.length > 0 && (
              <section className="mt-3" aria-labelledby="unreadable-coach-messages">
                <h3 id="unreadable-coach-messages" className="text-sm font-medium">
                  Messages we couldn&apos;t read
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  We can&apos;t send these automatically, so their details stay
                  hidden. You can keep or discard them.
                </p>
                <ol className="mt-3 flex flex-col gap-3">
                  {quarantined.map((entry, index) => (
                    <li key={entry.quarantineKey} className="rounded-xl border border-destructive/30 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="destructive">Can&apos;t read</Badge>
                        <span>Saved copy {index + 1}</span>
                      </div>
                      <p className="mt-2 text-sm">{entry.reason}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {confirmQuarantine === entry ? (
                          <>
                            <p role="alert" className="basis-full text-sm font-medium">
                              Discard this saved copy?
                            </p>
                            <Button
                              ref={confirmQuarantineButtonRef}
                              type="button"
                              size="sm"
                              variant="destructive"
                              onClick={() =>
                                void discardQuarantine(confirmQuarantine)
                              }
                            >
                              Discard saved copy
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => keepQuarantine(entry)}
                            >
                              Keep it
                            </Button>
                          </>
                        ) : (
                          <Button
                            ref={(node) => {
                              if (node) {
                                quarantineDiscardButtonRefs.current.set(
                                  entry.quarantineKey,
                                  node
                                );
                              } else {
                                quarantineDiscardButtonRefs.current.delete(
                                  entry.quarantineKey
                                );
                              }
                            }}
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setQuarantineError(null);
                              setConfirmQuarantine(entry);
                            }}
                          >
                            <Trash2 className="size-3.5" /> Discard
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            <ol className="flex flex-col gap-3" aria-label="Queued Live Coach messages">
              {entries.map((entry) => (
                <li key={entry.clientKey} className="rounded-xl border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge
                      variant={
                        entry.status === "needs_attention"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {entry.status === "needs_attention"
                        ? "Needs attention"
                        : "Queued on this device"}
                    </Badge>
                    <span>
                      {entry.exerciseName ?? "Whole workout"} ·{" "}
                      {new Date(entry.createdAtISO).toLocaleString()}
                    </span>
                    {entry.inputMode === "dictation" && (
                      <Badge variant="outline">Dictated</Badge>
                    )}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm">{entry.content}</p>
                  {entry.lastError && (
                    <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                      {entry.lastError}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {entry.status === "needs_attention" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await retryLiveCoachMessage(entry.clientKey);
                          onWake();
                        }}
                      >
                        <RotateCcw className="size-3.5" /> Try again
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void copyEntry(entry)}
                    >
                      <Copy className="size-3.5" />
                      {copyStatus === entry.clientKey ? "Copied" : "Copy text"}
                    </Button>
                    {confirmRemove === entry.clientKey ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={async () => {
                            await removeLiveCoachMessage(entry.clientKey);
                            setConfirmRemove(null);
                          }}
                        >
                          Remove unsaved copy
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmRemove(null)}
                        >
                          Keep it
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmRemove(entry.clientKey)}
                      >
                        <Trash2 className="size-3.5" /> Remove
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <DrawerFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
