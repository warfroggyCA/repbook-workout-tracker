import { z } from "zod";
import { isValidIanaTimezone, localDateToUtcDate, workoutLocalDate } from "@/lib/workout-calendar";
import { resolveRetrospectiveWallTime } from "@/lib/retrospective-workout";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime({ offset: true });

export const workoutTimingCorrectionSchema = z.object({
  sessionId: z.string().uuid(),
  clientMutationId: z.string().uuid(),
  expectedHistoryRevision: z.number().int().nonnegative(),
  reviewed: z.literal(true),
  expected: z.object({
    startedAtISO: instant,
    finishedAtISO: instant.nullable(),
    timezone: z.string().min(1).max(100),
    localDate,
    precision: z.enum(["instant", "date_only"]),
    excludeDurationFromAnalytics: z.boolean(),
  }),
  proposed: z.object({
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidIanaTimezone, "Choose a valid workout timezone."),
    localDate,
    timing: z.discriminatedUnion("precision", [
      z.object({ precision: z.literal("date_only") }),
      z.object({
        precision: z.literal("instant"),
        localStartTime: z
          .string()
          .regex(/^\d{2}:\d{2}(?::\d{2})?$/, "Choose a valid local start time."),
        ambiguityChoice: z.enum(["earlier", "later"]).nullable(),
        durationSeconds: z.number().int().min(0).max(604_800).nullable(),
      }),
    ]),
  }),
});

export type WorkoutTimingCorrectionInput = z.input<
  typeof workoutTimingCorrectionSchema
>;

export function normalizeWorkoutTimingCorrection(
  input: WorkoutTimingCorrectionInput,
  now = new Date(),
) {
  const parsed = workoutTimingCorrectionSchema.parse(input);
  const calendarDate = localDateToUtcDate(parsed.proposed.localDate);
  if (calendarDate.getTime() < Date.UTC(1900, 0, 1)) {
    throw new Error("Choose a workout date after 1900.");
  }
  const today = workoutLocalDate(now, parsed.proposed.timezone);
  if (parsed.proposed.localDate > today) {
    throw new Error("A completed workout cannot be moved to a future date.");
  }

  if (parsed.proposed.timing.precision === "date_only") {
    const anchor = resolveRetrospectiveWallTime({
      localDate: parsed.proposed.localDate,
      localTime: "12:00:00",
      timezone: parsed.proposed.timezone,
    });
    if (anchor.outcome !== "unique") {
      throw new Error("The date-only technical anchor could not be resolved.");
    }
    return {
      parsed,
      startedAt: anchor.instant,
      finishedAt: null,
      performedTimePrecision: "date_only" as const,
      excludeDurationFromAnalytics: true,
    };
  }

  const resolution = resolveRetrospectiveWallTime({
    localDate: parsed.proposed.localDate,
    localTime: parsed.proposed.timing.localStartTime,
    timezone: parsed.proposed.timezone,
  });
  if (resolution.outcome === "nonexistent") {
    throw new Error(
      `That local start time does not exist in ${parsed.proposed.timezone} because of daylight-saving time.`,
    );
  }
  if (
    resolution.outcome === "ambiguous" &&
    parsed.proposed.timing.ambiguityChoice == null
  ) {
    throw new Error(
      `That local start time occurs twice in ${parsed.proposed.timezone}; choose the earlier or later occurrence.`,
    );
  }
  const startedAt =
    resolution.outcome === "unique"
      ? resolution.instant
      : parsed.proposed.timing.ambiguityChoice === "later"
        ? resolution.later
        : resolution.earlier;
  if (startedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("A completed workout cannot start in the future.");
  }
  const finishedAt =
    parsed.proposed.timing.durationSeconds == null
      ? null
      : new Date(
          startedAt.getTime() +
            parsed.proposed.timing.durationSeconds * 1_000,
        );
  if (finishedAt && finishedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("A completed workout cannot finish in the future.");
  }
  return {
    parsed,
    startedAt,
    finishedAt,
    performedTimePrecision: "instant" as const,
    excludeDurationFromAnalytics: finishedAt == null,
  };
}
