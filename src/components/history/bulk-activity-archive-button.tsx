"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import { resetActivityHistory } from "@/app/actions/activities";
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
import type { BulkActivityArchivePreview } from "@/services/archive";

export function BulkActivityArchiveButton({
  preview,
}: {
  preview: BulkActivityArchivePreview;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (preview.activities === 0) return null;
  const scope =
    `${preview.activities} manual activit${preview.activities === 1 ? "y" : "ies"}` +
    (preview.earliest && preview.latest
      ? ` · ${preview.earliest} to ${preview.latest}`
      : "");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setError(null);
      }}
    >
      <DialogTrigger
        render={<Button size="sm" variant="outline" className="text-destructive" />}
      >
        <Archive className="size-4" /> Archive all activities
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive every manual activity?</DialogTitle>
          <DialogDescription>
            A verified safety snapshot is created first. All manual activities
            then leave History, Coach, and ordinary exports in one recoverable
            operation — their records, dates, and details stay in Archive, and
            one Undo restores them all.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl bg-muted/60 p-3 text-sm">
          <p className="font-medium">Exact scope</p>
          <p className="mt-1 text-muted-foreground">{scope}</p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await resetActivityHistory(preview.activities);
                if (!result.ok) {
                  setError(result.reason);
                  return;
                }
                setOpen(false);
                router.refresh();
                toast.success("Manual activities archived", {
                  description: "Every record stays recoverable in Archive.",
                  action: {
                    label: "Undo",
                    onClick: async () => {
                      const restored = await restoreArchiveOperation(
                        result.operationId
                      );
                      if (restored.ok) {
                        toast.success("Activities restored");
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
            {pending
              ? "Archiving…"
              : `Archive ${preview.activities} activit${preview.activities === 1 ? "y" : "ies"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
