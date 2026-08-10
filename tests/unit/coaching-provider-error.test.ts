import { APICallError } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getDb: vi.fn(),
  createCoachingAnswer: vi.fn(),
  createTrainingReview: vi.fn(),
  evaluateRecentProgression: vi.fn(),
  audit: vi.fn(),
  logDiagnosticEvent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/db", () => ({
  getDb: mocks.getDb,
}));
vi.mock("@/services/coaching", () => ({
  createCoachingAnswer: mocks.createCoachingAnswer,
  createTrainingReview: mocks.createTrainingReview,
}));
vi.mock("@/services/progression", () => ({
  evaluateRecentProgression: mocks.evaluateRecentProgression,
}));
vi.mock("@/services/audit", () => ({
  audit: mocks.audit,
}));
vi.mock("@/lib/server-log", () => ({
  logDiagnosticEvent: mocks.logDiagnosticEvent,
}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));
vi.mock("@/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ai/provider")>();
  return {
    ...actual,
    isAIAvailable: () => true,
  };
});

import { askCoach, generateTrainingReview } from "@/app/actions/coaching";

function providerError() {
  return new APICallError({
    message: "WT_SENTINEL_MESSAGE",
    url: "https://example.invalid/private",
    requestBodyValues: { prompt: "WT_SENTINEL_REQUEST" },
    statusCode: 503,
    responseHeaders: { "x-private": "WT_SENTINEL_HEADER" },
    responseBody: "WT_SENTINEL_RESPONSE",
    data: { error: { message: "WT_SENTINEL_DATA" } },
    cause: new Error("WT_SENTINEL_CAUSE"),
  });
}

describe("Coach provider failure logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      profile: { coachingPrefs: {} },
    });
    mocks.getDb.mockResolvedValue({});
    mocks.evaluateRecentProgression.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
  });

  it("keeps a failed generated review generic and logs only allowlisted fields", async () => {
    mocks.createTrainingReview.mockRejectedValue(providerError());

    await expect(generateTrainingReview()).resolves.toEqual({
      ok: false,
      reason:
        "Coach could not finish that request. Your data is safe; please try again.",
    });

    expect(mocks.logDiagnosticEvent).toHaveBeenCalledWith(
      "ai.coach_review_failed",
      {
        errorKind: "provider_api",
        providerStatusCode: 503,
        providerRetryable: true,
        causeKind: "unknown_error",
      }
    );
    expect(JSON.stringify(mocks.logDiagnosticEvent.mock.calls)).not.toContain(
      "WT_SENTINEL"
    );
  });

  it("keeps a failed answer generic and logs only allowlisted fields", async () => {
    mocks.createCoachingAnswer.mockRejectedValue(providerError());

    await expect(askCoach("How should I train today?")).resolves.toEqual({
      ok: false,
      reason:
        "Coach could not finish that request. Your data is safe; please try again.",
    });

    expect(mocks.logDiagnosticEvent).toHaveBeenCalledWith(
      "ai.coach_question_failed",
      {
        errorKind: "provider_api",
        providerStatusCode: 503,
        providerRetryable: true,
        causeKind: "unknown_error",
      }
    );
    expect(JSON.stringify(mocks.logDiagnosticEvent.mock.calls)).not.toContain(
      "WT_SENTINEL"
    );
  });
});
