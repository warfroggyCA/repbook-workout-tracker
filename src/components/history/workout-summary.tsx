import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type {
  WorkoutSummaryAnswer,
  WorkoutSummaryViewModel,
} from "@/lib/workout-summary";
import { cn } from "@/lib/utils";

function SummaryAnswer({
  question,
  answer,
}: {
  question: string;
  answer: WorkoutSummaryAnswer;
}) {
  return (
    <div className="border-t py-3 first:border-t-0 sm:[&:nth-child(-n+2)]:border-t-0 sm:[&:nth-child(even)]:border-l sm:[&:nth-child(even)]:pl-4 sm:[&:nth-child(odd)]:pr-4">
      <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {question}
      </dt>
      <dd className="mt-1">
        <span
          className={cn(
            "block font-semibold leading-snug",
            answer.tone === "attention" &&
              "text-amber-800 dark:text-amber-300",
            answer.tone === "positive" && "text-foreground",
          )}
        >
          {answer.value}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {answer.detail}
        </span>
        {answer.href && answer.actionLabel && (
          <Link
            href={answer.href}
            className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            {answer.actionLabel}{" "}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        )}
      </dd>
    </div>
  );
}

export function WorkoutSummary({
  summary,
}: {
  summary: WorkoutSummaryViewModel;
}) {
  return (
    <section
      aria-labelledby="workout-summary-heading"
      data-testid="workout-summary"
      className="rounded-2xl border bg-card px-4 py-3 shadow-[var(--shadow-soft)]"
    >
      <div className="pb-2">
        <h2 id="workout-summary-heading" className="text-lg font-semibold">
          Workout summary
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Recorded facts first; recommendations remain separate.
        </p>
      </div>
      <dl className="grid sm:grid-cols-2">
        <SummaryAnswer question="What happened?" answer={summary.happened} />
        <SummaryAnswer question="What changed?" answer={summary.changed} />
        <SummaryAnswer question="Was anything notable?" answer={summary.notable} />
        <SummaryAnswer
          question="Does anything deserve action next time?"
          answer={summary.next}
        />
      </dl>
      {summary.recordContext.length > 0 && (
        <p className="border-t pt-2 text-xs leading-relaxed text-muted-foreground">
          Record context: {summary.recordContext.join(" · ")}.
        </p>
      )}
    </section>
  );
}
