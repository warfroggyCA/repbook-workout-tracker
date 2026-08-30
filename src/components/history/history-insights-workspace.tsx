import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarCheck2,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Dumbbell,
  Footprints,
  TrendingUp,
} from "lucide-react";
import { ActivitySummary } from "@/components/history/activity-summary";
import { HistoryLensCard } from "@/components/history/history-lens-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  buildHistoryHref,
  type HistoryContext,
  type HistoryInsightLens,
} from "@/lib/history-navigation";
import { cn } from "@/lib/utils";
import type { ActivityReport } from "@/services/activity-report";
import type {
  HistoryRangeKey,
  HistoryReport,
} from "@/services/history-report";

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <Card size="sm" aria-label={`${label}: ${value}. ${detail}`}>
      <CardContent className="p-3">
        <div className="mb-2 flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <span className="hidden size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground sm:flex">
            <Icon className="size-4" aria-hidden="true" />
          </span>
        </div>
        <p className="break-words text-lg font-semibold tracking-tight tabular-nums sm:text-xl">
          {value}
        </p>
        <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </CardContent>
    </Card>
  );
}

function WeeklyWorkload({
  report,
  unit,
}: {
  report: HistoryReport;
  unit: string;
}) {
  const visibleWeeks = report.weekly.slice(-6);
  const hasWeeklyEvidence = visibleWeeks.some(
    (week) => week.sessions > 0 || week.sets > 0 || week.volume > 0,
  );
  const maxWeeklyVolume = Math.max(
    1,
    ...visibleWeeks.map((week) => week.volume),
  );

  return (
    <Card size="sm">
      <CardHeader className="gap-1">
        <CardTitle>
          <h3>Weekly workload</h3>
        </CardTitle>
        <CardDescription>
          Latest six weeks · eligible loaded volume and completed workouts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasWeeklyEvidence ? (
          <p className="text-sm text-muted-foreground">
            No completed workout data is available for a weekly chart.
          </p>
        ) : (
          <div className="flex h-40 items-end gap-2 border-b pb-7 sm:gap-3">
            {visibleWeeks.map((week) => {
              const weekDate = new Date(week.weekStartISO);
              const label = weekDate.toLocaleDateString(undefined, {
                timeZone: "UTC",
                month: "short",
                day: "numeric",
              });
              const height = week.volume === 0
                ? 0
                : Math.max(
                    4,
                    Math.round((week.volume / maxWeeklyVolume) * 108),
                  );
              return (
                <div
                  key={week.weekStartISO}
                  role="img"
                  aria-label={`Week of ${label}: ${week.sessions} completed workout${week.sessions === 1 ? "" : "s"}, ${week.sets} working sets, ${number.format(week.volume)} ${unit} eligible loaded volume`}
                  className="relative flex min-w-0 flex-1 flex-col items-center justify-end"
                  title={`Week of ${label}: ${week.sessions} workout${week.sessions === 1 ? "" : "s"}, ${week.sets} sets, ${number.format(week.volume)} ${unit}`}
                >
                  <span
                    aria-hidden="true"
                    className="mb-1 text-[0.625rem] font-medium tabular-nums text-muted-foreground"
                  >
                    {week.sessions}
                  </span>
                  <div
                    aria-hidden="true"
                    className={cn(
                      "w-full min-w-1 rounded-t bg-primary/25",
                      week.sessions > 0 && "bg-primary/45",
                    )}
                    style={{ height }}
                  />
                  <span
                    aria-hidden="true"
                    className="absolute -bottom-5 whitespace-nowrap text-[0.5rem] text-muted-foreground sm:text-[0.625rem]"
                  >
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Bar = eligible loaded volume · Number = completed workouts
        </p>
      </CardContent>
    </Card>
  );
}

function InsightsOverview({
  report,
  activityReport,
  context,
  unit,
}: {
  report: HistoryReport;
  activityReport: ActivityReport;
  context: HistoryContext;
  unit: string;
}) {
  const targetCoverageTotal =
    report.overview.targetOutcomes.supported +
    report.overview.targetOutcomes.unknown;
  const targetCoveragePercent = targetCoverageTotal === 0
    ? null
    : Math.round(
        (report.overview.targetOutcomes.supported / targetCoverageTotal) *
          1_000,
      ) / 10;
  const progressLens = report.lenses.find((lens) => lens.key === "progress")!;
  const progressHref = buildHistoryHref({
    ...context,
    view: "insights",
    lens: "progress",
  });
  const exercisesHref = buildHistoryHref({
    ...context,
    view: "exercises",
    lens: "overview",
  });
  const outcomeRows = [
    ["Below", report.overview.targetOutcomes.below],
    ["At", report.overview.targetOutcomes.at],
    ["Above", report.overview.targetOutcomes.above],
    ["Unknown", report.overview.targetOutcomes.unknown],
  ] as const;
  const narrative = report.overview.completedSessions === 0
    ? progressLens.answer
    : `${number.format(report.overview.completedSessions)} completed workout${
        report.overview.completedSessions === 1 ? "" : "s"
      } and ${number.format(report.overview.workingSets)} working set${
        report.overview.workingSets === 1 ? "" : "s"
      } are recorded in this period. ${progressLens.answer}`;
  const ProgressToneIcon = progressLens.tone === "positive"
    ? CheckCircle2
    : progressLens.tone === "watch"
      ? AlertTriangle
      : CircleHelp;
  const progressToneLabel = progressLens.tone === "positive"
    ? "Positive signal"
    : progressLens.tone === "watch"
      ? "Needs attention"
      : "Review evidence";
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card className="border-primary/25 bg-primary/3">
        <CardHeader className="gap-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="size-4 text-primary" aria-hidden="true" />
              <CardTitle>
                <h3>Current progress</h3>
              </CardTitle>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-background/80 px-2.5 py-1 text-xs font-medium">
              <ProgressToneIcon className="size-3.5" aria-hidden="true" />
              {progressToneLabel}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm font-medium leading-relaxed sm:text-base">
            {narrative}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Link
              href={progressHref}
              prefetch={false}
              className="inline-flex min-h-11 items-center justify-between gap-2 rounded-xl border bg-background px-3 py-2 text-sm font-medium outline-none hover:border-primary/40 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Open progress evidence
              <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>
            <Link
              href={exercisesHref}
              prefetch={false}
              className="inline-flex min-h-11 items-center justify-between gap-2 rounded-xl border bg-background px-3 py-2 text-sm font-medium outline-none hover:border-primary/40 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              View exact exercises
              <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="period-at-a-glance-heading">
        <div className="mb-3">
          <h3
            id="period-at-a-glance-heading"
            className="font-semibold tracking-tight"
          >
            At a glance
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Recorded workout evidence for this period.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <MetricCard
            label="Completed workouts"
            value={number.format(report.overview.completedSessions)}
            detail={report.overview.abandonedSessions === 0
              ? "No abandoned workouts"
              : `${report.overview.abandonedSessions} abandoned`}
            icon={CalendarCheck2}
          />
          <MetricCard
            label="Working sets"
            value={number.format(report.overview.workingSets)}
            detail={`${number.format(report.overview.totalReps)} total reps`}
            icon={Dumbbell}
          />
          <MetricCard
            label="Loaded volume"
            value={report.overview.loadedSets === 0
              ? "Not available"
              : `${number.format(report.overview.loadedVolume)} ${unit}`}
            detail={report.overview.loadedSets === 0
              ? "No eligible loaded sets"
              : "Eligible loaded sets only"}
            icon={BarChart3}
          />
          <MetricCard
            label="Average duration"
            value={
              report.overview.averageDurationMin == null
                ? "Not available"
                : `${report.overview.averageDurationMin} min`
            }
            detail={report.overview.averageDurationMin == null
              ? "Retained timing is incomplete"
              : "Completed workouts with usable timing"}
            icon={Clock3}
          />
        </div>
      </section>

      <div className="grid min-w-0 gap-3 xl:grid-cols-2">
        <WeeklyWorkload report={report} unit={unit} />
        <Card size="sm">
          <CardHeader className="gap-1">
            <CardTitle>
              <h3>Planned set outcomes</h3>
            </CardTitle>
            <CardDescription>
              Evaluable and unknown outcomes stay separate.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {targetCoverageTotal === 0 ? (
              <p className="text-sm text-muted-foreground">
                No retained planned-outcome evidence is available for this
                period.
              </p>
            ) : (
              <dl className="space-y-2">
                {outcomeRows.map(([label, value]) => (
                  <div key={label}>
                    <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                      <dt>{label}</dt>
                      <dd className="font-semibold tabular-nums">{value}</dd>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        aria-hidden="true"
                        className={cn(
                          "h-full rounded-full bg-primary",
                          label === "Below" && "bg-amber-500",
                          label === "Above" && "bg-success",
                          label === "Unknown" && "bg-muted-foreground/45",
                        )}
                        style={{
                          width: `${Math.round((value / targetCoverageTotal) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </dl>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {targetCoveragePercent == null
                ? "Attainment is not available."
                : `${report.overview.targetOutcomes.supported} of ${targetCoverageTotal} quantified outcomes were evaluable (${targetCoveragePercent}%).${report.overview.targetOutcomes.atOrAboveRate == null ? "" : ` Within that subset, ${report.overview.targetOutcomes.atOrAboveRate}% were at or above target.`}`}
              {!report.overview.targetDenominatorComplete && (
                <> The retained denominator is incomplete, so no overall conclusion is supported.</>
              )}
            </p>
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="explore-evidence-heading">
        <div className="mb-3">
          <h3 id="explore-evidence-heading" className="font-semibold tracking-tight">
            Explore the evidence
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Open a question for its evidence, limits, and supported actions.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {report.lenses.map((lens) => (
            <Link
              key={lens.key}
              aria-label={lens.title}
              href={buildHistoryHref({
                ...context,
                view: "insights",
                lens: lens.key,
              })}
              prefetch={false}
              className="group flex min-h-14 min-w-0 items-center justify-between gap-3 rounded-xl border bg-card px-3 py-2.5 outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="min-w-0">
                <span className="block text-[0.6875rem] font-medium text-muted-foreground">
                  {lens.tone === "positive"
                    ? "Positive signal"
                    : lens.tone === "watch"
                      ? "Needs attention"
                      : "Review evidence"}
                </span>
                <span className="block break-words text-sm font-semibold group-hover:text-primary">
                  {lens.title}
                </span>
              </span>
              <ArrowRight
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary motion-reduce:transform-none motion-reduce:transition-none"
                aria-hidden="true"
              />
            </Link>
          ))}
        </div>
      </section>

      <Card size="sm">
        <CardHeader className="gap-1">
          <div className="flex items-center gap-2">
            <Footprints className="size-4 text-primary" aria-hidden="true" />
            <CardTitle>
              <h3>Independent activities</h3>
            </CardTitle>
          </div>
          <CardDescription>
            Context only; these do not change strength progress or the Program.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activityReport.overview.totalActivities === 0 ? (
            <p className="text-sm text-muted-foreground">
              No independent activities were recorded in this period.
            </p>
          ) : (
            <p className="text-sm font-medium leading-relaxed">
              {activityReport.overview.totalActivities} activit
              {activityReport.overview.totalActivities === 1 ? "y" : "ies"}
              {" · "}{activityReport.overview.totalMinutes} min
              {activityReport.measurementCoverage.distance > 0
                ? ` · ${activityReport.overview.totalDistanceKm} km`
                : " · Distance not recorded"}
            </p>
          )}
        </CardContent>
      </Card>

      <details className="rounded-2xl border bg-card p-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          More report measurements
        </summary>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">
              Target-attainment coverage
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {targetCoveragePercent == null
                ? "Not available"
                : `${report.overview.targetOutcomes.supported}/${targetCoverageTotal} (${targetCoveragePercent}%)${report.overview.targetDenominatorComplete ? "" : " among quantified outcomes; denominator incomplete"}`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Average effort</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {report.overview.averageRpe == null
                ? "Not available"
                : `${report.overview.averageRpe} RPE`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Timed workout activity
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {number.format(report.overview.timedActivityMinutes)} min
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Workout distance
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {report.overview.distanceKm} km
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Excluded metric sets
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {report.overview.excludedMetricSets}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Excluded workout durations
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {report.overview.excludedDurationSessions}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Excluded independent activities
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {activityReport.overview.excludedActivities}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Workouts per complete week
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {report.cadence.averageSessionsPerCompleteWeek ?? "Not available"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Median workout gap</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {report.cadence.medianGapDays == null
                ? "Not available"
                : `${report.cadence.medianGapDays} days`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Current workout gap</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {report.cadence.currentGapDays == null
                ? "Not available"
                : `${report.cadence.currentGapDays} ${report.cadence.currentGapDays === 1 ? "day" : "days"}`}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Current preference: {report.cadence.currentPreference.sessionsPerWeek}{" "}
          sessions per week. {report.cadence.currentPreference.limitation}
        </p>
        {report.cadence.programDayExposures.length > 0 && (
          <div className="mt-4">
            <h4 className="text-xs font-semibold">Program-day exposure</h4>
            <ul className="mt-2 flex flex-wrap gap-2">
              {report.cadence.programDayExposures.map((exposure) => (
                <li
                  key={exposure.lineageId}
                  className="rounded-full border px-2.5 py-1 text-xs"
                >
                  {exposure.labels.map((label) => label.label).join(" / ")}{" "}
                  <span className="text-muted-foreground">
                    · {exposure.sessions} workout
                    {exposure.sessions === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.cadence.unlinkedSessions > 0 && (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {report.cadence.unlinkedSessions} completed workout
            {report.cadence.unlinkedSessions === 1 ? " is" : "s are"} not linked
            to a Program day.
          </p>
        )}
      </details>
    </div>
  );
}

export function HistoryInsightsWorkspace({
  report,
  activityReport,
  lens,
  context,
  rangeLabel,
  unit,
}: {
  report: HistoryReport;
  activityReport: ActivityReport;
  lens: HistoryInsightLens;
  context: HistoryContext & { range: HistoryRangeKey };
  rangeLabel: string;
  unit: string;
}) {
  if (lens === "overview") {
    return (
      <InsightsOverview
        report={report}
        activityReport={activityReport}
        context={context}
        unit={unit}
      />
    );
  }

  const selected = report.lenses.find((candidate) => candidate.key === lens);
  if (!selected) return null;
  const exercisesHref = buildHistoryHref({
    ...context,
    view: "exercises",
    lens: "overview",
  });

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <HistoryLensCard
        lens={selected}
        activityReport={activityReport}
        exercisesHref={exercisesHref}
        detailContent={
          lens === "work-capacity" ? (
            <div className="grid gap-3">
              <WeeklyWorkload report={report} unit={unit} />
              <ActivitySummary
                report={activityReport}
                rangeLabel={rangeLabel}
              />
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
