import { MAX_ANALYTICS_WORKOUT_DURATION_MINUTES } from "@/lib/workout-duration-quality";

export const ACTIVE_SESSION_STALE_AFTER_SECONDS =
  MAX_ANALYTICS_WORKOUT_DURATION_MINUTES * 60;

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
