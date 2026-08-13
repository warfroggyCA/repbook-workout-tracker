"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
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
  discardQuarantinedWorkoutSet,
  getWorkoutSetOutboxServerSnapshot,
  getWorkoutSetOutboxSnapshot,
  removeWorkoutSet,
  subscribeToWorkoutSetOutbox,
} from "@/lib/workout-set-outbox";
import {
  discardUnreadableOccurrenceMutationOutbox,
  getOccurrenceMutationOutboxServerSnapshot,
  getOccurrenceMutationOutboxSnapshot,
  removeOccurrenceMutation,
  subscribeToOccurrenceMutationOutbox,
} from "@/lib/occurrence-mutation-outbox";

export function ActiveWorkoutDiscard({
  sessionId,
  sessionName,
  triggerLabel = "Discard this workout",
  onBeforeDiscard,
}: {
  sessionId: string;
  sessionName: string;
  triggerLabel?: string;
  onBeforeDiscard?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const outbox = useSyncExternalStore(
    subscribeToWorkoutSetOutbox,
    getWorkoutSetOutboxSnapshot,
    getWorkoutSetOutboxServerSnapshot
  );
  const retainedEntries = outbox.entries.filter(
    (entry) => entry.sessionId === sessionId
  );
  const retainedSets = retainedEntries.length;
  const quarantinedCopies = outbox.quarantined.length;
  const occurrenceOutbox = useSyncExternalStore(
    subscribeToOccurrenceMutationOutbox,
    getOccurrenceMutationOutboxSnapshot,
    getOccurrenceMutationOutboxServerSnapshot,
  );
  const retainedOccurrenceEntries = occurrenceOutbox.entries.filter(
    (entry) => entry.sessionId === sessionId,
  );
  const retainedOccurrenceChanges = retainedOccurrenceEntries.length;
  const unreadableOccurrenceChanges = occurrenceOutbox.error != null;
  const deviceCopiesRemain =
    retainedSets > 0 ||
    quarantinedCopies > 0 ||
    retainedOccurrenceChanges > 0 ||
    unreadableOccurrenceChanges;

  async function abandonNow() {
    await onBeforeDiscard?.();
    await abandonSession(sessionId);
  }

  // Exit must always be reachable. When unsent set copies remain, the user can
  // explicitly discard them and abandon instead of being trapped. This is a
  // deliberate, confirmed removal of device-only copies — nothing is dropped
  // silently, and the server marks any pending occurrences as abandoned rather
  // than performed.
  async function discardCopiesAndAbandon() {
    for (const entry of retainedEntries) {
      await removeWorkoutSet(entry.clientKey);
    }
    for (const copy of outbox.quarantined) {
      await discardQuarantinedWorkoutSet(copy.quarantineKey, copy.raw);
    }
    for (const entry of retainedOccurrenceEntries) {
      await removeOccurrenceMutation(entry.clientKey);
    }
    if (unreadableOccurrenceChanges) {
      discardUnreadableOccurrenceMutationOutbox();
    }
    await abandonNow();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto [&_button]:min-h-11 [&_button]:min-w-11">
        <DialogHeader>
          <DialogTitle>Discard {sessionName}?</DialogTitle>
          <DialogDescription>
            This marks the unfinished workout as abandoned and returns Today to
            normal workout selection. Saved history is retained, but this active
            workout cannot be resumed afterward.
          </DialogDescription>
        </DialogHeader>
        {deviceCopiesRemain && (
          <p
            role="alert"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
          >
            {retainedSets > 0 &&
              `${retainedSets} logged set ${retainedSets === 1 ? "copy is" : "copies are"} still waiting to sync. `}
            {quarantinedCopies > 0 &&
              `${quarantinedCopies} unreadable set ${quarantinedCopies === 1 ? "copy is" : "copies are"} retained. `}
            {retainedOccurrenceChanges > 0 &&
              `${retainedOccurrenceChanges} warm-up or workout-item ${retainedOccurrenceChanges === 1 ? "change is" : "changes are"} still waiting to sync. `}
            {unreadableOccurrenceChanges &&
              "Unreadable workout-item changes are retained on this device. "}
            If you can, resume the workout to retry syncing them first.
            Otherwise you can discard those device copies and abandon anyway —
            the copies will be permanently removed and will not appear in
            history.
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            Keep workout
          </DialogClose>
          {deviceCopiesRemain ? (
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
              {pending ? "Discarding…" : "Discard unsent copies & abandon"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              className="h-auto min-h-11 whitespace-normal py-2 text-balance"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  await abandonNow();
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
