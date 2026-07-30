import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptanceEnabled: vi.fn(),
  getRouteUser: vi.fn(),
  getDb: vi.fn(),
  captureState: vi.fn(),
}));

vi.mock("@/lib/acceptance-runtime", () => ({
  isStage6DisposableAcceptanceRuntime: mocks.acceptanceEnabled,
}));
vi.mock("@/lib/route-auth", () => ({ getRouteUser: mocks.getRouteUser }));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/services/simulation-mutation-state", () => ({
  captureSimulationMutationState: mocks.captureState,
}));

import { GET } from "@/app/api/acceptance/simulation-state/route";

describe("guarded acceptance simulation-state route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acceptanceEnabled.mockReturnValue(false);
  });

  it("is absent outside the complete disposable acceptance runtime", async () => {
    const response = await GET();
    expect(response.status).toBe(404);
    expect(mocks.getRouteUser).not.toHaveBeenCalled();
  });

  it("requires the authenticated disposable fixture owner", async () => {
    mocks.acceptanceEnabled.mockReturnValue(true);
    mocks.getRouteUser.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns only counts and a digest for the owned canonical snapshot", async () => {
    const db = { kind: "disposable" };
    const state = {
      schemaVersion: "25",
      counts: { users: 1, total: 1 },
      digest: "a".repeat(64),
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
