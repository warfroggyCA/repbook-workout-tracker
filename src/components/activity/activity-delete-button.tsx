"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import { archiveActivity } from "@/app/actions/activities";
import { restoreArchiveOperation } from "@/app/actions/archive";
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

export function ActivityDeleteButton({
  activityId,
  returnHref,
}: {
  activityId: string;
  returnHref: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setError(null);
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" className="text-destructive" />}
      >
        <Archive className="size-4" /> Archive activity
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive this activity?</DialogTitle>
          <DialogDescription>
            This removes one activity from History, Coach, and ordinary exports.
            Its original date, measurements, notes, and source stay recoverable
            in Archive.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await archiveActivity(activityId);
                if (!result.ok) {
                  setError(result.reason);
                  return;
                }
                setOpen(false);
                router.push(returnHref);
                router.refresh();
                toast.success("Activity archived", {
                  description: "Its original measurements and date are preserved.",
                  action: {
                    label: "Undo",
                    onClick: async () => {
                      const restored = await restoreArchiveOperation(
                        result.operationId
                      );
                      if (restored.ok) {
                        toast.success("Activity restored");
                        router.refresh();
                      } else {
                        toast.error(restored.reason);
                      }
                    },
                  },
                });
              })
            }
          >
            {pending ? "Archiving…" : "Archive activity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
