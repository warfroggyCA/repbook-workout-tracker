import { z } from "zod";

/**
 * Shared AI envelope (plan §13). Every parsing task returns its data wrapped
 * in this. The iron rule: anything with confidence < CONFIDENCE_THRESHOLD or
 * non-empty ambiguities requires the confirmation screen, and nothing
 * AI-parsed persists to core tables without a user confirm action.
 */
export const CONFIDENCE_THRESHOLD = 0.9;

export function aiEnvelope<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    data,
    /** Model's overall self-assessment, 0–1. */
    confidence: z.number().min(0).max(1),
    ambiguities: z.array(
      z.object({
        /** JSON-path-ish pointer into data, e.g. "entries[0].sets[2].weight" */
        field: z.string(),
        issue: z.string(),
        options: z.array(z.string()).nullable(),
      })
    ),
    clarifyingQuestions: z.array(z.string()),
    /** Input fragments the model could not place — never dropped silently. */
    unparsed: z.array(z.string()),
  });
}

export type AIEnvelope<T> = {
  data: T;
  confidence: number;
  ambiguities: Array<{ field: string; issue: string; options: string[] | null }>;
  clarifyingQuestions: string[];
  unparsed: string[];
};

/** Does this parse require the user to resolve something before saving? */
export function requiresConfirmation(env: AIEnvelope<unknown>): boolean {
  return (
    env.confidence < CONFIDENCE_THRESHOLD ||
    env.ambiguities.length > 0 ||
    env.clarifyingQuestions.length > 0 ||
    env.unparsed.length > 0
  );
}
