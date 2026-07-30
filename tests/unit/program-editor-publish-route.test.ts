import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(async () => ({})),
  getRouteUser: vi.fn(async () => ({ id: "owner-id" })),
  getPublishedProgramDraftReplay: vi.fn(async () => null),
  validateProgramDraftPublication: vi.fn(async () => ({
    ok: false as const,
    reason: "invalid" as const,
  })),
  publishProgramDraft: vi.fn(),
  createAutomaticSafetySnapshot: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/route-auth", () => ({ getRouteUser: mocks.getRouteUser }));
vi.mock("@/lib/program-editor-feature", () => ({
  isProgramEditorEnabled: () => true,
}));
vi.mock("@/services/program-publication", () => ({
  getPublishedProgramDraftReplay: mocks.getPublishedProgramDraftReplay,
  validateProgramDraftPublication: mocks.validateProgramDraftPublication,
  publishProgramDraft: mocks.publishProgramDraft,
}));
vi.mock("@/services/snapshots", () => ({
  createAutomaticSafetySnapshot: mocks.createAutomaticSafetySnapshot,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { POST } from "@/app/api/program/draft/publish/route";

describe("Program draft publication route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublishedProgramDraftReplay.mockResolvedValue(null);
    mocks.validateProgramDraftPublication.mockResolvedValue({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects obsolete review evidence before creating a safety snapshot", async () => {
    const response = await POST(
      new Request("http://localhost/api/program/draft/publish", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          draftId: "00000000-0000-4000-8000-000000000010",
          expectedRevision: 4,
          reviewHash: "a".repeat(64),
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: expect.stringMatching(/fresh review/i),
    });
    expect(mocks.createAutomaticSafetySnapshot).not.toHaveBeenCalled();
    expect(mocks.publishProgramDraft).not.toHaveBeenCalled();
  });
});
