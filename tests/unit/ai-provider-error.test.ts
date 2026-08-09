import { readFileSync } from "node:fs";
import { APICallError } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sanitizeAIFinishReason,
  sanitizeAIProviderError,
} from "@/lib/ai-provider-error";
import { logDiagnosticEvent } from "@/lib/server-log";

const SENTINELS = [
  "WT_SENTINEL_MESSAGE",
  "WT_SENTINEL_REQUEST",
  "WT_SENTINEL_RESPONSE",
  "WT_SENTINEL_HEADER",
  "WT_SENTINEL_DATA",
  "WT_SENTINEL_CAUSE",
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI provider error privacy boundary", () => {
  it("retains only allowlisted diagnostics from request, response, data, and cause", () => {
    const error = new APICallError({
      message: SENTINELS[0],
      url: "https://example.invalid/private",
      requestBodyValues: {
        prompt: SENTINELS[1],
        nested: { value: SENTINELS[1] },
      },
      statusCode: 503,
      responseHeaders: { "x-private": SENTINELS[3] },
      responseBody: SENTINELS[2],
      isRetryable: true,
      data: {
        error: {
          code: SENTINELS[4],
          message: SENTINELS[4],
        },
      },
      cause: Object.assign(new Error(SENTINELS[5]), {
        name: "WT_SENTINEL_CAUSE_NAME",
        request: SENTINELS[1],
        response: SENTINELS[2],
      }),
    });

    const sanitized = sanitizeAIProviderError(error);

    expect(sanitized).toEqual({
      errorKind: "provider_api",
      providerStatusCode: 503,
      providerRetryable: true,
      causeKind: "unknown_error",
    });
    const serialized = JSON.stringify(sanitized);
    for (const sentinel of SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("emits the sanitized projection without leaking provider payloads", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = new APICallError({
      message: SENTINELS[0],
      url: "https://example.invalid/private",
      requestBodyValues: { prompt: SENTINELS[1] },
      statusCode: 429,
      responseHeaders: { "x-private": SENTINELS[3] },
      responseBody: SENTINELS[2],
      data: { error: { message: SENTINELS[4] } },
      cause: new Error(SENTINELS[5]),
    });

    logDiagnosticEvent("ai.coach_question_failed", {
      ...sanitizeAIProviderError(error),
    });

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      event: "ai.coach_question_failed",
      errorKind: "provider_api",
      providerStatusCode: 429,
      providerRetryable: true,
      causeKind: "unknown_error",
    });
    for (const sentinel of SENTINELS) {
      expect(line).not.toContain(sentinel);
    }
  });

  it("fails closed for hostile accessors, non-errors, and cyclic causes", () => {
    const hostile = {};
    Object.defineProperties(hostile, {
      name: {
        get() {
          throw new Error(SENTINELS[0]);
        },
      },
      statusCode: {
        get() {
          throw new Error(SENTINELS[2]);
        },
      },
      isRetryable: {
        get() {
          throw new Error(SENTINELS[3]);
        },
      },
      cause: {
        get() {
          throw new Error(SENTINELS[5]);
        },
      },
    });
    expect(sanitizeAIProviderError(hostile)).toEqual({
      errorKind: "unknown_error",
      providerStatusCode: null,
      providerRetryable: null,
      causeKind: null,
    });
    expect(sanitizeAIProviderError(SENTINELS[0])).toEqual({
      errorKind: "non_error",
      providerStatusCode: null,
      providerRetryable: null,
      causeKind: null,
    });

    const cyclic: Record<string, unknown> = {
      name: "AI_APICallError",
      statusCode: 500,
      isRetryable: true,
    };
    cyclic.cause = cyclic;
    expect(sanitizeAIProviderError(cyclic)).toEqual({
      errorKind: "provider_api",
      providerStatusCode: 500,
      providerRetryable: true,
      causeKind: "cyclic",
    });
  });

  it("allowlists normalized finish reasons and rejects raw provider text", () => {
    expect(sanitizeAIFinishReason("stop")).toBe("stop");
    expect(sanitizeAIFinishReason("provider-sentinel-finish-reason")).toBe(
      "unknown",
    );
  });

  it("keeps every provider-error logging path on the central boundary", () => {
    const expectedPaths = new Map([
      ["src/app/actions/coaching.ts", "sanitizeAIProviderError"],
      ["src/app/actions/setup.ts", "sanitizeAIProviderError"],
      ["src/app/actions/import.ts", "sanitizeAIProviderError"],
      ["src/app/api/live-coach/respond/route.ts", "sanitizeAIProviderError"],
      ["src/ai/provider.ts", "sanitizeAIFinishReason"],
    ]);
    for (const [path, sanitizer] of expectedPaths) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain(sanitizer);
    }
    expect(
      readFileSync("src/app/actions/coaching.ts", "utf8")
    ).not.toContain("console.error");
    expect(readFileSync("src/app/actions/setup.ts", "utf8")).not.toContain(
      "describeAIParseError"
    );
    expect(readFileSync("src/ai/provider.ts", "utf8")).not.toContain(
      "rawFinishReason",
    );
  });
});
