"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActiveWorkoutRecoveryItem } from "@/lib/active-workout-view-model";

export function WorkoutRecoveryStatus({
  items,
  onResolve,
}: {
  items: ActiveWorkoutRecoveryItem[];
  onResolve?: (item: ActiveWorkoutRecoveryItem) => void;
}) {
  if (items.length === 0) return null;
  const primary = items[0]!;
  return (
    <section
      role="alert"
      data-testid="workout-recovery-status"
      className="rounded-xl border border-destructive/35 bg-destructive/5 px-3 py-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
        <p className="min-w-0 flex-1 text-sm font-semibold">{primary.label}</p>
        {onResolve && primary.sessionExerciseId != null && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 bg-background"
            onClick={() => onResolve(primary)}
          >
            Review
          </Button>
        )}
      </div>
      {items.length > 1 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {items.length - 1} more recovery item{items.length === 2 ? "" : "s"}
        </p>
      )}
    </section>
  );
}
