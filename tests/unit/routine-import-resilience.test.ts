import { describe, expect, it } from "vitest";
import { structuredOutputTokenLimit } from "@/ai/provider";
import {
  collectSupersetRestTimings,
  inspectRoutineTextStructure,
  parseCanonicalRoutineText,
} from "@/ai/tasks/routine-parse/deterministic";
import { normalizeRoutineParseDraftEnvelope } from "@/ai/tasks/routine-parse/normalize";
import {
  PROGRAM_INPUT_MAX_WARMUP_ITEMS_PER_DAY,
  routineParseDraftSchema,
} from "@/ai/tasks/routine-parse/schema";
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
    expect(parsed?.data.schemaVersion).toBe("program-input/1");
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
        collectSupersetRestTimings(
          parsed?.data.days[0]?.exercises ?? [],
        ),
      ),
    ).toEqual({
      A: { betweenMembersSec: 30, afterRoundSec: 60 },
      B: { betweenMembersSec: 30, afterRoundSec: 60 },
    });
    expect(parsed?.unparsed).toEqual([]);
    expect(parsed?.clarifyingQuestions).toEqual([]);
  });

  it("keeps general preparation and first/later lift ramps as distinct ordered actions", () => {
    const source = `Program: Synthetic Warm-up Routine
Day 1 — Ordered preparation
Warm-up: Elliptical easy | load=2 min easy | notes=Raise body temperature
Warm-up: Bodyweight Squat | reps=10
Barbell Bench Press 3x6-8 @ 135 lb, rest 120 sec
Ramp-up: Empty bar | reps=10 | load=45 lb
Ramp-up: Fifty-five percent | reps=5 | load=55% of working load
Romanian Deadlift 3x8-10 @ 115 lb, rest 120 sec
Ramp-up: Lighter hinge prep | reps=5 | load=one lighter set`;

    const parsed = parseCanonicalRoutineText(source);
    expect(parsed).not.toBeNull();
    const day = parsed?.data.days[0];
    expect(day?.warmupItems).toEqual([
      expect.objectContaining({
        label: "Elliptical easy",
        beforeSlotLineageId: null,
        loadText: "2 min easy",
        notes: "Raise body temperature",
      }),
      expect.objectContaining({
        label: "Bodyweight Squat",
        reps: 10,
        beforeSlotLineageId: null,
      }),
      expect.objectContaining({
        label: "Empty bar",
        reps: 10,
        load: 45,
        loadUnit: "lb",
        beforeSlotLineageId: day?.exercises[0]?.lineageId,
      }),
      expect.objectContaining({
        label: "Fifty-five percent",
        reps: 5,
        loadPercent: 55,
        loadText: null,
        beforeSlotLineageId: day?.exercises[0]?.lineageId,
      }),
      expect.objectContaining({
        label: "Lighter hinge prep",
        reps: 5,
        loadText: "one lighter set",
        beforeSlotLineageId: day?.exercises[1]?.lineageId,
      }),
    ]);
    expect(day?.exercises.every((exercise) => exercise.notes === null)).toBe(
      true,
    );
    expect(inspectRoutineTextStructure(source).exerciseCount).toBe(2);
  });

  it("preserves explicitly unknown warm-up values as null with review ambiguities", () => {
    const parsed = parseCanonicalRoutineText(`Program: Synthetic Unknowns
Day 1 — Review
Warm-up: Owner decides during review | reps=? | load=? | notes=?
Goblet Squat 2x8-10, rest 60 sec`);

    expect(parsed?.confidence).toBeLessThan(0.9);
    expect(parsed?.data.days[0]?.warmupItems[0]).toMatchObject({
      label: "Owner decides during review",
      reps: null,
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: null,
      notes: null,
    });
    expect(parsed?.ambiguities.map((ambiguity) => ambiguity.field)).toEqual([
      "days[0].warmupItems[0].reps",
      "days[0].warmupItems[0].load",
      "days[0].warmupItems[0].notes",
    ]);
  });

  it("derives identical lineage from the normalized source, never provider IDs", () => {
    const makeDraft = (labels: { day: string; exercise: string; warmup: string }) =>
      routineParseDraftSchema.parse({
        data: {
          programName: "Synthetic Identity",
          days: [
            {
              name: labels.day,
              order: 0,
              warmupItems: [warmup(labels.warmup)],
              exercises: [exercise(labels.exercise)],
            },
          ],
        },
        confidence: 1,
        ambiguities: [],
        clarifyingQuestions: [],
        unparsed: [],
      });
    const source = "Program: Synthetic Identity\nDay 1\nSquat 3x8";
    const first = normalizeRoutineParseDraftEnvelope(
      makeDraft({ day: "Day 1", exercise: "Squat", warmup: "Easy bike" }),
      source,
    );
    const providerVariation = normalizeRoutineParseDraftEnvelope(
      makeDraft({
        day: "Day one",
        exercise: "Back squat",
        warmup: "Easy cycling",
      }),
      `  Program: Synthetic Identity\r\nDay 1\r\nSquat   3x8  `,
    );

    expect(providerVariation.data.days[0]?.lineageId).toBe(
      first.data.days[0]?.lineageId,
    );
    expect(providerVariation.data.days[0]?.warmupItems[0]?.key).toBe(
      first.data.days[0]?.warmupItems[0]?.key,
    );
    expect(providerVariation.data.days[0]?.exercises[0]?.lineageId).toBe(
      first.data.days[0]?.exercises[0]?.lineageId,
    );
  });

  it("rejects duplicated warm-up notes and malformed or oversized draft contracts", () => {
    const duplicate = draftEnvelope({
      warmupItems: [warmup("Easy bike")],
      exercises: [{ ...exercise("Squat"), notes: "Easy bike" }],
    });
    expect(routineParseDraftSchema.safeParse(duplicate).success).toBe(false);

    const duplicatedRamp = draftEnvelope({
      exercises: [
        {
          ...exercise("Squat"),
          notes: "Empty bar",
          rampUps: [warmup("Empty bar")],
        },
      ],
    });
    expect(routineParseDraftSchema.safeParse(duplicatedRamp).success).toBe(
      false,
    );

    const omittedUnknowns = draftEnvelope({
      warmupItems: [{ label: "Missing explicit fields" }],
    });
    expect(routineParseDraftSchema.safeParse(omittedUnknowns).success).toBe(
      false,
    );

    const contradictoryLoad = draftEnvelope({
      warmupItems: [
        {
          ...warmup("Contradictory loading"),
          load: 45,
          loadUnit: "lb",
          loadPercent: 50,
        },
      ],
    });
    expect(routineParseDraftSchema.safeParse(contradictoryLoad).success).toBe(
      false,
    );

    const oversized = draftEnvelope({
      warmupItems: Array.from(
        { length: PROGRAM_INPUT_MAX_WARMUP_ITEMS_PER_DAY + 1 },
        (_, index) => warmup(`Step ${index + 1}`, index),
      ),
    });
    expect(routineParseDraftSchema.safeParse(oversized).success).toBe(false);

    const unknownField = draftEnvelope({ extra: "not in program-input/1" });
    expect(routineParseDraftSchema.safeParse(unknownField).success).toBe(false);
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
      "unsupported_rep_sequence",
      "usage_control",
      "unknown",
    ] as const) {
      const message = routineImportFailureMessage(category);
      expect(message).toContain("current Program was not changed");
      expect(message).toContain("failed paste was discarded");
      expect(message).not.toContain("Synthetic Full Routine");
    }
    expect(routineImportFailureMessage("unsupported_rep_sequence")).toContain(
      "different rep targets for individual sets",
    );
  });
});

function warmup(label: string, sourceOrder = 0) {
  return {
    sourceOrder,
    label,
    reps: null,
    load: null,
    loadUnit: null,
    loadPercent: null,
    loadText: null,
    notes: null,
  };
}

function exercise(rawName: string) {
  return {
    rawName,
    sets: 3,
    reps: { kind: "range" as const, min: 8, max: 10 },
    load: null,
    loadUnit: null,
    restSec: 90,
    supersetKey: null,
    notes: null,
    rampUps: [],
  };
}

function draftEnvelope(
  dayOverrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    data: {
      programName: "Synthetic Contract",
      days: [
        {
          name: "Day 1",
          order: 0,
          warmupItems: [],
          exercises: [exercise("Squat")],
          ...dayOverrides,
        },
      ],
    },
    confidence: 1,
    ambiguities: [],
    clarifyingQuestions: [],
    unparsed: [],
  };
}
