import { afterEach, describe, expect, it, vi } from "vitest";
import {
  categorizeDiagnosticError,
  createDiagnosticEpisode,
  DIAGNOSTIC_EPISODE_MINUTES,
  DIAGNOSTIC_EVENT_SCHEMA_VERSION,
  DIAGNOSTIC_REDACTION_VERSION,
  DIAGNOSTIC_RETENTION_HOURS,
  logDiagnosticEvent,
} from "@/lib/server-log";
import { PRODUCT_VERSION } from "@/lib/product-version";

const NOW = new Date("2026-08-08T18:00:00.000Z");
const CORRELATION_ID = "2dc53f9e-d651-4c72-8b07-ca011afa2847";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured redacted diagnostic logger", () => {
  it("writes one versioned, retention-bounded event from the closed vocabulary", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = logDiagnosticEvent(
      "progression.job_failed",
      {
        attemptCount: 2,
        retryScheduled: true,
        errorCategory: "persistence",
      },
      { now: NOW, randomId: () => CORRELATION_ID },
    );

    expect(result).toBe("written");
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      schemaVersion: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
      redactionVersion: DIAGNOSTIC_REDACTION_VERSION,
      appVersion: PRODUCT_VERSION,
      at: NOW.toISOString(),
      retentionClass: "ephemeral_24h",
      retentionExpiresAt: new Date(
        NOW.getTime() + DIAGNOSTIC_RETENTION_HOURS * 60 * 60 * 1_000,
      ).toISOString(),
      correlationId: CORRELATION_ID,
      level: "error",
      event: "progression.job_failed",
      component: "progression",
      operation: "job",
      state: "failed",
      durationMs: null,
      errorCategory: "persistence",
      attemptCount: 2,
      retryScheduled: true,
    });
  });

  it("refuses unknown events, extra fields, missing fields, and invalid values", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const unsafe = logDiagnosticEvent as (
      event: string,
      fields: Record<string, unknown>,
    ) => string;

    expect(unsafe("private.event", {})).toBe("refused");
    expect(
      unsafe("settings.timezone_save_failed", {
        errorCategory: "persistence",
        userId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBe("refused");
    expect(unsafe("settings.timezone_save_failed", {})).toBe("refused");
    expect(
      unsafe("settings.timezone_save_failed", {
        errorCategory: "database said owner note text",
      }),
    ).toBe("refused");
    expect(write).not.toHaveBeenCalled();
  });

  it("records only bounded routine-import failure metadata", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      logDiagnosticEvent(
        "routine_import.parse_failed",
        {
          failureCategory: "output_incomplete",
          inputCharacterCount: 1_104,
          detectedDayCount: 3,
          detectedExerciseCount: 20,
          durationMs: 30_001,
        },
        { now: NOW, randomId: () => CORRELATION_ID },
      ),
    ).toBe("written");

    const output = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      event: "routine_import.parse_failed",
      component: "routine_import",
      operation: "parse",
      state: "failed",
      failureCategory: "output_incomplete",
      inputCharacterCount: 1_104,
      detectedDayCount: 3,
      detectedExerciseCount: 20,
      durationMs: 30_001,
    });
    expect(output).not.toContain("Private routine text");
    expect(output).not.toContain("userId");
  });

  it("reuses correlation only inside a valid short-lived episode", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const episode = createDiagnosticEpisode({
      now: NOW,
      randomId: () => CORRELATION_ID,
    });
    expect(episode).toEqual({
      correlationId: CORRELATION_ID,
      startedAt: NOW.toISOString(),
      expiresAt: new Date(
        NOW.getTime() + DIAGNOSTIC_EPISODE_MINUTES * 60 * 1_000,
      ).toISOString(),
    });

    logDiagnosticEvent(
      "settings.timezone_save_failed",
      { errorCategory: "persistence" },
      { now: NOW, episode },
    );
    logDiagnosticEvent(
      "settings.font_size_save_failed",
      { errorCategory: "persistence" },
      {
        now: new Date(
          NOW.getTime() + (DIAGNOSTIC_EPISODE_MINUTES + 1) * 60 * 1_000,
        ),
        episode,
      },
    );

    expect(JSON.parse(String(write.mock.calls[0]?.[0])).correlationId).toBe(
      CORRELATION_ID,
    );
    expect(JSON.parse(String(write.mock.calls[1]?.[0])).correlationId).toBeNull();
  });

  it("categorizes errors without emitting message, stack, or hostile names", () => {
    const sentinel = "WT_SENTINEL_PRIVATE_ERROR";
    expect(
      categorizeDiagnosticError(
        new DOMException(sentinel, "TimeoutError"),
        "runtime",
      ),
    ).toBe("timeout");
    expect(categorizeDiagnosticError(new Error(sentinel), "storage")).toBe(
      "storage",
    );

    const hostile = Object.defineProperty({}, "name", {
      get() {
        throw new Error(sentinel);
      },
    });
    expect(categorizeDiagnosticError(hostile, "unknown")).toBe("unknown");
    expect(
      JSON.stringify([
        categorizeDiagnosticError(new Error(sentinel), "storage"),
        categorizeDiagnosticError(hostile, "unknown"),
      ]),
    ).not.toContain(sentinel);
  });

  it("never throws when random generation or diagnostic output fails", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout unavailable");
    });

    expect(() =>
      logDiagnosticEvent(
        "settings.timezone_save_failed",
        { errorCategory: "persistence" },
        {
          now: NOW,
          randomId: () => {
            throw new Error("random unavailable");
          },
        },
      ),
    ).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
