import { describe, expect, it } from "vitest";
import {
  deriveProgramDayWarmupLines,
  formatProgramDayLabel,
  projectProgramPresentation,
  type ProgramPresentationSource,
} from "@/lib/program-presentation";
import { formatWarmupSetLine } from "@/lib/warmup";

describe("saved Program presentation", () => {
  it.each([
    ["Day 1 — Strength", 0, "Day 1 — Strength"],
    ["day 2: Hinge", 1, "Day 2 — Hinge"],
    ["DAY 3. Accessories", 2, "Day 3 — Accessories"],
    ["Day 4 · Conditioning", 3, "Day 4 — Conditioning"],
    ["Day 5", 4, "Day 5"],
    ["Day 2 — Mismatched", 0, "Day 1 — Day 2 — Mismatched"],
    ["Upper day strength", 0, "Day 1 — Upper day strength"],
    ["  Day 1   Strength  ", 0, "Day 1 — Strength"],
  ])("formats %j without repeating its matching ordinal", (name, index, expected) => {
    expect(formatProgramDayLabel(name, index)).toBe(expected);
    expect(name).toBe(name);
  });

  it("formats one meaningful load, reps, and notes without empty values", () => {
    expect(
      formatWarmupSetLine({
        label: "Primer",
        reps: 5,
        load: 85,
        loadUnit: "lb",
        loadPercent: 55,
        loadText: "Empty bar",
        notes: "Move smoothly",
      }),
    ).toBe("Primer · 85 lb · 5 reps · Move smoothly");
    expect(
      formatWarmupSetLine({
        label: "First ramp",
        reps: 5,
        loadPercent: 55,
        loadText: "Light",
      }),
    ).toBe("First ramp · 55% of work weight · 5 reps");
    expect(
      formatWarmupSetLine({
        label: "Empty bar",
        reps: 10,
        loadText: "Empty bar",
      }),
    ).toBe("Empty bar · 10 reps");
    expect(formatWarmupSetLine({ label: "Unloaded", reps: 8 })).toBe(
      "Unloaded · 8 reps",
    );
  });

  it("combines day and retained exercise guidance once in workout order", () => {
    expect(
      deriveProgramDayWarmupLines("Five minutes easy\nShoulder circles", [
        {
          exerciseName: "Bench Press",
          warmupNotes: "Five minutes easy",
          warmupSets: [
            { label: "Empty bar", reps: 10, loadText: "Empty bar" },
            { label: "Ramp", reps: 5, loadPercent: 55 },
          ],
        },
        {
          exerciseName: "Romanian Deadlift",
          warmupNotes: "Two hinge rehearsals",
          warmupSets: [],
        },
      ]),
    ).toEqual([
      "Five minutes easy",
      "Shoulder circles",
      "Before Bench Press: Empty bar · 10 reps",
      "Before Bench Press: Ramp · 55% of work weight · 5 reps",
      "Before Romanian Deadlift: Two hinge rehearsals",
    ]);
  });

  it("shows structured warm-up steps instead of a stale overview", () => {
    expect(
      deriveProgramDayWarmupLines(
        "Old overview that no longer controls the workout",
        [],
        [
          {
            key: "10000000-0000-4000-8000-000000000001",
            label: "Two minutes easy",
            reps: null,
            load: null,
            loadUnit: null,
            loadPercent: null,
            loadText: null,
            notes: null,
          },
          {
            key: "10000000-0000-4000-8000-000000000002",
            label: "Two smooth ramp-up sets",
            reps: null,
            load: null,
            loadUnit: null,
            loadPercent: null,
            loadText: null,
            notes: null,
          },
        ],
      ),
    ).toEqual(["Two minutes easy", "Two smooth ramp-up sets"]);
  });

  it("shows the full legacy overview instead of its generated 120-character prefix", () => {
    const lineageId = "10000000-0000-4000-8000-000000000001";
    const overview = [
      "Elliptical two minutes easy, then complete arm circles and scapular push-ups with a comfortable range of motion.",
      "Bench ramp-up: empty bar for ten, then three progressively heavier preparation sets.",
    ].join("\n");
    expect(overview.length).toBeGreaterThan(120);
    expect(
      deriveProgramDayWarmupLines(
        overview,
        [],
        [{
          key: lineageId,
          label: overview.slice(0, 120),
          reps: null,
          load: null,
          loadUnit: null,
          loadPercent: null,
          loadText: null,
          notes: null,
        }],
        lineageId,
      ),
    ).toEqual(overview.split("\n"));
  });

  it("projects every day and batched superset without mutating its source", () => {
    const source: ProgramPresentationSource = {
      program: { id: "program", name: "Fixture" },
      version: { id: "version", versionNo: 3 },
      groups: [{ id: "group", name: "Superset 1", restAfterRoundSec: 90 }],
      days: [
        {
          id: "day-2",
          lineageId: "lineage-2",
          name: "Day 2 — Pair",
          notes: null,
          warmupNotes: null,
          orderIdx: 1,
          intent: null,
          slots: [
            {
              id: "slot-2",
              lineageId: "slot-lineage-1",
              exercise: {
                id: "exercise-2",
                name: "Row",
                family: "Row",
                movementPattern: "horizontal_pull",
              },
              orderIdx: 1,
              supersetGroupId: "group",
              restSec: 90,
              notes: null,
              warmupNotes: null,
              warmupSets: [],
              prescription: null,
            },
            {
              id: "slot-1",
              lineageId: "slot-lineage-2",
              exercise: {
                id: "exercise-1",
                name: "Press",
                family: "Press",
                movementPattern: "horizontal_push",
              },
              orderIdx: 0,
              supersetGroupId: "group",
              restSec: 90,
              notes: null,
              warmupNotes: "Arm circles",
              warmupSets: [],
              prescription: null,
            },
          ],
        },
        {
          id: "day-1",
          lineageId: "lineage-1",
          name: "Day 1 — Straight sets",
          notes: null,
          warmupNotes: "Walk five minutes",
          orderIdx: 0,
          intent: null,
          slots: [],
        },
      ],
    };
    const before = structuredClone(source);
    const projected = projectProgramPresentation(source);

    expect(source).toEqual(before);
    expect(projected.days.map((day) => day.id)).toEqual(["day-1", "day-2"]);
    expect(projected.days[1].slots.map((slot) => slot.id)).toEqual([
      "slot-1",
      "slot-2",
    ]);
    expect(projected.days[1].warmupLines).toEqual(["Arm circles"]);
    expect(projected.days[1].slots[0].superset).toEqual({
      id: "group",
      name: "Superset 1",
      restAfterRoundSec: 90,
      memberNames: ["Press", "Row"],
    });
  });
});
