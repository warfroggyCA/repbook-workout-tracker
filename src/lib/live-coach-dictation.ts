export const LIVE_COACH_RECORDING_MAX_DURATION_MS = 60_000;
export const LIVE_COACH_RECORDING_MAX_BYTES = 5 * 1024 * 1024;
export const LIVE_COACH_RECORDING_MIN_BYTES = 16;

export const LIVE_COACH_RECORDING_MEDIA_TYPES = [
  "audio/webm",
  "audio/mp4",
  "audio/wav",
  "audio/mpeg",
] as const;

export type LiveCoachRecordingMediaType =
  (typeof LIVE_COACH_RECORDING_MEDIA_TYPES)[number];

export type LiveCoachTranscriptionResponse =
  | { ok: true; transcript: string }
  | {
      ok: false;
      code: string;
      reason: string;
      retryable: boolean;
    };

export type LiveCoachDictationTarget = {
  messageKind: "question" | "observation";
  sessionExerciseId: string | null;
  exerciseName: string | null;
  activeRestTimerSeconds: number | null;
};

export type LiveCoachDictationDecision =
  | { type: "cancel" | "discard" }
  | {
      type: "confirm";
      transcript: string;
      clientKey: string;
      target: LiveCoachDictationTarget;
    };

export function confirmedLiveCoachDictation(
  decision: LiveCoachDictationDecision
) {
  if (decision.type !== "confirm") return null;
  const transcript = decision.transcript.trim();
  if (transcript.length < 2 || transcript.length > 800) return null;
  return { ...decision, transcript };
}

const RECORDING_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/wav",
] as const;

export function normalizeLiveCoachRecordingMediaType(
  value: string
): LiveCoachRecordingMediaType | null {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return LIVE_COACH_RECORDING_MEDIA_TYPES.find(
    (candidate) => candidate === normalized
  ) ?? null;
}

export function liveCoachRecordingExtension(
  mediaType: LiveCoachRecordingMediaType
) {
  if (mediaType === "audio/webm") return "webm";
  if (mediaType === "audio/mp4") return "m4a";
  if (mediaType === "audio/wav") return "wav";
  return "mp3";
}

export function selectLiveCoachRecordingMimeType(
  isTypeSupported: (mimeType: string) => boolean
) {
  return RECORDING_CANDIDATES.find((candidate) => isTypeSupported(candidate)) ?? null;
}

export function formatLiveCoachRecordingTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function liveCoachMicrophoneIssue(error: unknown) {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow microphone access for this site in your browser settings, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone is available. Connect or enable a microphone, then try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The microphone is busy or unavailable. Close other apps using it, then try again.";
  }
  if (name === "AbortError") {
    return "The browser interrupted microphone setup. Try again when ready.";
  }
  return "The microphone could not start. Check the browser permission and selected input device, then try again.";
}

export function parseLiveCoachTranscriptionResponse(
  value: unknown
): LiveCoachTranscriptionResponse | null {
  if (!value || typeof value !== "object" || !("ok" in value)) return null;
  if (value.ok === true) {
    return "transcript" in value && typeof value.transcript === "string"
      ? { ok: true, transcript: value.transcript }
      : null;
  }
  if (value.ok !== false) return null;
  return "code" in value &&
    typeof value.code === "string" &&
    "reason" in value &&
    typeof value.reason === "string" &&
    "retryable" in value &&
    typeof value.retryable === "boolean"
    ? {
        ok: false,
        code: value.code,
        reason: value.reason,
        retryable: value.retryable,
      }
    : null;
}
