import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ActiveSetCockpit({
  exerciseName,
  setLabel,
  totalSets,
  prominent,
  children,
}: {
  exerciseName: string;
  setLabel: string;
  totalSets: number | null;
  prominent: boolean;
  children: ReactNode;
}) {
  return (
    <section
      data-testid="active-workout-primary"
      aria-label={`${exerciseName}, ${setLabel}`}
      className="min-w-0"
    >
      <div
        className={cn(
          "mb-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg px-3 py-2",
          prominent
            ? "border border-primary/25 bg-primary/10"
            : "bg-muted/40",
        )}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          <span className="sr-only">Current action · </span>
          Current set
        </p>
        <p className="text-lg font-bold tabular-nums">
          {setLabel} of {totalSets ?? "open"}
        </p>
      </div>
      {children}
    </section>
  );
}
