import { z } from "zod";
import { aiEnvelope } from "@/ai/envelope";

/**
 * Plan §13 contract 4 — exercise name mapping. The model receives rawNames
 * plus a server-pre-selected candidate slice (from resolveExerciseName) and
 * may only choose among those candidates — it cannot mint exercise IDs.
 * `fuzzy` and `none` always render amber on the review table.
 */

export const exerciseMappingSchema = z.object({
  rawName: z.string(),
  /** Must be one of the provided candidate IDs, or null. */
  exerciseId: z.string().nullable(),
  matchType: z.enum(["exact", "alias", "fuzzy", "none"]),
  altCandidates: z.array(
    z.object({
      exerciseId: z.string(),
      why: z.string(),
    })
  ),
});

export const exerciseMapData = z.object({
  mappings: z.array(exerciseMappingSchema),
});

export const exerciseMapSchema = aiEnvelope(exerciseMapData);

export type ExerciseMapping = z.infer<typeof exerciseMappingSchema>;
export type ExerciseMapData = z.infer<typeof exerciseMapData>;

/** The model's input: one row per unresolved rawName with its candidates. */
export type ExerciseMapRequest = Array<{
  rawName: string;
  candidates: Array<{ exerciseId: string; name: string }>;
}>;
