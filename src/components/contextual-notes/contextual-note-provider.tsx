"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { FilePenLine, LockKeyhole, RotateCcw, Trash2 } from "lucide-react";
import { LiveCoachDictation } from "@/components/session/live-coach-dictation";
import { ContextualNoteManager } from "@/components/contextual-notes/contextual-note-manager";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { StateNotice } from "@/components/ui/state-notice";
import { Textarea } from "@/components/ui/textarea";
import {
  contextualNoteCreateInputSchema,
  type ContextualNoteCreateInput,
  type ContextualNoteInputMode,
} from "@/lib/contextual-note-contract";
import {
  enqueueContextualNoteOutboxEntry,
  getContextualNoteOutboxServerSnapshot,
  getContextualNoteOutboxSnapshot,
  mutateContextualNoteOutboxInBrowser,
  removeContextualNoteOutboxEntry,
  retryContextualNoteOutboxEntry,
  subscribeToContextualNoteOutbox,
} from "@/lib/contextual-note-outbox";
import { createClientUuid } from "@/lib/client-uuid";
import {
  CONTEXTUAL_NOTE_OPEN_EVENT,
  CONTEXTUAL_NOTE_SCOPE_EVENT,
  contextualNoteDictationBlockedReason,
  generalContextualNoteScope,
  resolveContextualNoteComposerOpening,
  type ContextualNoteAttachmentChoice,
  type ContextualNoteScopeValue,
} from "@/lib/contextual-note-ui";
import {
  discardContextualNoteSimulationTransfer,
  readContextualNoteSimulationTransfer,
} from "@/lib/contextual-note-simulation-transfer";

function destinationFromPath(pathname: string) {
  if (pathname.startsWith("/today")) return "today" as const;
  if (pathname.startsWith("/session/")) return "workout" as const;
  if (pathname.startsWith("/history")) return "history" as const;
  if (pathname.startsWith("/coach")) return "review" as const;
  if (pathname.startsWith("/program")) return "program" as const;
  if (pathname.startsWith("/settings")) return "settings" as const;
  if (pathname.startsWith("/recovery")) return "recovery" as const;
  if (pathname.startsWith("/archive")) return "archive" as const;
  if (pathname.startsWith("/export")) return "export" as const;
  return "other" as const;
}

function payloadForAttachment(input: {
  scope: ContextualNoteScopeValue;
  attachment: ContextualNoteAttachmentChoice;
  clientKey: string;
  body: string;
  coachVisible: boolean;
  inputMode: ContextualNoteInputMode;
  recordedAt: string;
}): ContextualNoteCreateInput | null {
  const common = {
    clientKey: input.clientKey,
    body: input.body,
    coachVisible: input.coachVisible,
    inputMode: input.inputMode,
    recordedAt: input.recordedAt,
    capturedContext: input.scope.capturedContext,
  };
  const attachment = input.attachment;
  let candidate: unknown;
  if (attachment.kind === "general") {
    candidate = { ...common, attachmentKind: "general" };
  } else if (attachment.kind === "workout" && attachment.sessionId) {
    candidate = { ...common, attachmentKind: "workout", sessionId: attachment.sessionId };
  } else if (
    attachment.kind === "exercise" &&
    attachment.sessionId &&
    attachment.sessionExerciseId
  ) {
    candidate = {
      ...common,
      attachmentKind: "exercise",
      sessionId: attachment.sessionId,
      sessionExerciseId: attachment.sessionExerciseId,
    };
  } else if (
    attachment.kind === "occurrence" &&
    attachment.sessionId &&
    attachment.occurrenceId
  ) {
    candidate = {
      ...common,
      attachmentKind: "occurrence",
      sessionId: attachment.sessionId,
      occurrenceId: attachment.occurrenceId,
    };
  } else if (
    attachment.kind === "set" &&
    attachment.sessionId &&
    attachment.sessionExerciseId &&
    attachment.occurrenceId &&
    attachment.completedSetId
  ) {
    candidate = {
      ...common,
      attachmentKind: "set",
      sessionId: attachment.sessionId,
      sessionExerciseId: attachment.sessionExerciseId,
      occurrenceId: attachment.occurrenceId,
      completedSetId: attachment.completedSetId ?? null,
    };
  } else if (
    attachment.kind === "rest" &&
    attachment.sessionId &&
    attachment.sessionExerciseId &&
    attachment.occurrenceId
  ) {
    candidate = {
      ...common,
      attachmentKind: "rest",
      sessionId: attachment.sessionId,
      sessionExerciseId: attachment.sessionExerciseId,
      occurrenceId: attachment.occurrenceId,
      completedSetId: attachment.completedSetId,
    };
  } else if (
    attachment.kind === "program" &&
    attachment.programId &&
    attachment.programVersionId
  ) {
    candidate = {
      ...common,
      attachmentKind: "program",
      programId: attachment.programId,
      programVersionId: attachment.programVersionId,
    };
  } else if (
    attachment.kind === "program_day" &&
    attachment.programId &&
    attachment.programVersionId &&
    attachment.workoutTemplateId
  ) {
    candidate = {
      ...common,
      attachmentKind: "program_day",
      programId: attachment.programId,
      programVersionId: attachment.programVersionId,
      workoutTemplateId: attachment.workoutTemplateId,
    };
  } else if (
    attachment.kind === "program_item" &&
    attachment.programId &&
    attachment.programVersionId &&
    attachment.workoutTemplateId &&
    attachment.workoutTemplateExerciseId
  ) {
    candidate = {
      ...common,
      attachmentKind: "program_item",
      programId: attachment.programId,
      programVersionId: attachment.programVersionId,
      workoutTemplateId: attachment.workoutTemplateId,
      workoutTemplateExerciseId: attachment.workoutTemplateExerciseId,
    };
  } else {
    return null;
  }
  const parsed = contextualNoteCreateInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function ContextualNoteProvider({
  ownerId,
  children,
}: {
  ownerId: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const defaultScope = useMemo(
    () =>
      generalContextualNoteScope({
        scopeId: `route:${pathname}`,
        destination: destinationFromPath(pathname),
        workflow: pathname,
      }),
    [pathname],
  );
  const [registeredScope, setRegisteredScope] =
    useState<ContextualNoteScopeValue | null>(null);
  const scope = registeredScope ?? defaultScope;
  const [composerScope, setComposerScope] =
    useState<ContextualNoteScopeValue>(scope);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [coachVisible, setCoachVisible] = useState(true);
  const [attachmentKey, setAttachmentKey] = useState(scope.defaultAttachmentKey);
  const [retainedFromDifferentScope, setRetainedFromDifferentScope] =
    useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const simulationTransferLoaded = useRef(false);
  const outbox = useSyncExternalStore(
    useCallback(
      (onStoreChange) => subscribeToContextualNoteOutbox(ownerId, onStoreChange),
      [ownerId],
    ),
    useCallback(() => getContextualNoteOutboxSnapshot(ownerId), [ownerId]),
    useCallback(() => getContextualNoteOutboxServerSnapshot(ownerId), [ownerId]),
  );

  const beginComposer = useCallback(
    (nextScope = scope) => {
      const opening = resolveContextualNoteComposerOpening({
        draftBody: body,
        currentScope: composerScope,
        currentAttachmentKey: attachmentKey,
        requestedScope: nextScope,
      });
      setComposerScope(opening.scope);
      setAttachmentKey(opening.attachmentKey);
      setRetainedFromDifferentScope(opening.retainedFromDifferentScope);
      setIssue(null);
      setOpen(true);
    },
    [attachmentKey, body, composerScope, scope],
  );

  useEffect(() => {
    const onScope = (event: Event) => {
      setRegisteredScope(
        (event as CustomEvent<ContextualNoteScopeValue | null>).detail,
      );
    };
    const onOpen = () => beginComposer();
    window.addEventListener(CONTEXTUAL_NOTE_SCOPE_EVENT, onScope);
    window.addEventListener(CONTEXTUAL_NOTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(CONTEXTUAL_NOTE_SCOPE_EVENT, onScope);
      window.removeEventListener(CONTEXTUAL_NOTE_OPEN_EVENT, onOpen);
    };
  }, [beginComposer]);

  useEffect(() => {
    if (body.trim().length === 0) return;
    const warnBeforeDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeDiscard);
    return () => window.removeEventListener("beforeunload", warnBeforeDiscard);
  }, [body]);

  useEffect(() => {
    if (simulationTransferLoaded.current) return;
    simulationTransferLoaded.current = true;
    const transfer = readContextualNoteSimulationTransfer(window.sessionStorage);
    if (!transfer) return;
    const transferScope = generalContextualNoteScope({
      scopeId: `simulation-transfer:${transfer.transferId}`,
      destination: "today",
      workflow: transfer.sourceLabel,
      originatedFromSimulation: true,
    });
    const timer = window.setTimeout(() => {
      setBody(transfer.content);
      setCoachVisible(true);
      beginComposer(transferScope);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [beginComposer]);

  const queueNote = useCallback(
    async (input: {
      text: string;
      inputMode: ContextualNoteInputMode;
      clientKey?: string;
    }) => {
      const attachment = composerScope.attachments.find(
        (candidate) => candidate.key === attachmentKey,
      );
      const recordedAt = new Date().toISOString();
      const clientKey = input.clientKey ?? createClientUuid();
      if (!attachment) {
        return { ok: false as const, reason: "Choose what this note describes." };
      }
      const payload = payloadForAttachment({
        scope: composerScope,
        attachment,
        clientKey,
        body: input.text,
        coachVisible,
        inputMode: input.inputMode,
        recordedAt,
      });
      if (!payload) {
        return {
          ok: false as const,
          reason: "That attachment is no longer valid. Reopen the composer and review it.",
        };
      }
      const result = await mutateContextualNoteOutboxInBrowser(ownerId, (storage) =>
        enqueueContextualNoteOutboxEntry(storage, {
          clientKey,
          ownerId,
          payload,
          createdAtISO: recordedAt,
        }),
      );
      if (!result.ok) return result;
      discardContextualNoteSimulationTransfer(window.sessionStorage);
      setBody("");
      setRetainedFromDifferentScope(false);
      setIssue(null);
      setOpen(false);
      return { ok: true as const };
    },
    [attachmentKey, coachVisible, composerScope, ownerId],
  );

  const needsAttention = outbox.entries.filter(
    (entry) => entry.status === "needs_attention",
  );
  const pending = outbox.entries.filter(
    (entry) => entry.status !== "needs_attention",
  );

  return (
    <>
      <div
        className={
          pathname.startsWith("/session/")
            ? "hidden"
            : "flex min-h-14 flex-wrap items-center justify-end gap-2 px-4 py-2"
        }
      >
        {outbox.error ? (
          <StateNotice
            className="mr-auto flex-1"
            state="needs_attention"
            title="The device note queue cannot be read"
            description={outbox.error}
          />
        ) : needsAttention.length > 0 ? (
          <StateNotice
            className="mr-auto flex-1"
            state="needs_attention"
            title={`${needsAttention.length} note${needsAttention.length === 1 ? " needs" : "s need"} attention`}
            description="The text remains on this device. Retry it or remove it explicitly."
            action={needsAttention.map((entry) => (
              <span key={entry.clientKey} className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void mutateContextualNoteOutboxInBrowser(ownerId, (storage) =>
                      retryContextualNoteOutboxEntry(
                        storage,
                        ownerId,
                        entry.clientKey,
                        entry.payloadHash,
                      ),
                    )
                  }
                >
                  <RotateCcw aria-hidden="true" /> Retry
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (!window.confirm("Remove this unsaved device copy? This cannot be undone.")) return;
                    void mutateContextualNoteOutboxInBrowser(ownerId, (storage) =>
                      removeContextualNoteOutboxEntry(
                        storage,
                        ownerId,
                        entry.clientKey,
                        entry.payloadHash,
                      ),
                    );
                  }}
                >
                  <Trash2 aria-hidden="true" /> Remove
                </Button>
              </span>
            ))}
          />
        ) : pending.length > 0 ? (
          <StateNotice
            className="mr-auto flex-1"
            state={pending.some((entry) => entry.status === "syncing") ? "saving" : "pending"}
            title={pending.some((entry) => entry.status === "syncing") ? "Saving note…" : "Note waiting to save"}
            description="The reviewed text is retained on this device until the server acknowledges it."
          />
        ) : null}
        <Button data-testid="contextual-note-trigger" type="button" size="touch" variant="outline" onClick={() => beginComposer()}>
          <FilePenLine aria-hidden="true" /> Add note
        </Button>
        <ContextualNoteManager />
      </div>
      {children}

      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerContent className="[--drawer-content-max-height:calc(100dvh-1rem)] [&_[data-slot=drawer-content]]:overflow-hidden [&_button]:min-h-11 [&_textarea]:min-h-24">
          <DrawerHeader>
            <DrawerTitle>Add a training note</DrawerTitle>
            <DrawerDescription>
              This is your observation, not a diagnosis. It is saved before any optional Coach use.
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="space-y-4 p-4">
              <label className="block text-sm font-medium">
                Attach to
                <select
                  className="mt-1 min-h-11 w-full rounded-lg border bg-background px-3"
                  value={attachmentKey}
                  onChange={(event) => setAttachmentKey(event.target.value)}
                >
                  {composerScope.attachments.map((attachment) => (
                    <option key={attachment.key} value={attachment.key}>
                      {attachment.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded-xl border bg-muted/30 p-3 text-sm">
                <p className="font-medium">Captured context</p>
                <p className="mt-1 text-muted-foreground">
                  {composerScope.capturedContext.workflow ?? "General training"}
                  {composerScope.capturedContext.originatedFromSimulation
                    ? " · brought from Simulation for explicit review"
                    : ""}
                </p>
              </div>
              {retainedFromDifferentScope && (
                <StateNotice
                  state="idle"
                  title="Draft kept with its original context"
                  description="This draft still describes where you started it. Save or discard it before starting a note for this page."
                />
              )}
              <label className="block text-sm font-medium">
                Your observation
                <Textarea
                  className="mt-1"
                  value={body}
                  onChange={(event) => {
                    const nextBody = event.target.value;
                    setBody(nextBody);
                    if (
                      retainedFromDifferentScope &&
                      nextBody.trim().length === 0
                    ) {
                      setComposerScope(scope);
                      setAttachmentKey(scope.defaultAttachmentKey);
                      setRetainedFromDifferentScope(false);
                    }
                    setIssue(null);
                  }}
                  maxLength={5_000}
                  rows={5}
                  autoFocus
                />
              </label>
              <p className="text-xs text-muted-foreground">{body.length} / 5,000 characters</p>
              <label className="flex min-h-11 items-center gap-3 rounded-xl border p-3 text-sm">
                <Checkbox
                  checked={coachVisible}
                  onCheckedChange={(checked) => setCoachVisible(checked === true)}
                />
                <span className="min-w-0">
                  <span className="block font-medium">Visible to Coach and Review</span>
                  <span className="block text-muted-foreground">
                    On by default. Turn it off to keep this note private from AI context.
                  </span>
                </span>
                {!coachVisible && <LockKeyhole className="ml-auto size-4 shrink-0" aria-label="Private note" />}
              </label>
            </div>
            <div className="space-y-4 px-4 pb-4">
              {body.trim().length > 0 && (
                <StateNotice
                  state="idle"
                  title="Typed draft retained"
                  description="Save or explicitly discard this draft before confirming dictation, so one observation can never replace another silently."
                />
              )}
              <LiveCoachDictation
                target={{
                  messageKind: "observation",
                  sessionExerciseId: null,
                  exerciseName:
                    composerScope.attachments.find((item) => item.key === attachmentKey)?.label ??
                    "general training",
                  activeRestTimerSeconds: composerScope.capturedContext.restContext?.remainingSeconds ?? null,
                }}
                onDecision={async (decision) => {
                  if (decision.type !== "confirm") return { ok: true };
                  const blockedReason = contextualNoteDictationBlockedReason(body);
                  if (blockedReason) {
                    return {
                      ok: false,
                      reason: blockedReason,
                    };
                  }
                  const result = await queueNote({
                    text: decision.transcript,
                    inputMode: "reviewed_dictation",
                    clientKey: decision.clientKey,
                  });
                  if (!result.ok) setIssue(result.reason);
                  return result;
                }}
              />
              {issue && (
                <StateNotice state="needs_attention" title="This note was not queued" description={issue} />
              )}
              {composerScope.capturedContext.originatedFromSimulation && (
                <StateNotice
                  state="idle"
                  title="Simulation remains separate"
                  description="Confirming creates a new real note. It does not promote the simulated record or any other rehearsal data."
                />
              )}
            </div>
          </div>
          <DrawerFooter
            className="mt-0 border-t bg-background/95 pt-3 backdrop-blur"
            role="group"
            aria-label="Note actions"
          >
            <Button
              type="button"
              onClick={() => {
                void queueNote({ text: body, inputMode: "typed" }).then((result) => {
                  if (!result.ok) setIssue(result.reason);
                });
              }}
              disabled={body.trim().length < 1}
            >
              Save note
            </Button>
            <Button type="button" variant="outline" size="touch" onClick={() => setOpen(false)}>
              Close · keep draft
            </Button>
            {body.trim().length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="touch"
                onClick={() => {
                  if (!window.confirm("Discard this unsaved note draft? This cannot be undone.")) return;
                  setBody("");
                  setRetainedFromDifferentScope(false);
                  setIssue(null);
                  setOpen(false);
                }}
              >
                <Trash2 aria-hidden="true" /> Discard draft
              </Button>
            )}
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
