"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Mic, RotateCcw, Square, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  LIVE_COACH_RECORDING_MAX_BYTES,
  LIVE_COACH_RECORDING_MAX_DURATION_MS,
  LIVE_COACH_RECORDING_MIN_BYTES,
  type LiveCoachDictationDecision,
  type LiveCoachDictationTarget,
  formatLiveCoachRecordingTime,
  liveCoachMicrophoneIssue,
  liveCoachRecordingExtension,
  normalizeLiveCoachRecordingMediaType,
  parseLiveCoachTranscriptionResponse,
  selectLiveCoachRecordingMimeType,
} from "@/lib/live-coach-dictation";
import { createClientUuid } from "@/lib/client-uuid";

type Props = {
  target: LiveCoachDictationTarget;
  onDecision: (
    decision: LiveCoachDictationDecision
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
};

type DictationPhase =
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "failed"
  | "review";

type StopIntent = "transcribe" | "discard" | "error";

const NAVIGATION_WARNING =
  "This unsent dictation recording exists only in this page. Leave and discard it?";

export function LiveCoachDictation({ target, onDecision }: Props) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [reviewText, setReviewText] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [hasRecording, setHasRecording] = useState(false);
  const [recordedTarget, setRecordedTarget] =
    useState<LiveCoachDictationTarget | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordedBytesRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const recordingDurationRef = useRef(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const stopIntentsRef = useRef<WeakMap<MediaRecorder, StopIntent>>(
    new WeakMap()
  );
  const sizeLimitExceededRef = useRef(false);
  const audioRef = useRef<Blob | null>(null);
  const reviewClientKeyRef = useRef<string | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const operationRef = useRef(0);
  const confirmingRef = useRef(false);

  const hasUnsentRecording =
    phase === "requesting" ||
    phase === "recording" ||
    phase === "transcribing" ||
    (phase === "failed" && hasRecording);

  useEffect(() => {
    if (!hasUnsentRecording) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeLinkNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const element = event.target instanceof Element ? event.target : null;
      const anchor = element?.closest("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      if (!window.confirm(NAVIGATION_WARNING)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeLinkNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", beforeLinkNavigation, true);
    };
  }, [hasUnsentRecording]);

  useEffect(
    () => () => {
      operationRef.current += 1;
      transcriptionAbortRef.current?.abort();
      if (elapsedTimerRef.current != null) {
        window.clearInterval(elapsedTimerRef.current);
      }
      const recorder = recorderRef.current;
      if (recorder) {
        stopIntentsRef.current.set(recorder, "discard");
      }
      if (recorder?.state === "recording") {
        recorder.stop();
      }
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      audioRef.current = null;
    },
    []
  );

  function stopElapsedTimer() {
    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }

  function stopMicrophone() {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }

  function releaseRecording() {
    audioRef.current = null;
    recordingDurationRef.current = 0;
    setHasRecording(false);
  }

  function resetReviewState() {
    setReviewText("");
    reviewClientKeyRef.current = null;
    setRecordedTarget(null);
    confirmingRef.current = false;
  }

  function resetToIdle() {
    operationRef.current += 1;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    stopElapsedTimer();
    stopMicrophone();
    const recorder = recorderRef.current;
    if (recorder) stopIntentsRef.current.set(recorder, "discard");
    if (recorder?.state === "recording") recorder.stop();
    releaseRecording();
    resetReviewState();
    chunksRef.current = [];
    recordedBytesRef.current = 0;
    sizeLimitExceededRef.current = false;
    setElapsedMs(0);
    setIssue(null);
    setRetryable(false);
    setPhase("idle");
  }

  async function requestTranscription(blob: Blob, durationMs: number) {
    const operation = ++operationRef.current;
    if (!navigator.onLine) {
      setIssue(
        "You are offline. This recording is still available only in this page. Reconnect, then retry or discard it."
      );
      setRetryable(true);
      setPhase("failed");
      return;
    }

    const mediaType = normalizeLiveCoachRecordingMediaType(blob.type);
    if (!mediaType) {
      releaseRecording();
      setIssue(
        "This browser produced an unsupported recording format. Record again with a supported browser or device."
      );
      setRetryable(false);
      setPhase("failed");
      return;
    }

    setIssue(null);
    setPhase("transcribing");
    const abortController = new AbortController();
    transcriptionAbortRef.current = abortController;
    const form = new FormData();
    form.set(
      "audio",
      new File(
        [blob],
        `live-coach-recording.${liveCoachRecordingExtension(mediaType)}`,
        { type: mediaType }
      )
    );
    form.set("durationMs", String(durationMs));

    try {
      const response = await fetch("/api/live-coach/transcribe", {
        method: "POST",
        body: form,
        signal: abortController.signal,
      });
      const payload = parseLiveCoachTranscriptionResponse(
        await response.json().catch(() => null)
      );
      if (operation !== operationRef.current) return;
      if (!payload) {
        setIssue(
          "The transcription response was incomplete. This recording is still available in the page to retry or discard."
        );
        setRetryable(true);
        setPhase("failed");
        return;
      }
      if (!response.ok || !payload.ok) {
        const failure = payload.ok
          ? {
              reason:
                "Transcription could not be confirmed. This recording is still available in the page to retry or discard.",
              retryable: true,
            }
          : payload;
        if (!failure.retryable) releaseRecording();
        setIssue(failure.reason);
        setRetryable(failure.retryable);
        setPhase("failed");
        return;
      }

      releaseRecording();
      setReviewText(payload.transcript.trim());
      try {
        reviewClientKeyRef.current ??= createClientUuid();
      } catch {
        setIssue(
          "The transcript is ready, but this device could not create a secure save identity. Keep this page open and try confirming again."
        );
      }
      setRetryable(false);
      setPhase("review");
    } catch (error) {
      if (operation !== operationRef.current) return;
      if (abortController.signal.aborted) return;
      setIssue(
        error instanceof TypeError
          ? "The connection was interrupted. This recording is still available only in this page to retry or discard."
          : "Transcription did not finish. This recording is still available only in this page to retry or discard."
      );
      setRetryable(true);
      setPhase("failed");
    } finally {
      if (operation === operationRef.current) {
        transcriptionAbortRef.current = null;
      }
    }
  }

  function finishRecording(recorder: MediaRecorder) {
    stopElapsedTimer();
    stopMicrophone();
    recorderRef.current = null;

    const stopIntent = stopIntentsRef.current.get(recorder) ?? "discard";
    stopIntentsRef.current.delete(recorder);
    if (stopIntent === "discard") {
      resetToIdle();
      return;
    }
    if (stopIntent === "error") return;

    const durationMs = Math.min(
      Math.max(Date.now() - recordingStartedAtRef.current, 1),
      LIVE_COACH_RECORDING_MAX_DURATION_MS
    );
    recordingDurationRef.current = durationMs;
    setElapsedMs(durationMs);
    const mediaType = normalizeLiveCoachRecordingMediaType(recorder.mimeType);
    const blob = mediaType
      ? new Blob(chunksRef.current, { type: mediaType })
      : new Blob(chunksRef.current, { type: recorder.mimeType });
    chunksRef.current = [];

    if (
      sizeLimitExceededRef.current ||
      blob.size > LIVE_COACH_RECORDING_MAX_BYTES
    ) {
      releaseRecording();
      setIssue(
        "The recording reached the 5 MB limit. Record a shorter message and try again."
      );
      setRetryable(false);
      setPhase("failed");
      return;
    }
    if (blob.size < LIVE_COACH_RECORDING_MIN_BYTES) {
      releaseRecording();
      setIssue(
        "The recording did not contain usable audio. Check the microphone and record again."
      );
      setRetryable(false);
      setPhase("failed");
      return;
    }

    audioRef.current = blob;
    setHasRecording(true);
    void requestTranscription(blob, durationMs);
  }

  async function startRecording() {
    if (phase !== "idle" && phase !== "failed") return;
    if (recorderRef.current) return;
    if (!navigator.onLine) {
      setIssue(
        "Connect to the internet before starting dictation. Audio is not stored in the offline outbox."
      );
      setRetryable(false);
      setPhase("failed");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setIssue(
        "This browser does not support microphone recording for dictation. You can still type the message."
      );
      setRetryable(false);
      setPhase("failed");
      return;
    }

    const mimeType = selectLiveCoachRecordingMimeType((candidate) =>
      MediaRecorder.isTypeSupported(candidate)
    );
    if (!mimeType) {
      setIssue(
        "This browser cannot create a supported audio format. You can still type the message or use another browser."
      );
      setRetryable(false);
      setPhase("failed");
      return;
    }

    resetReviewState();
    releaseRecording();
    setIssue(null);
    setElapsedMs(0);
    setPhase("requesting");
    const requestOperation = ++operationRef.current;
    setRecordedTarget({ ...target });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      if (requestOperation !== operationRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recordedBytesRef.current = 0;
      sizeLimitExceededRef.current = false;
      stopIntentsRef.current.set(recorder, "transcribe");

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size <= 0) return;
        chunksRef.current.push(event.data);
        recordedBytesRef.current += event.data.size;
        if (
          recordedBytesRef.current > LIVE_COACH_RECORDING_MAX_BYTES &&
          recorder.state === "recording"
        ) {
          sizeLimitExceededRef.current = true;
          recorder.stop();
        }
      });
      recorder.addEventListener("stop", () => finishRecording(recorder), {
        once: true,
      });
      recorder.addEventListener(
        "error",
        () => {
          stopIntentsRef.current.set(recorder, "error");
          stopElapsedTimer();
          stopMicrophone();
          releaseRecording();
          chunksRef.current = [];
          setIssue(
            "The browser interrupted recording. Check the microphone and record again."
          );
          setRetryable(false);
          setPhase("failed");
        },
        { once: true }
      );

      recordingStartedAtRef.current = Date.now();
      recorder.start(1_000);
      setPhase("recording");
      elapsedTimerRef.current = window.setInterval(() => {
        const elapsed = Math.min(
          Date.now() - recordingStartedAtRef.current,
          LIVE_COACH_RECORDING_MAX_DURATION_MS
        );
        setElapsedMs(elapsed);
        if (
          elapsed >= LIVE_COACH_RECORDING_MAX_DURATION_MS &&
          recorder.state === "recording"
        ) {
          stopIntentsRef.current.set(recorder, "transcribe");
          recorder.stop();
        }
      }, 250);
    } catch (error) {
      if (requestOperation !== operationRef.current) return;
      stopMicrophone();
      releaseRecording();
      setIssue(liveCoachMicrophoneIssue(error));
      setRetryable(false);
      setPhase("failed");
    }
  }

  function stopAndTranscribe() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    stopIntentsRef.current.set(recorder, "transcribe");
    setPhase("transcribing");
    recorder.stop();
  }

  async function cancelRecording() {
    const recorder = recorderRef.current;
    if (recorder) stopIntentsRef.current.set(recorder, "discard");
    if (recorder?.state === "recording") recorder.stop();
    await onDecision({ type: "cancel" });
    resetToIdle();
  }

  async function discardDictation() {
    await onDecision({ type: "discard" });
    resetToIdle();
  }

  function retryTranscription() {
    const audio = audioRef.current;
    if (!audio) return;
    void requestTranscription(audio, recordingDurationRef.current);
  }

  function recordAgain() {
    resetToIdle();
    void startRecording();
  }

  async function confirmTranscript() {
    if (confirmingRef.current) return;
    const transcript = reviewText.trim();
    let clientKey = reviewClientKeyRef.current;
    if (!clientKey) {
      try {
        clientKey = createClientUuid();
        reviewClientKeyRef.current = clientKey;
      } catch {
        setIssue(
          "This device still cannot create a secure save identity. The transcript remains in this page; copy it before leaving."
        );
        return;
      }
    }
    if (
      transcript.length < 2 ||
      transcript.length > 800 ||
      !recordedTarget
    ) {
      return;
    }
    confirmingRef.current = true;
    const result = await onDecision({
      type: "confirm",
      transcript,
      clientKey,
      target: recordedTarget,
    });
    if (!result.ok) {
      confirmingRef.current = false;
      setIssue(result.reason);
      return;
    }
    resetToIdle();
  }

  const targetLabel = recordedTarget?.exerciseName ?? "the whole workout";

  return (
    <section className="rounded-xl border bg-muted/20 p-3" aria-label="Push-to-talk dictation">
      {phase === "idle" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Prefer to speak?</p>
            <p className="text-xs text-muted-foreground">
              Record up to one minute, then review the text before anything is saved.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => void startRecording()}>
            <Mic className="size-4" /> Start dictation
          </Button>
        </div>
      ) : phase === "requesting" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="flex items-center gap-2 text-sm">
            <Mic className="size-4" /> Waiting for microphone permission…
          </p>
          <Button type="button" variant="outline" size="sm" onClick={cancelRecording}>
            <X className="size-3.5" /> Cancel
          </Button>
        </div>
      ) : phase === "recording" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2" role="status" aria-live="polite">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive">
              <span className="size-2.5 rounded-full bg-destructive" aria-hidden="true" />
              Recording
            </p>
            <p className="font-mono text-sm tabular-nums">
              {formatLiveCoachRecordingTime(elapsedMs)} / 1:00
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            The recording stays only in this page until it is transcribed or discarded.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={stopAndTranscribe}>
              <Square className="size-4 fill-current" /> Stop and transcribe
            </Button>
            <Button type="button" variant="outline" onClick={cancelRecording}>
              <X className="size-4" /> Cancel recording
            </Button>
          </div>
        </div>
      ) : phase === "transcribing" ? (
        <div className="space-y-2">
          <p role="status" className="text-sm font-medium">
            Transcribing recording…
          </p>
          <p className="text-xs text-muted-foreground">
            Keep this page open. The recording is not placed in the offline outbox.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={discardDictation}>
            <Trash2 className="size-3.5" /> Discard recording
          </Button>
        </div>
      ) : phase === "failed" ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {issue}
          </p>
          <div className="flex flex-wrap gap-2">
            {retryable && hasRecording ? (
              <Button type="button" variant="outline" onClick={retryTranscription}>
                <RotateCcw className="size-4" /> Retry transcription
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={recordAgain}>
                <Mic className="size-4" /> Record again
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={discardDictation}>
              <Trash2 className="size-4" /> Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Review before saving</p>
            <p className="text-xs text-muted-foreground">
              This will be saved as a {recordedTarget?.messageKind ?? "question"} about {targetLabel} only after you confirm it.
            </p>
          </div>
          <Textarea
            aria-label="Reviewed dictation transcript"
            value={reviewText}
            onChange={(event) => {
              setReviewText(event.target.value);
              setIssue(null);
            }}
            rows={3}
            maxLength={800}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{reviewText.length} / 800 characters</span>
            {reviewText.trim().length > 800 && <span>Shorten the transcript before confirming.</span>}
          </div>
          {issue && (
            <p role="alert" className="text-sm text-destructive">
              {issue}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={confirmTranscript}
              disabled={reviewText.trim().length < 2 || reviewText.trim().length > 800}
            >
              <Check className="size-4" /> Confirm reviewed text
            </Button>
            <Button type="button" variant="outline" onClick={discardDictation}>
              <Trash2 className="size-4" /> Discard transcript
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
