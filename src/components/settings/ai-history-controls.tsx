"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { archiveAIHistoryAction } from "@/app/actions/ai-privacy";
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
import type { AIHistoryArchivePreview } from "@/services/ai-privacy";

export function AIHistoryControls({
  preview,
}: {
  preview: AIHistoryArchivePreview;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hasHistory = preview.coachingInsights + preview.parsingInputs > 0;

  function archiveHistory() {
    setError(null);
    startTransition(async () => {
      const result = await archiveAIHistoryAction(preview);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setOpen(false);
      toast.success("AI and Coach history cleared", {
        description:
          "Coach records are in Archive. Retained raw AI inputs were securely cleared.",
        action: {
          label: "Restore Coach history",
          onClick: async () => {
            const restored = await restoreArchiveOperation(result.operationId);
            if (restored.ok) {
              toast.success("Coach history restored");
              router.refresh();
            } else {
              toast.error(restored.reason);
            }
          },
        },
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        className="h-auto min-h-8 max-w-full justify-start whitespace-normal text-left text-destructive"
        disabled={!hasHistory}
        onClick={() => setOpen(true)}
      >
        <Archive className="size-4" /> Clear AI and Coach history
      </Button>
      {!hasHistory && (
        <p className="text-xs text-muted-foreground">
          There is no active AI or Coach history to clear.
        </p>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) {
            setOpen(next);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear AI and Coach history?</DialogTitle>
            <DialogDescription>
              A verified safety copy is created first. Coach messages and answers
              move to Archive. Stored AI parsing inputs and outputs are then cleared,
              while confirmed workouts, programs, imports, and activity history stay
              unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl bg-muted/60 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <ShieldCheck className="size-4" /> Exact scope
            </p>
            <p className="mt-1 text-muted-foreground">
              {preview.coachingInsights} Coach record
              {preview.coachingInsights === 1 ? "" : "s"} · {preview.parsingInputs}{" "}
              retained AI input{preview.parsingInputs === 1 ? "" : "s"}
            </p>
          </div>
          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />} disabled={pending}>
              Cancel
            </DialogClose>
            <Button variant="destructive" disabled={pending} onClick={archiveHistory}>
              {pending ? "Protecting and clearing…" : "Create safety copy and clear"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
