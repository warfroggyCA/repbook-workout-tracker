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
import { evaluateRecentProgression } from "@/services/progression";
import { audit } from "@/services/audit";

export type CoachActionResult =
  | { ok: true; insightId: string }
  | { ok: false; reason: string };

const questionSchema = z
  .string()
  .trim()
  .min(3, "Ask a little more so Coach has something to work with.")
  .max(600, "Keep the question under 600 characters.");

function friendlyCoachError(error: unknown): string {
  if (error instanceof AIUnavailableError) {
    return "Coach needs an AI key before it can write a review. Your workout tracking and rule-based suggestions still work normally.";
  }
  return "Coach could not finish that request. Your data is safe; please try again.";
}

export async function generateTrainingReview(): Promise<CoachActionResult> {
  const user = await getCurrentUser();
  const db = await getDb();
  if (!isAIAvailable()) {
    return { ok: false, reason: friendlyCoachError(new AIUnavailableError()) };
  }

  try {
    await evaluateRecentProgression(
      db,
      user.id,
      user.profile.coachingPrefs
    );
    const { insight } = await createTrainingReview(
      db,
      user.id,
      user.profile.coachingPrefs
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
    });
    return { ok: false, reason: friendlyCoachError(error) };
  }
}

export async function askCoach(question: string): Promise<CoachActionResult> {
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
    return { ok: false, reason: friendlyCoachError(new AIUnavailableError()) };
  }

  try {
    const { insight } = await createCoachingAnswer(
      db,
      user.id,
      user.profile.coachingPrefs,
      parsed.data
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
    });
    return { ok: false, reason: friendlyCoachError(error) };
  }
}
