import { z } from "zod";
import { aiEnvelope } from "@/ai/envelope";

/**
 * Setup routine generation. Unlike routine_parse, this task may fill in a
 * sensible program from a request, but every exercise must use an ID supplied
 * by the server in the available exercise list.
 */

export const routineBuildExerciseSchema = z.object({
  /** Name or line from the request that this library exercise represents. */
  requestedName: z.string().min(1).max(120),
  exerciseId: z.string().uuid(),
  sets: z.number().int().min(1).max(10),
  repMin: z.number().int().min(1).max(50),
  repMax: z.number().int().min(1).max(50),
  targetLoad: z.number().min(0).nullable(),
  restSec: z.number().int().min(0).max(600),
  supersetGroup: z.string().max(2).nullable(),
  notes: z.string().max(500).nullable(),
  warmup: z
    .object({
      notes: z.string().max(1000).nullable(),
      sets: z
        .array(
          z.object({
            label: z.string().min(1).max(80),
            reps: z.number().int().min(0).max(100).nullable(),
            load: z.number().min(0).max(2000).nullable(),
            loadPercent: z.number().min(0).max(100).nullable(),
            loadText: z.string().max(80).nullable(),
            notes: z.string().max(300).nullable(),
          })
        )
        .max(8),
    })
    .nullable(),
  setNotes: z.array(z.string().max(300).nullable()).max(10),
});

export const routineBuildDaySchema = z.object({
  name: z.string().min(1).max(60),
  notes: z.string().max(2000).nullable(),
  warmupNotes: z.string().max(4000).nullable(),
  exercises: z.array(routineBuildExerciseSchema).min(1).max(15),
});

export const routineBuildData = z.object({
  programName: z.string().min(1).max(160).nullable(),
  days: z.array(routineBuildDaySchema).min(1).max(7),
  rationale: z.string().max(1000).nullable(),
});

export const routineBuildSchema = aiEnvelope(routineBuildData);

export type RoutineBuildExercise = z.infer<typeof routineBuildExerciseSchema>;
export type RoutineBuildData = z.infer<typeof routineBuildData>;
export type RoutineBuildResult = z.infer<typeof routineBuildSchema>;
