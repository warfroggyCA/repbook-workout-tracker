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

const tonePriority = { watch: 0, positive: 1, neutral: 2 } as const;

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
  const attention = report.lenses
    .map((lens, index) => ({ lens, index }))
    .sort(
      (a, b) =>
        tonePriority[a.lens.tone] - tonePriority[b.lens.tone] ||
        a.index - b.index,
    )
    .slice(0, 3)
    .map(({ lens }) => lens);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <HistoryCalendar
        key={`${context.calendarView}-${calendarDate ?? ownerToday}`}
        records={records}
        unit={unit}
        range={context.range}
        initialView={context.calendarView}
        initialDate={calendarDate}
        ownerToday={ownerToday}
      />

      <section aria-labelledby="history-attention-heading">
        <div className="mb-3">
          <h3
            id="history-attention-heading"
            className="font-semibold tracking-tight"
          >
            Needs attention
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Up to three period signals, ordered by urgency. Open a lens for its
            evidence and limitations.
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          {attention.map((lens) => {
            const Icon =
              lens.tone === "watch"
                ? AlertTriangle
                : lens.tone === "positive"
                  ? CheckCircle2
                  : CircleHelp;
            return (
              <Link
                key={lens.key}
                href={buildHistoryHref({
                  ...context,
                  view: "insights",
                  lens: lens.key,
                })}
                prefetch={false}
                className={cn(
                  "group rounded-2xl border bg-card p-4 shadow-xs transition-colors hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  lens.tone === "watch" && "border-amber-500/35",
                  lens.tone === "positive" && "border-success/25",
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className={cn(
                      "size-4 shrink-0 text-primary",
                      lens.tone === "watch" && "text-amber-600",
                      lens.tone === "positive" && "text-success",
                    )}
                    aria-hidden="true"
                  />
                  <h3 className="text-sm font-semibold">{lens.title}</h3>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {lens.answer}
                </p>
                <span className="mt-3 inline-flex items-center text-xs font-medium text-primary">
                  View evidence
                  <ArrowRight
                    className="ml-1 size-3.5 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
