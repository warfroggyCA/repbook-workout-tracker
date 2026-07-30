import Link from "next/link";
import { Activity, Clock3, Footprints, Gauge, MapPinned } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  activityUsesSpeed,
  formatActivityDistance,
  formatActivityDuration,
  formatActivityPace,
  formatActivitySpeed,
} from "@/lib/activities";
import { cn } from "@/lib/utils";
import type { ActivityReport } from "@/services/activity-report";

function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-success/20 bg-background/70 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{detail}</p>
    </div>
  );
}

export function ActivitySummary({
  report,
  rangeLabel,
  bulkArchive,
}: {
  report: ActivityReport;
  rangeLabel: string;
  bulkArchive?: React.ReactNode;
}) {
  const maxWeeklyMinutes = Math.max(
    1,
    ...report.weekly.map((week) => week.durationMinutes)
  );

  if (report.overview.totalActivities === 0) {
    return (
      <Card className="border-success/20 bg-success/3">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>
              <h3>Independent health activities</h3>
            </CardTitle>
            <Badge variant="outline" className="border-success/30 text-success">
              Separate from strength progress
            </Badge>
          </div>
          <CardDescription>
            Walks, cycling, mobility, and other dated activities can be tracked
            here without changing workout order or strength progression.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
              <Footprints className="size-4" />
            </span>
            <div>
              <p className="text-sm font-medium">
                No independent activities in {rangeLabel.toLowerCase()}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Record one when it happens; it does not need to follow a workout.
              </p>
            </div>
          </div>
          <Button
            render={<Link href="/activity/new" />}
            nativeButton={false}
            variant="outline"
          >
            Record activity
          </Button>
        </CardContent>
      </Card>
    );
  }

  const trend = report.trend.minuteChangePercent;
  const measured = report.measurementCoverage;
  const coverageItems = [
    ["distance", measured.distance],
    ["pace", measured.pace],
    ["intensity", measured.intensity],
    ["elevation", measured.elevation],
    ["heart rate", measured.heartRate],
    ["energy", measured.energy],
  ] as const;

  return (
    <section aria-labelledby="activity-summary-heading">
      <Card className="border-success/20 bg-success/3">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>
                  <h3 id="activity-summary-heading">
                    Independent health activities
                  </h3>
                </CardTitle>
                <Badge variant="outline" className="border-success/30 text-success">
                  Separate from strength progress
                </Badge>
              </div>
              <CardDescription className="mt-1.5">
                Health activity totals and trends for {rangeLabel.toLowerCase()}.
                These records can add recovery context, but never change strength
                progression or your program automatically.
              </CardDescription>
            </div>
            {bulkArchive}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <SummaryMetric
              label="Activities"
              value={String(report.overview.totalActivities)}
              detail={`${report.overview.activitiesPerWeek} per week`}
            />
            <SummaryMetric
              label="Total time"
              value={formatActivityDuration(report.overview.totalMinutes * 60)}
              detail={`${report.overview.averageDurationMinutes ?? 0} min average`}
            />
            <SummaryMetric
              label="Distance"
              value={formatActivityDistance(report.overview.totalDistanceKm)}
              detail="Only activities with distance"
            />
            <SummaryMetric
              label="Active weeks"
              value={`${report.overview.activeWeeks}/${report.overview.weeksInRange}`}
              detail={`${report.overview.consistencyPercent}% of selected weeks`}
            />
            <SummaryMetric
              label="Recent time trend"
              value={trend == null ? "—" : `${trend >= 0 ? "+" : ""}${trend}%`}
              detail="Latest 4 weeks vs previous 4"
            />
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.85fr)]">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Clock3 className="size-4 text-success" />
                <h3 className="text-sm font-medium">Weekly activity time</h3>
              </div>
              <div className="flex h-40 items-end gap-1.5 border-b pb-7 sm:gap-2">
                {report.weekly.map((week) => {
                  const weekDate = new Date(week.weekStartISO);
                  const label = weekDate.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  });
                  const height = Math.max(
                    3,
                    Math.round(
                      (week.durationMinutes / maxWeeklyMinutes) * 105
                    )
                  );
                  return (
                    <div
                      key={week.weekStartISO}
                      className="group relative flex min-w-0 flex-1 flex-col items-center justify-end"
                      title={`Week of ${label}: ${week.activities} ${week.activities === 1 ? "activity" : "activities"}, ${week.durationMinutes} minutes, ${week.distanceKm} km`}
                    >
                      <span className="mb-1 text-[0.5625rem] tabular-nums text-muted-foreground">
                        {week.activities || ""}
                      </span>
                      <div
                        className={cn(
                          "w-full min-w-1 rounded-t bg-success/15 transition-colors group-hover:bg-success/45",
                          week.activities > 0 && "bg-success/35"
                        )}
                        style={{ height }}
                      />
                      <span className="absolute -bottom-5 text-[0.5625rem] text-muted-foreground">
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[0.6875rem] text-muted-foreground">
                Bar height = minutes · Number = activities
              </p>
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2">
                <Activity className="size-4 text-success" />
                <h3 className="text-sm font-medium">By activity type</h3>
              </div>
              <div className="divide-y rounded-xl border bg-background/60 px-3">
                {report.byType.map((type) => (
                  <div key={type.activityType} className="py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium">{type.label}</p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {type.activities} · {type.totalMinutes} min
                      </p>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground">
                      {type.distanceKm > 0 && (
                        <span>{formatActivityDistance(type.distanceKm)}</span>
                      )}
                      {type.averagePaceSecondsPerKm != null && (
                        <span>
                          {activityUsesSpeed(type.activityType)
                            ? formatActivitySpeed(
                                type.averagePaceSecondsPerKm
                              )
                            : formatActivityPace(
                                type.averagePaceSecondsPerKm
                              )}
                        </span>
                      )}
                      {type.performanceChangePercent != null && (
                        <span
                          className={cn(
                            "font-medium",
                            type.performanceChangePercent > 0
                              ? "text-success"
                              : type.performanceChangePercent < 0
                                ? "text-amber-700 dark:text-amber-400"
                                : ""
                          )}
                        >
                          {Math.abs(type.performanceChangePercent)}% {type.performanceChangePercent >= 0 ? "improved" : "slower"}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-xl border border-dashed bg-background/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium">
                <Gauge className="size-3.5 text-success" /> Measurement coverage
              </div>
              <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
                {coverageItems
                  .map(
                    ([label, count]) =>
                      `${label} ${count}/${measured.activities}`
                  )
                  .join(" · ")}
              </p>
              {report.overview.excludedActivities > 0 && (
                <p className="mt-1 text-[0.6875rem] text-muted-foreground">
                  {report.overview.excludedActivities} flagged activity
                  {report.overview.excludedActivities === 1 ? " was" : " records were"} kept but excluded from these totals.
                </p>
              )}
            </div>
            <Button
              render={<Link href="/activity/new" />}
              nativeButton={false}
              variant="outline"
              size="sm"
            >
              <MapPinned className="size-3.5" /> Record activity
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
