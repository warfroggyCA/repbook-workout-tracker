import Link from "next/link";
import { Footprints } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatActivityDistance,
  formatActivityDuration,
} from "@/lib/activities";
import type { ActivityReport } from "@/services/activity-report";

export function CoachActivityContext({
  report,
}: {
  report: ActivityReport;
}) {
  const primaryType = report.byType[0];

  return (
    <section
      aria-labelledby="coach-activity-heading"
      className="rounded-2xl border border-success/20 bg-success/3 p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
            <Footprints className="size-4" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="coach-activity-heading" className="font-medium">
                Independent activity context
              </h2>
              <Badge
                variant="outline"
                className="border-success/30 text-success"
              >
                Separate evidence
              </Badge>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Coach may use these records to explain overall activity or recovery
              context. They never count as strength workouts, alter progression,
              or change your program automatically.
            </p>
          </div>
        </div>
        <Button
          render={<Link href="/history?range=12w" />}
          nativeButton={false}
          variant="outline"
          size="sm"
        >
          View activity trends
        </Button>
      </div>

      {report.overview.totalActivities > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ActivityFact
            label="Activities"
            value={String(report.overview.totalActivities)}
            detail={`${report.overview.activitiesPerWeek} per week`}
          />
          <ActivityFact
            label="Time"
            value={formatActivityDuration(report.overview.totalMinutes * 60)}
            detail={`${report.overview.activeWeeks} active ${report.overview.activeWeeks === 1 ? "week" : "weeks"}`}
          />
          <ActivityFact
            label="Distance"
            value={formatActivityDistance(report.overview.totalDistanceKm)}
            detail="Recorded distance only"
          />
          <ActivityFact
            label="Main activity"
            value={primaryType?.label ?? "—"}
            detail={
              primaryType
                ? `${primaryType.activities} ${primaryType.activities === 1 ? "record" : "records"} · ${primaryType.totalMinutes} min`
                : "No activity types"
            }
          />
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-dashed bg-background/50 p-3 text-sm text-muted-foreground">
          No independent activities were recorded in the last 12 weeks. Coach
          will state that gap instead of guessing about activity outside workouts.
        </p>
      )}
    </section>
  );
}

function ActivityFact({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-success/15 bg-background/70 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{detail}</p>
    </div>
  );
}
