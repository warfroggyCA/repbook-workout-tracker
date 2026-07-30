import Link from "next/link";
import {
  CalendarDays,
  Dumbbell,
  Footprints,
  HeartPulse,
  Lightbulb,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { HistoryCalendarWorkspace } from "@/components/history/history-calendar-workspace";
import { HistoryExercisesWorkspace } from "@/components/history/history-exercises-workspace";
import { HistoryInsightsWorkspace } from "@/components/history/history-insights-workspace";
import { HistoryMoreMenu } from "@/components/history/history-more-menu";
import { HistoryRangeNav } from "@/components/history/history-range-nav";
import {
  buildHistoryHref,
  type HistoryCalendarView,
  type HistoryContext,
  type HistoryInsightLens,
  type HistoryView,
} from "@/lib/history-navigation";
import { cn } from "@/lib/utils";
import type { ActivityReport } from "@/services/activity-report";
import type {
  BulkActivityArchivePreview,
  SampleHistoryArchivePreview,
} from "@/services/archive";
import {
  HISTORY_RANGES,
  type HistoryCalendarRecord,
  type HistoryRangeKey,
  type HistoryReport,
} from "@/services/history-report";

const viewOptions = [
  {
    key: "calendar",
    label: "Calendar",
    description:
      "Find a date, open a record, or enter a remembered workout without changing the facts it represents.",
    icon: CalendarDays,
  },
  {
    key: "insights",
    label: "Insights",
    description:
      "Ask one question at a time and inspect the evidence, limitations, and decision support for this period.",
    icon: Lightbulb,
  },
  {
    key: "exercises",
    label: "Exercises",
    description:
      "Review exact-variant progression, best observations, and movement context with links back to source workouts.",
    icon: Dumbbell,
  },
] as const;

export function HistoryWorkspace({
  report,
  activityReport,
  calendarRecords,
  range,
  view,
  lens,
  calendarView,
  calendarDate,
  ownerToday,
  unit,
  testSessionCount,
  samplePreview,
  activityArchivePreview,
}: {
  report: HistoryReport;
  activityReport: ActivityReport | null;
  calendarRecords: HistoryCalendarRecord[] | null;
  range: HistoryRangeKey;
  view: HistoryView;
  lens: HistoryInsightLens;
  calendarView: HistoryCalendarView;
  calendarDate: string | null;
  ownerToday: string;
  unit: string;
  testSessionCount: number;
  samplePreview: SampleHistoryArchivePreview | null;
  activityArchivePreview: BulkActivityArchivePreview;
}) {
  const rangeLabel =
    HISTORY_RANGES.find((option) => option.key === range)?.label ??
    "Selected period";
  const activeView = viewOptions.find((option) => option.key === view)!;
  const context: HistoryContext & { range: HistoryRangeKey } = {
    range,
    view,
    lens,
    calendarView,
    calendarDate,
  };
  const exportWeeks = {
    "4w": "4",
    "12w": "12",
    "6m": "26",
    "1y": "52",
    all: "all",
  }[range];

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
              Training history
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
              History
            </h1>
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              render={<Link href="/activity/new" />}
              nativeButton={false}
            >
              <Footprints className="size-4" aria-hidden="true" />
              Record activity
            </Button>
            <HistoryMoreMenu
              exportWeeks={exportWeeks}
              testSessionCount={testSessionCount}
              samplePreview={samplePreview}
              activityArchivePreview={activityArchivePreview}
            />
          </div>
        </div>

        {testSessionCount > 0 && (
          <p className="-mt-3 text-xs font-medium text-primary" role="status">
            Sample history is active ({testSessionCount} workouts). Use More to
            manage it.
          </p>
        )}

        <nav
          aria-label="History views"
          className="grid grid-cols-3 gap-1 rounded-2xl border bg-card p-1"
        >
          {viewOptions.map((option) => {
            const Icon = option.icon;
            const selected = option.key === view;
            return (
              <Link
                key={option.key}
                href={buildHistoryHref({
                  ...context,
                  view: option.key,
                  lens:
                    option.key === "insights" && view === "insights"
                      ? lens
                      : "overview",
                })}
                scroll={false}
                prefetch={false}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-center text-xs font-medium transition-colors sm:text-sm",
                  selected
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{option.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="rounded-2xl border bg-card p-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {activeView.label}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              {activeView.description}
            </p>
            {view !== "calendar" && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing {rangeLabel.toLowerCase()}.
              </p>
            )}
          </div>
        </div>
      </header>

      {view !== "calendar" && (
        <div className="pointer-events-none sticky top-2 z-30 flex justify-end">
          <div className="pointer-events-auto w-full rounded-xl shadow-md sm:w-auto">
            <HistoryRangeNav
              options={HISTORY_RANGES}
              currentRange={range}
              context={context}
            />
          </div>
        </div>
      )}

      {view === "calendar" && calendarRecords && (
        <HistoryCalendarWorkspace
          report={report}
          records={calendarRecords}
          context={{ ...context, calendarView }}
          calendarDate={calendarDate}
          ownerToday={ownerToday}
          unit={unit}
        />
      )}

      {view === "insights" && activityReport && (
        <HistoryInsightsWorkspace
          report={report}
          activityReport={activityReport}
          lens={lens}
          context={context}
          rangeLabel={rangeLabel}
          unit={unit}
        />
      )}

      {view === "exercises" && (
        <HistoryExercisesWorkspace
          report={report}
          context={context}
          unit={unit}
        />
      )}

      <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
        <HeartPulse
          className="mt-0.5 size-3.5 shrink-0"
          aria-hidden="true"
        />
        History describes recorded training patterns; it is not a medical
        assessment. Estimated strength uses the existing Epley calculation and
        is most useful with consistent load, reps, and effort logging.
      </p>
    </main>
  );
}
