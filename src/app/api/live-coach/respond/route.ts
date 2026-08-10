import { z } from "zod";
import { getDb } from "@/db";
import { sensitiveJson, sensitiveResponse } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import { encodeLiveCoachStreamEvent } from "@/lib/live-coach-stream";
import { sanitizeAIProviderError } from "@/lib/ai-provider-error";
import {
  categorizeDiagnosticError,
  logDiagnosticEvent,
} from "@/lib/server-log";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";
import {
  AIControlError,
  claimLiveCoachGeneration,
  networkIdentityHash,
} from "@/services/ai-control";
import {
  completeLiveCoachResponse,
  getLiveCoachResponse,
  liveCoachFailureReason,
  markLiveCoachResponseFailed,
  prepareLiveCoachResponseStream,
} from "@/services/live-coaching";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_REQUEST_BYTES = 8 * 1024;

const requestSchema = z.object({
  responseId: z.string().uuid(),
  activeRestTimerSeconds: z.number().int().min(0).max(3600).nullable(),
});

export async function POST(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;

  const user = await getRouteUser();
  if (!user) {
    return sensitiveJson({ ok: false, reason: "Unauthorized" }, { status: 401 });
  }
  const profile = user.profile;
  if (!profile) {
    return sensitiveJson(
      { ok: false, reason: "Complete account setup before using Live Coach." },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    const bytes = await readBoundedRequestBody(request, MAX_REQUEST_BYTES);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return sensitiveJson(
      {
        ok: false,
        reason:
          error instanceof RequestBodyTooLargeError
            ? "Live Coach received a request that was too large."
            : "Live Coach received an invalid request.",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 }
    );
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return sensitiveJson(
      { ok: false, reason: "Live Coach received an invalid request." },
      { status: 400 }
    );
  }

  const db = await getDb();
  let claim: Awaited<ReturnType<typeof claimLiveCoachGeneration>>;
  try {
    claim = await claimLiveCoachGeneration(db, {
      userId: user.id,
      responseId: parsed.data.responseId,
      networkHash: networkIdentityHash(request.headers),
    });
  } catch (error) {
    if (error instanceof AIControlError) {
      return sensitiveJson(
        { ok: false, reason: error.message, code: error.code },
        { status: error.status }
      );
    }
    return sensitiveJson(
      { ok: false, reason: "Live Coach could not reserve this answer." },
      { status: 503 }
    );
  }
  const encoder = new TextEncoder();
  const generationAbort = new AbortController();
  let deadlineReached = false;
  const hardDeadline = setTimeout(() => {
    deadlineReached = true;
    generationAbort.abort(new DOMException("Live Coach timed out.", "TimeoutError"));
  }, 50_000);
  let cancelled = false;
  const abortGeneration = () => generationAbort.abort();
  if (request.signal.aborted) {
    abortGeneration();
  } else {
    request.signal.addEventListener("abort", abortGeneration, { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let prepared:
        | Awaited<ReturnType<typeof prepareLiveCoachResponseStream>>
        | undefined;
      const send = (event: Parameters<typeof encodeLiveCoachStreamEvent>[0]) => {
        if (!cancelled) {
          controller.enqueue(
            encoder.encode(encodeLiveCoachStreamEvent(event))
          );
        }
      };

      try {
        // WebKit buffers tiny streamed responses. This harmless blank line gets
        // the response over its initial threshold without becoming UI content.
        controller.enqueue(encoder.encode(`${" ".repeat(1024)}\n`));
        send({ type: "ready", responseId: parsed.data.responseId });
        prepared = await prepareLiveCoachResponseStream(
          db,
          user.id,
          profile.coachingPrefs,
          parsed.data.responseId,
          parsed.data.activeRestTimerSeconds,
          generationAbort.signal,
          claim
        );

        let lastAnswer = "";
        for await (const partial of prepared.partials) {
          const answer = partial.answer;
          if (typeof answer === "string" && answer !== lastAnswer) {
            lastAnswer = answer;
            send({
              type: "partial",
              responseId: parsed.data.responseId,
              answer,
            });
          }
        }

        const answer = await prepared.value;
        const usage = await prepared.usage;
        const response = await completeLiveCoachResponse(
          db,
          user.id,
          parsed.data.responseId,
          prepared.context,
          answer,
          prepared.model,
          prepared.claim,
          usage
        );
        send({ type: "completed", response });
      } catch (error) {
        void prepared?.value.catch((valueError) => {
          logDiagnosticEvent("live_coach.prepared_value_failed", {
            ...sanitizeAIProviderError(valueError),
          });
        });
        const disconnected = cancelled || request.signal.aborted;
        const reason = liveCoachFailureReason(
          deadlineReached
            ? new DOMException("Live Coach timed out.", "TimeoutError")
            : error,
          disconnected
        );
        let response = null;
        try {
          response = await markLiveCoachResponseFailed(
            db,
            user.id,
            parsed.data.responseId,
            reason,
            prepared?.claim ?? claim,
            disconnected
              ? "cancelled"
              : deadlineReached
                ? "timed_out"
                : "failed"
          );
          response ??= await getLiveCoachResponse(
            db,
            user.id,
            parsed.data.responseId
          );
        } catch (failureWriteError) {
          // The saved user message and pending response still remain retryable
          // even if the failure-status write cannot complete.
          logDiagnosticEvent("live_coach.failure_write_failed", {
            errorCategory: categorizeDiagnosticError(
              failureWriteError,
              "persistence",
            ),
          });
        }

        logDiagnosticEvent("live_coach.response_failed", {
          disconnected,
          deadlineReached,
          ...sanitizeAIProviderError(error),
        });

        if (!disconnected) {
          if (response?.responseStatus === "completed") {
            send({ type: "completed", response });
          } else {
            send({ type: "failed", response, reason });
          }
        }
      } finally {
        request.signal.removeEventListener("abort", abortGeneration);
        clearTimeout(hardDeadline);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      generationAbort.abort();
    },
  });

  return sensitiveResponse(stream, {
    headers: {
      "Cache-Control": "private, no-store, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
