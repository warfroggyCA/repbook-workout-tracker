import { beforeEach, describe, expect, it, vi } from "vitest";

const programMocks = vi.hoisted(() => ({
  getActiveProgramVersion: vi.fn(),
  getTemplatesWithSlots: vi.fn(),
}));

vi.mock("@/services/program", () => programMocks);

import { getActiveProgramPresentation } from "@/services/program-presentation";

function template(lineageId: string, groupId: string | null, orderIdx: number) {
  return {
    template: {
      id: `template-${lineageId}`,
      lineageId,
      name: `Day ${orderIdx + 1}`,
      notes: null,
      warmupNotes: null,
      orderIdx,
    },
    slots: [
      {
        slot: {
          id: `slot-${lineageId}`,
          orderIdx: 0,
          supersetGroupId: groupId,
          restSec: 90,
          notes: null,
          warmupNotes: null,
          warmupSets: [],
        },
        exercise: {
          id: `exercise-${lineageId}`,
          name: `Exercise ${orderIdx + 1}`,
          family: null,
          movementPattern: "squat",
        },
        prescription: null,
      },
    ],
  };
}

describe("saved Program presentation loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    programMocks.getActiveProgramVersion.mockResolvedValue({
      program: { id: "program", name: "Program" },
      version: { id: "version", versionNo: 1 },
    });
  });

  it("loads every referenced superset in one bounded batch", async () => {
    programMocks.getTemplatesWithSlots.mockResolvedValue([
      template("day-1", "group-1", 0),
      template("day-2", "group-1", 1),
      template("day-3", "group-2", 2),
    ]);
    const findMany = vi.fn().mockResolvedValue([
      { id: "group-1", name: "Pair 1", restAfterRoundSec: 90 },
      { id: "group-2", name: "Pair 2", restAfterRoundSec: 75 },
    ]);
    const db = { query: { supersetGroups: { findMany } } };

    const result = await getActiveProgramPresentation(db as never, "owner");

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(result?.days).toHaveLength(3);
    expect(result?.days.map((day) => day.slots[0].superset?.id)).toEqual([
      "group-1",
      "group-1",
      "group-2",
    ]);
  });

  it("does not issue an empty superset query", async () => {
    programMocks.getTemplatesWithSlots.mockResolvedValue([
      template("day-1", null, 0),
    ]);
    const findMany = vi.fn();
    const db = { query: { supersetGroups: { findMany } } };

    const result = await getActiveProgramPresentation(db as never, "owner");

    expect(findMany).not.toHaveBeenCalled();
    expect(result?.days[0].slots[0].superset).toBeNull();
  });
});
