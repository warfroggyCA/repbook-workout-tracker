import { describe, expect, it, vi } from "vitest";
import {
  LIVE_COACH_RECORDING_MAX_BYTES,
  LIVE_COACH_RECORDING_MAX_DURATION_MS,
  confirmedLiveCoachDictation,
  formatLiveCoachRecordingTime,
  liveCoachMicrophoneIssue,
  normalizeLiveCoachRecordingMediaType,
  parseLiveCoachTranscriptionResponse,
  selectLiveCoachRecordingMimeType,
} from "@/lib/live-coach-dictation";
import { handleLiveCoachTranscriptionRequest } from "@/services/live-coach-transcription-route";
import {
  LiveCoachTranscriptionError,
  transcribeLiveCoachAudio,
  validateLiveCoachAudioFile,
} from "@/services/live-coach-transcription";
import type { Db } from "@/db";
import type { AIUsageClaim } from "@/services/ai-control";

function audioFile(
  size = 128,
  type = "audio/webm;codecs=opus"
) {
  return new File([new Uint8Array(size)], "recording.webm", { type });
}

function authenticatedUser() {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    profile: {},
  };
}

function controlledRouteDependencies(
  transcribe: typeof transcribeLiveCoachAudio
) {
  const claim: AIUsageClaim = {
    id: "00000000-0000-4000-8000-000000000002",
    leaseId: "00000000-0000-4000-8000-000000000003",
    leaseExpiresAt: new Date("2026-07-13T20:01:00.000Z"),
    logicalKey: "test-transcription",
  };
  return {
    getUser: async () => authenticatedUser(),
    getDb: async () => ({}) as Db,
    claimUsage: async () => claim,
    completeUsage: async () => undefined,
    failUsage: async () => undefined,
    transcribe,
  };
}

function transcriptionRequest(input?: {
  file?: File;
  durationMs?: number;
  headers?: Record<string, string>;
}) {
  const form = new FormData();
  form.set("audio", input?.file ?? audioFile());
  form.set("durationMs", String(input?.durationMs ?? 2_000));
  const headers = new Headers(input?.headers);
  if (!headers.has("origin") && !headers.has("sec-fetch-site")) {
    headers.set("origin", "http://localhost");
    headers.set("sec-fetch-site", "same-origin");
  }
  return new Request("http://localhost/api/live-coach/transcribe", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("Live Coach dictation media contract", () => {
  it("normalizes supported browser formats and chooses the first usable recorder type", () => {
    expect(normalizeLiveCoachRecordingMediaType("audio/webm;codecs=opus")).toBe(
      "audio/webm"
    );
    expect(normalizeLiveCoachRecordingMediaType("video/webm")).toBeNull();
    expect(normalizeLiveCoachRecordingMediaType("audio/ogg")).toBeNull();
    expect(
      selectLiveCoachRecordingMimeType((value) => value === "audio/mp4")
    ).toBe("audio/mp4");
    expect(formatLiveCoachRecordingTime(1_001)).toBe("0:02");
  });

  it("provides specific microphone recovery guidance", () => {
    expect(liveCoachMicrophoneIssue({ name: "NotAllowedError" })).toContain(
      "Allow microphone access"
    );
    expect(liveCoachMicrophoneIssue({ name: "NotFoundError" })).toContain(
      "No microphone"
    );
    expect(liveCoachMicrophoneIssue({ name: "NotReadableError" })).toContain(
      "busy"
    );
  });

  it("validates audio size and media type again on the server", () => {
    expect(validateLiveCoachAudioFile(audioFile())).toBe("audio/webm");
    expect(() => validateLiveCoachAudioFile(audioFile(128, "text/plain"))).toThrow(
      LiveCoachTranscriptionError
    );
    expect(() =>
      validateLiveCoachAudioFile(audioFile(LIVE_COACH_RECORDING_MAX_BYTES + 1))
    ).toThrow("too large");
    expect(() => validateLiveCoachAudioFile(audioFile(0))).toThrow(
      "did not contain usable audio"
    );
  });

  it("parses only the bounded client response shape", () => {
    expect(
      parseLiveCoachTranscriptionResponse({ ok: true, transcript: "Reviewed" })
    ).toEqual({ ok: true, transcript: "Reviewed" });
    expect(
      parseLiveCoachTranscriptionResponse({
        ok: false,
        code: "invalid_audio",
        reason: "Record again.",
        retryable: false,
      })
    ).toMatchObject({ ok: false, retryable: false });
    expect(parseLiveCoachTranscriptionResponse({ ok: true })).toBeNull();
  });

  it("creates no message for cancel or discard and preserves confirmation identity", () => {
    expect(confirmedLiveCoachDictation({ type: "cancel" })).toBeNull();
    expect(confirmedLiveCoachDictation({ type: "discard" })).toBeNull();
    const decision = {
      type: "confirm" as const,
      transcript: "  Reviewed dictation.  ",
      clientKey: "7fd4d6d1-5081-4374-a9a8-67d851e0bbc0",
      target: {
        messageKind: "question" as const,
        sessionExerciseId: null,
        exerciseName: null,
        activeRestTimerSeconds: 75,
      },
    };
    expect(confirmedLiveCoachDictation(decision)).toMatchObject({
      transcript: "Reviewed dictation.",
      clientKey: decision.clientKey,
    });
    expect(confirmedLiveCoachDictation(decision)?.clientKey).toBe(
      decision.clientKey
    );
  });
});

describe("Live Coach transcription provider", () => {
  it("uses deterministic local transcription without a paid request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const transcript = await transcribeLiveCoachAudio(audioFile(), {
      useFake: true,
      fetcher,
    });
    expect(transcript).toContain("last set felt harder");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the recording to the server-side OpenAI transcription endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("model")).toBe("gpt-4o-transcribe");
      expect((body as FormData).get("file")).toBeInstanceOf(File);
      return Response.json({ text: "The reviewed workout note." });
    });
    await expect(
      transcribeLiveCoachAudio(audioFile(), {
        apiKey: "test-key",
        model: "gpt-4o-transcribe",
        fetcher,
      })
    ).resolves.toBe("The reviewed workout note.");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("marks invalid audio as permanent and provider interruptions as retryable", async () => {
    await expect(
      transcribeLiveCoachAudio(audioFile(), {
        apiKey: "test-key",
        fetcher: async () => new Response(null, { status: 400 }),
      })
    ).rejects.toMatchObject({
      code: "invalid_audio",
      retryable: false,
    });
    await expect(
      transcribeLiveCoachAudio(audioFile(), {
        apiKey: "test-key",
        fetcher: async () => {
          throw new TypeError("offline");
        },
      })
    ).rejects.toMatchObject({
      code: "transcription_network_error",
      retryable: true,
    });
    await expect(
      transcribeLiveCoachAudio(audioFile(), {
        apiKey: "test-key",
        fetcher: async () => new Response(null, { status: 401 }),
      })
    ).rejects.toMatchObject({
      code: "transcription_configuration_error",
      retryable: false,
    });
    await expect(
      transcribeLiveCoachAudio(audioFile(), { apiKey: "" })
    ).rejects.toMatchObject({
      code: "transcription_unavailable",
      retryable: false,
    });
  });
});

describe("authenticated Live Coach transcription route", () => {
  it("authenticates before reading or transcribing audio", async () => {
    const transcribe = vi.fn(async () => "Never called");
    const response = await handleLiveCoachTranscriptionRequest(
      new Request("http://localhost/api/live-coach/transcribe", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      {
        getUser: async () => null,
        transcribe,
      }
    );
    expect(response.status).toBe(401);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("blocks cross-site requests before provider access", async () => {
    const transcribe = vi.fn(async () => "Never called");
    const fetchSiteResponse = await handleLiveCoachTranscriptionRequest(
      transcriptionRequest({ headers: { "sec-fetch-site": "cross-site" } }),
      {
        getUser: async () => authenticatedUser(),
        transcribe,
      }
    );
    expect(fetchSiteResponse.status).toBe(403);
    const originResponse = await handleLiveCoachTranscriptionRequest(
      transcriptionRequest({ headers: { origin: "https://attacker.example" } }),
      {
        getUser: async () => authenticatedUser(),
        transcribe,
      }
    );
    expect(originResponse.status).toBe(403);
    expect(transcribe).not.toHaveBeenCalled();

    const sameOriginTranscribe = vi.fn(async () => "Allowed transcript");
    const browserFacingOriginResponse =
      await handleLiveCoachTranscriptionRequest(
        transcriptionRequest({
          headers: {
            host: "127.0.0.1:8621",
            origin: "http://127.0.0.1:8621",
            "sec-fetch-site": "same-site",
          },
        }),
        {
          getUser: async () => authenticatedUser(),
          transcribe: sameOriginTranscribe,
        }
      );
    expect(browserFacingOriginResponse.status).toBe(403);
    expect(sameOriginTranscribe).not.toHaveBeenCalled();

    const allowed = await handleLiveCoachTranscriptionRequest(
      transcriptionRequest({
        headers: {
          host: "127.0.0.1:8621",
          origin: "http://127.0.0.1:8621",
          "sec-fetch-site": "same-origin",
        },
      }),
      controlledRouteDependencies(sameOriginTranscribe)
    );
    expect(allowed.status).toBe(200);
    expect(sameOriginTranscribe).toHaveBeenCalledOnce();
  });

  it("rejects browser mutations that omit both provenance headers", async () => {
    const form = new FormData();
    form.set("audio", audioFile());
    form.set("durationMs", "2000");
    const transcribe = vi.fn(async () => "Never called");
    const response = await handleLiveCoachTranscriptionRequest(
      new Request("http://localhost/api/live-coach/transcribe", {
        method: "POST",
        body: form,
      }),
      { getUser: async () => authenticatedUser(), transcribe }
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("enforces duration, size, and media-type limits before transcription", async () => {
    const transcribe = vi.fn(async () => "Never called");
    const dependencies = {
      getUser: async () => authenticatedUser(),
      transcribe,
    };
    const tooLong = await handleLiveCoachTranscriptionRequest(
      transcriptionRequest({
        durationMs: LIVE_COACH_RECORDING_MAX_DURATION_MS + 1,
      }),
      dependencies
    );
    expect(tooLong.status).toBe(413);

    const tooLarge = await handleLiveCoachTranscriptionRequest(
      transcriptionRequest({
        file: audioFile(LIVE_COACH_RECORDING_MAX_BYTES + 1),
      }),
      dependencies
    );
    expect(tooLarge.status).toBe(413);

    const unsupported = await handleLiveCoachTranscriptionRequest(
      transcriptionRequest({ file: audioFile(128, "video/webm") }),
      dependencies
    );
    expect(unsupported.status).toBe(415);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("returns only the temporary transcript and writes no Live Coach record", async () => {
    const transcribe = vi.fn(async () => "Review this text before saving it.");
    const response = await handleLiveCoachTranscriptionRequest(
      transcriptionRequest(),
      controlledRouteDependencies(transcribe)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      transcript: "Review this text before saving it.",
    });
    expect(transcribe).toHaveBeenCalledOnce();
  });
});
