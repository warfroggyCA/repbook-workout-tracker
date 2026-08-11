import { describe, expect, it } from "vitest";
import { structuredOutputTokenLimit } from "@/ai/provider";
import {
  collectSupersetRoundRestSeconds,
  inspectRoutineTextStructure,
  parseCanonicalRoutineText,
} from "@/ai/tasks/routine-parse/deterministic";
import {
  routineImportFailureCategory,
  routineImportFailureMessage,
} from "@/lib/routine-import-error";

const SYNTHETIC_THREE_DAY_ROUTINE = `Program: Synthetic Full Routine — 3-Day Recomposition

Day 1 — Focus A
Incline Dumbbell Press 3x8-12, rest 120 sec
Lat Pulldown 3x8-12, rest 90 sec
Bulgarian Split Squat 3x8-12, rest 90 sec
A1 Dumbbell Lateral Raise 3x12-20, rest 30 sec
A2 Triceps Pushdown 2x10-15, rest 60 sec
B1 Dumbbell Rear Delt Fly 2x12-20, rest 30 sec
B2 EZ-Bar Curl 2x10-15, rest 60 sec

Day 2 — Focus B
Barbell Back Squat 3x6-10, rest 120 sec
Romanian Deadlift 3x8-10, rest 120 sec
Barbell Bench Press 3x6-10, rest 120 sec
Chest-Supported Dumbbell Row 3x8-12, rest 120 sec
A1 Dumbbell Calf Raise 2x10-20, rest 30 sec
A2 Dead Bug 2x8-12, rest 60 sec

Day 3 — Focus C
Incline Barbell Bench Press 3x8-12, rest 120 sec
Barbell Overhead Press 3x6-10, rest 120 sec
Lat Pulldown 3x10-15, rest 90 sec
A1 Dumbbell Lateral Raise 2x15-25, rest 30 sec
A2 Triceps Pushdown 3x10-15, rest 60 sec
B1 Dumbbell Rear Delt Fly 2x15-20, rest 30 sec
B2 Hammer Curl 3x10-15, rest 60 sec`;

describe("routine import resilience", () => {
  it("parses a complete synthetic three-day, twenty-exercise routine without AI", () => {
    const parsed = parseCanonicalRoutineText(SYNTHETIC_THREE_DAY_ROUTINE);

    expect(inspectRoutineTextStructure(SYNTHETIC_THREE_DAY_ROUTINE)).toEqual({
      characterCount: SYNTHETIC_THREE_DAY_ROUTINE.length,
      dayCount: 3,
      exerciseCount: 20,
    });
    expect(parsed?.data.programName).toBe(
      "Synthetic Full Routine — 3-Day Recomposition",
    );
    expect(parsed?.data.days.map((day) => day.exercises.length)).toEqual([
      7, 6, 7,
    ]);
    expect(parsed?.data.days[0]?.exercises[0]).toMatchObject({
      rawName: "Incline Dumbbell Press",
      sets: 3,
      reps: { kind: "range", min: 8, max: 12 },
      restSec: 120,
      supersetKey: null,
    });
    expect(
      parsed?.data.days[0]?.exercises.slice(3).map((exercise) =>
        exercise.supersetKey,
      ),
    ).toEqual(["A", "A", "B", "B"]);
    expect(
      Object.fromEntries(
        collectSupersetRoundRestSeconds(
          parsed?.data.days[0]?.exercises ?? [],
        ),
      ),
    ).toEqual({ A: 60, B: 60 });
    expect(parsed?.unparsed).toEqual([]);
    expect(parsed?.clarifyingQuestions).toEqual([]);
  });

  it("supports explicit load and minute rest in the canonical format", () => {
    const parsed = parseCanonicalRoutineText(`Program: Synthetic Loaded Routine
Day 1 — Loaded
Barbell Bench Press 3x6-8 @ 135 lb, rest 2 min`);

    expect(parsed?.data.days[0]?.exercises[0]).toMatchObject({
      load: 135,
      loadUnit: "lb",
      restSec: 120,
    });
  });

  it("fails closed instead of dropping unsupported text or orphaned supersets", () => {
    expect(
      parseCanonicalRoutineText(`Program: Synthetic Notes
Day 1 — Focus
Warm up thoroughly
Barbell Bench Press 3x6-8, rest 120 sec`),
    ).toBeNull();
    expect(
      parseCanonicalRoutineText(`Program: Synthetic Superset
Day 1 — Focus
A1 Barbell Bench Press 3x6-8, rest 120 sec`),
    ).toBeNull();
  });

  it("scales the AI fallback output allowance to the routine size", () => {
    expect(
      structuredOutputTokenLimit(
        "routine_parse",
        "Day 1\nBarbell Bench Press 3x8-10, rest 120 sec",
      ),
    ).toBe(2_300);
    expect(
      structuredOutputTokenLimit("routine_parse", SYNTHETIC_THREE_DAY_ROUTINE),
    ).toBe(8_000);
    expect(structuredOutputTokenLimit("routine_parse", "x".repeat(20_000))).toBe(
      8_000,
    );
  });

  it("categorizes fallback failures and returns recovery-specific safe copy", () => {
    expect(routineImportFailureCategory("timeout")).toBe("timeout");
    expect(routineImportFailureCategory("provider_output")).toBe(
      "output_incomplete",
    );
    expect(routineImportFailureCategory("provider_api")).toBe(
      "provider_failure",
    );

    for (const category of [
      "timeout",
      "output_incomplete",
      "provider_failure",
      "persistence_failure",
      "usage_control",
      "unknown",
    ] as const) {
      const message = routineImportFailureMessage(category);
      expect(message).toContain("current Program was not changed");
      expect(message).toContain("failed paste was discarded");
      expect(message).not.toContain("Synthetic Full Routine");
    }
  });
});
