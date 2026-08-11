import { createHmac, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { aiUsageEvents } from "@/db/schema";
import {
  getAIProvider,
  structuredOutputTokenLimit,
  type AIResult,
  type AITask,
  type AIUsage,
} from "@/ai/provider";
import { optionalEnv } from "@/lib/env";
import {
  categorizeDiagnosticError,
  logDiagnosticEvent,
} from "@/lib/server-log";

export const AI_RATE_WINDOW_MINUTES = 10;
export const AI_REQUEST_LIMIT = 20;
export const AI_NETWORK_REQUEST_LIMIT = 40;
export const AI_CONCURRENT_LIMIT = 2;
export const AI_DAILY_TOKEN_LIMIT = 250_000;
export const AI_DAILY_COST_LIMIT_MICROUSD = 5_000_000;
export const AI_TRANSCRIPTION_HOURLY_LIMIT = 10;
export const AI_TRANSCRIPTION_DAILY_SECONDS = 20 * 60;
export const AI_USAGE_RETENTION_DAYS = 90;

export type AIUsageClaim = {
  id: string;
  leaseId: string;
  leaseExpiresAt: Date;
  logicalKey: string;
};

export type AIClaimFailureCode =
  | "already_running"
  | "concurrent_limit"
  | "rate_limit"
  | "network_rate_limit"
  | "token_limit"
  | "cost_limit"
  | "transcription_rate_limit"
  | "transcription_duration_limit";

export class AIControlError extends Error {
  constructor(
    message: string,
    readonly code: AIClaimFailureCode,
    readonly status = 429
  ) {
    super(message);
    this.name = "AIControlError";
  }
}

export async function claimLiveCoachGeneration(
  db: Db,
  input: {
    userId: string;
    responseId: string;
    networkHash?: string | null;
    now?: Date;
  }
): Promise<AIUsageClaim> {
  const now = input.now ?? new Date();
  const logicalKey = `live_coach:${input.responseId}`;
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const reservedUsage = {
    inputTokens: 19_000,
    outputTokens: 1_000,
    totalTokens: 20_000,
  };
  const reservedCost = estimateAICostMicrousd(reservedUsage);
  const query = sql`
    SELECT
      usage_id::text AS usage_id,
      response_state,
      failure_code,
      claimed
    FROM claim_live_coach_generation(
      ${input.userId}::uuid,
      ${input.responseId}::uuid,
      ${logicalKey},
      ${leaseId}::uuid,
      ${leaseExpiresAt.toISOString()}::timestamptz,
      ${input.networkHash ?? null},
      ${reservedUsage.totalTokens},
      ${reservedCost},
      ${now.toISOString()}::timestamptz
    )
  `;
  let row: Record<string, unknown> | undefined;
  try {
    row = resultRows(await db.execute(query))[0];
  } catch (error) {
    if (isRunningLogicalConflict(error)) {
      throw new AIControlError(
        claimFailureMessage("already_running"),
        "already_running",
        409
      );
    }
    throw error;
  }
  if (row?.claimed !== true || !row.usage_id) {
    const state = String(row?.response_state ?? "missing");
    if (state === "completed") {
      throw new AIControlError("This Live Coach answer is already complete.", "already_running", 409);
    }
    if (state === "failed" || state === "missing") {
      throw new AIControlError(
        "This Live Coach response is no longer pending. Retry from the saved question.",
        "already_running",
        409
      );
    }
    const code = String(row?.failure_code ?? "already_running") as AIClaimFailureCode;
    throw new AIControlError(
      claimFailureMessage(code),
      code,
      code === "already_running" ? 409 : 429
    );
  }
  return {
    id: String(row.usage_id),
    leaseId,
    leaseExpiresAt,
    logicalKey,
  };
}

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function inputRateMicrousd() {
  return positiveIntegerEnv("AI_INPUT_MICROUSD_PER_TOKEN", 15);
}

function outputRateMicrousd() {
  return positiveIntegerEnv("AI_OUTPUT_MICROUSD_PER_TOKEN", 75);
}

export function estimateAICostMicrousd(usage: AIUsage) {
  return Math.max(
    0,
    Math.ceil(
      usage.inputTokens * inputRateMicrousd() +
        usage.outputTokens * outputRateMicrousd()
    )
  );
}

function claimFailureMessage(code: AIClaimFailureCode) {
  switch (code) {
    case "already_running":
      return "This AI request is already being processed.";
    case "concurrent_limit":
      return "Another AI request is still running. Wait for it to finish, then retry.";
    case "rate_limit":
    case "network_rate_limit":
      return "AI requests are temporarily limited. Wait a few minutes, then retry.";
    case "token_limit":
    case "cost_limit":
      return "The daily AI usage limit has been reached. Try again tomorrow.";
    case "transcription_rate_limit":
      return "Dictation has been used too often this hour. Wait before retrying.";
    case "transcription_duration_limit":
      return "The daily dictation limit has been reached. Use the typed message box for now.";
  }
}

function isRunningLogicalConflict(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("ai_usage_events_running_logical_uq")
  );
}

export function networkIdentityHash(headers: Headers, now = new Date()) {
  const raw =
    headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "";
  if (!raw) return null;
  const secret =
    optionalEnv("AI_NETWORK_HASH_SECRET") ??
    optionalEnv("AUTH_SECRET") ??
    "development-only-network-identity";
  const day = now.toISOString().slice(0, 10);
  return createHmac("sha256", secret)
    .update(`${day}\0${raw}`)
    .digest("hex")
    .slice(0, 32);
}

export async function claimAIUsage(
  db: Db,
  input: {
    userId: string;
    task: string;
    logicalKey?: string;
    networkHash?: string | null;
    reservedUsage: AIUsage;
    audioSeconds?: number;
    leaseSeconds?: number;
    now?: Date;
  }
): Promise<AIUsageClaim> {
  const now = input.now ?? new Date();
  const logicalKey = input.logicalKey ?? `${input.task}:${randomUUID()}`;
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() + (input.leaseSeconds ?? 60) * 1_000
  );
  const reservedCost = estimateAICostMicrousd(input.reservedUsage);
  const audioSeconds = Math.max(0, Math.ceil(input.audioSeconds ?? 0));
  const query = sql`
    SELECT usage_id::text AS id, failure_code
    FROM claim_ai_usage(
      ${input.userId}::uuid,
      ${input.task},
      ${logicalKey},
      ${leaseId}::uuid,
      ${leaseExpiresAt.toISOString()}::timestamptz,
      ${input.networkHash ?? null},
      ${input.reservedUsage.totalTokens},
      ${reservedCost},
      ${audioSeconds},
      ${now.toISOString()}::timestamptz
    )
  `;
  let row: Record<string, unknown> | undefined;
  try {
    row = resultRows(await db.execute(query))[0];
  } catch (error) {
    if (isRunningLogicalConflict(error)) {
      throw new AIControlError(
        claimFailureMessage("already_running"),
        "already_running",
        409
      );
    }
    throw error;
  }
  if (!row?.id) {
    const code = String(row?.failure_code ?? "rate_limit") as AIClaimFailureCode;
    throw new AIControlError(
      claimFailureMessage(code),
      code,
      code === "already_running" ? 409 : 429
    );
  }
  return {
    id: String(row.id),
    leaseId,
    leaseExpiresAt,
    logicalKey,
  };
}

export async function completeAIUsage(
  db: Db,
  claim: AIUsageClaim,
  input: { model: string; usage: AIUsage; costMicrousd?: number; now?: Date }
) {
  const now = input.now ?? new Date();
  const cost = input.costMicrousd ?? estimateAICostMicrousd(input.usage);
  const [completed] = await db
    .update(aiUsageEvents)
    .set({
      status: "completed",
      model: input.model,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      totalTokens: input.usage.totalTokens,
      estimatedCostMicrousd: cost,
      failureCode: null,
      completedAt: now,
    })
    .where(
      sql`${aiUsageEvents.id} = ${claim.id}::uuid AND ${aiUsageEvents.leaseId} = ${claim.leaseId}::uuid AND ${aiUsageEvents.status} = 'running'`
    )
    .returning({ id: aiUsageEvents.id });
  if (!completed) throw new Error("The AI usage lease expired before completion.");
}

export async function failAIUsage(
  db: Db,
  claim: AIUsageClaim,
  code: "failed" | "cancelled" | "timed_out",
  now = new Date()
) {
  await db
    .update(aiUsageEvents)
    .set({ status: code, failureCode: code, completedAt: now })
    .where(
      sql`${aiUsageEvents.id} = ${claim.id}::uuid AND ${aiUsageEvents.leaseId} = ${claim.leaseId}::uuid AND ${aiUsageEvents.status} = 'running'`
    );
}

function deadlineSignal(external: AbortSignal | undefined, deadlineMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("AI request timed out.", "TimeoutError")),
    deadlineMs
  );
  const abort = () => controller.abort(external?.reason);
  external?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  };
}

export async function runControlledStructuredGeneration<T>(
  db: Db,
  userId: string,
  opts: {
    task: AITask;
    system: string;
    input: string;
    schema: z.ZodType<T>;
    logicalKey?: string;
    networkHash?: string | null;
    abortSignal?: AbortSignal;
    deadlineMs?: number;
  }
): Promise<AIResult<T>> {
  const inputTokens = Math.max(1, Math.ceil(opts.input.length / 4));
  const outputTokens = structuredOutputTokenLimit(opts.task, opts.input);
  const reservedUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
  const deadlineMs = Math.min(Math.max(opts.deadlineMs ?? 30_000, 1), 120_000);
  const claim = await claimAIUsage(db, {
    userId,
    task: opts.task,
    logicalKey: opts.logicalKey,
    networkHash: opts.networkHash,
    reservedUsage,
    leaseSeconds: Math.ceil(deadlineMs / 1_000) + 15,
  });
  const deadline = deadlineSignal(opts.abortSignal, deadlineMs);
  try {
    const result = await getAIProvider().parseStructured({
      task: opts.task,
      system: opts.system,
      input: opts.input,
      schema: opts.schema,
      abortSignal: deadline.signal,
    });
    await completeAIUsage(db, claim, {
      model: result.model,
      usage: result.usage,
    });
    return result;
  } catch (error) {
    const cancelled = opts.abortSignal?.aborted === true;
    const timedOut = deadline.signal.aborted && !cancelled;
    await failAIUsage(
      db,
      claim,
      cancelled ? "cancelled" : timedOut ? "timed_out" : "failed"
    ).catch((failureWriteError) => {
      logDiagnosticEvent("ai.usage_failure_write_failed", {
        usageOutcome: cancelled
          ? "cancelled"
          : timedOut
            ? "timed_out"
            : "failed",
        errorCategory: categorizeDiagnosticError(
          failureWriteError,
          "persistence",
        ),
      });
    });
    throw error;
  } finally {
    deadline.dispose();
  }
}

export async function getAIUsageEvent(db: Db, id: string) {
  return db.query.aiUsageEvents.findFirst({
    where: eq(aiUsageEvents.id, id),
  });
}
