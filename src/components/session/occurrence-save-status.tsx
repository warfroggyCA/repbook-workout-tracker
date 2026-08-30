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
  displayLabel = null,
  saved = false,
  runtimeState = null,
  onRetry,
  onDiscard,
}: {
  entry: OccurrenceMutationOutboxEntry | null;
  displayLabel?: string | null;
  saved?: boolean;
  runtimeState?: "saving" | "retrying" | null;
  onRetry: (entry: OccurrenceMutationOutboxEntry) => void;
  onDiscard: (entry: OccurrenceMutationOutboxEntry) => void;
}) {
  if (!entry) {
    return saved ? (
      <p
        role="status"
        data-ui-state="saved"
        className="ui-state mt-2 w-full border-0 px-2 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
      >
        {displayLabel ? `${displayLabel} · Saved` : "Saved"}
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
  const actionLabel = displayLabel ?? entry.label;

  return (
    <div
      data-ui-state={failed ? "retained" : runtimeState ?? "pending"}
      className="ui-state mt-2 w-full p-3 text-xs"
    >
      <div role={failed ? "alert" : "status"}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="font-semibold text-foreground">{actionLabel}</span>
          <span
            className={cn(
              "font-medium text-muted-foreground",
              failed && "text-destructive",
            )}
          >
            {operationLabel(entry.operation)} · {state}
          </span>
        </div>
        <p className="mt-1 leading-5 text-muted-foreground">
          {failed
            ? `This device copy did not save. Retry save, or discard it to restore ${actionLabel.toLowerCase()}.`
            : `${actionLabel} will not advance until Repbook acknowledges this change.`}
        </p>
        {entry.lastError && (
          <p className="mt-2 text-sm text-foreground">
            {entry.lastError}
          </p>
        )}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 min-[460px]:grid-cols-2">
          {failed && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onRetry(entry)}
            >
              <RotateCcw className="size-4" /> Retry save
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            className="text-destructive"
            onClick={() => onDiscard(entry)}
          >
            <Trash2 className="size-4" /> Discard device copy
          </Button>
      </div>
    </div>
  );
}
