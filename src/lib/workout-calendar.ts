import { activityDateKey } from "@/lib/activities";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function workoutLocalDate(startedAt: Date, timezone: string): string {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error("Choose a valid workout timezone.");
  }
  return activityDateKey(startedAt, timezone);
}

export function localDateToUtcDate(value: string): Date {
  if (!LOCAL_DATE.test(value)) throw new Error("Invalid local calendar date.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid local calendar date.");
  }
  return date;
}

export function localWeekStart(value: string): string {
  const date = localDateToUtcDate(value);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function addLocalDays(value: string, days: number): string {
  const date = localDateToUtcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function localDateDifference(later: string, earlier: string): number {
  return Math.floor(
    (localDateToUtcDate(later).getTime() - localDateToUtcDate(earlier).getTime()) /
      86_400_000
  );
}
