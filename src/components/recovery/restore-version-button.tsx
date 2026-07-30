"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { History } from "lucide-react";
import { toast } from "sonner";
import { restoreEarlierVersion } from "@/app/actions/versions";
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

export function RestoreVersionButton({
  versionId,
  recordLabel,
  changedFields,
}: {
  versionId: string;
  recordLabel: string;
  changedFields: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [clientMutationId, setClientMutationId] = useState(
    () => crypto.randomUUID(),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <History className="size-3.5" /> Restore earlier values
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore the earlier values for {recordLabel}?</DialogTitle>
          <DialogDescription>
            A new encrypted safety snapshot is created and verified first. The
            current values are then retained as another version, so this rollback
            can itself be reversed later.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p className="font-medium">Fields restored</p>
          <p className="mt-1 text-muted-foreground">
            {changedFields.length > 0 ? changedFields.join(", ") : "Recorded values"}
          </p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await restoreEarlierVersion(
                  versionId,
                  clientMutationId,
                );
                if (!result.ok) {
                  setError(result.reason);
                  return;
                }
                setOpen(false);
                setClientMutationId(crypto.randomUUID());
                toast.success("Earlier values restored", {
                  description: "The replaced values remain available in edit history.",
                });
                router.refresh();
              })
            }
          >
            {pending ? "Protecting and restoring…" : "Create snapshot and restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
