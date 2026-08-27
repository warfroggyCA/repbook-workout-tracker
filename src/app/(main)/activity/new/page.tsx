import Link from "next/link";
import { ArrowLeft, Footprints } from "lucide-react";
import { getDb } from "@/db";
import { ActivityForm } from "@/components/activity/activity-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  buildHistoryHref,
  firstSearchParam,
  parseHistoryCalendarDate,
  parseHistoryCalendarView,
  parseHistoryInsightLens,
  parseHistoryView,
  type SearchParamValue,
} from "@/lib/history-navigation";
import { getCurrentUser } from "@/lib/user";
import { workoutLocalDate } from "@/lib/workout-calendar";
import { getRecentNamedActivityPresets } from "@/services/activities";
import { parseHistoryRange } from "@/services/history-report";

export default async function NewActivityPage({
  searchParams,
}: {
  searchParams: Promise<{
    date?: SearchParamValue;
    range?: SearchParamValue;
    view?: SearchParamValue;
    lens?: SearchParamValue;
    calendarView?: SearchParamValue;
    calendarDate?: SearchParamValue;
  }>;
}) {
  const query = await searchParams;
  const [user, db] = await Promise.all([getCurrentUser(), getDb()]);
  const ownerToday = workoutLocalDate(new Date(), user.profile.timezone);
  const requestedDate = parseHistoryCalendarDate(query.date);
  const initialCalendarDate = requestedDate && requestedDate <= ownerToday
    ? requestedDate
    : undefined;
  const historyContext = {
    range: parseHistoryRange(firstSearchParam(query.range)),
    view: parseHistoryView(query.view),
    lens: parseHistoryInsightLens(query.lens),
    calendarView: parseHistoryCalendarView(query.calendarView),
    calendarDate:
      parseHistoryCalendarDate(query.calendarDate) ??
      initialCalendarDate ??
      ownerToday,
  };
  const historyHref = buildHistoryHref(historyContext, {
    focusCalendar: historyContext.view === "calendar",
  });
  const recentPresets = await getRecentNamedActivityPresets(db, user.id);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header>
        <Button
          render={<Link href={historyHref} />}
          nativeButton={false}
          variant="ghost"
          className="-ml-2 mb-2"
        >
          <ArrowLeft className="size-4" /> History
        </Button>
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
          Independent health activity
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          Record activity
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add a walk, hike, run, or other activity for its actual date without
          changing your workout order or strength program.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Footprints className="size-5 text-primary" /> Activity details
          </CardTitle>
          <CardDescription>
            Duration is required. Add distance and other measurements only when
            you have them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActivityForm
            initialCalendarDate={initialCalendarDate}
            recentPresets={recentPresets}
            cancelHref={historyHref}
            newActivityHistoryContext={historyContext}
          />
        </CardContent>
      </Card>
    </main>
  );
}
