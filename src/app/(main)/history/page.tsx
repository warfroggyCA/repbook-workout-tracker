import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { HistoryWorkspace } from "@/components/history/history-workspace";
import {
  getHistoryCalendarRecords,
  getHistoryReport,
  parseHistoryRange,
} from "@/services/history-report";
import {
  firstSearchParam,
  parseHistoryCalendarDate,
  parseHistoryCalendarView,
  parseHistoryInsightLens,
  parseHistoryExerciseEvidenceTier,
  parseHistoryExerciseId,
  parseHistoryView,
  type SearchParamValue,
} from "@/lib/history-navigation";
import { workoutLocalDate } from "@/lib/workout-calendar";
import { getActivityReport } from "@/services/activity-report";
import { getHistoryPageMaintenance } from "@/services/history-page";

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: SearchParamValue;
    view?: SearchParamValue;
    lens?: SearchParamValue;
    calendarView?: SearchParamValue;
    calendarDate?: SearchParamValue;
    exerciseId?: SearchParamValue;
    evidenceTier?: SearchParamValue;
  }>;
}) {
  const query = await searchParams;
  const range = parseHistoryRange(firstSearchParam(query.range));
  const view = parseHistoryView(query.view);
  const lens = parseHistoryInsightLens(query.lens);
  const calendarView = parseHistoryCalendarView(query.calendarView);
  const calendarDate = parseHistoryCalendarDate(query.calendarDate);
  const exerciseId = parseHistoryExerciseId(query.exerciseId);
  const evidenceTier = parseHistoryExerciseEvidenceTier(query.evidenceTier);
  const user = await getCurrentUser();
  const db = await getDb();
  const ownerToday = workoutLocalDate(new Date(), user.profile.timezone);
  const effectiveCalendarDate = calendarDate ?? ownerToday;
  const [report, activityReport, calendarRecords, maintenance] =
    await Promise.all([
    getHistoryReport(
      db,
      user.id,
      range,
      user.profile.weeklyFrequency,
      new Date(),
      { timezone: user.profile.timezone, unit: user.profile.unit }
    ),
    view === "insights"
      ? getActivityReport(db, user.id, range)
      : Promise.resolve(null),
    view === "calendar"
      ? getHistoryCalendarRecords(db, user.id, user.profile.unit, {
          view: calendarView,
          date: effectiveCalendarDate,
        })
      : Promise.resolve(null),
    getHistoryPageMaintenance(db, user.id),
  ]);

  return (
    <HistoryWorkspace
      report={report}
      activityReport={activityReport}
      calendarRecords={calendarRecords}
      range={range}
      view={view}
      lens={lens}
      calendarView={calendarView}
      calendarDate={calendarDate}
      exerciseId={exerciseId}
      evidenceTier={evidenceTier}
      ownerToday={ownerToday}
      unit={user.profile.unit}
      testSessionCount={maintenance.testSessionCount}
      samplePreview={
        maintenance.samplePreview.workouts > 0
          ? maintenance.samplePreview
          : null
      }
      activityArchivePreview={maintenance.activityArchivePreview}
    />
  );
}
