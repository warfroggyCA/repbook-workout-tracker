import type { ReactNode } from "react";
import type { ActiveWorkoutQueueItem } from "@/lib/active-workout-view-model";

export function ExerciseQueue({
  items,
  children,
}: {
  items: ActiveWorkoutQueueItem[];
  children: ReactNode;
}) {
  const remaining = items.filter(
    (item) => item.pending > 0 || item.status === "not_started",
  ).length;
  return (
    <section aria-label="Exercise queue" data-testid="exercise-queue">
      <div className="mb-1 flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-sm font-semibold">Exercise queue</h2>
        <p className="text-xs tabular-nums text-muted-foreground">
          {remaining > 0 ? `${remaining} remaining` : "All resolved"}
        </p>
      </div>
      <div role="list" className="flex flex-col gap-3">
        {children}
      </div>
    </section>
  );
}
