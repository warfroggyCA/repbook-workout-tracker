import Link from "next/link";
import type { ReactNode } from "react";
import {
  Activity,
  ChevronRight,
  ClipboardCheck,
  Footprints,
  Gauge,
  HeartPulse,
  Info,
  ListChecks,
  TrendingUp,
  Trophy,
} from "lucide-react";
import type { ActivityReport } from "@/services/activity-report";
import type {
  HistoryLens,
  HistoryLensKey,
} from "@/services/history-lenses";
import { formatIndependentActivityContext } from "@/lib/history-activity-context";
import { cn } from "@/lib/utils";

const lensIcons: Record<HistoryLensKey, typeof Activity> = {
  progress: TrendingUp,
  "program-fit": ListChecks,
  "pain-constraints": HeartPulse,
  "work-capacity": Gauge,
  records: Trophy,
};

export function HistoryLensCard({
  lens,
  activityReport,
  exercisesHref,
  detailContent,
}: {
  lens: HistoryLens;
  activityReport: ActivityReport;
  exercisesHref?: string;
  detailContent?: ReactNode;
}) {
  const Icon = lensIcons[lens.key];
  const linksToExercises =
    exercisesHref && (lens.key === "progress" || lens.key === "records");

  return (
    <article
      aria-labelledby={`history-lens-${lens.key}-heading`}
      className={cn(
        "min-w-0 overflow-hidden rounded-2xl border bg-card shadow-xs",
        lens.tone === "positive" && "border-success/25",
        lens.tone === "watch" && "border-amber-500/35",
      )}
    >
      <div className="flex items-start gap-3 border-b bg-muted/20 p-4 sm:p-5">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary",
            lens.tone === "positive" && "bg-success/10 text-success",
            lens.tone === "watch" && "bg-amber-500/10 text-amber-700",
          )}
          aria-hidden="true"
        >
          <Icon className="size-4.5" />
        </span>
        <div className="min-w-0">
          <h3
            id={`history-lens-${lens.key}-heading`}
            className="font-semibold tracking-tight"
          >
            {lens.title}
          </h3>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
            {lens.question}
          </p>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
        <section aria-label="Short answer">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Short answer
          </p>
          <p className="mt-1 text-sm font-medium leading-relaxed">
            {lens.answer}
          </p>
        </section>

        <section
          aria-label="Decision support"
          className={cn(
            "rounded-xl border px-3 py-2.5",
            lens.decision.supported
              ? "border-primary/25 bg-primary/5"
              : "bg-muted/25",
          )}
        >
          <div className="flex items-start gap-2">
            <ClipboardCheck
              className={cn(
                "mt-0.5 size-4 shrink-0",
                lens.decision.supported
                  ? "text-primary"
                  : "text-muted-foreground",
              )}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Decision support
              </p>
              <p className="mt-1 break-words text-xs leading-relaxed">
                {lens.decision.statement}
              </p>
              {lens.decision.href && lens.decision.linkLabel && (
                <Link
                  href={lens.decision.href}
                  className="mt-2 inline-flex min-h-8 items-center rounded-md text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {lens.decision.linkLabel}
                  <ChevronRight
                    className="ml-1 size-3.5"
                    aria-hidden="true"
                  />
                </Link>
              )}
            </div>
          </div>
        </section>

        <details className="group rounded-xl border bg-muted/15 p-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Evidence and methodology
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
          <div className="mt-3 space-y-4 border-t pt-3">
            <section aria-label="Supporting evidence">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Supporting evidence
              </p>
              <dl className="mt-2 divide-y rounded-xl border bg-background/70 px-3">
                {lens.evidence.map((item) => (
                  <div
                    key={`${item.label}-${item.value}`}
                    className="grid min-w-0 gap-1 py-2.5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] sm:gap-3"
                  >
                    <dt className="min-w-0 break-words text-xs font-medium">
                      {item.label}
                    </dt>
                    <dd className="min-w-0 break-words text-xs leading-relaxed text-muted-foreground sm:text-right">
                      <span className="font-medium text-foreground">
                        {item.value}
                      </span>
                      {item.detail && (
                        <span className="mt-0.5 block">{item.detail}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              {linksToExercises && (
                <Link
                  href={exercisesHref}
                  prefetch={false}
                  className="mt-2 inline-flex min-h-8 items-center rounded-md text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Open supporting exercise evidence
                  <ChevronRight
                    className="ml-1 size-3.5"
                    aria-hidden="true"
                  />
                </Link>
              )}
            </section>

            {lens.key === "work-capacity" && (
              <section
                aria-label="Independent activity context"
                className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3"
              >
                <div className="flex items-center gap-2">
                  <Footprints
                    className="size-4 shrink-0 text-emerald-700"
                    aria-hidden="true"
                  />
                  <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">
                    Independent activity context — kept separate
                  </p>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {formatIndependentActivityContext(activityReport)}
                </p>
                <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
                  This context never changes strength progress, Program fit,
                  loaded workload, or records.
                </p>
              </section>
            )}

            <section
              aria-label="Confidence and data limitation"
              className="flex items-start gap-2"
            >
              <Info
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Confidence and data limitation
                </p>
                <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                  {lens.limitation}
                </p>
              </div>
            </section>

            {detailContent}
          </div>
        </details>
      </div>
    </article>
  );
}
