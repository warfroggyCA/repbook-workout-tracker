"use client";

import { Check, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RestCockpit({
  phase,
  remainingSeconds,
  alertLabel,
  alertAriaLabel = alertLabel.toLowerCase(),
  destinationLabel,
  resumeLabel = null,
  onAdjust,
  onEnd,
}: {
  phase: "running" | "ready" | "skipped";
  remainingSeconds: number | null;
  alertLabel: string;
  alertAriaLabel?: string;
  destinationLabel: string | null;
  resumeLabel?: string | null;
  onAdjust: (deltaSeconds: number) => void;
  onEnd: () => void;
}) {
  const running = phase === "running" && remainingSeconds != null;
  const destination = destinationLabel
    ? `Next: ${destinationLabel}`
    : resumeLabel
      ? `Resume plan: ${resumeLabel}`
    : "No further work";
  return (
    <div
      role="region"
      aria-label="Rest timer"
      data-testid="rest-cockpit"
      data-rest-phase={phase}
      className={cn(
        "col-span-full min-w-0",
        running &&
          "mb-0.5 rounded-xl border-2 border-primary/40 bg-[var(--surface-selected)] px-2 py-1.5 shadow-sm",
        !running &&
          phase === "ready" &&
          "border-b border-emerald-600/35 bg-emerald-50/80 pb-1 text-emerald-950 dark:bg-emerald-950/65 dark:text-emerald-100",
        !running &&
          phase === "skipped" &&
          "border-b border-border bg-muted/35 pb-1",
      )}
    >
      {running ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_repeat(3,auto)] items-center gap-1.5 max-[360px]:grid-cols-3 max-[360px]:gap-1">
          <div className="min-w-0 max-[360px]:col-span-3">
            <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 leading-none">
              <span className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-[0.1em] text-primary">
                <Timer aria-hidden="true" className="size-3.5" />
                Rest
              </span>
              <span
                className="text-xl font-bold tracking-tight tabular-nums"
                aria-label={`${Math.floor(remainingSeconds / 60)} minutes ${remainingSeconds % 60} seconds remaining`}
              >
                {Math.floor(remainingSeconds / 60)}:{String(
                  remainingSeconds % 60,
                ).padStart(2, "0")}
              </span>
              <span
                className="text-xs text-muted-foreground"
                aria-label={`Rest alert: ${alertAriaLabel}`}
              >
                · {alertLabel}
              </span>
            </p>
            <p className="break-words text-xs leading-tight text-muted-foreground">
              {destination}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-[44px] min-h-[44px] min-w-[44px] border-primary/25 bg-background/90 px-[6px] text-xs shadow-xs max-[360px]:w-full"
            onClick={() => onAdjust(-15)}
            aria-label="Decrease rest by 15 seconds"
          >
            −15s
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-[44px] min-h-[44px] min-w-[44px] border-primary/25 bg-background/90 px-[6px] text-xs shadow-xs max-[360px]:w-full"
            onClick={() => onAdjust(15)}
            aria-label="Increase rest by 15 seconds"
          >
            +15s
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-[44px] min-h-[44px] min-w-[44px] border-primary/25 bg-background/90 px-[6px] text-xs shadow-xs max-[360px]:w-full"
            onClick={onEnd}
          >
            End rest
          </Button>
        </div>
      ) : (
        <div
          role={phase === "ready" ? "status" : undefined}
          aria-live={phase === "ready" ? "polite" : undefined}
          aria-atomic={phase === "ready" ? "true" : undefined}
          className="flex min-h-8 min-w-0 items-center gap-1.5 px-1 text-xs font-medium"
        >
          {phase === "ready" ? (
            <Check aria-hidden="true" className="size-4 shrink-0" />
          ) : null}
          <span className="shrink-0 font-semibold">
            {phase === "ready" ? "Rest complete" : "Rest ended"}
          </span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 break-words text-muted-foreground">
            {destination}
          </span>
        </div>
      )}
    </div>
  );
}
