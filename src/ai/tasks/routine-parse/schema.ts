import { z } from "zod";
import { aiEnvelope } from "@/ai/envelope";

/**
 * Closed, versioned Program-input contract. Paste parsing produces a provider
 * draft first; the server then assigns every stable identity before the
 * envelope may be staged for review. The same final contract can later be
 * accepted from a structured external-assistant package without depending on
 * free-text interpretation.
 */
export const PROGRAM_INPUT_SCHEMA_VERSION = "program-input/1" as const;
// Program documents support at most 14 days. Keep intake aligned so an owner
// never completes a review for a package that publication cannot represent.
export const PROGRAM_INPUT_MAX_DAYS = 14;
export const PROGRAM_INPUT_MAX_EXERCISES_PER_DAY = 60;
export const PROGRAM_INPUT_MAX_WARMUP_ITEMS_PER_DAY = 24;

const requiredText = (max: number) =>
  z.string().min(1).max(max).refine((value) => value.trim().length > 0, {
    message: "Text cannot be blank.",
  });
const nullableText = (max: number) =>
  z.string().trim().min(1).max(max).nullable();

/** repsPerSet: explicit per-set counts ("8, 8, 6") or a range ("8-10"). */
export const repSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("perSet"),
      perSet: z
        .array(z.number().int().min(0).max(100))
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("range"),
      min: z.number().int().min(0).max(100),
      max: z.number().int().min(0).max(100),
    })
    .strict()
    .superRefine((range, context) => {
      if (range.max < range.min) {
        context.addIssue({
          code: "custom",
          path: ["max"],
          message: "Maximum repetitions must be at least minimum repetitions.",
        });
      }
    }),
]);

const warmupItemShape = {
  label: z.string().trim().min(1).max(120),
  reps: z.number().int().min(0).max(1000).nullable(),
  load: z.number().finite().min(0).max(100000).nullable(),
  loadUnit: z.enum(["lb", "kg"]).nullable(),
  loadPercent: z.number().finite().min(0).max(500).nullable(),
  loadText: nullableText(160),
  notes: nullableText(500),
};

function refineWarmupLoading(
  item: {
    load: number | null;
    loadUnit: "lb" | "kg" | null;
    loadPercent: number | null;
    loadText: string | null;
  },
  context: z.RefinementCtx,
) {
  if ((item.load == null) !== (item.loadUnit == null)) {
    context.addIssue({
      code: "custom",
      path: ["loadUnit"],
      message: "A measured warm-up load needs an explicit unit.",
    });
  }
  const loadingModes = [
    item.load != null,
    item.loadPercent != null,
    item.loadText != null,
  ].filter(Boolean).length;
  if (loadingModes > 1) {
    context.addIssue({
      code: "custom",
      path: ["load"],
      message:
        "Use only one warm-up loading method: a measured load, a percentage, or a written instruction.",
    });
  }
}

/** Provider-facing warm-up item. Stable keys are never accepted from a model. */
export const routineParseDraftWarmupItemSchema = z
  .object({
    sourceOrder: z.number().int().min(0),
    ...warmupItemShape,
  })
  .strict()
  .superRefine(refineWarmupLoading);

/** Final structured warm-up item, field-for-field compatible with Program v3. */
export const programInputWarmupItemSchema = z
  .object({
    key: z.string().uuid(),
    /** Null means day preparation; otherwise run before this Program slot. */
    beforeSlotLineageId: z.string().uuid().nullable(),
    ...warmupItemShape,
  })
  .strict()
  .superRefine(refineWarmupLoading);

const routineExerciseShape = {
  /** Verbatim from the input — normalization happens in exercise_map. */
  rawName: requiredText(240),
  sets: z.number().int().min(1).max(20).nullable(),
  reps: repSpecSchema.nullable(),
  load: z.number().finite().min(0).max(100000).nullable(),
  loadUnit: z.enum(["lb", "kg"]).nullable(),
  restSec: z.number().int().min(0).max(1800).nullable(),
  /**
   * Exercises sharing a key within a day are an authored pair/group. In group
   * order, non-final restSec values mean rest before the next member and the
   * final restSec means rest after the full round.
   */
  supersetKey: nullableText(80),
  notes: nullableText(2000),
};

function refineExerciseLoad(
  exercise: { load: number | null; loadUnit: "lb" | "kg" | null },
  context: z.RefinementCtx,
) {
  if (exercise.load == null && exercise.loadUnit != null) {
    context.addIssue({
      code: "custom",
      path: ["loadUnit"],
      message: "A load unit cannot be retained without a load value.",
    });
  }
}

export const routineParseDraftExerciseSchema = z
  .object({
    ...routineExerciseShape,
    /** Structurally owned lift ramps; normalization resolves the slot lineage. */
    rampUps: z.array(routineParseDraftWarmupItemSchema).max(12),
  })
  .strict()
  .superRefine(refineExerciseLoad);

export const programInputExerciseSchema = z
  .object({
    lineageId: z.string().uuid(),
    ...routineExerciseShape,
  })
  .strict()
  .superRefine(refineExerciseLoad);

const comparableInstruction = (value: string) =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-CA")
    .replace(/^warm[ -]?up\s*:\s*/u, "")
    .replace(/[\s.!]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

function refineNoDuplicatedWarmups(
  warmupItems: ReadonlyArray<{ label: string }>,
  exercises: ReadonlyArray<{ notes: string | null }>,
  context: z.RefinementCtx,
) {
  const warmupLabels = new Set(
    warmupItems.map((item) => comparableInstruction(item.label)),
  );
  for (const [exerciseIndex, exercise] of exercises.entries()) {
    if (!exercise.notes) continue;
    const fragments = exercise.notes
      .split(/[;\r\n]+/u)
      .map(comparableInstruction)
      .filter(Boolean);
    if (fragments.some((fragment) => warmupLabels.has(fragment))) {
      context.addIssue({
        code: "custom",
        path: ["exercises", exerciseIndex, "notes"],
        message:
          "A structured warm-up instruction cannot also be stored as an exercise note.",
      });
    }
  }
}

function refineDraftWarmupOrder(
  day: {
    warmupItems: ReadonlyArray<{ label: string; sourceOrder: number }>;
    exercises: ReadonlyArray<{
      notes: string | null;
      rampUps: ReadonlyArray<{ label: string; sourceOrder: number }>;
    }>;
  },
  context: z.RefinementCtx,
) {
  const items = [
    ...day.warmupItems,
    ...day.exercises.flatMap((exercise) => exercise.rampUps),
  ].sort((left, right) => left.sourceOrder - right.sourceOrder);
  for (const [index, item] of items.entries()) {
    if (item.sourceOrder !== index) {
      context.addIssue({
        code: "custom",
        path: ["warmupItems"],
        message:
          "Warm-up source order must be unique and contiguous from zero within a day.",
      });
      break;
    }
  }
  refineNoDuplicatedWarmups(items, day.exercises, context);
}

export const routineParseDraftDaySchema = z
  .object({
    name: requiredText(120),
    order: z.number().int().min(0),
    warmupItems: z
      .array(routineParseDraftWarmupItemSchema)
      .max(PROGRAM_INPUT_MAX_WARMUP_ITEMS_PER_DAY),
    exercises: z
      .array(routineParseDraftExerciseSchema)
      .min(1)
      .max(PROGRAM_INPUT_MAX_EXERCISES_PER_DAY),
  })
  .strict()
  .superRefine(refineDraftWarmupOrder);

export const programInputDaySchema = z
  .object({
    lineageId: z.string().uuid(),
    name: requiredText(120),
    order: z.number().int().min(0),
    warmupItems: z
      .array(programInputWarmupItemSchema)
      .max(PROGRAM_INPUT_MAX_WARMUP_ITEMS_PER_DAY),
    exercises: z
      .array(programInputExerciseSchema)
      .min(1)
      .max(PROGRAM_INPUT_MAX_EXERCISES_PER_DAY),
  })
  .strict()
  .superRefine((day, context) => {
    refineNoDuplicatedWarmups(day.warmupItems, day.exercises, context);
    const slotLineages = new Set(
      day.exercises.map((exercise) => exercise.lineageId),
    );
    for (const [index, item] of day.warmupItems.entries()) {
      if (
        item.beforeSlotLineageId != null &&
        !slotLineages.has(item.beforeSlotLineageId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["warmupItems", index, "beforeSlotLineageId"],
          message: "A lift ramp must refer to an exercise in the same day.",
        });
      }
    }
  });

function refineDayOrder(
  value: { days: ReadonlyArray<{ order: number }> },
  context: z.RefinementCtx,
) {
  for (const [index, day] of value.days.entries()) {
    if (day.order !== index) {
      context.addIssue({
        code: "custom",
        path: ["days", index, "order"],
        message: "Program days must keep contiguous source order from zero.",
      });
    }
  }
}

/** Strict provider output before trusted server-side identity assignment. */
export const routineParseDraftDataSchema = z
  .object({
    programName: requiredText(120).nullable(),
    days: z
      .array(routineParseDraftDaySchema)
      .min(1)
      .max(PROGRAM_INPUT_MAX_DAYS),
  })
  .strict()
  .superRefine(refineDayOrder);

/** Final normalized input that is safe to stage for explicit owner review. */
export const programInputV1Schema = z
  .object({
    schemaVersion: z.literal(PROGRAM_INPUT_SCHEMA_VERSION),
    programName: requiredText(120).nullable(),
    days: z.array(programInputDaySchema).min(1).max(PROGRAM_INPUT_MAX_DAYS),
  })
  .strict()
  .superRefine((value, context) => {
    refineDayOrder(value, context);
    const identities = new Set<string>();
    for (const [dayIndex, day] of value.days.entries()) {
      const entities = [
        { id: day.lineageId, path: ["days", dayIndex, "lineageId"] },
        ...day.warmupItems.map((item, itemIndex) => ({
          id: item.key,
          path: ["days", dayIndex, "warmupItems", itemIndex, "key"],
        })),
        ...day.exercises.map((exercise, exerciseIndex) => ({
          id: exercise.lineageId,
          path: ["days", dayIndex, "exercises", exerciseIndex, "lineageId"],
        })),
      ];
      for (const entity of entities) {
        if (identities.has(entity.id)) {
          context.addIssue({
            code: "custom",
            path: entity.path,
            message: "Program-input identities must be unique.",
          });
        }
        identities.add(entity.id);
      }
    }
  });

/** Existing stored envelope, now carrying the versioned normalized contract. */
export const routineParseData = programInputV1Schema;
export const routineParseSchema = aiEnvelope(routineParseData);
/** Provider envelope. Normalize this immediately; never stage it directly. */
export const routineParseDraftSchema = aiEnvelope(routineParseDraftDataSchema);

export type RepSpec = z.infer<typeof repSpecSchema>;
export type RoutineParseDraftWarmupItem = z.infer<
  typeof routineParseDraftWarmupItemSchema
>;
export type RoutineParseDraftExercise = z.infer<
  typeof routineParseDraftExerciseSchema
>;
export type RoutineParseDraftDay = z.infer<typeof routineParseDraftDaySchema>;
export type RoutineParseDraftData = z.infer<typeof routineParseDraftDataSchema>;
export type RoutineParseDraftResult = z.infer<typeof routineParseDraftSchema>;
export type ProgramInputWarmupItem = z.infer<
  typeof programInputWarmupItemSchema
>;
export type ProgramInputExercise = z.infer<typeof programInputExerciseSchema>;
export type ProgramInputDay = z.infer<typeof programInputDaySchema>;
export type ProgramInputV1 = z.infer<typeof programInputV1Schema>;
export type RoutineExercise = ProgramInputExercise;
export type RoutineDay = ProgramInputDay;
export type RoutineParseData = ProgramInputV1;
export type RoutineParseResult = z.infer<typeof routineParseSchema>;

/** True when current Program rows cannot preserve the authored set sequence. */
export function repSpecRequiresExactPerSetSupport(
  spec: RepSpec | null,
  sets: number | null,
) {
  return Boolean(
    spec?.kind === "perSet" &&
      (new Set(spec.perSet).size > 1 ||
        (sets !== null && sets !== spec.perSet.length)),
  );
}

export function programInputRequiresExactPerSetSupport(
  data: RoutineParseData,
) {
  return data.days.some((day) =>
    day.exercises.some((exercise) =>
      repSpecRequiresExactPerSetSupport(exercise.reps, exercise.sets),
    ),
  );
}
