import { z } from "zod";
import {
  isValidIanaTimezone,
  localDateToUtcDate,
  workoutLocalDate,
} from "@/lib/workout-calendar";
import {
  incompleteSessionReasonSchema,
  OCCURRENCE_RESOLUTION_SEMANTICS_VERSION,
} from "@/lib/session-completion-semantics";
import { SUBSTITUTION_REASONS } from "@/lib/exercise-alternatives";

const uuid = z.string().uuid();
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullableText = (limit: number) =>
  z.string().trim().max(limit).nullable().default(null);

const completedSetSchema = z.object({
  id: uuid,
  clientKey: uuid,
  setNo: z.number().int().min(1).max(100),
  weight: z.number().finite().nonnegative().max(100_000).nullable(),
  weightUnit: z.enum(["lb", "kg"]).nullable(),
  reps: z.number().int().min(0).max(10_000).nullable(),
  distanceKm: z.number().finite().nonnegative().max(10_000).nullable().default(null),
  durationSeconds: z.number().int().min(0).max(604_800).nullable().default(null),
  rpe: z.number().min(0).max(10).nullable().default(null),
  targetMet: z.boolean().nullable().default(null),
  restTakenSec: z.number().int().min(0).max(86_400).nullable().default(null),
  note: nullableText(4_000),
  observedCompletedAtISO: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .default(null),
});

export const LEGACY_RETROSPECTIVE_SKIP_REASONS = [
  "time",
  "pain",
  "fatigue",
  "equipment",
  "other",
] as const;

const legacyRetrospectiveSkipReasonSchema = z.enum(
  LEGACY_RETROSPECTIVE_SKIP_REASONS,
);

const outcomeSchema = z.union([
  z.object({
    occurrenceId: uuid,
    ordinal: z.number().int().min(0).max(999),
    outcome: z.literal("completed"),
    completedSet: completedSetSchema,
  }),
  z.object({
    occurrenceId: uuid,
    ordinal: z.number().int().min(0).max(999),
    outcome: z.literal("skipped"),
    resolutionSemanticsVersion: z.literal(
      OCCURRENCE_RESOLUTION_SEMANTICS_VERSION,
    ),
    reasonCode: incompleteSessionReasonSchema,
    note: nullableText(4_000),
  }),
  // Pre-taxonomy requests remain valid inputs for retry/backward compatibility.
  // Their free-text category is retained as legacy evidence and is never mapped
  // into a current canonical reason without a fresh owner choice.
  z.object({
    occurrenceId: uuid,
    ordinal: z.number().int().min(0).max(999),
    outcome: z.literal("skipped"),
    reason: legacyRetrospectiveSkipReasonSchema,
    note: nullableText(4_000),
  }),
  z.object({
    occurrenceId: uuid,
    ordinal: z.number().int().min(0).max(999),
    outcome: z.literal("legacy_unrecorded"),
  }),
]);

const exerciseSchema = z.object({
  id: uuid,
  exerciseId: uuid,
  sourceTemplateExerciseId: uuid.nullable(),
  substitutionReason: z
    .enum(SUBSTITUTION_REASONS)
    .nullable()
    .default(null),
  outcomes: z.array(outcomeSchema).min(1).max(100),
});

const timingSchema = z.discriminatedUnion("precision", [
  z.object({
    precision: z.literal("date_only"),
  }),
  z.object({
    precision: z.literal("instant"),
    startedAtISO: z.string().datetime({ offset: true }),
    finishedAtISO: z.string().datetime({ offset: true }).nullable(),
  }),
]);

const linkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unlinked") }),
  z.object({
    kind: z.literal("program_day"),
    programId: uuid,
    programVersionId: uuid,
    templateId: uuid,
    dayLineageId: uuid,
  }),
]);

export const retrospectiveWorkoutSchema = z.object({
  requestId: uuid,
  sessionId: uuid,
  progressionJobId: uuid,
  localDate,
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(isValidIanaTimezone, "Choose a valid workout timezone."),
  timing: timingSchema,
  link: linkSchema,
  exercises: z.array(exerciseSchema).min(1).max(100),
  sessionNote: nullableText(8_000),
  recordAnotherWorkout: z.boolean().default(false),
});

export type RetrospectiveWorkoutInput = z.input<
  typeof retrospectiveWorkoutSchema
>;
export type RetrospectiveWorkout = z.output<typeof retrospectiveWorkoutSchema>;

export type RetrospectiveWallTimeResolution =
  | { outcome: "nonexistent" }
  | { outcome: "unique"; instant: Date }
  | { outcome: "ambiguous"; earlier: Date; later: Date };

function wallParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/**
 * Resolve a reviewed local wall time without guessing across DST transitions.
 * The bounded scan covers every IANA UTC offset and both sides of an offset
 * transition while retaining exact second precision.
 */
export function resolveRetrospectiveWallTime(input: {
  localDate: string;
  localTime: string;
  timezone: string;
}): RetrospectiveWallTimeResolution {
  localDateToUtcDate(input.localDate);
  if (!isValidIanaTimezone(input.timezone)) {
    throw new Error("Choose a valid workout timezone.");
  }
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input.localTime);
  if (!match) throw new Error("Choose a valid local time.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error("Choose a valid local time.");
  }
  const naive = Date.parse(`${input.localDate}T${match[1]}:${match[2]}:${String(second).padStart(2, "0")}.000Z`);
  const wanted = {
    year: input.localDate.slice(0, 4),
    month: input.localDate.slice(5, 7),
    day: input.localDate.slice(8, 10),
    hour: match[1],
    minute: match[2],
    second: String(second).padStart(2, "0"),
  };
  const matches: Date[] = [];
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = new Date(naive - offsetMinutes * 60_000);
    const parts = wallParts(candidate, input.timezone);
    if (
      parts.year === wanted.year &&
      parts.month === wanted.month &&
      parts.day === wanted.day &&
      parts.hour === wanted.hour &&
      parts.minute === wanted.minute &&
      parts.second === wanted.second
    ) {
      matches.push(candidate);
    }
  }
  const unique = [...new Map(matches.map((date) => [date.getTime(), date])).values()]
    .sort((left, right) => left.getTime() - right.getTime());
  if (unique.length === 0) return { outcome: "nonexistent" };
  if (unique.length === 1) return { outcome: "unique", instant: unique[0] };
  return { outcome: "ambiguous", earlier: unique[0], later: unique.at(-1)! };
}

export function normalizeRetrospectiveWorkout(
  input: RetrospectiveWorkoutInput,
  now = new Date(),
) {
  const parsed = retrospectiveWorkoutSchema.parse(input);
  const localCalendarDate = localDateToUtcDate(parsed.localDate);
  if (localCalendarDate.getTime() < Date.UTC(1900, 0, 1)) {
    throw new Error("Choose a workout date after 1900.");
  }
  const today = workoutLocalDate(now, parsed.timezone);
  if (parsed.localDate >= today) {
    throw new Error("Retrospective workouts must use a past local date.");
  }

  const startedAt =
    parsed.timing.precision === "date_only"
      ? resolveRetrospectiveWallTime({
          localDate: parsed.localDate,
          localTime: "12:00:00",
          timezone: parsed.timezone,
        })
      : { outcome: "unique" as const, instant: new Date(parsed.timing.startedAtISO) };
  if (startedAt.outcome !== "unique") {
    throw new Error("The date-only technical anchor could not be resolved.");
  }
  if (workoutLocalDate(startedAt.instant, parsed.timezone) !== parsed.localDate) {
    throw new Error("The workout time does not match its local calendar date.");
  }
  if (startedAt.instant.getTime() < Date.UTC(1900, 0, 1)) {
    throw new Error("Choose a workout date after 1900.");
  }
  if (startedAt.instant.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("Retrospective workouts cannot start in the future.");
  }
  const finishedAt =
    parsed.timing.precision === "instant" && parsed.timing.finishedAtISO
      ? new Date(parsed.timing.finishedAtISO)
      : null;
  if (finishedAt && finishedAt.getTime() < startedAt.instant.getTime()) {
    throw new Error("Workout finish time cannot be before its start.");
  }
  if (finishedAt && finishedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("Retrospective workouts cannot finish in the future.");
  }

  const ids = new Set<string>();
  const clientKeys = new Set<string>();
  for (const value of [parsed.sessionId, parsed.progressionJobId]) ids.add(value);
  for (const exercise of parsed.exercises) {
    if (ids.has(exercise.id)) throw new Error("Child identities must be unique.");
    ids.add(exercise.id);
    if (parsed.link.kind === "unlinked" && exercise.sourceTemplateExerciseId) {
      throw new Error("An unlinked workout cannot carry Program slot identity.");
    }
    if (parsed.link.kind === "unlinked" && exercise.substitutionReason) {
      throw new Error("An unlinked workout cannot carry substitution evidence.");
    }
    const ordinals = new Set<number>();
    for (const outcome of exercise.outcomes) {
      if (ordinals.has(outcome.ordinal)) {
        throw new Error("Set order must be unique within an exercise.");
      }
      ordinals.add(outcome.ordinal);
      if (ids.has(outcome.occurrenceId)) {
        throw new Error("Child identities must be unique.");
      }
      ids.add(outcome.occurrenceId);
      if (outcome.outcome === "completed") {
        const set = outcome.completedSet;
        if (ids.has(set.id)) throw new Error("Child identities must be unique.");
        ids.add(set.id);
        if (clientKeys.has(set.clientKey)) {
          throw new Error("Set retry identities must be unique.");
        }
        clientKeys.add(set.clientKey);
        if ((set.weight == null) !== (set.weightUnit == null)) {
          throw new Error("Load and load unit must be supplied together.");
        }
        if (set.setNo !== outcome.ordinal + 1) {
          throw new Error("Set numbers must match reviewed set order.");
        }
        if (set.observedCompletedAtISO) {
          const observed = new Date(set.observedCompletedAtISO);
          if (workoutLocalDate(observed, parsed.timezone) !== parsed.localDate) {
            throw new Error(
              "Observed set completion must use the workout's local calendar date.",
            );
          }
          if (
            parsed.timing.precision === "instant" &&
            (observed.getTime() < startedAt.instant.getTime() ||
              (finishedAt && observed.getTime() > finishedAt.getTime()))
          ) {
            throw new Error(
              "Observed set completion must fall within the reviewed workout time.",
            );
          }
          if (observed.getTime() > now.getTime() + 5 * 60_000) {
            throw new Error("Observed set completion cannot be in the future.");
          }
        }
      }
    }
    if (
      [...ordinals].sort((left, right) => left - right)
        .some((ordinal, index) => ordinal !== index)
    ) {
      throw new Error("Set order must be contiguous within an exercise.");
    }
  }
  if (
    !parsed.exercises.some((exercise) =>
      exercise.outcomes.some(
        (outcome) => outcome.outcome !== "legacy_unrecorded",
      ),
    )
  ) {
    throw new Error(
      "Record at least one completed or intentionally skipped set before saving.",
    );
  }
  return {
    parsed,
    startedAt: startedAt.instant,
    finishedAt,
    performedTimePrecision: parsed.timing.precision,
    excludeDurationFromAnalytics:
      parsed.timing.precision === "date_only" || finishedAt == null,
  };
}
