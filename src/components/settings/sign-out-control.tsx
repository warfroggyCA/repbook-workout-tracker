"use client";

import {
  useCallback,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { signOutCurrentUser } from "@/app/actions/settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  describeSignOutDeviceStore,
  discardSignOutDeviceWork,
  getSignOutDeviceWorkServerSnapshot,
  getSignOutDeviceWorkSnapshot,
  subscribeToSignOutDeviceWork,
} from "@/lib/sign-out-device-work";

export function SignOutControl({ ownerId }: { ownerId: string }) {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeToSignOutDeviceWork(ownerId, onStoreChange),
    [ownerId],
  );
  const getSnapshot = useCallback(
    () => getSignOutDeviceWorkSnapshot(ownerId),
    [ownerId],
  );
  const getServerSnapshot = useCallback(
    () => getSignOutDeviceWorkServerSnapshot(ownerId),
    [ownerId],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isPending || isDiscarding;

  function finishSignOut() {
    startTransition(() => void signOutCurrentUser());
  }

  function beginSignOut() {
    setError(null);
    const latest = getSignOutDeviceWorkSnapshot(ownerId);
    if (latest.needsReview) {
      setOpen(true);
      return;
    }
    finishSignOut();
  }

  function keepCopiesAndSignOut() {
    if (isBusy) return;
    setError(null);
    getSignOutDeviceWorkSnapshot(ownerId);
    finishSignOut();
  }

  async function discardAndSignOut() {
    if (isDiscarding) return;
    setError(null);
    setIsDiscarding(true);
    const result = await discardSignOutDeviceWork(ownerId);
    if (!result.ok) {
      setError(result.reason);
      setIsDiscarding(false);
      return;
    }
    finishSignOut();
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={isBusy}
        onClick={beginSignOut}
      >
        {isBusy ? "Signing out…" : "Sign out"}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (isBusy && !nextOpen) return;
          setOpen(nextOpen);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved work is on this device</DialogTitle>
            <DialogDescription>
              Review all saved device work before choosing whether to keep or
              discard this account&apos;s readable copies.
            </DialogDescription>
          </DialogHeader>
          <ul
            aria-label="Saved device work"
            className="space-y-1 text-sm text-muted-foreground"
          >
            {snapshot.stores.map((store) => (
              <li key={store.kind}>{describeSignOutDeviceStore(store)}</li>
            ))}
          </ul>
          {(snapshot.quarantinedCount > 0 || snapshot.errorCount > 0) && (
            <p className="text-sm text-muted-foreground">
              Unreadable or unattributable copies cannot be safely discarded in
              bulk. Keep them and review them after signing in again.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="sm:flex-wrap">
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="outline"
                  disabled={isBusy}
                />
              }
            >
              Stay signed in
            </DialogClose>
            <Button
              type="button"
              variant="outline"
              disabled={isBusy}
              onClick={keepCopiesAndSignOut}
            >
              Sign out and keep copies
            </Button>
            {snapshot.canDiscardOwnerCopies && (
              <Button
                type="button"
                variant="destructive"
                disabled={isBusy}
                onClick={discardAndSignOut}
              >
                {isDiscarding
                  ? "Discarding copies…"
                  : "Discard this account\u2019s copies and sign out"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
