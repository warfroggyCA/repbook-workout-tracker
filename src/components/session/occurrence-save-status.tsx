"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OccurrenceMutationOutboxEntry } from "@/lib/occurrence-mutation-outbox";

function operationLabel(
  operation: OccurrenceMutationOutboxEntry["operation"],
) {
  if (operation === "complete") return "Completion";
  if (operation === "skip") return "Skip";
  if (operation === "restore") return "Restore";
  return "Note";
}

export function OccurrenceSaveStatus({
  entry,
  saved = false,
  runtimeState = null,
  onRetry,
  onDiscard,
}: {
  entry: OccurrenceMutationOutboxEntry | null;
  saved?: boolean;
  runtimeState?: "saving" | "retrying" | null;
  onRetry: (entry: OccurrenceMutationOutboxEntry) => void;
  onDiscard: (entry: OccurrenceMutationOutboxEntry) => void;
}) {
  if (!entry) {
    return saved ? (
      <p role="status" className="mt-2 w-full text-xs font-medium text-emerald-700 dark:text-emerald-300">
        Saved
      </p>
    ) : null;
  }

  const failed =
    entry.status === "needs_attention" || entry.lastError != null;
  const retrying = !failed && runtimeState === "retrying";
  const state = failed
    ? "Failed"
    : retrying
      ? "Retrying"
      : runtimeState === "saving"
        ? "Saving"
        : "Unsaved";

  return (
    <div className="mt-2 w-full border-t pt-2 text-xs" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          role={failed ? "alert" : "status"}
          className={cn(
            "font-medium text-muted-foreground",
            failed && "text-destructive",
          )}
        >
          {operationLabel(entry.operation)} · {state}
        </span>
        <div className="flex flex-wrap gap-2">
          {failed && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onRetry(entry)}
            >
              <RotateCcw className="size-4" /> Retry
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => onDiscard(entry)}
          >
            <Trash2 className="size-4" /> Discard unsaved change
          </Button>
        </div>
      </div>
      {entry.lastError && (
        <p className="mt-2 text-amber-800 dark:text-amber-300">
          {entry.lastError}
        </p>
      )}
    </div>
  );
}
