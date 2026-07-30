"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  type ReactNode,
  useMemo,
  useState,
} from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Dumbbell,
  Footprints,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  buildActivityHistoryHref,
  buildHistoryHref,
  buildRetrospectiveWorkoutHref,
  buildWorkoutHistoryHref,
  type HistoryCalendarView,
} from "@/lib/history-navigation";
import {
  activityTypeLabel,
  formatActivityDistance,
} from "@/lib/activities";
import type {
  HistoryCalendarRecord,
  HistoryRangeKey,
} from "@/services/history-report";

type CalendarRecord = HistoryCalendarRecord;

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfWeek(date: Date) {
  const result = new Date(date);
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}

function monthDays(anchor: Date) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
  const gridStart = startOfWeek(first);
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

function weekDays(anchor: Date) {
  const first = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}

function yearMonthCells(year: number, month: number) {
  const first = new Date(year, month, 1, 12);
  const leading = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0, 12).getDate();
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - leading + 1;
    return day >= 1 && day <= daysInMonth
      ? new Date(year, month, day, 12)
      : null;
  });
}

function shortRecordName(name: string) {
  return name.replace(/^Sample data · /, "Sample · ");
}

function fullDateLabel(day: Date) {
  return day.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function recordDateKey(record: CalendarRecord) {
  return record.calendarDateKey;
}

function recordTimeLabel(record: CalendarRecord) {
  if (
    record.recordType === "workout" &&
    record.performedTimePrecision === "date_only"
  ) {
    return "Time unknown";
  }
  return new Date(record.startedAtISO).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: record.timezone,
  });
}

function CalendarDayAction({
  day,
  records,
  range,
  view,
  selected,
  ownerToday,
  focused,
  className,
  children,
  onChoose,
  onNavigate,
  onFocus,
}: {
  day: Date;
  records: CalendarRecord[];
  range: HistoryRangeKey;
  view: HistoryCalendarView;
  selected: boolean;
  ownerToday: string;
  focused: boolean;
  className: string;
  children: ReactNode;
  onChoose: (key: string) => void;
  onNavigate: (key: string) => void;
  onFocus: (key: string) => void;
}) {
  const key = dateKey(day);
  const label = fullDateLabel(day);

  if (records.length === 1) {
    const record = records[0];
    const context = {
      range,
      calendarView: view,
      calendarDate: key,
    };
    return (
      <Link
        href={
          record.recordType === "workout"
            ? buildWorkoutHistoryHref(record.id, context)
            : buildActivityHistoryHref(record.id, context)
        }
        aria-label={`${label}: Open ${record.name}`}
        data-calendar-action
        data-calendar-date={key}
        tabIndex={focused ? 0 : -1}
        onFocus={() => onFocus(key)}
        onClick={() => onNavigate(key)}
        className={className}
      >
        {children}
      </Link>
    );
  }

  if (records.length > 1) {
    return (
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={selected}
        aria-label={`${label}: Choose from ${records.length} records`}
        data-calendar-action
        data-calendar-date={key}
        tabIndex={focused ? 0 : -1}
        onFocus={() => onFocus(key)}
        onClick={() => onChoose(key)}
        className={className}
      >
        {children}
      </button>
    );
  }

  if (key === ownerToday) {
    return (
      <Link
        href="/today"
        aria-label={`${label}: Open Today to record a workout`}
        data-calendar-action
        data-calendar-date={key}
        tabIndex={focused ? 0 : -1}
        onFocus={() => onFocus(key)}
        className={className}
      >
        {children}
      </Link>
    );
  }

  if (key < ownerToday) {
    return (
      <Link
        href={buildRetrospectiveWorkoutHref(key, {
          range,
          calendarView: view,
          calendarDate: key,
        })}
        prefetch={false}
        aria-label={`${label}: Record a workout`}
        data-calendar-action
        data-calendar-date={key}
        tabIndex={focused ? 0 : -1}
        onFocus={() => onFocus(key)}
        className={className}
      >
        {children}
      </Link>
    );
  }

  return (
    <time
      dateTime={key}
      aria-label={`${label}: No history`}
      className={className}
    >
      {children}
    </time>
  );
}

export function HistoryDayRecordList({
  records,
  range,
  view,
  date,
  unit,
}: {
  records: CalendarRecord[];
  range: HistoryRangeKey;
  view: HistoryCalendarView;
  date: string;
  unit: string;
}) {
  return (
    <div className="min-w-0 divide-y overflow-hidden rounded-xl border px-3">
      {records.map((record) => {
        const context = {
          range,
          calendarView: view,
          calendarDate: date,
        };
        return (
          <Link
            key={`${record.recordType}-${record.id}`}
            href={
              record.recordType === "workout"
                ? buildWorkoutHistoryHref(record.id, context)
                : buildActivityHistoryHref(record.id, context)
            }
            className="group flex min-w-0 items-center justify-between gap-3 py-3"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate font-medium group-hover:text-primary">
                  {record.name}
                </p>
                <Badge variant="outline">
                  {record.recordType === "workout"
                    ? "Workout"
                    : activityTypeLabel(record.activityType)}
                </Badge>
                {record.recordType === "workout" &&
                  record.status === "abandoned" && (
                    <Badge variant="outline">abandoned</Badge>
                  )}
                {record.recordType === "workout" &&
                  record.source === "history_manual" && (
                    <Badge variant="outline">Entered later</Badge>
                  )}
                {record.recordType === "workout" && record.painEvents > 0 && (
                  <Badge variant="destructive">pain</Badge>
                )}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {recordTimeLabel(record)}
                </span>
                {record.durationMin != null && (
                  <span className="flex items-center gap-1">
                    <Clock3 className="size-3" /> {record.durationMin} min
                  </span>
                )}
                {record.recordType === "workout" ? (
                  <>
                    <span className="flex items-center gap-1">
                      <Dumbbell className="size-3" /> {record.sets} sets
                    </span>
                    <span className="tabular-nums">
                      {number.format(record.volume)} {unit}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-1">
                      <Footprints className="size-3" /> Activity
                    </span>
                    {record.distanceKm != null && (
                      <span className="tabular-nums">
                        {formatActivityDistance(record.distanceKm)}
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
          </Link>
        );
      })}
    </div>
  );
}

export function HistoryCalendar({
  records,
  unit,
  range,
  initialView,
  initialDate,
  ownerToday,
}: {
  records: CalendarRecord[];
  unit: string;
  range: HistoryRangeKey;
  initialView: HistoryCalendarView;
  initialDate: string | null;
  ownerToday: string;
}) {
  const router = useRouter();
  const groupedRecords = useMemo(() => {
    const grouped = new Map<string, CalendarRecord[]>();
    for (const record of records) {
      const key = recordDateKey(record);
      grouped.set(key, [...(grouped.get(key) ?? []), record]);
    }
    return grouped;
  }, [records]);
  const todayKey = ownerToday;
  const initialKey = initialDate ?? todayKey;
  const [view, setView] = useState<HistoryCalendarView>(initialView);
  const [anchor, setAnchor] = useState(() => dateFromKey(initialKey));
  const [chooserKey, setChooserKey] = useState<string | null>(() =>
    initialDate &&
    (groupedRecords.get(initialDate)?.length ?? 0) > 1
      ? initialDate
      : null
  );
  const [focusedKey, setFocusedKey] = useState(() =>
    initialKey <= ownerToday ? initialKey : ownerToday
  );

  const days =
    view === "month"
      ? monthDays(anchor)
      : view === "week"
        ? weekDays(anchor)
        : [];
  const chooserRecords = chooserKey
    ? groupedRecords.get(chooserKey) ?? []
    : [];
  const anchorLabel =
    view === "year"
      ? String(anchor.getFullYear())
      : view === "month"
        ? anchor.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })
        : `${days[0].toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })} – ${days.at(-1)!.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}`;

  function move(direction: -1 | 1) {
    const next = new Date(anchor);
    if (view === "year") {
      next.setFullYear(next.getFullYear() + direction);
    } else if (view === "month") {
      next.setDate(1);
      next.setMonth(next.getMonth() + direction);
    } else {
      next.setDate(next.getDate() + direction * 7);
    }
    setAnchor(next);
    setChooserKey(null);
    const nextKey = dateKey(next);
    setFocusedKey(nextKey <= ownerToday ? nextKey : ownerToday);
    loadCalendarWindow(view, nextKey);
  }

  function showToday() {
    const next = dateFromKey(ownerToday);
    setAnchor(next);
    setChooserKey(null);
    setFocusedKey(ownerToday);
    loadCalendarWindow(view, ownerToday);
  }

  function changeView(nextView: HistoryCalendarView) {
    setView(nextView);
    setChooserKey(null);
    setFocusedKey(dateKey(anchor) <= ownerToday ? dateKey(anchor) : ownerToday);
    loadCalendarWindow(nextView, dateKey(anchor));
  }

  function loadCalendarWindow(nextView: HistoryCalendarView, nextDate: string) {
    router.replace(
      buildHistoryHref({
        range,
        calendarView: nextView,
        calendarDate: nextDate,
      }),
      { scroll: false }
    );
  }

  function syncAddress(nextView: HistoryCalendarView, nextDate: string) {
    window.history.replaceState(
      null,
      "",
      buildHistoryHref({
        range,
        calendarView: nextView,
        calendarDate: nextDate,
      })
    );
  }

  function openChooser(key: string) {
    setAnchor(dateFromKey(key));
    setChooserKey(key);
    syncAddress(view, key);
  }

  function prepareDirectNavigation(key: string) {
    setAnchor(dateFromKey(key));
    setChooserKey(null);
    syncAddress(view, key);
  }

  function handleCalendarKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-calendar-action]"
    );
    if (!current) return;
    const actions = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "[data-calendar-action]"
      )
    );
    const currentIndex = actions.indexOf(current);
    if (currentIndex < 0) return;

    const dayOffsets: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (
      !(event.key in dayOffsets) &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const currentKey = current.dataset.calendarDate;
    const target =
      event.key === "Home"
        ? actions[0]
        : event.key === "End"
          ? actions.at(-1)
          : currentKey
            ? event.currentTarget.querySelector<HTMLElement>(
                `[data-calendar-action][data-calendar-date="${dateKey(
                  addDays(dateFromKey(currentKey), dayOffsets[event.key])
                )}"]`
              )
            : null;
    if (!target) return;
    event.preventDefault();
    const nextKey = target.dataset.calendarDate;
    if (nextKey) setFocusedKey(nextKey);
    target.focus();
  }

  return (
    <Card id="history-calendar" className="scroll-mt-4">
      <CardHeader className="gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="size-4 text-primary" />
            <h3>Training calendar</h3>
          </CardTitle>
          <CardDescription>
            One record opens directly. Dates with workouts and activities let
            you choose the exact entry or record another workout. An empty past
            date starts a reviewed retrospective entry.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-1 sm:justify-end">
          <Button variant="outline" size="sm" onClick={showToday}>
            Today
          </Button>
          <div
            className="flex rounded-lg bg-muted p-0.5"
            role="group"
            aria-label="Calendar view"
          >
            {(["month", "week", "year"] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={view === option ? "default" : "ghost"}
                aria-pressed={view === option}
                onClick={() => changeView(option)}
              >
                {option === "month"
                  ? "Month"
                  : option === "week"
                    ? "Week"
                    : "Year"}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent onKeyDown={handleCalendarKeyDown}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`Previous ${view}`}
            onClick={() => move(-1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <h3 className="text-center text-sm font-semibold">{anchorLabel}</h3>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`Next ${view}`}
            onClick={() => move(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        {view === "year" ? (
          <div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 12 }, (_, month) => {
                const monthDate = new Date(anchor.getFullYear(), month, 1, 12);
                return (
                  <section
                    key={month}
                    className="rounded-xl border bg-muted/15 p-2"
                  >
                    <p className="mb-1 text-center text-xs font-semibold">
                      {monthDate.toLocaleDateString(undefined, {
                        month: "long",
                      })}
                    </p>
                    <div className="grid grid-cols-7 text-center text-[0.5rem] font-medium uppercase text-muted-foreground">
                      {weekdays.map((day) => (
                        <span key={day}>{day.slice(0, 1)}</span>
                      ))}
                    </div>
                    <div className="mt-0.5 grid grid-cols-7 gap-0.5">
                      {yearMonthCells(anchor.getFullYear(), month).map(
                        (day, index) => {
                          if (!day) {
                            return <span key={`blank-${index}`} aria-hidden />;
                          }
                          const key = dateKey(day);
                          const dayRecords = groupedRecords.get(key) ?? [];
                          const selected = key === chooserKey;
                          return (
                            <CalendarDayAction
                              key={key}
                              day={day}
                              records={dayRecords}
                              range={range}
                              view={view}
                              selected={selected}
                              ownerToday={ownerToday}
                              focused={key === focusedKey}
                              onChoose={openChooser}
                              onNavigate={prepareDirectNavigation}
                              onFocus={setFocusedKey}
                              className={cn(
                                "relative flex aspect-square min-w-0 items-center justify-center rounded-md text-[0.58rem] tabular-nums transition-colors",
                                (dayRecords.length > 0 || key <= ownerToday) &&
                                  "outline-none hover:bg-muted focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring",
                                dayRecords.length === 0 &&
                                  "text-muted-foreground/55",
                                selected &&
                                  "bg-primary/10 font-semibold text-primary ring-2 ring-inset ring-primary/60",
                                key === todayKey &&
                                  !selected &&
                                  "bg-accent font-semibold text-accent-foreground"
                              )}
                            >
                              {day.getDate()}
                              {dayRecords.length > 0 && (
                                <span
                                  className="absolute bottom-0.5 flex gap-px"
                                  aria-hidden
                                >
                                  {dayRecords.slice(0, 3).map((record) => (
                                    <span
                                      key={record.id}
                                      className={cn(
                                        "size-1 rounded-full bg-primary",
                                        record.recordType === "activity" &&
                                          "bg-emerald-500",
                                        record.recordType === "workout" &&
                                          record.status === "abandoned" &&
                                          "bg-amber-500"
                                      )}
                                    />
                                  ))}
                                </span>
                              )}
                            </CalendarDayAction>
                          );
                        }
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap justify-end gap-3 text-[0.65rem] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-primary" /> Completed
              </span>
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-amber-500" /> Abandoned
              </span>
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-emerald-500" /> Activity
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-7 border-b text-center text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground sm:text-xs">
              {weekdays.map((day) => (
                <div key={day} className="py-1.5">
                  {day}
                </div>
              ))}
            </div>
            <div
              className={cn(
                "grid grid-cols-7 overflow-hidden rounded-b-xl border-x border-b",
                view === "week" && "min-h-32"
              )}
            >
              {days.map((day) => {
                const key = dateKey(day);
                const dayRecords = groupedRecords.get(key) ?? [];
                const dayWorkouts = dayRecords.filter(
                  (record) => record.recordType === "workout"
                );
                const activityCount = dayRecords.length - dayWorkouts.length;
                const currentMonth = day.getMonth() === anchor.getMonth();
                const selected = key === chooserKey;
                const completedCount = dayWorkouts.filter(
                  (record) => record.status === "completed"
                ).length;
                const setCount = dayWorkouts.reduce(
                  (total, record) => total + record.sets,
                  0
                );
                return (
                  <CalendarDayAction
                    key={key}
                    day={day}
                    records={dayRecords}
                    range={range}
                    view={view}
                    selected={selected}
                    ownerToday={ownerToday}
                    focused={key === focusedKey}
                    onChoose={openChooser}
                    onNavigate={prepareDirectNavigation}
                    onFocus={setFocusedKey}
                    className={cn(
                      "relative min-h-16 border-r border-b p-1.5 text-left transition-colors last:border-r-0 sm:min-h-24 sm:p-2",
                      (dayRecords.length > 0 || key <= ownerToday) &&
                        "outline-none hover:bg-muted/55 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring",
                      dayRecords.length === 0 &&
                        key > ownerToday &&
                        "cursor-default",
                      !currentMonth &&
                        view === "month" &&
                        "bg-muted/20 text-muted-foreground/60",
                      selected &&
                        "z-10 bg-primary/8 ring-2 ring-inset ring-primary/60",
                      key === todayKey && !selected && "bg-accent/40"
                    )}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span
                        className={cn(
                          "flex size-5 items-center justify-center rounded-full text-[0.6875rem] tabular-nums sm:size-6 sm:text-xs",
                          key === todayKey &&
                            "bg-primary font-semibold text-primary-foreground"
                        )}
                      >
                        {day.getDate()}
                      </span>
                      {dayRecords.length > 0 && (
                        <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[0.5625rem] font-semibold text-primary sm:text-[0.625rem]">
                          {dayRecords.length}
                        </span>
                      )}
                    </div>
                    {dayRecords.length > 0 && (
                      <>
                        <div className="mt-1 flex gap-1 sm:hidden">
                          {dayRecords.map((record) => (
                            <span
                              key={record.id}
                              className={cn(
                                "size-1.5 rounded-full bg-primary",
                                record.recordType === "activity" &&
                                  "bg-emerald-500",
                                record.recordType === "workout" &&
                                  record.status === "abandoned" &&
                                  "bg-amber-500"
                              )}
                            />
                          ))}
                        </div>
                        <div className="mt-1 hidden space-y-1 sm:block">
                          {dayRecords
                            .slice(0, view === "week" ? 3 : 2)
                            .map((record) => (
                              <p
                                key={record.id}
                                className={cn(
                                  "truncate rounded bg-primary/10 px-1.5 py-1 text-[0.625rem] font-medium leading-tight text-primary",
                                  record.recordType === "activity" &&
                                    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                                  record.recordType === "workout" &&
                                    record.status === "abandoned" &&
                                    "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                )}
                              >
                                {shortRecordName(record.name)}
                              </p>
                            ))}
                          <p className="text-[0.5625rem] tabular-nums text-muted-foreground">
                            {completedCount > 0 && `${setCount} sets`}
                            {completedCount > 0 && activityCount > 0 && " · "}
                            {activityCount > 0 &&
                              `${activityCount} activit${activityCount === 1 ? "y" : "ies"}`}
                            {completedCount === 0 && activityCount === 0 &&
                              "not completed"}
                          </p>
                        </div>
                      </>
                    )}
                  </CalendarDayAction>
                );
              })}
            </div>
          </>
        )}

        <Dialog
          open={chooserKey !== null}
          onOpenChange={(open) => {
            if (!open) setChooserKey(null);
          }}
        >
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Choose a record</DialogTitle>
              <DialogDescription>
                {chooserKey ? fullDateLabel(dateFromKey(chooserKey)) : ""} · {" "}
                {chooserRecords.length} records
              </DialogDescription>
            </DialogHeader>
            <HistoryDayRecordList
              records={chooserRecords}
              range={range}
              view={view}
              date={chooserKey ?? dateKey(anchor)}
              unit={unit}
            />
            {chooserKey && chooserKey <= ownerToday && (
              <Button
                render={
                  <Link
                    href={
                      chooserKey === ownerToday
                        ? "/today"
                        : buildRetrospectiveWorkoutHref(chooserKey, {
                            range,
                            calendarView: view,
                            calendarDate: chooserKey,
                          })
                    }
                  />
                }
                nativeButton={false}
                size="touch"
                className="w-full whitespace-normal text-center leading-snug"
              >
                Record another workout
              </Button>
            )}
          </DialogContent>
        </Dialog>

      </CardContent>
    </Card>
  );
}
