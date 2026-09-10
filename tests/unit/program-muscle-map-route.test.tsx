import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getActiveProgramPresentation: vi.fn() }));
vi.mock("@/services/program-presentation", () => mocks);
vi.mock("@/db", () => ({ getDb: async () => ({}) }));
vi.mock("@/lib/user", () => ({
  getCurrentUser: async () => ({ id: "synthetic-owner" }),
}));
vi.mock("@/components/muscle-map/program-muscle-map", () => ({
  ProgramMuscleMap: ({
    initialDayId,
    unavailableDay,
  }: {
    initialDayId: string | null;
    unavailableDay: boolean;
  }) => (
    <div data-day={initialDayId ?? "all"} data-unavailable={unavailableDay} />
  ),
}));
import Page from "@/app/(main)/program/muscles/page";

describe("muscle-map saved-day links", () => {
  it.each([
    [{ day: "stable-day" }, "stable-day", false],
    [{ day: "old-template-id" }, "all", true],
    [{ day: "foreign-day" }, "all", true],
    [{ day: ["stable-day", "foreign-day"] }, "all", false],
    [{}, "all", false],
  ])(
    "resolves only current owned day lineage: %j",
    async (query, expected, unavailable) => {
      mocks.getActiveProgramPresentation.mockResolvedValue({
        program: { id: "p" },
        days: [{ id: "new-template-id", lineageId: "stable-day" }],
      });
      const html = renderToStaticMarkup(
        await Page({
          searchParams: Promise.resolve(query),
          params: Promise.resolve({}),
        }),
      );
      expect(html).toContain(`data-day="${expected}"`);
      expect(html).toContain(`data-unavailable="${unavailable}"`);
      expect(mocks.getActiveProgramPresentation).toHaveBeenLastCalledWith(
        {},
        "synthetic-owner",
      );
    },
  );
});
