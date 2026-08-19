import { z } from "zod";
import { aiEnvelope } from "@/ai/envelope";
import { incompleteSessionReasonSchema } from "@/lib/session-completion-semantics";

/** Plan §13 contract 5/6 — text & voice-transcript workout log parsing. */

export const QUICK_LOG_PARSE_SEMANTICS_VERSION = 2 as const;

const setEntrySchema = z.object({
  kind: z.literal("sets"),
  rawExercise: z.string(),
  sets: z.array(
    z
      .object({
        weight: z.number().nullable(),
        weightUnit: z.enum(["lb", "kg"]).nullable(),
        reps: z.number().int().min(0).max(100),
        rpeHint: z.enum(["easy", "ok", "hard", "grind"]).nullable(),
      })
      .refine((set) => (set.weight == null) === (set.weightUnit == null), {
        message: "Weighted sets require one explicit load unit.",
        path: ["weightUnit"],
      }),
  ),
});
const currentSkipEntrySchema = z.object({
  kind: z.literal("skip"),
  rawExercise: z.string(),
  reasonCode: incompleteSessionReasonSchema.nullable(),
});
const painEntrySchema = z.object({
  kind: z.literal("pain"),
  bodyPart: z.string(),
  severity: z.number().min(0).max(10).nullable(),
  rawExercise: z.string().nullable(),
});
const noteEntrySchema = z.object({
  kind: z.literal("note"),
  text: z.string(),
});

export const logEntrySchema = z.discriminatedUnion("kind", [
  setEntrySchema,
  currentSkipEntrySchema,
  painEntrySchema,
  noteEntrySchema,
]);

const legacyLogEntrySchema = z.discriminatedUnion("kind", [
  setEntrySchema,
  z.object({
    kind: z.literal("skip"),
    rawExercise: z.string(),
    reason: z.enum(["time", "pain", "fatigue", "equipment", "other"]).nullable(),
  }),
  painEntrySchema,
  noteEntrySchema,
]);

export const logParseData = z.object({
  semanticsVersion: z.literal(QUICK_LOG_PARSE_SEMANTICS_VERSION),
  entries: z.array(logEntrySchema),
});

export const logParseSchema = aiEnvelope(logParseData);
const legacyLogParseSchema = aiEnvelope(
  z.object({
    entries: z.array(legacyLogEntrySchema),
  }),
);
export const storedLogParseSchema = z.union([
  logParseSchema,
  legacyLogParseSchema,
]);

export type LogEntry = z.infer<typeof logEntrySchema>;
export type StoredLogEntry = z.infer<typeof legacyLogEntrySchema> | LogEntry;
export type LogParseResult = z.infer<typeof logParseSchema>;

export const RPE_HINT_VALUES: Record<string, number> = {
  easy: 6,
  ok: 7,
  hard: 8,
  grind: 9.5,
};
