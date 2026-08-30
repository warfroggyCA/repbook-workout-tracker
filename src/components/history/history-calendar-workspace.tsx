import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleHelp,
} from "lucide-react";
import { HistoryCalendar } from "@/components/history/history-calendar";
import {
  buildHistoryHref,
  type HistoryCalendarView,
  type HistoryContext,
} from "@/lib/history-navigation";
import { cn } from "@/lib/utils";
import type {
  HistoryCalendarRecord,
  HistoryRangeKey,
  HistoryReport,
} from "@/services/history-report";
import type { HistoryLens } from "@/services/history-lenses";

const tonePriority = { watch: 0, positive: 1, neutral: 2 } as const;

export function selectHistoryActionSignal(
  lenses: readonly HistoryLens[],
): HistoryLens | null {
  return lenses
    .map((lens, index) => ({ lens, index }))
    .filter(({ lens }) => lens.decision.supported)
    .sort(
      (a, b) =>
        tonePriority[a.lens.tone] - tonePriority[b.lens.tone] ||
        a.index - b.index,
    )[0]?.lens ?? null;
}

export function HistoryCalendarWorkspace({
  report,
  records,
  context,
  calendarDate,
  ownerToday,
  unit,
}: {
  report: HistoryReport;
  records: HistoryCalendarRecord[];
  context: HistoryContext & {
    range: HistoryRangeKey;
    calendarView: HistoryCalendarView;
  };
  calendarDate: string | null;
  ownerToday: string;
  unit: string;
}) {
  const actionSignal = selectHistoryActionSignal(report.lenses);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {actionSignal ? (
        <section aria-labelledby="history-action-signal-heading">
          <Link
            href={buildHistoryHref({
              ...context,
              view: "insights",
              lens: actionSignal.key,
            })}
            prefetch={false}
            data-ui-surface={
              actionSignal.tone === "watch" ? "attention" : "inset"
            }
            className={cn(
              "ui-motion-surface ui-surface group block p-4 transition-colors hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              actionSignal.tone === "watch" && "border-amber-500/35",
              actionSignal.tone === "positive" && "border-success/25",
            )}
          >
            <div className="flex items-start gap-3">
              {actionSignal.tone === "watch" ? (
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-amber-600"
                  aria-hidden="true"
                />
              ) : actionSignal.tone === "positive" ? (
                <CheckCircle2
                  className="mt-0.5 size-4 shrink-0 text-success"
                  aria-hidden="true"
                />
              ) : (
                <CircleHelp
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <p className="ui-metadata">One thing to review</p>
                <h2
                  id="history-action-signal-heading"
                  className="mt-0.5 text-sm font-semibold"
                >
                  {actionSignal.title}
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {actionSignal.answer}
                </p>
                <p className="mt-2 text-xs leading-relaxed">
                  {actionSignal.decision.statement}
                </p>
                <span className="mt-2 inline-flex items-center text-xs font-medium text-primary">
                  Review evidence
                  <ArrowRight
                    className="ml-1 size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </span>
              </div>
            </div>
          </Link>
        </section>
      ) : null}

      <HistoryCalendar
        key={`${context.calendarView}-${calendarDate ?? ownerToday}`}
        records={records}
        unit={unit}
        range={context.range}
        initialView={context.calendarView}
        initialDate={calendarDate}
        ownerToday={ownerToday}
      />
    </div>
  );
}
