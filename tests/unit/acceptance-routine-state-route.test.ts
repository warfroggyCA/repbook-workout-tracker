import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptanceEnabled: vi.fn(),
  getRouteUser: vi.fn(),
  getDb: vi.fn(),
  captureState: vi.fn(),
}));

vi.mock("@/lib/acceptance-runtime", () => ({
  isDisposableAcceptanceRuntime: mocks.acceptanceEnabled,
}));
vi.mock("@/lib/route-auth", () => ({ getRouteUser: mocks.getRouteUser }));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/services/acceptance-routine-state", () => ({
  captureAcceptanceRoutineState: mocks.captureState,
}));

import { GET } from "@/app/api/acceptance/routine-state/route";

describe("guarded acceptance routine-state route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acceptanceEnabled.mockReturnValue(false);
  });

  it("is absent outside the complete disposable acceptance runtime", async () => {
    const response = await GET();

    expect(response.status).toBe(404);
    expect(mocks.getRouteUser).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.captureState).not.toHaveBeenCalled();
  });

  it("requires an authenticated fixture owner inside acceptance", async () => {
    mocks.acceptanceEnabled.mockReturnValue(true);
    mocks.getRouteUser.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.captureState).not.toHaveBeenCalled();
  });

  it("returns only the bounded durable summary for an authenticated fixture owner", async () => {
    const db = { kind: "disposable" };
    const state = {
      programTree: { programs: 1, versions: 1, currentVersionNumbers: [1] },
      drafts: { count: 1, states: [{ status: "open", revision: 1 }] },
      proposals: { count: 0 },
      recommendations: { count: 0 },
      workouts: { sessions: 1, occurrences: 6, sets: 15 },
    };
    mocks.acceptanceEnabled.mockReturnValue(true);
    mocks.getRouteUser.mockResolvedValue({ id: "fixture-owner" });
    mocks.getDb.mockResolvedValue(db);
    mocks.captureState.mockResolvedValue(state);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", state });
    expect(mocks.captureState).toHaveBeenCalledWith(db, "fixture-owner");
  });
});
