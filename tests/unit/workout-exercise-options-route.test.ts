import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(async () => ({ kind: "test-db" })),
  getRouteUser: vi.fn(),
  alternatives: vi.fn(),
  replacements: vi.fn(),
}));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/route-auth", () => ({ getRouteUser: mocks.getRouteUser }));
vi.mock("@/services/exercise-alternatives", () => ({
  getExerciseAlternativeOptions: mocks.alternatives,
}));
vi.mock("@/services/exercise-replacements", () => ({
  getExerciseReplacementOptions: mocks.replacements,
}));

import { GET } from "@/app/api/session/exercise-options/route";
import { WorkoutExerciseOptionsUnavailableError } from "@/services/workout-exercise-options-errors";

const exerciseId = "00000000-0000-4000-8000-000000000001";

function request(mode: string, sessionExerciseId = exerciseId) {
  const query = new URLSearchParams({ mode, sessionExerciseId });
  return new Request(
    `http://localhost/api/session/exercise-options?${query.toString()}`,
  );
}

describe("authenticated active-workout exercise options route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRouteUser.mockResolvedValue({ id: "owner-id" });
  });

  it("requires authentication and rejects malformed identities", async () => {
    mocks.getRouteUser.mockResolvedValue(null);
    const unauthorized = await GET(request("replacement"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toContain("no-store");
    expect(mocks.getDb).not.toHaveBeenCalled();

    mocks.getRouteUser.mockResolvedValue({ id: "owner-id" });
    const invalid = await GET(request("replacement", "not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(mocks.replacements).not.toHaveBeenCalled();
  });

  it("routes each read through the owner-scoped service without caching", async () => {
    const replacementOptions = { currentExerciseId: "replacement", items: [] };
    mocks.replacements.mockResolvedValue(replacementOptions);
    const replacement = await GET(request("replacement"));
    expect(replacement.status).toBe(200);
    expect(replacement.headers.get("cache-control")).toContain("private");
    expect(replacement.headers.get("cache-control")).toContain("no-store");
    await expect(replacement.json()).resolves.toEqual({
      ok: true,
      options: replacementOptions,
    });
    expect(mocks.replacements).toHaveBeenCalledWith(
      { kind: "test-db" },
      "owner-id",
      exerciseId,
    );

    const alternativeOptions = { currentExerciseId: "alternative", items: [] };
    mocks.alternatives.mockResolvedValue(alternativeOptions);
    const alternative = await GET(request("alternative"));
    await expect(alternative.json()).resolves.toEqual({
      ok: true,
      options: alternativeOptions,
    });
    expect(mocks.alternatives).toHaveBeenCalledWith(
      { kind: "test-db" },
      "owner-id",
      exerciseId,
    );
  });

  it("does not expose service errors", async () => {
    mocks.replacements.mockRejectedValue(new Error("private database detail"));
    const response = await GET(request("replacement"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message:
        "The exercise catalog could not be loaded. Try again or return to the workout.",
    });
  });

  it("distinguishes a positively identified inactive workout", async () => {
    mocks.alternatives.mockRejectedValue(
      new WorkoutExerciseOptionsUnavailableError(
        "workout_not_active",
        "private service detail",
      ),
    );
    const response = await GET(request("alternative"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "Only an active workout can be changed.",
    });
  });
});
