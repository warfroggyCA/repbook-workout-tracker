"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import { removeHevyHistoryImport } from "@/app/actions/hevy-import";
import { restoreArchiveOperation } from "@/app/actions/archive";
import type { ImportBatchArchivePreview } from "@/services/archive";
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

export function ImportBatchArchiveButton({
  batchId,
  filename,
  preview,
}: {
  batchId: string;
  filename: string;
  preview: ImportBatchArchivePreview;
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
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Archive className="size-3.5" /> Archive import
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {filename}?</DialogTitle>
          <DialogDescription>
            Repbook will first create and check a backup. These records will then be hidden from History, Coach, progress, and exports. You can restore them later.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p className="font-medium">Exact active scope</p>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {preview.importBatches} import batch · {preview.workouts} workouts ·{" "}
            {preview.sessionExerciseGroups} exercise groups ·{" "}
            {preview.exerciseOccurrences} exercises · {preview.sessionOccurrences} planned sets and warm-ups ·{" "}
            {preview.sessionOccurrenceMutations} save confirmations · {preview.sets} sets ·{" "}
            {preview.notes} notes · {preview.painLogs} pain logs · {preview.fatigueLogs} fatigue logs ·{" "}
            {preview.coachingMessages} Coach messages ·{" "}
            {preview.recommendations} recommendations
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Kept for recovery: {preview.importFiles} source file ·{" "}
            {preview.reviewDecisions} review decisions · {preview.reviewedMappings} mappings ·{" "}
            {preview.customExercises} custom exercises · {preview.warnings} warnings.
          </p>
          {preview.previouslyArchivedWorkouts > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {preview.previouslyArchivedWorkouts} workout(s) already archived separately remain
              controlled by their earlier archive action.
            </p>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removeHevyHistoryImport(batchId, preview);
                if (!result.ok) {
                  setError(result.reason);
                  return;
                }
                setOpen(false);
                router.refresh();
                toast.success("Import batch archived", {
                  description: "The original file, exercise matches, and review decisions are kept.",
                  action: {
                    label: "Undo",
                    onClick: async () => {
                      const restored = await restoreArchiveOperation(result.operationId);
                      if (restored.ok) {
                        toast.success("Import batch restored");
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
            {pending ? "Protecting and archiving…" : "Create snapshot and archive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
