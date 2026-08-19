import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { getDb } from "@/db";
import { healthActivities } from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import type { ActivityIntensity, ActivityType } from "@/lib/activities";
import {
  buildActivityHistoryHref,
  firstSearchParam,
  parseHistoryCalendarDate,
  parseHistoryCalendarView,
  parseHistoryInsightLens,
  parseHistoryView,
  type SearchParamValue,
} from "@/lib/history-navigation";
import { parseHistoryRange } from "@/services/history-report";
import { ActivityForm } from "@/components/activity/activity-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type EditActivityPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    range?: SearchParamValue;
    view?: SearchParamValue;
    lens?: SearchParamValue;
    calendarView?: SearchParamValue;
    calendarDate?: SearchParamValue;
  }>;
};

export default async function EditActivityPage(props: EditActivityPageProps) {
  const { id } = await props.params;
  const query = await props.searchParams;
  const context = {
    range: parseHistoryRange(firstSearchParam(query.range)),
    view: parseHistoryView(query.view),
    lens: parseHistoryInsightLens(query.lens),
    calendarView: parseHistoryCalendarView(query.calendarView),
    calendarDate: parseHistoryCalendarDate(query.calendarDate),
  };
  const user = await getCurrentUser();
  const db = await getDb();
  const activity = await db.query.healthActivities.findFirst({
    where: and(
      eq(healthActivities.id, id),
      eq(healthActivities.userId, user.id),
      isNull(healthActivities.archivedAt)
    ),
  });
  if (!activity || activity.source !== "manual") notFound();

  const detailHref = buildActivityHistoryHref(activity.id, context);
  const original = activity.originalMetrics;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header>
        <Button
          render={<Link href={detailHref} />}
          nativeButton={false}
          variant="ghost"
          className="-ml-2 mb-2"
        >
          <ArrowLeft className="size-4" /> Activity
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Edit activity
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the measurements without affecting workout order or progression.
        </p>
      </header>

      <Card>
        <CardContent>
          <ActivityForm
            activityId={activity.id}
            successHref={detailHref}
            cancelHref={detailHref}
            initialValues={{
              activityType: activity.activityType as ActivityType,
              title: activity.title,
              startedAtISO: activity.startedAt.toISOString(),
              timezone: activity.timezone,
              durationSeconds: activity.durationSeconds,
              distanceValue:
                original.distanceValue ?? activity.distanceKm ?? null,
              distanceUnit: original.distanceUnit ?? "km",
              intensity: activity.intensity as ActivityIntensity | null,
              elevationValue:
                original.elevationValue ?? activity.elevationGainM ?? null,
              elevationUnit: original.elevationUnit ?? "m",
              averageHeartRateBpm: activity.averageHeartRateBpm,
              energyKcal: activity.energyKcal,
              notes: activity.notes,
            }}
          />
        </CardContent>
      </Card>
    </main>
  );
}
