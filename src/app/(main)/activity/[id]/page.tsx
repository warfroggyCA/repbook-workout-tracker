import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import {
  Activity,
  ArrowLeft,
  Clock3,
  Gauge,
  HeartPulse,
  MapPin,
  Mountain,
  Pencil,
  Zap,
} from "lucide-react";
import { getDb } from "@/db";
import { healthActivities } from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import {
  activityIntensityLabel,
  activityTypeLabel,
  activityUsesSpeed,
  formatActivityDistance,
  formatActivityDuration,
  formatActivityPace,
  formatActivitySpeed,
} from "@/lib/activities";
import {
  buildActivityEditHref,
  buildHistoryHref,
  firstSearchParam,
  parseHistoryCalendarDate,
  parseHistoryCalendarView,
  parseHistoryInsightLens,
  parseHistoryView,
  type SearchParamValue,
} from "@/lib/history-navigation";
import { parseHistoryRange } from "@/services/history-report";
import { ActivityDeleteButton } from "@/components/activity/activity-delete-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ActivityPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    range?: SearchParamValue;
    view?: SearchParamValue;
    lens?: SearchParamValue;
    calendarView?: SearchParamValue;
    calendarDate?: SearchParamValue;
  }>;
};

export default async function ActivityDetailPage(props: ActivityPageProps) {
  const { id } = await props.params;
  const query = await props.searchParams;
  const range = parseHistoryRange(firstSearchParam(query.range));
  const view = parseHistoryView(query.view);
  const lens = parseHistoryInsightLens(query.lens);
  const calendarView = parseHistoryCalendarView(query.calendarView);
  const calendarDate = parseHistoryCalendarDate(query.calendarDate);
  const context = { range, view, lens, calendarView, calendarDate };
  const historyHref = buildHistoryHref(context, {
    focusCalendar: view === "calendar",
  });
  const user = await getCurrentUser();
  const db = await getDb();
  const activity = await db.query.healthActivities.findFirst({
    where: and(
      eq(healthActivities.id, id),
      eq(healthActivities.userId, user.id),
      isNull(healthActivities.archivedAt)
    ),
  });
  if (!activity) notFound();

  const original = activity.originalMetrics;
  const distance =
    original.distanceValue != null && original.distanceUnit
      ? `${original.distanceValue} ${original.distanceUnit}`
      : activity.distanceKm != null
        ? formatActivityDistance(activity.distanceKm)
        : null;
  const elevation =
    original.elevationValue != null && original.elevationUnit
      ? `${original.elevationValue} ${original.elevationUnit}`
      : activity.elevationGainM != null
        ? `${Math.round(activity.elevationGainM)} m`
        : null;
  const startedLabel = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: activity.timezone,
  }).format(activity.startedAt);

  const metrics = [
    {
      label: "Duration",
      value: formatActivityDuration(activity.durationSeconds),
      icon: Clock3,
    },
    ...(distance ? [{ label: "Distance", value: distance, icon: MapPin }] : []),
    ...(activity.averagePaceSecondsPerKm != null
      ? [
          {
            label: activityUsesSpeed(activity.activityType)
              ? "Average speed"
              : "Average pace",
            value: activityUsesSpeed(activity.activityType)
              ? formatActivitySpeed(activity.averagePaceSecondsPerKm)
              : formatActivityPace(activity.averagePaceSecondsPerKm),
            icon: Gauge,
          },
        ]
      : []),
    ...(elevation
      ? [{ label: "Elevation gain", value: elevation, icon: Mountain }]
      : []),
    ...(activity.averageHeartRateBpm != null
      ? [
          {
            label: "Average heart rate",
            value: `${activity.averageHeartRateBpm} bpm`,
            icon: HeartPulse,
          },
        ]
      : []),
    ...(activity.energyKcal != null
      ? [
          {
            label: "Energy",
            value: `${activity.energyKcal} kcal`,
            icon: Zap,
          },
        ]
      : []),
  ];

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
            Independent activity
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            {activity.title || activityTypeLabel(activity.activityType)}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {activityTypeLabel(activity.activityType)}
            </Badge>
            {activity.intensity && (
              <Badge variant="outline">
                {activityIntensityLabel(activity.intensity)} intensity
              </Badge>
            )}
            <Badge variant="outline">
              {activity.source === "manual" ? "Manually recorded" : activity.source}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {startedLabel} · {activity.timezone}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            render={<Link href={historyHref} />}
            nativeButton={false}
            variant="outline"
          >
            <ArrowLeft className="size-4" /> Back to history
          </Button>
          {activity.source === "manual" && (
            <Button
              render={<Link href={buildActivityEditHref(activity.id, context)} />}
              nativeButton={false}
              variant="outline"
            >
              <Pencil className="size-4" /> Edit
            </Button>
          )}
          {activity.source === "manual" && (
            <ActivityDeleteButton
              activityId={activity.id}
              returnHref={historyHref}
            />
          )}
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map(({ label, value, icon: Icon }) => (
          <Card key={label} size="sm">
            <CardContent>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">
                  {label}
                </p>
                <Icon className="size-4 text-primary" />
              </div>
              <p className="text-xl font-semibold tabular-nums">{value}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      {activity.notes && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm">{activity.notes}</p>
          </CardContent>
        </Card>
      )}

      <Card size="sm" className="bg-muted/25">
        <CardContent className="flex gap-3 text-sm text-muted-foreground">
          <Activity className="mt-0.5 size-4 shrink-0 text-primary" />
          <p>
            This activity supports your overall health history but does not count
            as a strength workout or change exercise progression.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
