import {
  localDateDifference,
  localDateToUtcDate,
  workoutLocalDate,
} from "@/lib/workout-calendar";

export function formatRelativeLocalDate(value: string, today: string): string {
  const days = localDateDifference(today, value);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return localDateToUtcDate(value).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

export function formatRelativeDay(
  date: Date,
  timezone: string,
  now = new Date()
): string {
  const value = workoutLocalDate(date, timezone);
  const today = workoutLocalDate(now, timezone);
  return formatRelativeLocalDate(value, today);
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function formatRecordedLocalDate(value: string): string {
  return localDateToUtcDate(value).toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function formatDuration(start: Date, end: Date): string {
  const min = Math.round((end.getTime() - start.getTime()) / 60000);
  return `${min} min`;
}
