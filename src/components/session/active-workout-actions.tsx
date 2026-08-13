"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { abandonSession } from "@/app/actions/sessions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  getWorkoutSetOutboxServerSnapshot,
  getWorkoutSetOutboxSnapshot,
  subscribeToWorkoutSetOutbox,
  withOutboxLock,
} from "@/lib/workout-set-outbox";
import {
  getOccurrenceMutationOutboxServerSnapshot,
  getOccurrenceMutationOutboxSnapshot,
  subscribeToOccurrenceMutationOutbox,
  withOccurrenceMutationOutboxLock,
} from "@/lib/occurrence-mutation-outbox";
import { sessionScopedDeviceCopies } from "@/lib/session-runner";
import {
  activeWorkoutDiscardDialogOpenState,
  discardSessionCopiesAndAbandon,
} from "@/lib/active-workout-discard";

export function ActiveWorkoutDiscard({
  ownerId,
  sessionId,
  sessionName,
  triggerLabel = "Discard this workout",
  onBeforeDiscard,
}: {
  ownerId: string;
  sessionId: string;
  sessionName: string;
  triggerLabel?: string;
  onBeforeDiscard?: () => void | Promise<void>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const outbox = useSyncExternalStore(
    subscribeToWorkoutSetOutbox,
    getWorkoutSetOutboxSnapshot,
    getWorkoutSetOutboxServerSnapshot
  );
  const occurrenceOutbox = useSyncExternalStore(
    subscribeToOccurrenceMutationOutbox,
    getOccurrenceMutationOutboxSnapshot,
    getOccurrenceMutationOutboxServerSnapshot,
  );
  const scopedCopies = sessionScopedDeviceCopies({
    ownerId,
    sessionId,
    setCopies: outbox.entries,
    occurrenceCopies: occurrenceOutbox.entries,
  });
  const retainedEntries = scopedCopies.setCopies;
  const retainedSets = retainedEntries.length;
  const quarantinedCopies = outbox.quarantined.length;
  const retainedOccurrenceEntries = scopedCopies.occurrenceCopies;
  const retainedOccurrenceChanges = retainedOccurrenceEntries.length;
  const otherIdentifiedCopies =
    outbox.entries.length - retainedEntries.length +
    occurrenceOutbox.entries.length - retainedOccurrenceEntries.length;
  const unreadableOccurrenceChanges = occurrenceOutbox.error != null;
  const scopedDeviceCopiesRemain =
    retainedSets > 0 ||
    retainedOccurrenceChanges > 0;
  const unscopableCopiesRemain =
    otherIdentifiedCopies > 0 ||
    quarantinedCopies > 0 ||
    outbox.error != null ||
    unreadableOccurrenceChanges;

  // Exit must always be reachable. When unsent set copies remain, the user can
  // explicitly discard them and abandon instead of being trapped. This is a
  // deliberate, confirmed removal of device-only copies — nothing is dropped
  // silently, and the server marks any pending occurrences as abandoned rather
  // than performed.
  async function discardCopiesAndAbandon() {
    setDiscardError(null);
    let result: Awaited<ReturnType<typeof discardSessionCopiesAndAbandon>>;
    try {
      result = await withOutboxLock(() =>
        withOccurrenceMutationOutboxLock(() =>
          discardSessionCopiesAndAbandon({
            storage: window.localStorage,
            ownerId,
            sessionId,
            abandon: () => abandonSession(sessionId),
          }),
        ),
      );
    } catch {
      result = {
        ok: false,
        reason:
          "Repbook could not safely open the device copies. Nothing was discarded.",
      };
    }
    if (!result.ok) {
      setDiscardError(result.reason);
      return;
    }
    try {
      await onBeforeDiscard?.();
    } catch {
      // Navigation follows the authoritative server result; a stale local
      // rest timer must not keep the user inside a workout that has ended.
    }
    router.replace("/today");
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(requestedOpen) => {
        setOpen((currentOpen) =>
          activeWorkoutDiscardDialogOpenState({
            currentOpen,
            requestedOpen,
            pending,
          }),
        );
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 w-full whitespace-normal border-destructive/40 py-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
          />
        }
      >
        <Trash2 className="size-4" /> {triggerLabel}
      </DialogTrigger>
      <DialogContent
        showCloseButton={!pending}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto [&_button]:min-h-11 [&_button]:min-w-11"
      >
        <DialogHeader>
          <DialogTitle>Discard {sessionName}?</DialogTitle>
          <DialogDescription>
            This marks the unfinished workout as abandoned and returns Today to
            normal workout selection. Saved history is retained, but this active
            workout cannot be resumed afterward. At confirmation, Repbook
            rechecks this workout&apos;s device queue. Any unsaved set or
            workout-item copies found then are permanently removed and will not
            appear in History.
          </DialogDescription>
        </DialogHeader>
        {scopedDeviceCopiesRemain && (
          <p
            role="alert"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
          >
            {retainedSets > 0 &&
              `${retainedSets} logged set ${retainedSets === 1 ? "copy is" : "copies are"} still waiting to sync. `}
            {retainedOccurrenceChanges > 0 &&
              `${retainedOccurrenceChanges} warm-up or workout-item ${retainedOccurrenceChanges === 1 ? "change is" : "changes are"} still waiting to sync. `}
            If you can, resume the workout to retry syncing them first.
            Otherwise you can discard only this workout&apos;s identified device
            copies and abandon anyway. They will be permanently removed and
            will not appear in history.
          </p>
        )}
        {unscopableCopiesRemain && (
          <p
            role="note"
            className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 text-sm text-sky-950 dark:text-sky-100"
          >
            {quarantinedCopies > 0 &&
              `${quarantinedCopies} unreadable set ${quarantinedCopies === 1 ? "copy may" : "copies may"} belong to this or another workout. `}
            {otherIdentifiedCopies > 0 &&
              `${otherIdentifiedCopies} identified device ${otherIdentifiedCopies === 1 ? "copy belongs" : "copies belong"} to another workout or account. `}
            {outbox.error != null &&
              "The saved-set queue could not be read. "}
            {unreadableOccurrenceChanges &&
              "The workout-item queue could not be read. "}
            Repbook will keep these copies on this device. Abandoning this
            workout will not delete them; review them separately under the
            device-copy trays.
          </p>
        )}
        {discardError && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {discardError}
          </p>
        )}
        <DialogFooter>
          <DialogClose
            render={
              <Button type="button" variant="outline" disabled={pending} />
            }
          >
            Keep workout
          </DialogClose>
          {scopedDeviceCopiesRemain ? (
            <Button
              type="button"
              variant="destructive"
              className="h-auto min-h-11 whitespace-normal py-2 text-balance"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  await discardCopiesAndAbandon();
                });
              }}
            >
              {pending ? "Discarding…" : "Discard current device copies & abandon"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              className="h-auto min-h-11 whitespace-normal py-2 text-balance"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  setDiscardError(null);
                  await discardCopiesAndAbandon();
                });
              }}
            >
              {pending ? "Discarding…" : "Confirm discard"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
