import { z } from "zod";
import { aiEnvelope } from "@/ai/envelope";

/**
 * Plan §13 contract 3 — routine import parsing. `rawName` passes through
 * verbatim; mapping to library exercises is a separate step (contract 4) so
 * parse errors and mapping errors stay distinguishable. Numbers the input
 * doesn't state are null — never defaulted by the model.
 */

/** repsPerSet: explicit per-set counts ("8, 8, 6") or a range ("8-10"). */
export const repSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("perSet"),
    perSet: z.array(z.number().int().min(0).max(100)).min(1),
  }),
  z.object({
    kind: z.literal("range"),
    min: z.number().int().min(0).max(100),
    max: z.number().int().min(0).max(100),
  }),
]);

export const routineExerciseSchema = z.object({
  /** Verbatim from the input — normalization happens in exercise_map. */
  rawName: z.string().min(1),
  sets: z.number().int().min(1).max(20).nullable(),
  reps: repSpecSchema.nullable(),
  load: z.number().min(0).nullable(),
  loadUnit: z.enum(["lb", "kg"]).nullable(),
  restSec: z.number().int().min(0).max(1800).nullable(),
  /** Exercises sharing a key within a day are a superset pair/group. */
  supersetKey: z.string().nullable(),
  notes: z.string().nullable(),
});

export const routineDaySchema = z.object({
  name: z.string().min(1),
  order: z.number().int().min(0),
  exercises: z.array(routineExerciseSchema),
});

export const routineParseData = z.object({
  programName: z.string().nullable(),
  days: z.array(routineDaySchema),
});

export const routineParseSchema = aiEnvelope(routineParseData);

export type RepSpec = z.infer<typeof repSpecSchema>;
export type RoutineExercise = z.infer<typeof routineExerciseSchema>;
export type RoutineDay = z.infer<typeof routineDaySchema>;
export type RoutineParseData = z.infer<typeof routineParseData>;
export type RoutineParseResult = z.infer<typeof routineParseSchema>;

/** Rep range for a prescription row; perSet lists collapse to min/max. */
export function repSpecToRange(
  spec: RepSpec | null
): { min: number; max: number } | null {
  if (!spec) return null;
  if (spec.kind === "range") return { min: spec.min, max: spec.max };
  return { min: Math.min(...spec.perSet), max: Math.max(...spec.perSet) };
}
