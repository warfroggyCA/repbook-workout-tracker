"use client";

import { Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RestCockpit({
  phase,
  remainingSeconds,
  alertLabel,
  alertAriaLabel = alertLabel.toLowerCase(),
  destinationLabel,
  onAdjust,
  onSkip,
  onContinue,
}: {
  phase: "running" | "ready" | "skipped";
  remainingSeconds: number | null;
  alertLabel: string;
  alertAriaLabel?: string;
  destinationLabel: string | null;
  onAdjust: (deltaSeconds: number) => void;
  onSkip: () => void;
  onContinue: () => void;
}) {
  const running = phase === "running" && remainingSeconds != null;
  return (
    <div
      role="region"
      aria-label="Rest timer"
      data-testid="rest-cockpit"
      className="min-w-0 basis-full rounded-lg border border-current/15 bg-background/55 px-2 py-1.5 max-[360px]:py-[3px]"
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_repeat(4,auto)] items-center gap-1.5 max-[360px]:grid-cols-4 max-[360px]:gap-1">
        <div className="min-w-0 max-[360px]:col-span-4">
          <p className="text-xs font-semibold uppercase tracking-[0.1em]">
            {running ? "Rest" : "Rest complete"}
          </p>
          <p className="line-clamp-2 break-words text-xs leading-tight text-muted-foreground">
            {destinationLabel ? `Next: ${destinationLabel}` : "No further work"}
          </p>
        </div>
        {running ? (
          <>
            <span
              className="flex min-w-14 flex-col items-center text-center font-semibold max-[360px]:justify-self-center"
              aria-label={`Rest alert: ${alertAriaLabel}`}
            >
              <span className="text-lg leading-none tabular-nums">
                {Math.floor(remainingSeconds / 60)}:{String(
                  remainingSeconds % 60,
                ).padStart(2, "0")}
              </span>
              <span className="mt-1 text-[9px] leading-none">{alertLabel}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="min-h-11 min-w-11 max-[360px]:justify-self-center"
              onClick={() => onAdjust(-15)}
              aria-label="Decrease rest by 15 seconds"
            >
              <Minus className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="min-h-11 min-w-11 max-[360px]:justify-self-center"
              onClick={() => onAdjust(15)}
              aria-label="Increase rest by 15 seconds"
            >
              <Plus className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="min-h-11 min-w-11 max-[360px]:justify-self-center"
              onClick={onSkip}
              aria-label="Skip rest"
            >
              <X className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <span role="status" aria-live="polite" className="sr-only">
              Rest complete
              {destinationLabel ? `. Next: ${destinationLabel}` : "."}
            </span>
            <Button
              type="button"
              size="sm"
              className="col-span-4 min-h-11 shrink-0 justify-self-end"
              onClick={onContinue}
            >
              Dismiss rest timer
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
