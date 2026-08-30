"use client";

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AlertTriangle,
  Copy,
  MessageSquareText,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import {
  getLiveCoachResponseState,
  retryLiveCoachTurn,
} from "@/app/actions/live-coaching";
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
import { Textarea } from "@/components/ui/textarea";
import { LiveCoachDictation } from "@/components/session/live-coach-dictation";
import type {
  LiveCoachMessage,
  LiveCoachMessageKind,
} from "@/services/live-coaching";
import {
  isRetryableFailedResponse,
  sortConversationMessages,
} from "@/lib/live-coach-order";
import {
  streamLiveCoachResponse,
  subscribeToLiveCoachClientEvents,
  type LiveCoachClientEvent,
} from "@/lib/live-coach-client";
import type { LiveCoachStreamEvent } from "@/lib/live-coach-stream";
import {
  enqueueLiveCoachMessage,
  getLiveCoachOutboxServerSnapshot,
  getLiveCoachOutboxSnapshot,
  removeLiveCoachMessage,
  retryLiveCoachMessage,
  subscribeToLiveCoachOutbox,
  type LiveCoachOutboxEntry,
} from "@/lib/live-coach-outbox";
import {
  confirmedLiveCoachDictation,
  type LiveCoachDictationDecision,
} from "@/lib/live-coach-dictation";
import { createClientUuid } from "@/lib/client-uuid";

const QUICK_PROMPTS = [
  "Should I adjust this set?",
  "Give me a technique reminder.",
  "I feel pain or discomfort.",
  "What equipment alternative can I use?",
] as const;

type LiveCoachContext = {
  sessionExerciseId: string;
  exerciseName: string;
} | null;

export type LiveCoachDraft = {
  id: string;
  content: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ownerId: string;
  sessionId: string;
  context: LiveCoachContext;
  initialMessages: LiveCoachMessage[];
  exerciseNames: Record<string, string>;
  activeRestTimerSeconds: number | null;
  draft?: LiveCoachDraft | null;
};

function mergeMessages(
  current: LiveCoachMessage[],
  incoming: Array<LiveCoachMessage | null>
) {
  const next = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    if (message) next.set(message.id, message);
  }
  return sortConversationMessages([...next.values()]);
}

export function LiveCoachDrawer({
  open,
  onOpenChange,
  ownerId,
  sessionId,
  context,
  initialMessages,
  exerciseNames,
  activeRestTimerSeconds,
  draft = null,
}: Props) {
  const [messages, setMessages] = useState(initialMessages);
  const [kind, setKind] = useState<LiveCoachMessageKind>("question");
  const [content, setContent] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appliedDraftIdRef = useRef<string | null>(null);
  const [streamedAnswers, setStreamedAnswers] = useState<Record<string, string>>(
    {}
  );
  const outbox = useSyncExternalStore(
    subscribeToLiveCoachOutbox,
    getLiveCoachOutboxSnapshot,
    getLiveCoachOutboxServerSnapshot
  );

  useEffect(() => {
    if (!open || draft == null || appliedDraftIdRef.current === draft.id) {
      return;
    }
    appliedDraftIdRef.current = draft.id;
    setKind("question");
    setContent((current) =>
      (current.trim().length > 0
        ? `${current.trim()}\n\n${draft.content}`
        : draft.content
      ).slice(0, 800),
    );
  }, [draft, open]);

  function clearStreamedAnswer(responseId: string) {
    setStreamedAnswers((current) => {
      if (!(responseId in current)) return current;
      const next = { ...current };
      delete next[responseId];
      return next;
    });
  }

  function applyStreamEvent(
    event: LiveCoachStreamEvent,
    responseId: string
  ): boolean {
    if (event.type === "ready") return false;
    if (event.type === "partial") {
      if (event.responseId === responseId) {
        setStreamedAnswers((current) => ({
          ...current,
          [responseId]: event.answer,
        }));
      }
      return false;
    }
    clearStreamedAnswer(responseId);
    setBusyId((current) => (current === responseId ? null : current));
    if (event.response) {
      setMessages((current) => mergeMessages(current, [event.response]));
    }
    if (event.type === "failed") setError(event.reason);
    return true;
  }

  const onClientEvent = useEffectEvent((clientEvent: LiveCoachClientEvent) => {
    if (
      clientEvent.ownerId !== ownerId ||
      clientEvent.sessionId !== sessionId
    ) {
      return;
    }
    if (clientEvent.type === "saved") {
      setMessages((current) =>
        mergeMessages(current, [
          clientEvent.userMessage,
          clientEvent.pendingResponse,
        ])
      );
      if (clientEvent.pendingResponse?.responseStatus === "pending") {
        setBusyId(clientEvent.pendingResponse.id);
      }
      return;
    }
    if (clientEvent.type === "stream") {
      applyStreamEvent(clientEvent.event, clientEvent.responseId);
      return;
    }
    clearStreamedAnswer(clientEvent.responseId);
    setBusyId((current) =>
      current === clientEvent.responseId ? null : current
    );
    setError(clientEvent.reason);
  });

  useEffect(
    () => subscribeToLiveCoachClientEvents(onClientEvent),
    []
  );

  async function streamResponse(response: LiveCoachMessage) {
    setBusyId(response.id);
    try {
      await streamLiveCoachResponse({
        responseId: response.id,
        activeRestTimerSeconds,
        onEvent: (event) => applyStreamEvent(event, response.id),
      });
    } catch (streamError) {
      clearStreamedAnswer(response.id);
      let durableResponse: LiveCoachMessage | null = null;
      try {
        const current = await getLiveCoachResponseState({
          responseId: response.id,
        });
        durableResponse = current.response;
        if (durableResponse) {
          setMessages((messages) => mergeMessages(messages, [durableResponse]));
        }
      } catch {
        // A second connection failure must not replace the already saved
        // question with client-only state.
      }
      setError(
        durableResponse?.responseStatus === "completed"
          ? null
          : streamError instanceof Error
            ? `${streamError.message} Your saved question is still safe.`
            : "The connection ended early. Your saved question is still safe."
      );
    } finally {
      setBusyId(null);
    }
  }

  async function submit() {
    const message = content.trim();
    if (!message) return;
    setError(null);
    let clientKey: string;
    try {
      clientKey = createClientUuid();
    } catch {
      setError(
        "This device could not create a secure save identity. Your message remains in the editor."
      );
      return;
    }
    const queued = await enqueueLiveCoachMessage({
      ownerId,
      sessionId,
      sessionExerciseId: context?.sessionExerciseId ?? null,
      exerciseName: context?.exerciseName ?? null,
      completedSetId: null,
      messageKind: kind,
      inputMode: "text",
      content: message,
      clientKey,
      activeRestTimerSeconds,
      createdAtISO: new Date().toISOString(),
    });
    if (!queued.ok) {
      setError(queued.reason);
      return;
    }
    setContent("");
  }

  async function handleDictationDecision(decision: LiveCoachDictationDecision) {
    const confirmed = confirmedLiveCoachDictation(decision);
    if (!confirmed) return { ok: true as const };
    const {
      transcript,
      clientKey,
      target: recordedTarget,
    } = confirmed;
    setError(null);
    const queued = await enqueueLiveCoachMessage({
      ownerId,
      sessionId,
      sessionExerciseId: recordedTarget.sessionExerciseId,
      exerciseName: recordedTarget.exerciseName,
      completedSetId: null,
      messageKind: recordedTarget.messageKind,
      inputMode: "dictation",
      content: transcript,
      clientKey,
      activeRestTimerSeconds: recordedTarget.activeRestTimerSeconds,
      createdAtISO: new Date().toISOString(),
    });
    if (!queued.ok) {
      setError(queued.reason);
      return { ok: false as const, reason: queued.reason };
    }
    return { ok: true as const };
  }

  async function retry(response: LiveCoachMessage) {
    if (!response.replyToId) return;
    setError(null);
    setBusyId(response.id);
    if (response.responseStatus === "pending") {
      await streamResponse(response);
      return;
    }
    const result = await retryLiveCoachTurn({
      userMessageId: response.replyToId,
    });
    if (result.response) {
      setMessages((current) => mergeMessages(current, [result.response]));
    }
    if (!result.ok) {
      setError(result.reason);
      setBusyId(null);
      return;
    }
    await streamResponse(result.response);
  }

  const shownMessages = messages.filter(
    (message) =>
      context == null ||
      message.sessionExerciseId == null ||
      message.sessionExerciseId === context.sessionExerciseId
  );
  const shownQueuedMessages = outbox.entries.filter(
    (entry) =>
      entry.ownerId === ownerId &&
      entry.sessionId === sessionId &&
      (context == null ||
        entry.sessionExerciseId == null ||
        entry.sessionExerciseId === context.sessionExerciseId)
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent className="[--drawer-content-max-height:calc(100dvh-2rem)]">
        <DrawerHeader>
          <DrawerTitle className="flex items-center justify-center gap-2 md:justify-start">
            <MessageSquareText className="size-4 text-primary" /> Live Coach
          </DrawerTitle>
          <DrawerDescription>
            {context
              ? `Current exercise: ${context.exerciseName}. Messages stay with this workout.`
              : "Ask about the whole workout or save an observation for later review."}
          </DrawerDescription>
        </DrawerHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {shownMessages.length === 0 && shownQueuedMessages.length === 0 ? (
            <div className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
              No Coach messages for this workout yet.
            </div>
          ) : (
            <ol className="flex flex-col gap-3" aria-label="Workout Coach conversation">
              {shownMessages.map((message) => (
                <li key={message.id}>
                  <LiveCoachBubble
                    message={message}
                    exerciseName={
                      message.sessionExerciseId
                        ? exerciseNames[message.sessionExerciseId]
                        : undefined
                    }
                    busy={busyId === message.id}
                    streamedAnswer={streamedAnswers[message.id]}
                    retryAvailable={
                      message.responseStatus !== "failed" ||
                      isRetryableFailedResponse(message, messages)
                    }
                    onRetry={() => retry(message)}
                  />
                </li>
              ))}
              {shownQueuedMessages.map((entry) => (
                <li key={entry.clientKey}>
                  <QueuedLiveCoachBubble entry={entry} />
                </li>
              ))}
            </ol>
          )}
        </div>

        <DrawerFooter className="max-h-[70dvh] min-h-0 gap-3 overflow-y-auto overscroll-contain border-t pt-3">
          <div className="flex gap-2" aria-label="Message type">
            <Button
              type="button"
              size="sm"
              variant={kind === "question" ? "default" : "outline"}
              className="flex-1"
              onClick={() => setKind("question")}
            >
              Ask Coach
            </Button>
            <Button
              type="button"
              size="sm"
              variant={kind === "observation" ? "default" : "outline"}
              className="flex-1"
              onClick={() => setKind("observation")}
            >
              Add observation
            </Button>
          </div>
          {kind === "question" && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {QUICK_PROMPTS.map((prompt) => (
                <Button
                  key={prompt}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 text-xs"
                  onClick={() => setContent(prompt)}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          )}
          <Textarea
            aria-label={kind === "question" ? "Question for Live Coach" : "Workout observation"}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={
              kind === "question"
                ? "Ask about this set, technique, pain, rest, or equipment…"
                : "What felt different or worth remembering?"
            }
            rows={2}
            maxLength={800}
          />
          <LiveCoachDictation
            target={{
              messageKind: kind,
              sessionExerciseId: context?.sessionExerciseId ?? null,
              exerciseName: context?.exerciseName ?? null,
              activeRestTimerSeconds,
            }}
            onDecision={handleDictationDecision}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="button"
            size="lg"
            onClick={submit}
            disabled={content.trim().length < 2}
          >
            <Send className="size-4" />
            {kind === "question" ? "Save and ask" : "Save observation"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function QueuedLiveCoachBubble({ entry }: { entry: LiveCoachOutboxEntry }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(entry.content);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="ml-8 rounded-2xl rounded-br-md border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        <span>{entry.messageKind === "observation" ? "Observation" : "You"}</span>
        {entry.exerciseName && <span>· {entry.exerciseName}</span>}
        {entry.inputMode === "dictation" && (
          <Badge variant="secondary">dictated</Badge>
        )}
        <Badge
          variant={entry.status === "needs_attention" ? "destructive" : "secondary"}
        >
          {entry.status === "needs_attention" ? "needs attention" : "queued"}
        </Badge>
      </div>
      <p className="whitespace-pre-wrap">{entry.content}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {entry.status === "needs_attention"
          ? entry.lastError ?? "This saved device copy needs your attention."
          : "Saved on this device. It will send when a connection is available."}
      </p>
      {entry.status === "needs_attention" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () =>
              await retryLiveCoachMessage(entry.clientKey)
            }
          >
            <RotateCcw className="size-3.5" /> Try again
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyText()}
          >
            <Copy className="size-3.5" /> {copied ? "Copied" : "Copy text"}
          </Button>
          {confirmRemove ? (
            <>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={async () =>
                  await removeLiveCoachMessage(entry.clientKey)
                }
              >
                Remove unsaved copy
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRemove(false)}
              >
                Keep it
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 className="size-3.5" /> Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function LiveCoachBubble({
  message,
  exerciseName,
  busy,
  streamedAnswer,
  retryAvailable,
  onRetry,
}: {
  message: LiveCoachMessage;
  exerciseName?: string;
  busy: boolean;
  streamedAnswer?: string;
  retryAvailable: boolean;
  onRetry: () => void;
}) {
  if (message.author === "user") {
    return (
      <div className="ml-8 rounded-2xl rounded-br-md bg-primary px-3 py-2 text-primary-foreground">
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[0.6875rem] opacity-80">
          <span>{message.messageKind === "observation" ? "Observation" : "You"}</span>
          {exerciseName && <span>· {exerciseName}</span>}
          {message.inputMode !== "text" && (
            <Badge variant="secondary">
              {message.inputMode === "dictation" ? "dictated" : "voice"}
            </Badge>
          )}
        </div>
        <p className="whitespace-pre-wrap text-sm">{message.content}</p>
      </div>
    );
  }

  if (message.responseStatus === "pending") {
    return (
      <div
        className="mr-8 rounded-2xl rounded-bl-md border bg-muted/40 px-3 py-2 text-sm"
        aria-busy={busy}
      >
        {streamedAnswer ? (
          <p className="whitespace-pre-wrap">{streamedAnswer}</p>
        ) : (
          <p className="text-muted-foreground">
            {busy ? "Coach is starting the reply…" : "Coach reply is waiting."}
          </p>
        )}
        {busy ? (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            Coach is responding…
          </p>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            <RotateCcw className="size-3.5" /> Try now
          </Button>
        )}
      </div>
    );
  }

  if (message.responseStatus === "failed") {
    return (
      <div className="mr-8 rounded-2xl rounded-bl-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
        <p className="flex items-start gap-2 text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {message.failureReason ?? "Coach could not finish this answer."}
        </p>
        {retryAvailable ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRetry} disabled={busy}>
            <RotateCcw className="size-3.5" /> {busy ? "Retrying…" : "Retry"}
          </Button>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            A later retry is shown below.
          </p>
        )}
      </div>
    );
  }

  const answer = message.answer;
  return (
    <div className="mr-8 rounded-2xl rounded-bl-md border bg-card px-3 py-2 text-sm shadow-[var(--shadow-soft)]">
      <p className="whitespace-pre-wrap">{answer?.answer ?? "Coach response unavailable."}</p>
      {answer?.evidence.length ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">Evidence used</summary>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {answer.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {answer?.safetyNote && (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {answer.safetyNote}
        </p>
      )}
      {message.model && (
        <p className="mt-2 text-[0.6875rem] text-muted-foreground">Coach · {message.model}</p>
      )}
    </div>
  );
}
