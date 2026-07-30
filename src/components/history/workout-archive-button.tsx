"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import { archiveWorkoutDay } from "@/app/actions/history";
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
import type { WorkoutArchivePreview } from "@/services/archive";

export function WorkoutArchiveButton({
  sessionId,
  returnHref,
  counts,
}: {
  sessionId: string;
  returnHref: string;
  counts: WorkoutArchivePreview;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const details = [
    `${counts.sessionExerciseGroups} exercise group${counts.sessionExerciseGroups === 1 ? "" : "s"}`,
    `${counts.exerciseOccurrences} exercise${counts.exerciseOccurrences === 1 ? "" : "s"}`,
    `${counts.sessionOccurrences} planned occurrence${counts.sessionOccurrences === 1 ? "" : "s"}`,
    `${counts.sessionOccurrenceMutations} mutation receipt${counts.sessionOccurrenceMutations === 1 ? "" : "s"}`,
    `${counts.sets} set${counts.sets === 1 ? "" : "s"}`,
    `${counts.notes} note${counts.notes === 1 ? "" : "s"}`,
    `${counts.painLogs} pain flag${counts.painLogs === 1 ? "" : "s"}`,
    `${counts.fatigueLogs} fatigue check-in${counts.fatigueLogs === 1 ? "" : "s"}`,
    `${counts.coachingMessages} Coach message${counts.coachingMessages === 1 ? "" : "s"}`,
    `${counts.recommendations} linked suggestion${counts.recommendations === 1 ? "" : "s"}`,
  ];

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
        <Archive className="size-4" /> Archive workout
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive this workout?</DialogTitle>
          <DialogDescription>
            The workout will leave Today, History, Coach, progression, and
            ordinary exports. Its complete record stays recoverable in Archive.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl bg-muted/60 p-3 text-sm">
          <p className="font-medium">Exact scope</p>
          <p className="mt-1 text-muted-foreground">
            1 workout · {details.join(" · ")}
          </p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await archiveWorkoutDay(sessionId);
                if (!result.ok) {
                  setError(result.reason);
                  return;
                }
                setOpen(false);
                router.push(returnHref);
                router.refresh();
                toast.success("Workout archived", {
                  description: "Its original date and details are preserved.",
                  action: {
                    label: "Undo",
                    onClick: async () => {
                      const restored = await restoreArchiveOperation(
                        result.operationId
                      );
                      if (restored.ok) {
                        toast.success("Workout restored");
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
            {pending ? "Archiving…" : "Archive workout"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
