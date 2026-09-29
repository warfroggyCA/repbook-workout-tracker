import {
  buildWorkoutHistoryHref,
  buildHistoryHref,
  type HistoryContext,
} from "@/lib/history-navigation";
import Link from "next/link";
import type { HistoryPattern } from "@/lib/history-patterns";
import { formatRecordedLocalDate } from "@/lib/dates";

export function HistoryPatterns({
  patterns,
  context,
}: {
  patterns: HistoryPattern[];
  context: HistoryContext;
}) {
  if (!patterns.length) return null;
  return (
    <section
      aria-labelledby="training-patterns-heading"
      className="border-t pt-5"
    >
      <h2 id="training-patterns-heading" className="ui-section-title">
        Patterns in your training
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        From the last 12 weeks
      </p>
      {patterns.slice(0, 3).map((pattern) => (
        <details key={pattern.key} className="border-b py-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary">
            {pattern.exerciseName}: skipped in {pattern.skipped} of the last{" "}
            {pattern.workouts.length} workouts where it was planned
          </summary>
          <ul className="divide-y text-sm">
            {pattern.workouts.map((workout) => (
              <li
                key={workout.sessionId}
                className="flex items-center justify-between gap-3 py-2"
              >
                <Link
                  className="min-h-11 py-2 text-primary underline-offset-4 hover:underline"
                  href={buildWorkoutHistoryHref(workout.sessionId, context)}
                >
                  {formatRecordedLocalDate(workout.localDate)} ·{" "}
                  {workout.workoutName}
                </Link>
                <span>{workout.skipped ? "Skipped" : "Not skipped"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            This observation does not mean your plan needs to change.
          </p>
          <Link
            href={`/coach?pattern=${encodeURIComponent(pattern.key)}&from=${encodeURIComponent(buildHistoryHref(context))}`}
            className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-primary"
          >
            Ask Coach about this →
          </Link>
        </details>
      ))}
    </section>
  );
}
