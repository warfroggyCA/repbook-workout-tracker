import { z } from "zod";

const uuid = z.string().uuid();
const nullableUuid = uuid.nullable().optional();

export const contextualNoteInputModeSchema = z.enum([
  "typed",
  "reviewed_dictation",
]);

export const contextualNoteCapturedContextSchema = z.object({
  schemaVersion: z.literal(1),
  destination: z.enum([
    "today",
    "workout",
    "history",
    "review",
    "program",
    "settings",
    "recovery",
    "archive",
    "export",
    "other",
  ]),
  workflow: z.string().trim().min(1).max(120).nullable().default(null),
  workoutPhase: z.enum([
    "planning",
    "warmup",
    "working",
    "rest",
    "completed",
    "review",
  ]).nullable().default(null),
  originatedFromSimulation: z.boolean().default(false),
  programDay: z.object({
    programId: uuid,
    programVersionId: uuid,
    workoutTemplateId: uuid,
    name: z.string().trim().min(1).max(300),
    lineageId: uuid.nullable().optional(),
  }).strict().nullable().default(null),
  plannedExercise: z.object({
    id: uuid,
    name: z.string().trim().min(1).max(300),
  }).strict().nullable().default(null),
  performedExercise: z.object({
    id: uuid,
    name: z.string().trim().min(1).max(300),
  }).strict().nullable().default(null),
  occurrence: z.object({
    id: uuid,
    kind: z.enum(["day_warmup", "exercise_warmup", "working_set"]),
    ordinal: z.number().int().nonnegative(),
    outcome: z.enum([
      "pending",
      "completed",
      "skipped",
      "abandoned",
      "legacy_unrecorded",
    ]),
  }).strict().nullable().default(null),
  loadRepetitions: z.object({
    plannedLoad: z.number().finite().nullable().optional(),
    plannedLoadUnit: z.enum(["lb", "kg"]).nullable().optional(),
    plannedLoadPercent: z.number().finite().nullable().optional(),
    plannedLoadText: z.string().trim().max(200).nullable().optional(),
    plannedRepsMin: z.number().int().nonnegative().nullable().optional(),
    plannedRepsMax: z.number().int().nonnegative().nullable().optional(),
    performedLoad: z.number().finite().nullable().optional(),
    performedLoadUnit: z.enum(["lb", "kg"]).nullable().optional(),
    performedReps: z.number().int().nonnegative().nullable().optional(),
  }).strict().nullable().default(null),
  restContext: z.object({
    plannedSeconds: z.number().int().min(0).max(1_800).nullable(),
    remainingSeconds: z.number().int().min(0).max(86_400).nullable(),
    state: z.enum(["resting", "ready", "none"]),
  }).strict().nullable().default(null),
  reviewContext: z.object({
    kind: z.enum(["history_workout", "program", "program_day", "program_item"]),
    entityId: uuid,
    label: z.string().trim().min(1).max(300),
  }).strict().nullable().default(null),
}).strict().superRefine((context, issue) => {
  const load = context.loadRepetitions;
  if (!load) return;
  if ((load.plannedLoad == null) !== (load.plannedLoadUnit == null)) {
    issue.addIssue({
      code: "custom",
      path: ["loadRepetitions", "plannedLoadUnit"],
      message: "A planned load and unit must be captured together.",
    });
  }
  if ((load.performedLoad == null) !== (load.performedLoadUnit == null)) {
    issue.addIssue({
      code: "custom",
      path: ["loadRepetitions", "performedLoadUnit"],
      message: "A performed load and unit must be captured together.",
    });
  }
  if (
    load.plannedRepsMin != null &&
    load.plannedRepsMax != null &&
    load.plannedRepsMax < load.plannedRepsMin
  ) {
    issue.addIssue({
      code: "custom",
      path: ["loadRepetitions", "plannedRepsMax"],
      message: "The maximum planned repetitions cannot be below the minimum.",
    });
  }
});

const commonCreateFields = {
  clientKey: uuid,
  body: z.string().trim().min(1).max(5_000),
  coachVisible: z.boolean().default(true),
  inputMode: contextualNoteInputModeSchema,
  recordedAt: z.string().datetime({ offset: true }),
  capturedContext: contextualNoteCapturedContextSchema,
};

export const contextualNoteCreateInputSchema = z.discriminatedUnion(
  "attachmentKind",
  [
    z.object({ ...commonCreateFields, attachmentKind: z.literal("general") }).strict(),
    z.object({ ...commonCreateFields, attachmentKind: z.literal("workout"), sessionId: uuid }).strict(),
    z.object({ ...commonCreateFields, attachmentKind: z.literal("exercise"), sessionId: uuid, sessionExerciseId: uuid }).strict(),
    z.object({ ...commonCreateFields, attachmentKind: z.literal("occurrence"), sessionId: uuid, occurrenceId: uuid }).strict(),
    z.object({
      ...commonCreateFields,
      attachmentKind: z.literal("set"),
      sessionId: uuid,
      sessionExerciseId: uuid,
      occurrenceId: uuid,
      completedSetId: nullableUuid,
    }).strict(),
    z.object({
      ...commonCreateFields,
      attachmentKind: z.literal("rest"),
      sessionId: uuid,
      sessionExerciseId: uuid,
      occurrenceId: uuid,
      completedSetId: uuid,
    }).strict(),
    z.object({ ...commonCreateFields, attachmentKind: z.literal("program"), programId: uuid, programVersionId: uuid }).strict(),
    z.object({ ...commonCreateFields, attachmentKind: z.literal("program_day"), programId: uuid, programVersionId: uuid, workoutTemplateId: uuid }).strict(),
    z.object({
      ...commonCreateFields,
      attachmentKind: z.literal("program_item"),
      programId: uuid,
      programVersionId: uuid,
      workoutTemplateId: uuid,
      workoutTemplateExerciseId: uuid,
    }).strict(),
  ],
);

export const contextualNoteEditInputSchema = z.object({
  noteId: uuid,
  clientKey: uuid,
  expectedRevision: z.number().int().positive(),
  body: z.string().trim().min(1).max(5_000),
  coachVisible: z.boolean(),
  inputMode: contextualNoteInputModeSchema,
}).strict();

export type ContextualNoteCapturedContext = z.output<typeof contextualNoteCapturedContextSchema>;
export type ContextualNoteCreateInput = z.input<typeof contextualNoteCreateInputSchema>;
export type ParsedContextualNoteCreateInput = z.output<typeof contextualNoteCreateInputSchema>;
export type ContextualNoteEditInput = z.input<typeof contextualNoteEditInputSchema>;
export type ContextualNoteAttachmentKind = ParsedContextualNoteCreateInput["attachmentKind"];
export type ContextualNoteInputMode = z.infer<typeof contextualNoteInputModeSchema>;
