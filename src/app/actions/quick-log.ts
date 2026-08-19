"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { aiParsingEvents } from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import { isAIAvailable, AIUnavailableError } from "@/ai/provider";
import {
  logParseSchema,
  QUICK_LOG_PARSE_SEMANTICS_VERSION,
  type LogParseResult,
} from "@/ai/tasks/log-parse/schema";
import { LOG_PARSE_SYSTEM } from "@/ai/tasks/log-parse/prompt";
import { parseCleanLog } from "@/engine/quick-log-regex";
import {
  resolveExerciseName,
  type ExerciseResolution,
} from "@/services/exercise-map";
import { applyQuickLogToDatabase } from "@/services/quick-log-apply";
import {
  rawDataExpiresAt,
  sensitiveTextSha256,
} from "@/lib/privacy-retention";
import {
  AIControlError,
  runControlledStructuredGeneration,
} from "@/services/ai-control";
import { incompleteSessionReasonSchema } from "@/lib/session-completion-semantics";

export type QuickLogParseResponse =
  | {
      ok: true;
      parsingEventId: string;
      envelope: LogParseResult;
      resolutions: ExerciseResolution[];
      source: "regex" | "ai";
    }
  | { ok: false; reason: string };

/**
 * Plan §13 contract 5 + §8: regex fast path first; AI only for messy input.
 * Nothing is written to workout tables here — the parse is quarantined on an
 * AIParsingEvent until the user confirms (applyQuickLog).
 */
export async function parseQuickLog(input: string): Promise<QuickLogParseResponse> {
  const text = z.string().min(1).max(4000).parse(input).trim();
  const user = await getCurrentUser();
  const db = await getDb();

  let envelope: LogParseResult;
  let source: "regex" | "ai";
  let model: string | null = null;
  let latencyMs: number | null = null;

  const clean = parseCleanLog(text, user.profile.unit);
  if (clean) {
    envelope = {
      data: {
        semanticsVersion: QUICK_LOG_PARSE_SEMANTICS_VERSION,
        entries: clean,
      },
      confidence: 1,
      ambiguities: [],
      clarifyingQuestions: [],
      unparsed: [],
    };
    source = "regex";
  } else {
    if (!isAIAvailable()) {
      return {
        ok: false,
        reason:
          "That line is too free-form for the built-in parser, and AI parsing isn't configured. Try the pattern \"Exercise 135x8,8,7\" or log manually.",
      };
    }
    try {
      const result = await runControlledStructuredGeneration(db, user.id, {
        task: "log_parse",
        system: LOG_PARSE_SYSTEM,
        input: JSON.stringify({
          text,
          defaultWeightUnit: user.profile.unit,
        }),
        schema: logParseSchema,
      });
      envelope = result.value;
      source = "ai";
      model = result.model;
      latencyMs = result.latencyMs;
    } catch (err) {
      if (err instanceof AIUnavailableError) {
        return { ok: false, reason: err.message };
      }
      if (err instanceof AIControlError) return { ok: false, reason: err.message };
      return {
        ok: false,
        reason: "The parser had trouble with that. Try again or log manually.",
      };
    }
  }

  // Deterministic name resolution for every sets/skip entry
  const resolutions: ExerciseResolution[] = [];
  for (const entry of envelope.data.entries) {
    if (entry.kind === "sets" || entry.kind === "skip") {
      resolutions.push(await resolveExerciseName(db, entry.rawExercise, user.id));
    } else {
      resolutions.push({
        rawName: "",
        exerciseId: null,
        exerciseName: null,
        matchType: "none",
        matchedExercise: null,
        candidates: [],
      });
    }
  }

  const [event] = await db
    .insert(aiParsingEvents)
    .values({
      userId: user.id,
      scope: "log",
      task: "log_parse",
      rawInput: text,
      inputSha256: sensitiveTextSha256(text),
      rawOutput: source === "ai" ? JSON.stringify(envelope) : null,
      parsedJson: envelope,
      confidence: envelope.confidence,
      ambiguities: envelope.ambiguities,
      model: model ?? "regex",
      latencyMs,
      retentionExpiresAt: rawDataExpiresAt(),
    })
    .returning();

  return { ok: true, parsingEventId: event.id, envelope, resolutions, source };
}

const applySchema = z.object({
  parsingEventId: z.string().uuid(),
  /** entry index → exerciseId chosen by the user (or auto-resolved). */
  exerciseByEntry: z.record(z.string(), z.string().uuid()),
  /** entry indexes the user chose to discard. */
  discardedEntries: z.array(z.number().int()).default([]),
  /** user-resolved severities for pain entries that had none. */
  painSeverityByEntry: z.record(z.string(), z.number().int().min(0).max(10)).default({}),
  /** explicit owner-selected reason for each retained skip entry. */
  skipReasonByEntry: z.record(
    z.string(),
    incompleteSessionReasonSchema,
  ).default({}),
});

export type ApplyQuickLogInput = z.infer<typeof applySchema>;

/**
 * The confirmation gate (plan §13): this is the ONLY writer of parsed log
 * data, and it refuses unresolved entries. Safety proof (a) covers this.
 */
export async function applyQuickLog(
  input: ApplyQuickLogInput
): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
  const parsed = applySchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await applyQuickLogToDatabase(db, user.id, parsed);
  if (!result.ok) return result;
  revalidatePath("/today");
  revalidatePath("/history");
  return result;
}
