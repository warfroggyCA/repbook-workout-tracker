import type { ProgramPresentation } from "@/lib/program-presentation";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import type { ExerciseAlternativeReason } from "@/lib/exercise-alternatives";
import { LEGACY_RETROSPECTIVE_SKIP_REASONS } from "@/lib/retrospective-workout";
import {
  incompleteSessionReasonSchema,
  type IncompleteSessionReason,
} from "@/lib/session-completion-semantics";
import { z } from "zod";

export const RETROSPECTIVE_DRAFT_VERSION = 2 as const;
export const RETROSPECTIVE_DRAFT_LOCAL_PREFIX =
  "workout-tracker:retrospective-workout:v2";
export const RETROSPECTIVE_LEGACY_DRAFT_LOCAL_PREFIX =
  "workout-tracker:retrospective-workout:v1";

type LegacyRetrospectiveSkipReason =
  (typeof LEGACY_RETROSPECTIVE_SKIP_REASONS)[number];

export type RetrospectiveOutcomeDraft =
  | {
      occurrenceId: string;
      outcome: "legacy_unrecorded";
    }
  | {
      occurrenceId: string;
      outcome: "skipped";
      skipReason: IncompleteSessionReason | null;
      legacySkipReason: LegacyRetrospectiveSkipReason | null;
      note: string;
    }
  | {
      occurrenceId: string;
      outcome: "completed";
      completedSetId: string;
      clientKey: string;
      weight: string;
      reps: string;
      distanceKm: string;
      durationSeconds: string;
      rpe: string;
      note: string;
      observedLocalTime: string;
      observedOffsetChoice: "earlier" | "later" | null;
    };

export type RetrospectiveExerciseDraft = {
  id: string;
  exerciseId: string;
  sourceTemplateExerciseId: string | null;
  plannedExerciseId: string | null;
  plannedExerciseName: string | null;
  plannedSetCount: number;
  substitutionReason: ExerciseAlternativeReason | null;
  name: string;
  metricType: string;
  outcomes: RetrospectiveOutcomeDraft[];
};

export type RetrospectiveWorkoutDraft = {
  version: typeof RETROSPECTIVE_DRAFT_VERSION;
  ownerId: string;
  requestId: string;
  sessionId: string;
  progressionJobId: string;
  localDate: string;
  timezone: string;
  timingPrecision: "date_only" | "instant";
  startLocalTime: string;
  startOffsetChoice: "earlier" | "later" | null;
  durationMinutes: string;
  linkKind: "unlinked" | "program_day";
  dayLineageId: string | null;
  exercises: RetrospectiveExerciseDraft[];
  sessionNote: string;
  recordAnotherWorkout: boolean;
  step: "facts" | "review";
};

type IdFactory = () => string;

const completedOutcomeDraftSchema = z.object({
  occurrenceId: z.string().uuid(),
  outcome: z.literal("completed"),
  completedSetId: z.string().uuid(),
  clientKey: z.string().uuid(),
  weight: z.string(),
  reps: z.string(),
  distanceKm: z.string(),
  durationSeconds: z.string(),
  rpe: z.string(),
  note: z.string(),
  observedLocalTime: z.string(),
  observedOffsetChoice: z.enum(["earlier", "later"]).nullable(),
});

const outcomeDraftSchema = z.discriminatedUnion("outcome", [
  z.object({
    occurrenceId: z.string().uuid(),
    outcome: z.literal("legacy_unrecorded"),
  }),
  z.object({
    occurrenceId: z.string().uuid(),
    outcome: z.literal("skipped"),
    skipReason: incompleteSessionReasonSchema.nullable(),
    legacySkipReason: z.enum(LEGACY_RETROSPECTIVE_SKIP_REASONS).nullable(),
    note: z.string(),
  }),
  completedOutcomeDraftSchema,
]);

const legacyOutcomeDraftSchema = z.discriminatedUnion("outcome", [
  z.object({
    occurrenceId: z.string().uuid(),
    outcome: z.literal("legacy_unrecorded"),
  }),
  z.object({
    occurrenceId: z.string().uuid(),
    outcome: z.literal("skipped"),
    skipReason: z.enum(LEGACY_RETROSPECTIVE_SKIP_REASONS),
    note: z.string(),
  }),
  completedOutcomeDraftSchema,
]);

const retrospectiveDraftSchema = z.object({
  version: z.literal(RETROSPECTIVE_DRAFT_VERSION),
  ownerId: z.string().min(1),
  requestId: z.string().uuid(),
  sessionId: z.string().uuid(),
  progressionJobId: z.string().uuid(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).max(100),
  timingPrecision: z.enum(["date_only", "instant"]),
  startLocalTime: z.string(),
  startOffsetChoice: z.enum(["earlier", "later"]).nullable(),
  durationMinutes: z.string(),
  linkKind: z.enum(["unlinked", "program_day"]),
  dayLineageId: z.string().uuid().nullable(),
  exercises: z.array(
    z.object({
      id: z.string().uuid(),
      exerciseId: z.string().uuid(),
      sourceTemplateExerciseId: z.string().uuid().nullable(),
      plannedExerciseId: z.string().uuid().nullable().default(null),
      plannedExerciseName: z.string().min(1).nullable().default(null),
      plannedSetCount: z.number().int().min(0).max(100).default(0),
      substitutionReason: z
        .enum(["variety", "equipment_busy", "discomfort", "other"])
        .nullable()
        .default(null),
      name: z.string().min(1),
      metricType: z.string().min(1),
      outcomes: z.array(outcomeDraftSchema).min(1).max(100),
    }),
  ).max(100),
  sessionNote: z.string().max(8_000),
  recordAnotherWorkout: z.boolean(),
  step: z.enum(["facts", "review"]),
});

const legacyRetrospectiveDraftSchema = retrospectiveDraftSchema.extend({
  version: z.literal(1),
  exercises: z.array(
    z.object({
      id: z.string().uuid(),
      exerciseId: z.string().uuid(),
      sourceTemplateExerciseId: z.string().uuid().nullable(),
      plannedExerciseId: z.string().uuid().nullable().default(null),
      plannedExerciseName: z.string().min(1).nullable().default(null),
      plannedSetCount: z.number().int().min(0).max(100).default(0),
      substitutionReason: z
        .enum(["variety", "equipment_busy", "discomfort", "other"])
        .nullable()
        .default(null),
      name: z.string().min(1),
      metricType: z.string().min(1),
      outcomes: z.array(legacyOutcomeDraftSchema).min(1).max(100),
    }),
  ).max(100),
});

function newCompletedOutcome(id: IdFactory): RetrospectiveOutcomeDraft {
  return {
    occurrenceId: id(),
    outcome: "completed",
    completedSetId: id(),
    clientKey: id(),
    weight: "",
    reps: "",
    distanceKm: "",
    durationSeconds: "",
    rpe: "",
    note: "",
    observedLocalTime: "",
    observedOffsetChoice: null,
  };
}

export function newUnknownOutcome(id: IdFactory): RetrospectiveOutcomeDraft {
  return {
    occurrenceId: id(),
    outcome: "legacy_unrecorded",
  };
}

export function initializeRetrospectiveDraft(input: {
  ownerId: string;
  localDate: string;
  timezone: string;
  id?: IdFactory;
}): RetrospectiveWorkoutDraft {
  const id = input.id ?? (() => crypto.randomUUID());
  return {
    version: RETROSPECTIVE_DRAFT_VERSION,
    ownerId: input.ownerId,
    requestId: id(),
    sessionId: id(),
    progressionJobId: id(),
    localDate: input.localDate,
    timezone: input.timezone,
    timingPrecision: "date_only",
    startLocalTime: "12:00",
    startOffsetChoice: null,
    durationMinutes: "",
    linkKind: "unlinked",
    dayLineageId: null,
    exercises: [],
    sessionNote: "",
    recordAnotherWorkout: false,
    step: "facts",
  };
}

export function retrospectiveDraftKey(ownerId: string, localDate: string) {
  return `${RETROSPECTIVE_DRAFT_LOCAL_PREFIX}:${ownerId}:${localDate}`;
}

export function retrospectiveLegacyDraftKey(
  ownerId: string,
  localDate: string,
) {
  return `${RETROSPECTIVE_LEGACY_DRAFT_LOCAL_PREFIX}:${ownerId}:${localDate}`;
}

export function draftExercisesForProgramDay(
  day: ProgramPresentation["days"][number],
  id: IdFactory = () => crypto.randomUUID(),
  metricTypeByExerciseId: ReadonlyMap<string, string> = new Map(),
): RetrospectiveExerciseDraft[] {
  return day.slots.map((slot) => ({
    id: id(),
    exerciseId: slot.exercise.id,
    sourceTemplateExerciseId: slot.id,
    plannedExerciseId: slot.exercise.id,
    plannedExerciseName: slot.exercise.name,
    plannedSetCount: slot.prescription?.sets ?? 0,
    substitutionReason: null,
    name: slot.exercise.name,
    metricType: metricTypeByExerciseId.get(slot.exercise.id) ?? "weight_reps",
    outcomes: Array.from(
      { length: slot.prescription?.sets ?? 0 },
      () => newUnknownOutcome(id),
    ),
  }));
}

export function draftExerciseFromLibrary(
  exercise: ExerciseDiscoveryItem,
  id: IdFactory = () => crypto.randomUUID(),
): RetrospectiveExerciseDraft {
  return {
    id: id(),
    exerciseId: exercise.id,
    sourceTemplateExerciseId: null,
    plannedExerciseId: null,
    plannedExerciseName: null,
    plannedSetCount: 0,
    substitutionReason: null,
    name: exercise.name,
    metricType: exercise.metricType,
    outcomes: [newCompletedOutcome(id)],
  };
}

export function changeDraftOutcome(
  current: RetrospectiveOutcomeDraft,
  outcome: RetrospectiveOutcomeDraft["outcome"],
  id: IdFactory = () => crypto.randomUUID(),
): RetrospectiveOutcomeDraft {
  if (current.outcome === outcome) return current;
  if (outcome === "legacy_unrecorded") {
    return { occurrenceId: current.occurrenceId, outcome };
  }
  if (outcome === "skipped") {
    return {
      occurrenceId: current.occurrenceId,
      outcome,
      skipReason: null,
      legacySkipReason: null,
      note: "",
    };
  }
  return {
    ...newCompletedOutcome(id),
    occurrenceId: current.occurrenceId,
  };
}

export function addCompletedDraftSet(
  exercise: RetrospectiveExerciseDraft,
  id: IdFactory = () => crypto.randomUUID(),
) {
  return {
    ...exercise,
    outcomes: [...exercise.outcomes, newCompletedOutcome(id)],
  };
}

export function selectPerformedDraftExercise(
  exercise: RetrospectiveExerciseDraft,
  performed: ExerciseDiscoveryItem,
): RetrospectiveExerciseDraft {
  const returnsToPlan = performed.id === exercise.plannedExerciseId;
  const acceptsWeight = ["weight_reps", "assisted_reps"].includes(
    performed.metricType,
  );
  return {
    ...exercise,
    exerciseId: performed.id,
    name: performed.name,
    metricType: performed.metricType,
    substitutionReason: returnsToPlan ? null : exercise.substitutionReason,
    outcomes: exercise.outcomes.map((outcome) =>
      outcome.outcome === "completed"
        ? {
            ...outcome,
            weight: acceptsWeight ? outcome.weight : "",
            distanceKm: "",
            durationSeconds: "",
          }
        : outcome,
    ),
  };
}

export function parseRetrospectiveDraft(
  raw: string | null,
  expected: { ownerId: string; localDate: string },
): RetrospectiveWorkoutDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const current = retrospectiveDraftSchema.safeParse(value);
    const legacy = current.success
      ? null
      : legacyRetrospectiveDraftSchema.safeParse(value);
    if (!current.success && (!legacy || !legacy.success)) return null;
    let parsed: RetrospectiveWorkoutDraft;
    if (current.success) {
      parsed = current.data;
    } else {
      if (!legacy?.success) return null;
      const legacyDraft = legacy.data;
      parsed = {
        ...legacyDraft,
        version: RETROSPECTIVE_DRAFT_VERSION,
        exercises: legacyDraft.exercises.map((exercise) => ({
          ...exercise,
          outcomes: exercise.outcomes.map((outcome) =>
            outcome.outcome === "skipped"
              ? {
                  occurrenceId: outcome.occurrenceId,
                  outcome: "skipped" as const,
                  skipReason: null,
                  legacySkipReason: outcome.skipReason,
                  note: outcome.note,
                }
              : outcome,
          ),
        })),
      };
    }
    if (
      parsed.ownerId !== expected.ownerId ||
      parsed.localDate !== expected.localDate
    ) {
      return null;
    }
    return {
      ...parsed,
      exercises: parsed.exercises.map((exercise) =>
        exercise.sourceTemplateExerciseId &&
        exercise.plannedExerciseId == null
          ? {
              ...exercise,
              plannedExerciseId: exercise.exerciseId,
              plannedExerciseName: exercise.name,
              plannedSetCount: exercise.outcomes.length,
            }
          : exercise,
      ),
    };
  } catch {
    return null;
  }
}
