import {
  MAX_ACTIVE_WORKOUT_DURATION_SECONDS,
  MAX_ANALYTICS_WORKOUT_DURATION_MINUTES,
} from "@/lib/workout-duration-quality";

export const ACTIVE_SESSION_STALE_AFTER_SECONDS =
  MAX_ANALYTICS_WORKOUT_DURATION_MINUTES * 60;
export const MAX_OWNER_REPORTED_ACTIVE_MINUTES =
  MAX_ACTIVE_WORKOUT_DURATION_SECONDS / 60;

export type OwnerReportedActiveMinutesValidation =
  | { status: "empty"; seconds: null; error: null }
  | { status: "valid"; seconds: number; error: null }
  | {
      status: "invalid";
      seconds: null;
      error: string;
      reason: "not_whole" | "out_of_range" | "exceeds_wall_clock";
    };

export type ActiveSessionTiming = {
  wallClockSeconds: number;
  wallClockLabel: string;
  reviewRequired: boolean;
  reason: "ordinary" | "stale" | "clock_skew";
};

export function formatWallClockDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0
      ? `${totalHours} hr ${minutes} min`
      : `${totalHours} hr`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0
    ? `${days} day${days === 1 ? "" : "s"} ${hours} hr`
    : `${days} day${days === 1 ? "" : "s"}`;
}

export function classifyActiveSessionTiming(
  startedAt: Date,
  now: Date,
): ActiveSessionTiming {
  const rawSeconds = Math.floor(
    (now.getTime() - startedAt.getTime()) / 1_000,
  );
  if (rawSeconds < 0) {
    return {
      wallClockSeconds: 0,
      wallClockLabel: "unavailable",
      reviewRequired: true,
      reason: "clock_skew",
    };
  }
  return {
    wallClockSeconds: rawSeconds,
    wallClockLabel: formatWallClockDuration(rawSeconds),
    reviewRequired: rawSeconds > ACTIVE_SESSION_STALE_AFTER_SECONDS,
    reason:
      rawSeconds > ACTIVE_SESSION_STALE_AFTER_SECONDS ? "stale" : "ordinary",
  };
}

export function parseOwnerReportedActiveSeconds(value: string): number | null {
  return validateOwnerReportedActiveMinutes(value).seconds;
}

export function validateOwnerReportedActiveMinutes(
  value: string,
  wallClockSeconds?: number,
): OwnerReportedActiveMinutesValidation {
  if (value.trim() === "") {
    return { status: "empty", seconds: null, error: null };
  }
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    return {
      status: "invalid",
      seconds: null,
      error: "Enter active time as a whole number of minutes.",
      reason: "not_whole",
    };
  }
  const minutes = Number(normalized);
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 0 ||
    minutes > MAX_OWNER_REPORTED_ACTIVE_MINUTES
  ) {
    return {
      status: "invalid",
      seconds: null,
      error: `Active time must be between 0 and ${MAX_OWNER_REPORTED_ACTIVE_MINUTES.toLocaleString("en-CA")} minutes.`,
      reason: "out_of_range",
    };
  }
  const seconds = minutes * 60;
  if (wallClockSeconds != null && seconds > wallClockSeconds) {
    return {
      status: "invalid",
      seconds: null,
      error: "Active time cannot exceed the recorded wall-clock time.",
      reason: "exceeds_wall_clock",
    };
  }
  return { status: "valid", seconds, error: null };
}
