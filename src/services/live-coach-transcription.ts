import "server-only";

import { z } from "zod";
import {
  LIVE_COACH_RECORDING_MAX_BYTES,
  LIVE_COACH_RECORDING_MIN_BYTES,
  liveCoachRecordingExtension,
  normalizeLiveCoachRecordingMediaType,
} from "@/lib/live-coach-dictation";
import { optionalEnv } from "@/lib/env";
import { isDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";

const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const FAKE_TRANSCRIPT =
  "My last set felt harder than expected. Should I keep the same weight?";

const providerResponseSchema = z.object({
  text: z.string().trim().min(1).max(10_000),
});

export class LiveCoachTranscriptionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "LiveCoachTranscriptionError";
  }
}

export function validateLiveCoachAudioFile(file: File) {
  const mediaType = normalizeLiveCoachRecordingMediaType(file.type);
  if (!mediaType) {
    throw new LiveCoachTranscriptionError(
      "This recording format is not supported. Record again with a supported browser or device.",
      "unsupported_media_type",
      415,
      false
    );
  }
  if (file.size < LIVE_COACH_RECORDING_MIN_BYTES) {
    throw new LiveCoachTranscriptionError(
      "The recording did not contain usable audio. Check the microphone and record again.",
      "invalid_audio",
      422,
      false
    );
  }
  if (file.size > LIVE_COACH_RECORDING_MAX_BYTES) {
    throw new LiveCoachTranscriptionError(
      "The recording is too large. Record a shorter message and try again.",
      "recording_too_large",
      413,
      false
    );
  }
  return mediaType;
}

function fakeTranscriptionEnabled() {
  return (
    process.env.AI_FAKE === "1" &&
    (process.env.NODE_ENV === "development" || isDisposableAcceptanceRuntime())
  );
}

export function liveCoachTranscriptionModel(options?: { model?: string }) {
  return (
    options?.model ??
    optionalEnv("OPENAI_TRANSCRIPTION_MODEL") ??
    DEFAULT_TRANSCRIPTION_MODEL
  );
}

type TranscriptionOptions = {
  signal?: AbortSignal;
  apiKey?: string;
  model?: string;
  fetcher?: typeof fetch;
  useFake?: boolean;
};

export async function transcribeLiveCoachAudio(
  file: File,
  options: TranscriptionOptions = {}
) {
  const mediaType = validateLiveCoachAudioFile(file);
  if (options.useFake ?? fakeTranscriptionEnabled()) return FAKE_TRANSCRIPT;

  const apiKey = options.apiKey ?? optionalEnv("OPENAI_API_KEY");
  if (!apiKey) {
    throw new LiveCoachTranscriptionError(
      "Dictation transcription is not configured right now. Discard this recording and use the typed message box instead.",
      "transcription_unavailable",
      503,
      false
    );
  }

  const bytes = await file.arrayBuffer();
  const safeFile = new File(
    [bytes],
    `live-coach-recording.${liveCoachRecordingExtension(mediaType)}`,
    { type: mediaType }
  );
  const body = new FormData();
  body.set("file", safeFile);
  body.set(
    "model",
    liveCoachTranscriptionModel(options)
  );
  body.set("response_format", "json");
  body.set(
    "prompt",
    "A short workout note or question. Preserve exercise names, weights, repetitions, RPE, rest times, pain descriptions, and natural punctuation."
  );

  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
        signal: options.signal,
        cache: "no-store",
      }
    );
  } catch {
    if (options.signal?.aborted) {
      throw new LiveCoachTranscriptionError(
        "The transcription was interrupted. The recording is still available in this page to retry.",
        "transcription_interrupted",
        408,
        true
      );
    }
    throw new LiveCoachTranscriptionError(
      "The transcription service could not be reached. The recording is still available in this page to retry.",
      "transcription_network_error",
      503,
      true
    );
  }

  if (!response.ok) {
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      throw new LiveCoachTranscriptionError(
        "Dictation transcription is not configured correctly right now. Discard this recording and use the typed message box instead.",
        "transcription_configuration_error",
        503,
        false
      );
    }
    if (response.status === 400 || response.status === 415 || response.status === 422) {
      throw new LiveCoachTranscriptionError(
        "The transcription service could not read this audio. Check the microphone and record again.",
        "invalid_audio",
        422,
        false
      );
    }
    if (response.status === 413) {
      throw new LiveCoachTranscriptionError(
        "The recording is too large. Record a shorter message and try again.",
        "recording_too_large",
        413,
        false
      );
    }
    throw new LiveCoachTranscriptionError(
      response.status === 429
        ? "Transcription is busy right now. Keep this recording in the page and try again shortly."
        : "Transcription is temporarily unavailable. Keep this recording in the page and try again.",
      response.status === 429
        ? "transcription_rate_limited"
        : "transcription_provider_error",
      503,
      true
    );
  }

  const parsed = providerResponseSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (!parsed.success) {
    throw new LiveCoachTranscriptionError(
      "The transcription response was incomplete. Keep this recording in the page and try again.",
      "invalid_transcription_response",
      503,
      true
    );
  }
  return parsed.data.text;
}
