"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, Database } from "lucide-react";
import { toast } from "sonner";
import { archiveWorkoutTestData, loadWorkoutTestData } from "@/app/actions/history";
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
} from "@/components/ui/dialog";
import type { SampleHistoryArchivePreview } from "@/services/archive";

type Mode = "load" | "archive";

export function TestDataControls({
  testSessionCount,
  samplePreview,
}: {
  testSessionCount: number;
  samplePreview: SampleHistoryArchivePreview | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function runLoad() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await loadWorkoutTestData();
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setMode(null);
        setMessage(`${result.count} sample workouts are ready to explore.`);
        router.refresh();
      } catch {
        setError("The sample data could not be updated.");
      }
    });
  }

  function runArchive() {
    if (!samplePreview) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await archiveWorkoutTestData(samplePreview);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setMode(null);
      router.refresh();
      toast.success("Sample history archived", {
        description: "Every sample record stays recoverable in Archive.",
        action: {
          label: "Undo",
          onClick: async () => {
            const restored = await restoreArchiveOperation(result.operationId);
            if (restored.ok) {
              toast.success("Sample history restored");
              router.refresh();
            } else {
              toast.error(restored.reason);
            }
          },
        },
      });
    });
  }

  const sampleScope = samplePreview
    ? [
        `${samplePreview.workouts} workout${samplePreview.workouts === 1 ? "" : "s"}`,
        `${samplePreview.sessionExerciseGroups} exercise group${samplePreview.sessionExerciseGroups === 1 ? "" : "s"}`,
        `${samplePreview.exerciseOccurrences} exercise${samplePreview.exerciseOccurrences === 1 ? "" : "s"}`,
        `${samplePreview.sessionOccurrences} planned occurrence${samplePreview.sessionOccurrences === 1 ? "" : "s"}`,
        `${samplePreview.sessionOccurrenceMutations} mutation receipt${samplePreview.sessionOccurrenceMutations === 1 ? "" : "s"}`,
        `${samplePreview.sets} set${samplePreview.sets === 1 ? "" : "s"}`,
        `${samplePreview.notes} note${samplePreview.notes === 1 ? "" : "s"}`,
        `${samplePreview.painLogs} pain flag${samplePreview.painLogs === 1 ? "" : "s"}`,
        `${samplePreview.fatigueLogs} fatigue check-in${samplePreview.fatigueLogs === 1 ? "" : "s"}`,
        `${samplePreview.coachingMessages} Coach message${samplePreview.coachingMessages === 1 ? "" : "s"}`,
        `${samplePreview.recommendations} linked suggestion${samplePreview.recommendations === 1 ? "" : "s"}`,
      ].join(" · ")
    : null;

  return (
    <div className="flex flex-col items-start gap-2">
      {testSessionCount === 0 ? (
        <Button
          variant="outline"
          className="h-auto min-h-8 max-w-full whitespace-normal"
          onClick={() => setMode("load")}
        >
          <Database className="size-4" /> Load test data
        </Button>
      ) : (
        <Button
          variant="outline"
          className="h-auto min-h-8 max-w-full whitespace-normal text-destructive"
          onClick={() => setMode("archive")}
        >
          <Archive className="size-4" /> Archive sample history
        </Button>
      )}
      {message && (
        <p className="text-xs text-success" role="status">
          {message}
        </p>
      )}

      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setMode(null);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === "archive"
                ? "Archive the sample history?"
                : "Load a full sample history?"}
            </DialogTitle>
            <DialogDescription>
              {mode === "archive"
                ? "A verified safety snapshot is created first. Every clearly labelled sample workout and its linked records then move to Archive in one recoverable operation with one Undo. Real records are never touched."
                : "This adds 12 weeks of realistic, clearly labelled sample workouts with progressing loads, missed targets, fatigue, a substitution, an abandoned session, notes, and pain flags. Real data is never changed."}
            </DialogDescription>
          </DialogHeader>
          {mode === "archive" && sampleScope && (
            <div className="rounded-xl bg-muted/60 p-3 text-sm">
              <p className="font-medium">Exact scope</p>
              <p className="mt-1 text-muted-foreground">{sampleScope}</p>
            </div>
          )}
          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />} disabled={pending}>
              Cancel
            </DialogClose>
            <Button
              variant={mode === "archive" ? "destructive" : "default"}
              onClick={mode === "archive" ? runArchive : runLoad}
              disabled={pending || (mode === "archive" && !samplePreview)}
            >
              {mode === "archive"
                ? pending
                  ? "Archiving…"
                  : "Archive sample history"
                : pending
                  ? "Building sample history…"
                  : "Load Sample History"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
