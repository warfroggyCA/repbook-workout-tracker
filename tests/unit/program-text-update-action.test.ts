import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  draft: vi.fn(),
  library: vi.fn(),
  generate: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/db", () => ({ getDb: async () => ({}) }));
vi.mock("@/lib/user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/program-editor-feature", () => ({
  isProgramEditorEnabled: () => true,
}));
vi.mock("@/ai/provider", () => ({ isAIAvailable: () => true }));
vi.mock("@/services/program-drafts", () => ({
  getOpenProgramDraft: mocks.draft,
}));
vi.mock("@/services/routine-import", () => ({
  getLibraryWithAvailability: mocks.library,
}));
vi.mock("@/services/ai-control", () => ({
  runControlledStructuredGeneration: mocks.generate,
  AIControlError: class extends Error {},
}));
vi.mock("@/lib/server-log", () => ({ logDiagnosticEvent: mocks.log }));
import { proposeProgramTextUpdate } from "@/app/actions/program-text-update";
import { createDefaultProgramSlot } from "@/lib/program-editor-client";
import {
  createSuggestedDayIntent,
  programDocumentV3Schema,
} from "@/lib/program-document";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const slot = createDefaultProgramSlot(id(5), id(4));
const document = programDocumentV3Schema.parse({
  schemaVersion: "3",
  programId: id(1),
  baseVersionId: id(2),
  name: "Synthetic",
  days: [
    {
      lineageId: id(3),
      name: "Upper",
      notes: null,
      warmupNotes: null,
      warmupItems: [],
      intent: createSuggestedDayIntent([slot]),
      supersets: [],
      exercises: [slot],
    },
  ],
});
const input = {
  text: "Change preparation",
  draftId: id(8),
  revision: 2,
  activeDayId: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: id(9) });
  mocks.draft.mockResolvedValue({
    draft: { id: id(8), revision: 2, document },
    baseAdvanced: false,
  });
  mocks.library.mockResolvedValue([
    { id: id(5), name: "Synthetic press", available: true },
  ]);
  mocks.generate.mockResolvedValue({
    value: { changes: [], questions: ["Which preparation?"] },
  });
});
describe("program text action", () => {
  it("uses the authenticated saved document and returns clarification without writes", async () => {
    expect(await proposeProgramTextUpdate(input)).toMatchObject({
      ok: true,
      proposal: { questions: ["Which preparation?"] },
    });
    const generated = JSON.parse(mocks.generate.mock.calls[0][2].input);
    expect(generated.currentProgram).toEqual(document);
    expect(mocks.draft).toHaveBeenCalledWith({}, id(9));
  });
  it("refuses another draft or stale revision before spending an AI call", async () => {
    expect(
      await proposeProgramTextUpdate({ ...input, draftId: id(10) }),
    ).toMatchObject({ ok: false });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("rejects a draft that advances during generation", async () => {
    mocks.draft
      .mockResolvedValueOnce({
        draft: { id: id(8), revision: 2, document },
        baseAdvanced: false,
      })
      .mockResolvedValueOnce({
        draft: { id: id(8), revision: 3, document },
        baseAdvanced: false,
      });
    expect(await proposeProgramTextUpdate(input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("while"),
    });
  });
  it("does not reveal provider messages or credentials", async () => {
    mocks.generate.mockRejectedValue(
      Object.assign(new Error("secret provider payload"), {
        name: "AI_APICallError",
        statusCode: 401,
        isRetryable: false,
      }),
    );
    const result = await proposeProgramTextUpdate(input);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("configuration"),
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("secret");
  });
  it("authenticates before inspecting user state", async () => {
    mocks.user.mockRejectedValue(new Error("unauthorized"));
    await expect(proposeProgramTextUpdate(input)).rejects.toThrow(
      "unauthorized",
    );
    expect(mocks.draft).not.toHaveBeenCalled();
  });
});
