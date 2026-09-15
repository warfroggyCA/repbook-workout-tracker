import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  draft: vi.fn(),
  library: vi.fn(),
  generate: vi.fn(),
  visible: vi.fn(),
}));
vi.mock("@/db", () => ({ getDb: async () => ({}) }));
vi.mock("@/lib/user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/program-editor-feature", () => ({
  isProgramEditorEnabled: () => true,
}));
vi.mock("@/ai/provider", () => ({ isAIAvailable: () => false }));
vi.mock("@/services/program-drafts", () => ({
  getOpenProgramDraft: mocks.draft,
}));
vi.mock("@/services/routine-import", () => ({
  getLibraryWithAvailability: mocks.library,
}));
vi.mock("@/services/exercise-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/exercise-map")>()),
  loadVisibleExercises: mocks.visible,
}));
vi.mock("@/services/ai-control", () => ({
  runControlledStructuredGeneration: mocks.generate,
  AIControlError: class extends Error {},
}));
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
  text: "Before Synthetic press: 20 kg × 5.",
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
    {
      id: id(5),
      name: "Synthetic press",
      available: true,
      metricType: "weight_reps",
    },
  ]);
  mocks.visible.mockResolvedValue([
    { id: id(5), aliases: [{ alias: "sample press" }] },
  ]);
  mocks.generate.mockRejectedValue(new Error("AI must not be called"));
});
describe("program text action", () => {
  it("uses the authenticated saved document and prepares edits without configured AI or writes", async () => {
    expect(await proposeProgramTextUpdate(input)).toMatchObject({
      ok: true,
      proposal: {
        baseDocument: document,
        questions: [],
        changes: [
          expect.objectContaining({
            operations: [
              expect.objectContaining({
                kind: "warmup",
                slotId: id(4),
                items: [
                  expect.objectContaining({
                    load: 20,
                    reps: 5,
                    loadUnit: "kg",
                  }),
                ],
              }),
            ],
          }),
        ],
      },
    });
    expect(mocks.draft).toHaveBeenCalledWith({}, id(9));
    expect(mocks.visible).toHaveBeenCalledWith({}, id(9));
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("uses visible aliases and flags unknown instructions without a provider fallback", async () => {
    expect(
      await proposeProgramTextUpdate({
        ...input,
        text: "Before sample press: 10 kg × 7.",
      }),
    ).toMatchObject({
      ok: true,
      proposal: { questions: [], changes: [expect.any(Object)] },
    });
    expect(
      await proposeProgramTextUpdate({
        ...input,
        text: "Make everything optimal",
      }),
    ).toMatchObject({
      ok: true,
      proposal: {
        changes: [],
        questions: [expect.stringContaining("could not resolve")],
      },
    });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("refuses another draft or stale revision before loading the library", async () => {
    expect(
      await proposeProgramTextUpdate({ ...input, draftId: id(10) }),
    ).toMatchObject({ ok: false });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.library).not.toHaveBeenCalled();
  });
  it("rejects a draft that advances during comparison", async () => {
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
  it("preserves the request and does not reveal database errors", async () => {
    mocks.library.mockRejectedValue(new Error("secret connection string"));
    const result = await proposeProgramTextUpdate(input);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("text is still here"),
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("authenticates before inspecting user state", async () => {
    mocks.user.mockRejectedValue(new Error("unauthorized"));
    await expect(proposeProgramTextUpdate(input)).rejects.toThrow(
      "unauthorized",
    );
    expect(mocks.draft).not.toHaveBeenCalled();
  });
});
