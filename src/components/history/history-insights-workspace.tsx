import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BarChart3,
  CalendarCheck2,
  Clock3,
  Dumbbell,
  Footprints,
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
import { formatIndependentActivityContext } from "@/lib/history-activity-context";
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
    <Card size="sm">
      <CardContent>
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </span>
        </div>
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
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
  const maxWeeklyVolume = Math.max(
    1,
    ...report.weekly.map((week) => week.volume),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Weekly workload</h3>
        </CardTitle>
        <CardDescription>
          Loaded volume and completed workouts for the latest 12 weeks inside
          this period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {report.weekly.length === 0 ? (
          <p className="text-sm text-muted-foreground">No weekly data yet.</p>
        ) : (
          <div className="flex h-52 items-end gap-2 border-b pb-7 sm:gap-3">
            {report.weekly.map((week) => {
              const weekDate = new Date(week.weekStartISO);
              const label = weekDate.toLocaleDateString(undefined, {
                timeZone: "UTC",
                month: "short",
                day: "numeric",
              });
              const height = Math.max(
                4,
                Math.round((week.volume / maxWeeklyVolume) * 150),
              );
              return (
                <div
                  key={week.weekStartISO}
                  className="group relative flex min-w-0 flex-1 flex-col items-center justify-end"
                  title={`Week of ${label}: ${week.sessions} workout${week.sessions === 1 ? "" : "s"}, ${week.sets} sets, ${number.format(week.volume)} ${unit}`}
                >
                  <span className="mb-1 text-[0.625rem] font-medium tabular-nums text-muted-foreground">
                    {week.sessions || ""}
                  </span>
                  <div
                    className={cn(
                      "w-full min-w-1 rounded-t bg-primary/25",
                      week.sessions > 0 && "bg-primary/45",
                    )}
                    style={{ height }}
                  />
                  <span className="absolute -bottom-5 text-[0.5625rem] text-muted-foreground sm:text-[0.625rem]">
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Bar height = loaded volume · Number = workouts
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
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section aria-labelledby="strength-overview-heading">
        <div className="mb-3">
          <h3
            id="strength-overview-heading"
            className="font-semibold tracking-tight"
          >
            Strength overview
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            The four primary workout measures for this period.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Completed workouts"
            value={number.format(report.overview.completedSessions)}
            detail={`${report.overview.abandonedSessions} abandoned`}
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
            value={`${number.format(report.overview.loadedVolume)} ${unit}`}
            detail="Eligible strength sets only"
            icon={BarChart3}
          />
          <MetricCard
            label="Average duration"
            value={
              report.overview.averageDurationMin == null
                ? "—"
                : `${report.overview.averageDurationMin} min`
            }
            detail="Completed workouts with usable timing"
            icon={Clock3}
          />
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Training cadence</h3>
          </CardTitle>
          <CardDescription>
            Completed workouts by calendar time. This is separate from how
            individual planned sets turned out.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border bg-background/70 p-3">
              <dt className="text-xs text-muted-foreground">
                Per complete week
              </dt>
              <dd className="mt-1 font-semibold tabular-nums">
                {report.cadence.averageSessionsPerCompleteWeek ?? "—"}
              </dd>
              <p className="mt-1 text-xs text-muted-foreground">
                {report.cadence.completeWeeks} complete Monday–Sunday week
                {report.cadence.completeWeeks === 1 ? "" : "s"}
              </p>
            </div>
            <div className="rounded-xl border bg-background/70 p-3">
              <dt className="text-xs text-muted-foreground">Median gap</dt>
              <dd className="mt-1 font-semibold tabular-nums">
                {report.cadence.medianGapDays == null
                  ? "—"
                  : `${report.cadence.medianGapDays} days`}
              </dd>
              <p className="mt-1 text-xs text-muted-foreground">
                Between completed workout dates
              </p>
            </div>
            <div className="rounded-xl border bg-background/70 p-3">
              <dt className="text-xs text-muted-foreground">Current gap</dt>
              <dd className="mt-1 font-semibold tabular-nums">
                {report.cadence.currentGapDays == null
                  ? "—"
                  : `${report.cadence.currentGapDays} ${report.cadence.currentGapDays === 1 ? "day" : "days"}`}
              </dd>
              <p className="mt-1 text-xs text-muted-foreground">
                Since the latest completed workout date
              </p>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            Current preference: {report.cadence.currentPreference.sessionsPerWeek}
            {" "}sessions per week. {report.cadence.currentPreference.limitation}
          </p>
          {report.cadence.programDayExposures.length > 0 ? (
            <div>
              <h4 className="text-sm font-medium">Program-day exposure</h4>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {report.cadence.programDayExposures.map((exposure) => (
                  <li
                    key={exposure.lineageId}
                    className="rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">
                      {exposure.labels.map((label) => label.label).join(" / ")}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      {exposure.sessions} workout
                      {exposure.sessions === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {report.cadence.unlinkedSessions > 0 ? (
            <p className="text-xs text-muted-foreground">
              {report.cadence.unlinkedSessions} completed workout
              {report.cadence.unlinkedSessions === 1 ? " was" : "s were"} not
              linked to a Program day and remain outside Program-day exposure.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Planned set outcomes</h3>
          </CardTitle>
          <CardDescription>
            Performed working sets compared with their retained planned targets.
            These results do not describe training frequency.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([
              ["Below", report.overview.targetOutcomes.below],
              ["At", report.overview.targetOutcomes.at],
              ["Above", report.overview.targetOutcomes.above],
              ["Unknown", report.overview.targetOutcomes.unknown],
            ] as const).map(([label, value]) => (
              <div key={label} className="rounded-xl border p-3 text-center">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            {!report.overview.targetDenominatorComplete
              ? `${report.overview.targetOutcomes.supported} of ${targetCoverageTotal} quantified retained planned outcomes were evaluable${targetCoveragePercent == null ? "." : ` (${targetCoveragePercent}%).`} ${report.overview.targetOutcomes.atOrAboveRate == null ? "No supported-subset statistic is available." : `Within that subset, ${report.overview.targetOutcomes.atOrAboveRate}% were at or above target.`} At least one legacy exercise has no trustworthy planned-outcome count, so the full denominator is incomplete and no overall conclusion is supported.`
              : targetCoveragePercent == null
              ? "No planned outcome is available for an attainment conclusion."
              : `${report.overview.targetOutcomes.supported} of ${targetCoverageTotal} planned outcomes were evaluable (${targetCoveragePercent}%). ${report.overview.targetOutcomes.atOrAboveRate == null ? "No supported-subset statistic is available." : `Within that subset, ${report.overview.targetOutcomes.atOrAboveRate}% were at or above target.`} Overall conclusions require the shared coverage, sample-size, and session-span gates.`}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Five questions</h3>
          </CardTitle>
          <CardDescription>
            Open one answer to see its evidence, limitation, and supported
            decision.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {report.lenses.map((lens) => (
            <Link
              key={lens.key}
              href={buildHistoryHref({
                ...context,
                view: "insights",
                lens: lens.key,
              })}
              prefetch={false}
              className="group grid min-w-0 gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4"
            >
              <h3 className="text-sm font-semibold group-hover:text-primary">
                {lens.title}
              </h3>
              <p className="min-w-0 text-sm leading-relaxed text-muted-foreground">
                {lens.answer}
              </p>
              <ArrowRight
                className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                aria-hidden="true"
              />
            </Link>
          ))}
        </CardContent>
      </Card>

      <Card className="border-success/20 bg-success/3">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Footprints className="size-4 text-success" aria-hidden="true" />
            <CardTitle>
              <h3>Independent activity summary</h3>
            </CardTitle>
          </div>
          <CardDescription>
            Kept separate from workout progression, Program fit, workload, and
            records.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {formatIndependentActivityContext(activityReport)}
          </p>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl border bg-background/70 p-2">
              <p className="text-lg font-semibold tabular-nums">
                {activityReport.overview.totalActivities}
              </p>
              <p className="text-[0.6875rem] text-muted-foreground">
                activities
              </p>
            </div>
            <div className="rounded-xl border bg-background/70 p-2">
              <p className="text-lg font-semibold tabular-nums">
                {activityReport.overview.totalMinutes}
              </p>
              <p className="text-[0.6875rem] text-muted-foreground">minutes</p>
            </div>
            <div className="rounded-xl border bg-background/70 p-2">
              <p className="text-lg font-semibold tabular-nums">
                {activityReport.overview.totalDistanceKm}
              </p>
              <p className="text-[0.6875rem] text-muted-foreground">km</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <details className="rounded-2xl border bg-card p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          More report measurements
        </summary>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">
              Target-attainment coverage
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {targetCoveragePercent == null
                ? "—"
                : `${report.overview.targetOutcomes.supported}/${targetCoverageTotal} (${targetCoveragePercent}%)${report.overview.targetDenominatorComplete ? "" : " among quantified outcomes; denominator incomplete"}`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Average effort</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {report.overview.averageRpe == null
                ? "—"
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
        </dl>
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
      />
      {lens === "work-capacity" && (
        <>
          <WeeklyWorkload report={report} unit={unit} />
          <ActivitySummary
            report={activityReport}
            rangeLabel={rangeLabel}
          />
        </>
      )}
    </div>
  );
}
