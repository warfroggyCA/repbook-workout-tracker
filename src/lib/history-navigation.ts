export const HISTORY_CALENDAR_VIEWS = ["month", "week", "year"] as const;
export const HISTORY_VIEWS = ["calendar", "insights", "exercises"] as const;
export const HISTORY_INSIGHT_LENSES = [
  "overview",
  "progress",
  "program-fit",
  "pain-constraints",
  "work-capacity",
  "records",
] as const;

export type HistoryCalendarView = (typeof HISTORY_CALENDAR_VIEWS)[number];
export type HistoryView = (typeof HISTORY_VIEWS)[number];
export type HistoryInsightLens = (typeof HISTORY_INSIGHT_LENSES)[number];
export type SearchParamValue = string | string[] | undefined;

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function utcDate(key: string) {
  return new Date(`${key}T12:00:00.000Z`);
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Exact date span rendered by the calendar. */
export function historyCalendarWindow(
  view: HistoryCalendarView,
  anchorKey: string
) {
  const anchor = utcDate(anchorKey);
  if (view === "year") {
    return {
      start: `${anchor.getUTCFullYear()}-01-01`,
      end: `${anchor.getUTCFullYear()}-12-31`,
    };
  }

  const first =
    view === "month"
      ? new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1, 12))
      : anchor;
  const start = addUtcDays(first, -((first.getUTCDay() + 6) % 7));
  return {
    start: dateKey(start),
    end: dateKey(addUtcDays(start, view === "month" ? 41 : 6)),
  };
}

export function firstSearchParam(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseHistoryCalendarView(
  value: SearchParamValue
): HistoryCalendarView {
  const candidate = firstSearchParam(value);
  return HISTORY_CALENDAR_VIEWS.some((view) => view === candidate)
    ? (candidate as HistoryCalendarView)
    : "month";
}

export function parseHistoryView(value: SearchParamValue): HistoryView {
  const candidate = firstSearchParam(value);
  return HISTORY_VIEWS.some((view) => view === candidate)
    ? (candidate as HistoryView)
    : "calendar";
}

export function parseHistoryInsightLens(
  value: SearchParamValue
): HistoryInsightLens {
  const candidate = firstSearchParam(value);
  return HISTORY_INSIGHT_LENSES.some((lens) => lens === candidate)
    ? (candidate as HistoryInsightLens)
    : "overview";
}

export function parseHistoryCalendarDate(
  value: SearchParamValue
): string | null {
  const candidate = firstSearchParam(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;

  const [year, month, day] = candidate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? candidate
    : null;
}

export type HistoryContext = {
  range: string;
  view?: HistoryView;
  lens?: HistoryInsightLens;
  calendarView?: HistoryCalendarView;
  calendarDate?: string | null;
};

function contextParams({
  range,
  view = "calendar",
  lens = "overview",
  calendarView,
  calendarDate,
}: HistoryContext) {
  const params = new URLSearchParams({ range });
  if (view !== "calendar") params.set("view", view);
  if (view === "insights" && lens !== "overview") params.set("lens", lens);
  if (calendarView) params.set("calendarView", calendarView);
  if (calendarDate) params.set("calendarDate", calendarDate);
  return params;
}

export function buildHistoryHref(
  context: HistoryContext,
  options: { focusCalendar?: boolean } = {}
) {
  const hash = options.focusCalendar ? "#history-calendar" : "";
  return `/history?${contextParams(context).toString()}${hash}`;
}

export function buildWorkoutHistoryHref(
  workoutId: string,
  context: HistoryContext
) {
  return `/history/${encodeURIComponent(workoutId)}?${contextParams(context).toString()}`;
}

export function buildActivityHistoryHref(
  activityId: string,
  context: HistoryContext
) {
  return `/activity/${encodeURIComponent(activityId)}?${contextParams(context).toString()}`;
}

export function buildActivityEditHref(
  activityId: string,
  context: HistoryContext
) {
  return `/activity/${encodeURIComponent(activityId)}/edit?${contextParams(context).toString()}`;
}

export function buildRetrospectiveWorkoutHref(
  localDate: string,
  context: HistoryContext
) {
  const params = contextParams(context);
  params.set("date", localDate);
  return `/history/record?${params.toString()}`;
}
