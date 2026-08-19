export const ACTIVITY_TYPES = [
  { id: "walk", label: "Walk" },
  { id: "hike", label: "Hike" },
  { id: "run", label: "Run" },
  { id: "cycling", label: "Cycling" },
  { id: "swimming", label: "Swimming" },
  { id: "rowing", label: "Rowing" },
  { id: "elliptical", label: "Elliptical" },
  { id: "stair_climber", label: "Stair climber" },
  { id: "yoga", label: "Yoga" },
  { id: "mobility", label: "Mobility" },
  { id: "sports", label: "Sport" },
  { id: "other", label: "Other activity" },
] as const;

export const ACTIVITY_INTENSITIES = [
  { id: "light", label: "Light" },
  { id: "moderate", label: "Moderate" },
  { id: "vigorous", label: "Vigorous" },
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number]["id"];
export type ActivityIntensity = (typeof ACTIVITY_INTENSITIES)[number]["id"];
export type DistanceUnit = "km" | "mi";
export type ElevationUnit = "m" | "ft";
export const MAX_ACTIVITY_DURATION_SECONDS = 7 * 24 * 60 * 60;

type ActivityInputBase = {
  activityType: ActivityType;
  title: string | null;
  startedAtISO: string;
  timezone: string;
  distanceValue: number | null;
  distanceUnit: DistanceUnit;
  intensity: ActivityIntensity | null;
  elevationValue: number | null;
  elevationUnit: ElevationUnit;
  averageHeartRateBpm: number | null;
  energyKcal: number | null;
  notes: string | null;
};

export type ActivityInput = ActivityInputBase & (
  | {
      durationSeconds: number;
      durationMinutes?: never;
    }
  | {
      /** Legacy whole-minute input retained for cached clients. */
      durationSeconds?: never;
      durationMinutes: number;
    }
);

export function activityTypeLabel(value: string) {
  return ACTIVITY_TYPES.find((option) => option.id === value)?.label ?? value;
}

export function activityIntensityLabel(value: string | null) {
  if (!value) return null;
  return (
    ACTIVITY_INTENSITIES.find((option) => option.id === value)?.label ?? value
  );
}

export function formatActivityDuration(seconds: number) {
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hr`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (remainingSeconds > 0 || parts.length === 0) {
    parts.push(`${remainingSeconds} sec`);
  }
  return parts.join(" ");
}

export function formatActivityDurationInput(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0
    ? String(minutes)
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function parseActivityDurationInput(value: string) {
  const match = /^(\d{1,5})(?::([0-5]\d))?$/u.exec(value.trim());
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2] ?? "0");
  return seconds >= 1 && seconds <= MAX_ACTIVITY_DURATION_SECONDS
    ? seconds
    : null;
}

export function formatActivityDistance(distanceKm: number) {
  return `${distanceKm < 10 ? distanceKm.toFixed(2) : distanceKm.toFixed(1)} km`;
}

export function formatActivityPace(secondsPerKm: number) {
  const rounded = Math.round(secondsPerKm);
  const minutes = Math.floor(rounded / 60);
  const seconds = String(rounded % 60).padStart(2, "0");
  return `${minutes}:${seconds} /km`;
}

export function activityUsesSpeed(activityType: string) {
  return activityType === "cycling" || activityType === "elliptical";
}

export function formatActivitySpeed(secondsPerKm: number) {
  return `${(3600 / secondsPerKm).toFixed(1)} km/h`;
}

function dateTimePartsInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: "year" | "month" | "day" | "hour" | "minute") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

export function activityDateKey(date: Date, timeZone: string) {
  const { year, month, day } = dateTimePartsInZone(date, timeZone);
  return `${year}-${month}-${day}`;
}

export function formatDateTimeLocalInZone(date: Date, timeZone: string) {
  const { year, month, day, hour, minute } = dateTimePartsInZone(
    date,
    timeZone
  );
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function dateTimeLocalInZoneToDate(value: string, timeZone: string) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const desiredWallTime = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute)
  );
  let instant = desiredWallTime;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = dateTimePartsInZone(new Date(instant), timeZone);
    const observedWallTime = Date.UTC(
      Number(observed.year),
      Number(observed.month) - 1,
      Number(observed.day),
      Number(observed.hour),
      Number(observed.minute)
    );
    instant += desiredWallTime - observedWallTime;
  }

  const result = new Date(instant);
  return formatDateTimeLocalInZone(result, timeZone) === value ? result : null;
}
