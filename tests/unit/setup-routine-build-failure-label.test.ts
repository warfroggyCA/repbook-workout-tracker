import { APICallError } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getDb: vi.fn(),
  getLibraryWithAvailability: vi.fn(),
  runControlledStructuredGeneration: vi.fn(),
  logServerEvent: vi.fn(),
}));

vi.mock("@/lib/user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/services/routine-import", () => ({
  getLibraryWithAvailability: mocks.getLibraryWithAvailability,
}));

vi.mock("@/lib/server-log", () => ({
  logServerEvent: mocks.logServerEvent,
}));

vi.mock("@/services/ai-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai-control")>();
  return {
    ...actual,
    runControlledStructuredGeneration:
      mocks.runControlledStructuredGeneration,
  };
});

vi.mock("@/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ai/provider")>();
  return {
    ...actual,
    isAIAvailable: () => true,
  };
});

import { buildSetupRoutineDraft } from "@/app/actions/setup";

describe("routine-build failure labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      profile: {
        id: "22222222-2222-4222-8222-222222222222",
        experience: "intermediate",
        goals: ["strength"],
        weeklyFrequency: 3,
        sessionLengthMin: 45,
        unit: "lb",
      },
    });
    mocks.getDb.mockResolvedValue({
      query: {
        constraints: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    });
    mocks.getLibraryWithAvailability.mockResolvedValue([
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Bench Press",
        movementPattern: "horizontal_push",
        available: true,
      },
    ]);
    mocks.runControlledStructuredGeneration.mockRejectedValue(
      new DOMException("Deterministic timeout.", "TimeoutError"),
    );
  });

  it("does not turn prose about one day from a Program into 'Day f'", async () => {
    const result = await buildSetupRoutineDraft(
      "Create one day from my current Program with Bench Press.",
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Coach timed out while building this request. Try again; the other days do not need to be shortened.",
    });
  });

  it.each(["Day 1", "Day 2", "Day 3"])(
    "keeps the exact %s heading in the failure message",
    async (heading) => {
      const result = await buildSetupRoutineDraft(
        `${heading}\n\nBench Press — 3 sets of 8.`,
      );

      expect(result).toEqual({
        ok: false,
        reason: `Coach timed out while building ${heading}. Try again; the other days do not need to be shortened.`,
      });
    },
  );

  it("does not log provider request, response, data, or cause content", async () => {
    mocks.runControlledStructuredGeneration.mockRejectedValue(
      new APICallError({
        message: "WT_SENTINEL_MESSAGE",
        url: "https://example.invalid/private",
        requestBodyValues: { prompt: "WT_SENTINEL_REQUEST" },
        statusCode: 503,
        responseHeaders: { "x-private": "WT_SENTINEL_HEADER" },
        responseBody: "WT_SENTINEL_RESPONSE",
        data: { error: { message: "WT_SENTINEL_DATA" } },
        cause: new Error("WT_SENTINEL_CAUSE"),
      })
    );

    await expect(
      buildSetupRoutineDraft("Day 1\n\nBench Press — 3 sets of 8.")
    ).resolves.toEqual({
      ok: false,
      reason:
        "Coach returned an unusable result for Day 1. Try again; if it repeats, submit that day by itself.",
    });
    expect(mocks.logServerEvent).toHaveBeenCalledWith(
      "error",
      "ai.setup_routine_build_failed",
      {
        userId: "11111111-1111-4111-8111-111111111111",
        routinePart: "Day 1",
        errorKind: "provider_api",
        providerStatusCode: 503,
        providerRetryable: true,
        causeKind: "unknown_error",
      }
    );
    expect(JSON.stringify(mocks.logServerEvent.mock.calls)).not.toContain(
      "WT_SENTINEL"
    );
  });
});
