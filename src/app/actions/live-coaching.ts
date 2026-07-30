"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import {
  liveCoachValidationIssue,
  startLiveCoachTurnSchema,
} from "@/lib/live-coach-validation";
import { getCurrentUser } from "@/lib/user";
import {
  createLiveCoachRetry,
  getLiveCoachResponse,
  startLiveCoachTurn as persistLiveCoachTurn,
  type LiveCoachMessage,
} from "@/services/live-coaching";

export type StartLiveCoachActionResult =
  | {
      ok: true;
      userMessage: LiveCoachMessage;
      pendingResponse: LiveCoachMessage | null;
    }
  | { ok: false; reason: string };

export type LiveCoachResponseActionResult =
  | { ok: true; response: LiveCoachMessage }
  | { ok: false; reason: string; response: LiveCoachMessage | null };

function refreshLiveCoach(sessionId: string) {
  revalidatePath(`/session/${sessionId}`);
  revalidatePath(`/history/${sessionId}`);
  revalidatePath("/coach");
  revalidatePath("/export");
}

export async function startLiveCoachTurn(
  input: z.input<typeof startLiveCoachTurnSchema>
): Promise<StartLiveCoachActionResult> {
  const parsed = startLiveCoachTurnSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: liveCoachValidationIssue(parsed.error) };
  }
  try {
    const user = await getCurrentUser();
    const db = await getDb();
    const result = await persistLiveCoachTurn(db, user.id, parsed.data);
    refreshLiveCoach(parsed.data.sessionId);
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? error.message
          : "Live Coach could not save that message.",
    };
  }
}

export async function retryLiveCoachTurn(input: {
  userMessageId: string;
}): Promise<LiveCoachResponseActionResult> {
  const parsed = z
    .object({
      userMessageId: z.string().uuid(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: liveCoachValidationIssue(parsed.error),
      response: null,
    };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  try {
    const pending = await createLiveCoachRetry(
      db,
      user.id,
      parsed.data.userMessageId
    );
    refreshLiveCoach(pending.sessionId);
    return { ok: true, response: pending };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "This question could not be retried.",
      response: null,
    };
  }
}

export async function getLiveCoachResponseState(input: {
  responseId: string;
}): Promise<LiveCoachResponseActionResult> {
  const parsed = z
    .object({ responseId: z.string().uuid() })
    .safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: liveCoachValidationIssue(parsed.error),
      response: null,
    };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  const response = await getLiveCoachResponse(
    db,
    user.id,
    parsed.data.responseId
  );
  if (!response) {
    return {
      ok: false,
      reason: "That Live Coach response is no longer available.",
      response: null,
    };
  }
  return { ok: true, response };
}
