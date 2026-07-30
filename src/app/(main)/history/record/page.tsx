import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { RetrospectiveWorkoutForm } from "@/components/history/retrospective-workout-form";
import { getCurrentUser } from "@/lib/user";
import {
  buildHistoryHref,
  firstSearchParam,
  parseHistoryCalendarDate,
  parseHistoryCalendarView,
  parseHistoryInsightLens,
  parseHistoryView,
  type SearchParamValue,
} from "@/lib/history-navigation";
import { workoutLocalDate } from "@/lib/workout-calendar";
import { getExerciseDiscoveryLibrary } from "@/services/exercise-discovery";
import { getActiveProgramPresentation } from "@/services/program-presentation";
import { parseHistoryRange } from "@/services/history-report";

export default async function RecordRetrospectiveWorkoutPage({
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
  const localDate = parseHistoryCalendarDate(query.date);
  const calendarView = parseHistoryCalendarView(query.calendarView);
  const calendarDate = parseHistoryCalendarDate(query.calendarDate);
  const range = parseHistoryRange(firstSearchParam(query.range));
  const view = parseHistoryView(query.view);
  const lens = parseHistoryInsightLens(query.lens);
  const user = await getCurrentUser();
  const ownerToday = workoutLocalDate(new Date(), user.profile.timezone);
  const historyHref = buildHistoryHref({
    range,
    view,
    lens,
    calendarView,
    calendarDate: calendarDate ?? localDate ?? ownerToday,
  });
  if (!localDate || localDate >= ownerToday) {
    redirect(historyHref);
  }

  const db = await getDb();
  const [program, exerciseLibrary] = await Promise.all([
    getActiveProgramPresentation(db, user.id),
    getExerciseDiscoveryLibrary(db, user.id),
  ]);

  return (
    <RetrospectiveWorkoutForm
      ownerId={user.id}
      localDate={localDate}
      timezone={user.profile.timezone}
      unit={user.profile.unit}
      program={program}
      exerciseLibrary={exerciseLibrary}
      historyHref={historyHref}
      historyContext={{
        range,
        view,
        lens,
        calendarView,
        calendarDate: calendarDate ?? localDate,
      }}
    />
  );
}
