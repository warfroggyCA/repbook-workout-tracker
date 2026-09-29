"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { sanitizeAIProviderError } from "@/lib/ai-provider-error";
import { logDiagnosticEvent } from "@/lib/server-log";
import { AIUnavailableError, isAIAvailable } from "@/ai/provider";
import {
  createCoachingAnswer,
  createTrainingReview,
} from "@/services/coaching";
import { AIControlError } from "@/services/ai-control";
import { getHistoryPatterns } from "@/services/history-patterns";
import { audit } from "@/services/audit";

export type CoachActionResult =
  | { ok: true; insightId: string }
  | { ok: false; reason: string };

const questionSchema = z
  .string()
  .trim()
  .min(3, "Ask a little more so Coach has something to work with.")
  .max(600, "Keep the question under 600 characters.");

function friendlyCoachError(error: unknown, timezone: string): string {
  if (error instanceof AIControlError) {
    switch (error.code) {
      case "request_too_large":
        return "This review includes more information than Coach can process at once. Try asking about one exercise instead.";
      case "already_running":
        return "This request is already being processed. Check again shortly.";
      case "concurrent_limit":
        return "Coach is working on another request. Try again when it finishes.";
      case "token_limit":
      case "cost_limit": {
        const reset = new Date();
        reset.setUTCHours(24, 0, 0, 0);
        const when = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(reset);
        return `You've reached today's Coach limit. Try again after ${when}.`;
      }
      default:
        return "Coach is temporarily busy. Try again in a few minutes.";
    }
  }
  if (error instanceof AIUnavailableError) {
    return "Coach is not connected. You can still view and log workouts.";
  }
  return "Coach couldn't update this right now. Please try again later.";
}

export async function generateTrainingReview(): Promise<CoachActionResult> {
  const user = await getCurrentUser();
  const db = await getDb();
  if (!isAIAvailable()) {
    return {
      ok: false,
      reason: friendlyCoachError(
        new AIUnavailableError(),
        user.profile.timezone,
      ),
    };
  }

  try {
    const { insight } = await createTrainingReview(
      db,
      user.id,
      user.profile.coachingPrefs,
    );
    await audit(db, {
      userId: user.id,
      actorType: "ai",
      action: "coaching.review.create",
      entityType: "coaching_insight",
      entityId: insight.id,
      summary: "Generated an on-demand 12-week training review",
      causeRef: { insightId: insight.id, windowDays: 84 },
    });
    revalidatePath("/coach");
    return { ok: true, insightId: insight.id };
  } catch (error) {
    logDiagnosticEvent("ai.coach_review_failed", {
      ...sanitizeAIProviderError(error),
      usageControlCode: error instanceof AIControlError ? error.code : null,
    });
    return {
      ok: false,
      reason: friendlyCoachError(error, user.profile.timezone),
    };
  }
}

export async function askCoach(
  question: string,
  patternKey?: string,
): Promise<CoachActionResult> {
  const parsed = questionSchema.safeParse(question);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues[0]?.message ?? "Ask a valid question.",
    };
  }

  const user = await getCurrentUser();
  const db = await getDb();
  if (!isAIAvailable()) {
    return {
      ok: false,
      reason: friendlyCoachError(
        new AIUnavailableError(),
        user.profile.timezone,
      ),
    };
  }

  try {
    let pattern;
    if (patternKey !== undefined) {
      if (
        typeof patternKey !== "string" ||
        !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(patternKey)
      ) {
        return {
          ok: false,
          reason:
            "This pattern is no longer available. Return to History to view current workouts.",
        };
      }
      pattern = (
        await getHistoryPatterns(db, user.id, user.profile.timezone)
      ).find((item) => item.key === patternKey);
      if (!pattern)
        return {
          ok: false,
          reason:
            "This pattern has changed. Return to History to view current workouts.",
        };
    }
    const { insight } = await createCoachingAnswer(
      db,
      user.id,
      user.profile.coachingPrefs,
      parsed.data,
      pattern,
    );
    await audit(db, {
      userId: user.id,
      actorType: "ai",
      action: "coaching.question.answer",
      entityType: "coaching_insight",
      entityId: insight.id,
      summary: "Answered a question from the training digest",
      causeRef: { insightId: insight.id },
    });
    revalidatePath("/coach");
    return { ok: true, insightId: insight.id };
  } catch (error) {
    logDiagnosticEvent("ai.coach_question_failed", {
      ...sanitizeAIProviderError(error),
      usageControlCode: error instanceof AIControlError ? error.code : null,
    });
    return {
      ok: false,
      reason: friendlyCoachError(error, user.profile.timezone),
    };
  }
}
