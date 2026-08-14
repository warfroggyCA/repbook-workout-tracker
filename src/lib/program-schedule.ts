import { z } from "zod";

export const PROGRAM_SCHEDULE_SCHEMA_VERSION = "program-schedule/1" as const;

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

type CivilDate = { year: number; month: number; day: number };

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseCivilDate(value: string): CivilDate | null {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }
  return { year, month, day };
}

// Proleptic Gregorian civil-date arithmetic. Schedule iteration never converts
// a local calendar date to an instant, so 23- and 25-hour DST days stay one day.
function civilDateOrdinal(value: string) {
  const parsed = parseCivilDate(value);
  if (!parsed) throw new Error("Invalid local calendar date: " + value);
  let year = parsed.year;
  const month = parsed.month;
  if (month <= 2) year -= 1;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear =
    Math.floor((153 * shiftedMonth + 2) / 5) + parsed.day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function localDateFromOrdinal(ordinal: number) {
  const shifted = ordinal + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra +
      Math.floor(yearOfEra / 4) -
      Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day =
    dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth + (shiftedMonth < 10 ? 3 : -9);
  if (month <= 2) year += 1;
  if (year < 1 || year > 9999) {
    throw new Error("Local calendar date is outside the supported range.");
  }
  return (
    String(year).padStart(4, "0") +
    "-" +
    String(month).padStart(2, "0") +
    "-" +
    String(day).padStart(2, "0")
  );
}

function addCalendarDays(value: string, days: number) {
  if (!Number.isSafeInteger(days)) {
    throw new Error("Calendar-day adjustment must be a safe integer.");
  }
  return localDateFromOrdinal(civilDateOrdinal(value) + days);
}

function calendarDayDifference(later: string, earlier: string) {
  return civilDateOrdinal(later) - civilDateOrdinal(earlier);
}

function isoWeekday(value: string) {
  const zeroBased = ((civilDateOrdinal(value) + 3) % 7 + 7) % 7;
  return zeroBased + 1;
}

const localDateSchema = z
  .string()
  .refine(
    (value) => parseCivilDate(value) !== null,
    "Use a valid YYYY-MM-DD local date.",
  );
const uuidSchema = z.string().uuid();

const resistanceEventSchema = z
  .object({
    id: uuidSchema,
    kind: z.literal("resistance"),
    routineLineageId: uuidSchema,
  })
  .strict();

const cardioEventSchema = z
  .object({
    id: uuidSchema,
    kind: z.literal("cardio"),
    modality: z.string().trim().min(1).max(120),
    durationMinutes: z
      .object({
        min: z.number().int().min(1).max(1_440),
        max: z.number().int().min(1).max(1_440),
      })
      .strict(),
    intensity: z.string().trim().min(1).max(160).optional(),
    notes: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.durationMinutes.min > event.durationMinutes.max) {
      context.addIssue({
        code: "custom",
        path: ["durationMinutes", "max"],
        message: "Cardio maximum duration must be at least its minimum.",
      });
    }
  });

const recoveryEventSchema = z
  .object({ id: uuidSchema, kind: z.literal("recovery") })
  .strict();
const restEventSchema = z
  .object({ id: uuidSchema, kind: z.literal("rest") })
  .strict();

export const programScheduleEventSchema = z.discriminatedUnion("kind", [
  resistanceEventSchema,
  cardioEventSchema,
  recoveryEventSchema,
  restEventSchema,
]);

export type ScheduledProgramEventIntentSnapshot = DeepReadonly<
  z.infer<typeof programScheduleEventSchema>
>;

const fixedScheduleSchema = z
  .object({
    kind: z.literal("fixed_7_day"),
    days: z
      .array(
        z
          .object({
            isoWeekday: z.number().int().min(1).max(7),
            event: programScheduleEventSchema,
          })
          .strict(),
      )
      .length(7),
  })
  .strict()
  .superRefine((schedule, context) => {
    schedule.days.forEach((day, index) => {
      if (day.isoWeekday !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["days", index, "isoWeekday"],
          message:
            "Fixed schedule weekdays must appear exactly once in ISO order 1 through 7.",
        });
      }
    });
  });

const rollingScheduleSchema = z
  .object({
    kind: z.literal("rolling"),
    lengthDays: z.number().int().min(1).max(365),
    days: z
      .array(
        z
          .object({
            position: z.number().int().min(1).max(365),
            event: programScheduleEventSchema,
          })
          .strict(),
      )
      .min(1)
      .max(365),
  })
  .strict()
  .superRefine((schedule, context) => {
    if (schedule.days.length !== schedule.lengthDays) {
      context.addIssue({
        code: "custom",
        path: ["days"],
        message: "Rolling schedule days must match lengthDays.",
      });
    }
    schedule.days.forEach((day, index) => {
      if (day.position !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["days", index, "position"],
          message: "Rolling positions must be contiguous and ordered from 1.",
        });
      }
    });
  });

const programWeekBoundarySchema = z
  .object({
    kind: z.literal("program_week_range"),
    startWeek: z.number().int().min(1).max(520),
    endWeek: z.number().int().min(1).max(520),
  })
  .strict()
  .superRefine((boundary, context) => {
    if (boundary.startWeek > boundary.endWeek) {
      context.addIssue({
        code: "custom",
        path: ["endWeek"],
        message: "Phase endWeek must be at least startWeek.",
      });
    }
  });

const localDateBoundarySchema = z
  .object({
    kind: z.literal("local_date_range"),
    startsOn: localDateSchema,
    endsOn: localDateSchema,
  })
  .strict()
  .superRefine((boundary, context) => {
    if (boundary.startsOn > boundary.endsOn) {
      context.addIssue({
        code: "custom",
        path: ["endsOn"],
        message: "Phase endsOn must be on or after startsOn.",
      });
    }
  });

const phaseBoundarySchema = z.discriminatedUnion("kind", [
  programWeekBoundarySchema,
  localDateBoundarySchema,
]);

const programSchedulePhaseSchema = z
  .object({
    id: uuidSchema,
    name: z.string().trim().min(1).max(120),
    order: z.number().int().min(1).max(100),
    notes: z.string().trim().min(1).max(500).optional(),
    boundary: phaseBoundarySchema,
    schedule: z.discriminatedUnion("kind", [
      fixedScheduleSchema,
      rollingScheduleSchema,
    ]),
  })
  .strict();

type PhaseBoundary = z.infer<typeof phaseBoundarySchema>;

function boundaryDateRange(programStartsOn: string, boundary: PhaseBoundary) {
  if (boundary.kind === "local_date_range") {
    return { startsOn: boundary.startsOn, endsOn: boundary.endsOn };
  }
  return {
    startsOn: addCalendarDays(
      programStartsOn,
      (boundary.startWeek - 1) * 7,
    ),
    endsOn: addCalendarDays(programStartsOn, boundary.endWeek * 7 - 1),
  };
}

const programScheduleDocumentValueSchema = z
  .object({
    schemaVersion: z.literal(PROGRAM_SCHEDULE_SCHEMA_VERSION),
    startsOn: localDateSchema,
    targetEndsOn: localDateSchema.optional(),
    phases: z.array(programSchedulePhaseSchema).min(1).max(100),
  })
  .strict()
  .superRefine((document, context) => {
    if (document.targetEndsOn && document.targetEndsOn < document.startsOn) {
      context.addIssue({
        code: "custom",
        path: ["targetEndsOn"],
        message: "targetEndsOn must be on or after startsOn.",
      });
    }

    const phaseIds = new Set<string>();
    const eventIds = new Set<string>();
    let previousEndsOn: string | null = null;

    document.phases.forEach((phase, phaseIndex) => {
      if (phase.order !== phaseIndex + 1) {
        context.addIssue({
          code: "custom",
          path: ["phases", phaseIndex, "order"],
          message: "Phase order must be contiguous and ordered from 1.",
        });
      }
      if (phaseIds.has(phase.id)) {
        context.addIssue({
          code: "custom",
          path: ["phases", phaseIndex, "id"],
          message: "Phase IDs must be unique.",
        });
      }
      phaseIds.add(phase.id);

      let range: { startsOn: string; endsOn: string } | null = null;
      try {
        range = boundaryDateRange(document.startsOn, phase.boundary);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["phases", phaseIndex, "boundary"],
          message: "Phase boundary is outside the supported local-date range.",
        });
      }
      if (range) {
        const expectedStartsOn = previousEndsOn
          ? addCalendarDays(previousEndsOn, 1)
          : document.startsOn;
        if (range.startsOn !== expectedStartsOn) {
          context.addIssue({
            code: "custom",
            path: ["phases", phaseIndex, "boundary"],
            message:
              phaseIndex === 0
                ? "The first phase must begin on the Program schedule start date."
                : "Phase boundaries must be contiguous with no gaps or overlaps.",
          });
        }
        if (document.targetEndsOn && range.endsOn > document.targetEndsOn) {
          context.addIssue({
            code: "custom",
            path: ["phases", phaseIndex, "boundary"],
            message: "A phase cannot end after targetEndsOn.",
          });
        }
        previousEndsOn = range.endsOn;
      }

      phase.schedule.days.forEach((day, dayIndex) => {
        if (eventIds.has(day.event.id)) {
          context.addIssue({
            code: "custom",
            path: [
              "phases",
              phaseIndex,
              "schedule",
              "days",
              dayIndex,
              "event",
              "id",
            ],
            message:
              "Event IDs must be unique within a Program schedule document.",
          });
        }
        eventIds.add(day.event.id);
      });
    });

    if (
      document.targetEndsOn &&
      previousEndsOn !== document.targetEndsOn
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetEndsOn"],
        message: "The final phase must end exactly on targetEndsOn.",
      });
    }
  });

export const programScheduleDocumentSchema =
  programScheduleDocumentValueSchema.transform((document) =>
    deepFreeze(document),
  );

export type ProgramScheduleDocumentInput = z.input<
  typeof programScheduleDocumentSchema
>;
export type ProgramScheduleDocument = z.output<
  typeof programScheduleDocumentSchema
>;

export function parseProgramScheduleDocument(
  input: unknown,
): ProgramScheduleDocument {
  return programScheduleDocumentSchema.parse(input);
}

type EventKind = z.infer<typeof programScheduleEventSchema>["kind"];
type ScheduleKind = "fixed_7_day" | "rolling";

type UnscheduledResolution = DeepReadonly<{
  state: "before_start" | "missing_phase" | "after_complete";
  phaseId: null;
  phaseName: null;
  eventId: null;
  eventKind: null;
  intentSnapshot: null;
  routineLineageId: null;
  plannedLocalDate: string;
  nominalProgramWeek: number | null;
  cyclePosition: null;
  scheduleKind: null;
}>;

export type ProgramScheduleOccurrence = DeepReadonly<{
  state: "scheduled";
  phaseId: string;
  phaseName: string;
  eventId: string;
  eventKind: EventKind;
  intentSnapshot: ScheduledProgramEventIntentSnapshot;
  routineLineageId: string | null;
  plannedLocalDate: string;
  nominalProgramWeek: number;
  cyclePosition: number;
  scheduleKind: ScheduleKind;
}>;

export type ProgramScheduleDayResolution =
  | ProgramScheduleOccurrence
  | UnscheduledResolution;

function nominalProgramWeek(document: ProgramScheduleDocument, value: string) {
  const days = calendarDayDifference(value, document.startsOn);
  return days < 0 ? null : Math.floor(days / 7) + 1;
}

export function programScheduleCompletionDate(
  document: ProgramScheduleDocument,
): string {
  if (document.targetEndsOn) return document.targetEndsOn;
  return boundaryDateRange(
    document.startsOn,
    document.phases[document.phases.length - 1].boundary,
  ).endsOn;
}

function unresolved(
  state: UnscheduledResolution["state"],
  plannedLocalDate: string,
  week: number | null,
): UnscheduledResolution {
  return deepFreeze({
    state,
    phaseId: null,
    phaseName: null,
    eventId: null,
    eventKind: null,
    intentSnapshot: null,
    routineLineageId: null,
    plannedLocalDate,
    nominalProgramWeek: week,
    cyclePosition: null,
    scheduleKind: null,
  });
}

export function resolveProgramScheduleDay(
  document: ProgramScheduleDocument,
  plannedLocalDate: string,
): ProgramScheduleDayResolution {
  localDateSchema.parse(plannedLocalDate);
  const week = nominalProgramWeek(document, plannedLocalDate);
  if (plannedLocalDate < document.startsOn) {
    return unresolved("before_start", plannedLocalDate, null);
  }
  if (plannedLocalDate > programScheduleCompletionDate(document)) {
    return unresolved("after_complete", plannedLocalDate, week);
  }

  const activePhase = document.phases.find((phase) => {
    const range = boundaryDateRange(document.startsOn, phase.boundary);
    return plannedLocalDate >= range.startsOn && plannedLocalDate <= range.endsOn;
  });
  if (!activePhase) return unresolved("missing_phase", plannedLocalDate, week);

  const phaseRange = boundaryDateRange(document.startsOn, activePhase.boundary);
  const cyclePosition =
    activePhase.schedule.kind === "fixed_7_day"
      ? isoWeekday(plannedLocalDate)
      : (calendarDayDifference(plannedLocalDate, phaseRange.startsOn) %
          activePhase.schedule.lengthDays) +
        1;
  const event = activePhase.schedule.days[cyclePosition - 1].event;

  return deepFreeze({
    state: "scheduled",
    phaseId: activePhase.id,
    phaseName: activePhase.name,
    eventId: event.id,
    eventKind: event.kind,
    intentSnapshot: event,
    routineLineageId:
      event.kind === "resistance" ? event.routineLineageId : null,
    plannedLocalDate,
    nominalProgramWeek: week as number,
    cyclePosition,
    scheduleKind: activePhase.schedule.kind,
  });
}

export function materializeProgramScheduleWindow(
  document: ProgramScheduleDocument,
  window: Readonly<{ startsOn: string; endsOn: string }>,
): readonly ProgramScheduleDayResolution[] {
  localDateSchema.parse(window.startsOn);
  localDateSchema.parse(window.endsOn);
  const dayCount = calendarDayDifference(window.endsOn, window.startsOn);
  if (dayCount < 0) {
    throw new Error("Schedule window endsOn must be on or after startsOn.");
  }
  return deepFreeze(
    Array.from({ length: dayCount + 1 }, (_, offset) =>
      resolveProgramScheduleDay(
        document,
        addCalendarDays(window.startsOn, offset),
      ),
    ),
  );
}

const occurrenceSelectorSchema = z
  .object({
    eventId: uuidSchema,
    plannedLocalDate: localDateSchema,
  })
  .strict();

export const programScheduleAdjustmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("shift_rolling"),
      selected: occurrenceSelectorSchema,
      days: z.number().int().min(1).max(3_650),
    })
    .strict(),
  z
    .object({
      kind: z.literal("skip"),
      selected: occurrenceSelectorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("manual_reschedule"),
      selected: occurrenceSelectorSchema,
      toLocalDate: localDateSchema,
    })
    .strict(),
]);

export type ProgramScheduleAdjustment = z.infer<
  typeof programScheduleAdjustmentSchema
>;

export type AdjustedProgramScheduleOccurrence = DeepReadonly<
  ProgramScheduleOccurrence & {
    attendance: "planned" | "skipped";
    scheduledLocalDate: string;
    timingAdjustments: readonly ("rolling_shift" | "manual_reschedule")[];
  }
>;

export type ProgramScheduleAdjustmentResult =
  | DeepReadonly<{
      status: "applied";
      occurrences: readonly AdjustedProgramScheduleOccurrence[];
    }>
  | DeepReadonly<{
      status: "rejected";
      reason:
        | "invalid_adjustment"
        | "occurrence_not_found"
        | "not_rolling_occurrence"
        | "occurrence_already_skipped"
        | "no_date_change"
        | "same_day_resistance_collision";
      adjustmentIndex: number;
    }>;

function hasResistanceCollision(
  occurrences: readonly AdjustedProgramScheduleOccurrence[],
) {
  const occupiedDates = new Set<string>();
  for (const occurrence of occurrences) {
    if (
      occurrence.attendance === "skipped" ||
      occurrence.eventKind !== "resistance"
    ) {
      continue;
    }
    if (occupiedDates.has(occurrence.scheduledLocalDate)) return true;
    occupiedDates.add(occurrence.scheduledLocalDate);
  }
  return false;
}

function selectorMatches(
  occurrence: AdjustedProgramScheduleOccurrence,
  selected: z.infer<typeof occurrenceSelectorSchema>,
) {
  return (
    occurrence.eventId === selected.eventId &&
    occurrence.plannedLocalDate === selected.plannedLocalDate
  );
}

export function applyProgramScheduleAdjustments(
  materialized: readonly ProgramScheduleDayResolution[],
  adjustments: readonly unknown[],
): ProgramScheduleAdjustmentResult {
  const original = materialized
    .filter(
      (resolution): resolution is ProgramScheduleOccurrence =>
        resolution.state === "scheduled",
    )
    .map((occurrence) => ({
      ...occurrence,
      attendance: "planned" as const,
      scheduledLocalDate: occurrence.plannedLocalDate,
      timingAdjustments: [] as ("rolling_shift" | "manual_reschedule")[],
    }));
  let current: AdjustedProgramScheduleOccurrence[] = original;

  for (
    let adjustmentIndex = 0;
    adjustmentIndex < adjustments.length;
    adjustmentIndex += 1
  ) {
    const parsed = programScheduleAdjustmentSchema.safeParse(
      adjustments[adjustmentIndex],
    );
    if (!parsed.success) {
      return deepFreeze({
        status: "rejected",
        reason: "invalid_adjustment",
        adjustmentIndex,
      });
    }
    const adjustment = parsed.data;
    const selectedIndex = current.findIndex((occurrence) =>
      selectorMatches(occurrence, adjustment.selected),
    );
    if (selectedIndex < 0) {
      return deepFreeze({
        status: "rejected",
        reason: "occurrence_not_found",
        adjustmentIndex,
      });
    }
    const selected = current[selectedIndex];
    if (
      selected.attendance === "skipped" &&
      adjustment.kind !== "skip"
    ) {
      return deepFreeze({
        status: "rejected",
        reason: "occurrence_already_skipped",
        adjustmentIndex,
      });
    }

    if (adjustment.kind === "skip") {
      current = current.map((occurrence, index) =>
        index === selectedIndex
          ? { ...occurrence, attendance: "skipped" as const }
          : occurrence,
      );
      continue;
    }

    if (adjustment.kind === "shift_rolling") {
      if (selected.scheduleKind !== "rolling") {
        return deepFreeze({
          status: "rejected",
          reason: "not_rolling_occurrence",
          adjustmentIndex,
        });
      }
      current = current.map((occurrence) =>
        occurrence.phaseId === selected.phaseId &&
        occurrence.plannedLocalDate >= selected.plannedLocalDate
          ? {
              ...occurrence,
              scheduledLocalDate: addCalendarDays(
                occurrence.scheduledLocalDate,
                adjustment.days,
              ),
              timingAdjustments: [
                ...occurrence.timingAdjustments,
                "rolling_shift" as const,
              ],
            }
          : occurrence,
      );
    } else {
      if (selected.scheduledLocalDate === adjustment.toLocalDate) {
        return deepFreeze({
          status: "rejected",
          reason: "no_date_change",
          adjustmentIndex,
        });
      }
      current = current.map((occurrence, index) =>
        index === selectedIndex
          ? {
              ...occurrence,
              scheduledLocalDate: adjustment.toLocalDate,
              timingAdjustments: [
                ...occurrence.timingAdjustments,
                "manual_reschedule" as const,
              ],
            }
          : occurrence,
      );
    }

    if (hasResistanceCollision(current)) {
      return deepFreeze({
        status: "rejected",
        reason: "same_day_resistance_collision",
        adjustmentIndex,
      });
    }
  }

  return deepFreeze({ status: "applied", occurrences: current });
}
