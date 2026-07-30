import {
  LIVE_COACH_RECORDING_MAX_BYTES,
  LIVE_COACH_RECORDING_MAX_DURATION_MS,
} from "@/lib/live-coach-dictation";
import { sensitiveJson } from "@/lib/http-security";
import { sameOriginMutationFailure } from "@/lib/route-security";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";
import {
  LiveCoachTranscriptionError,
  liveCoachTranscriptionModel,
  transcribeLiveCoachAudio,
  validateLiveCoachAudioFile,
} from "@/services/live-coach-transcription";
import { getDb } from "@/db";
import type { Db } from "@/db";
import {
  AIControlError,
  claimAIUsage,
  completeAIUsage,
  failAIUsage,
  networkIdentityHash,
  type AIUsageClaim,
} from "@/services/ai-control";

const MAX_MULTIPART_BYTES = LIVE_COACH_RECORDING_MAX_BYTES + 64 * 1024;

export type TranscriptionRouteDependencies = {
  getUser: () => Promise<{ id: string; profile: unknown } | null>;
  getDb?: () => Promise<Db>;
  claimUsage?: typeof claimAIUsage;
  completeUsage?: typeof completeAIUsage;
  failUsage?: typeof failAIUsage;
  transcribe?: typeof transcribeLiveCoachAudio;
};

function failure(
  status: number,
  code: string,
  reason: string,
  retryable: boolean
) {
  return sensitiveJson(
    { ok: false, code, reason, retryable },
    { status }
  );
}

export async function handleLiveCoachTranscriptionRequest(
  request: Request,
  dependencies: TranscriptionRouteDependencies
) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) {
    return failure(
      403,
      "forbidden",
      "This transcription request was blocked.",
      false
    );
  }

  const user = await dependencies.getUser();
  if (!user) {
    return failure(
      401,
      "authentication_required",
      "Your sign-in expired. Sign in again in another tab, then return here and retry this recording.",
      true
    );
  }
  if (!user.profile) {
    return failure(
      409,
      "setup_required",
      "Complete account setup before using Live Coach dictation.",
      false
    );
  }

  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return failure(
      400,
      "invalid_request",
      "The recording upload was invalid. Record again and retry.",
      false
    );
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return failure(
      413,
      "recording_too_large",
      "The recording is too large. Record a shorter message and try again.",
      false
    );
  }

  let form: FormData;
  try {
    const body = await readBoundedRequestBody(request, MAX_MULTIPART_BYTES);
    const bounded = new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: new Uint8Array(body).buffer,
    });
    form = await bounded.formData();
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return failure(
        413,
        "recording_too_large",
        "The recording is too large. Record a shorter message and try again.",
        false
      );
    }
    return failure(
      400,
      "invalid_request",
      "The recording upload could not be read. Record again and retry.",
      false
    );
  }

  const audio = form.get("audio");
  const durationMs = Number(form.get("durationMs"));
  if (!(audio instanceof File) || !Number.isInteger(durationMs) || durationMs <= 0) {
    return failure(
      400,
      "invalid_request",
      "The recording upload was incomplete. Record again and retry.",
      false
    );
  }
  if (durationMs > LIVE_COACH_RECORDING_MAX_DURATION_MS) {
    return failure(
      413,
      "recording_too_long",
      "Dictation recordings are limited to one minute. Record a shorter message and try again.",
      false
    );
  }

  try {
    validateLiveCoachAudioFile(audio);
    const db = await (dependencies.getDb ?? getDb)();
    let claim: AIUsageClaim;
    try {
      claim = await (dependencies.claimUsage ?? claimAIUsage)(db, {
        userId: user.id,
        task: "live_coach_transcription",
        logicalKey: `live_coach_transcription:${crypto.randomUUID()}`,
        networkHash: networkIdentityHash(request.headers),
        reservedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        audioSeconds: Math.ceil(durationMs / 1_000),
        leaseSeconds: 60,
      });
    } catch (error) {
      if (error instanceof AIControlError) {
        return failure(error.status, error.code, error.message, true);
      }
      throw error;
    }
    const providerAbort = new AbortController();
    const abortProvider = () => providerAbort.abort(request.signal.reason);
    if (request.signal.aborted) {
      abortProvider();
    } else {
      request.signal.addEventListener("abort", abortProvider, { once: true });
    }
    const deadline = setTimeout(
      () =>
        providerAbort.abort(
          new DOMException("Transcription timed out.", "TimeoutError")
        ),
      45_000
    );
    let transcript: string;
    try {
      transcript = await (dependencies.transcribe ?? transcribeLiveCoachAudio)(
        audio,
        { signal: providerAbort.signal }
      );
      await (dependencies.completeUsage ?? completeAIUsage)(db, claim, {
        model: liveCoachTranscriptionModel(),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costMicrousd: Math.ceil((durationMs / 1_000) * 100),
      });
    } catch (error) {
      await (dependencies.failUsage ?? failAIUsage)(
        db,
        claim,
        request.signal.aborted
          ? "cancelled"
          : providerAbort.signal.aborted
            ? "timed_out"
            : "failed"
      ).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(deadline);
      request.signal.removeEventListener("abort", abortProvider);
    }
    return sensitiveJson(
      { ok: true, transcript },
      {}
    );
  } catch (error) {
    if (error instanceof LiveCoachTranscriptionError) {
      return failure(error.status, error.code, error.message, error.retryable);
    }
    return failure(
      503,
      "transcription_unavailable",
      "Transcription is temporarily unavailable. Keep this recording in the page and try again.",
      true
    );
  }
}
