import { describe, it, expect } from "vitest";
import { requiresConfirmation, CONFIDENCE_THRESHOLD } from "@/ai/envelope";
import { logParseSchema } from "@/ai/tasks/log-parse/schema";
import { equipmentParseSchema } from "@/ai/tasks/equipment-parse/schema";
import { routineBuildSchema } from "@/ai/tasks/routine-build/schema";
import { ROUTINE_BUILD_SYSTEM } from "@/ai/tasks/routine-build/prompt";
import { parseCleanLog, parseCleanLogLine } from "@/engine/quick-log-regex";
import {
  exerciseNameSimilarity,
  extractExplicitWorkExerciseNames,
  routineBuildContextForRequest,
  splitRoutineBuildRequests,
} from "@/lib/routine-build-chunks";

const cleanEnvelope = {
  confidence: 1,
  ambiguities: [],
  clarifyingQuestions: [],
  unparsed: [],
};

describe("log_parse schema (plan §13 contract 5)", () => {
  it("accepts the canonical messy bench log", () => {
    // "Bench 135 for 8, 8, 7. Last set was hard. Slight shoulder pinch.
    //  Skipped curls because I ran out of time."
    const parsed = logParseSchema.safeParse({
      data: {
        semanticsVersion: 2,
        entries: [
          {
            kind: "sets",
            rawExercise: "Bench",
            sets: [
              { weight: 135, weightUnit: "lb", reps: 8, rpeHint: null },
              { weight: 135, weightUnit: "lb", reps: 8, rpeHint: null },
              { weight: 135, weightUnit: "lb", reps: 7, rpeHint: "hard" },
            ],
          },
          { kind: "pain", bodyPart: "shoulder", severity: null, rawExercise: "Bench" },
          {
            kind: "skip",
            rawExercise: "curls",
            reasonCode: "time_limit_reached",
          },
        ],
      },
      confidence: 0.8,
      ambiguities: [
        { field: "entries[1].severity", issue: "'slight' is not a number", options: ["2"] },
      ],
      clarifyingQuestions: [],
      unparsed: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects invented enum values and out-of-range numbers", () => {
    expect(
      logParseSchema.safeParse({
        data: {
          semanticsVersion: 2,
          entries: [
            { kind: "sets", rawExercise: "Bench", sets: [{ weight: 135, weightUnit: "lb", reps: 8, rpeHint: "brutal" }] },
          ],
        },
        ...cleanEnvelope,
      }).success
    ).toBe(false);
    expect(
      logParseSchema.safeParse({
        data: {
          semanticsVersion: 2,
          entries: [{ kind: "pain", bodyPart: "shoulder", severity: 15, rawExercise: null }],
        },
        ...cleanEnvelope,
      }).success
    ).toBe(false);
  });

  it("rejects payloads missing the envelope", () => {
    expect(logParseSchema.safeParse({
      data: { semanticsVersion: 2, entries: [] },
    }).success).toBe(false);
  });
});

describe("equipment_parse schema (plan §13 contract 1)", () => {
  it("parses the canonical messy equipment string shape with nulls + ambiguities", () => {
    const parsed = equipmentParseSchema.safeParse({
      data: {
        items: [
          {
            type: "dumbbell",
            label: "dumbbells up to 35",
            quantity: 1,
            attrs: {
              minWeight: null,
              maxWeight: 35,
              unit: null, // not stated — must be asked
              adjustable: null,
              pair: null,
              increments: null,
              denominations: null,
              brand: null,
              barWeight: null,
              adjustableBench: null,
            },
          },
          {
            type: "bands",
            label: "Bodylastics bands",
            quantity: 1,
            attrs: {
              minWeight: null, maxWeight: null, unit: null, adjustable: null,
              pair: null, increments: null, denominations: null, brand: "Bodylastics",
              barWeight: null, adjustableBench: null,
            },
          },
        ],
      },
      confidence: 0.7,
      ambiguities: [
        { field: "items[0].attrs.unit", issue: "unit not stated", options: ["lb", "kg"] },
        { field: "items[0].attrs.adjustable", issue: "fixed or adjustable?", options: ["fixed", "adjustable"] },
      ],
      clarifyingQuestions: ["Which plate sizes do you have, and how many of each?"],
      unparsed: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("requires ambiguity options to be present, with null for no concise choices", () => {
    const payload = {
      data: { items: [] },
      confidence: 0.7,
      ambiguities: [{ field: "items[0]", issue: "Needs clarification", options: null }],
      clarifyingQuestions: [],
      unparsed: [],
    };
    expect(equipmentParseSchema.safeParse(payload).success).toBe(true);
    expect(
      equipmentParseSchema.safeParse({
        ...payload,
        ambiguities: [{ field: "items[0]", issue: "Needs clarification" }],
      }).success
    ).toBe(false);
  });

  it("rejects invented equipment types", () => {
    expect(
      equipmentParseSchema.safeParse({
        data: {
          items: [
            {
              type: "smith_machine_3000",
              label: "?",
              quantity: 1,
              attrs: {
                minWeight: null, maxWeight: null, unit: null, adjustable: null,
                pair: null, increments: null, denominations: null, brand: null,
                barWeight: null, adjustableBench: null,
              },
            },
          ],
        },
        ...cleanEnvelope,
      }).success
    ).toBe(false);
  });
});

describe("routine_build schema", () => {
  it("does not infer machine compatibility from a generic equipment category", () => {
    expect(ROUTINE_BUILD_SYSTEM).toContain("machine geometry");
    expect(ROUTINE_BUILD_SYSTEM).toContain("surface that uncertainty for review");
  });

  it("splits explicitly separated routines while carrying global rules", () => {
    const requests = splitRoutineBuildRequests(`Intro
ROUTINE TITLE: Day 1
MAIN WORKOUT:\nBench
ROUTINE TITLE: Day 2
MAIN WORKOUT:\nSquat
ROUTINE TITLE: Day 3
MAIN WORKOUT:\nRow
GLOBAL PROGRESSION RULES:\nKeep 1-2 RIR.`);

    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain("ROUTINE TITLE: Day 1");
    expect(requests[0]).not.toContain("ROUTINE TITLE: Day 2");
    expect(requests[2]).toContain("Keep 1-2 RIR");
    expect(requests.every((request) => request.includes("exactly one day")))
      .toBe(true);
  });

  it("gives each detailed day an exact work-exercise checklist", () => {
    const names = extractExplicitWorkExerciseNames(`WARM-UP:
1. Elliptical — 2 minutes
MAIN WORKOUT:
1. Bench Press (Barbell) — 4×5–8
SUPERSET A:
2A. Lateral Raise (Dumbbell) — 3×12–20
2B. Triceps Pressdown — 3×10–15`);

    expect(names).toEqual([
      "Bench Press (Barbell)",
      "Lateral Raise (Dumbbell)",
      "Triceps Pressdown",
    ]);

    const requests = splitRoutineBuildRequests(`PROGRAM NAME OVERRIDE: Demo Owner's Ideal 3-day
ROUTINE TITLE: Day 1
MAIN WORKOUT:
1. Bench Press (Barbell) — 4×5–8
ROUTINE TITLE: Day 2
MAIN WORKOUT:
1. Squat (Barbell) — 4×5–8`);

    expect(requests[0]).toContain("contains exactly 1 work exercises");
    expect(requests[0]).toContain("1. Bench Press (Barbell)");
    expect(requests[0]).toContain("Do not turn section headings");
    expect(
      requests.every((request) =>
        request.includes("PROGRAM NAME OVERRIDE: Demo Owner's Ideal 3-day")
      )
    ).toBe(true);
  });

  it("splits a natural multi-day Program update and gives each part its current day", () => {
    const update = `Day 1

* Bench Press: standardize to 4×5–8
* Replace EZ Bar Curl with Incline Dumbbell Curl — 3×8–12
* Keep Bulgarian Split Squat at 2 sets for now
* Optional: Face Pull — 1–2×15–20

Day 2

* Squat: standardize to 4×5–8
* Romanian Deadlift: change to 3×8–10
* Replace current curl with Zottman Curl — 2×10–12
* Add Overhead Cable Triceps Extension — 2×10–15
* Run rear-delt fly, Zottman curl, and overhead triceps extension as a 2-round tri-set

Day 3

* Lat Pulldown: increase from 1 set to 3×10–15
* Keep Incline Bench at 3×8–12
* Keep Overhead Press at 3×6–10
* Replace Triceps Pushdown with Overhead Cable Triceps Extension — 3×10–15
* Superset it with EZ Bar Curl — 3×10–15
* Keep Lateral Raise at 2×15–25`;
    const requests = splitRoutineBuildRequests(update);

    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain("one complete updated day");
    expect(requests[0]).toContain("Optional: Face Pull");
    expect(requests[0]).not.toContain("Zottman Curl");
    expect(requests[1]).toContain("current curl");
    expect(requests[1]).toContain("tri-set");
    expect(requests[2]).toContain("Superset it with EZ Bar Curl");
    expect(requests[2]).not.toContain("Bench Press: standardize");

    const currentProgram = {
      name: "Current Program",
      days: [1, 2, 3].map((day) => ({
        lineageId: `00000000-0000-4000-8000-00000000000${day}`,
        name: `Day ${day}`,
        exercises: [{
          exerciseId: `10000000-0000-4000-8000-00000000000${day}`,
          name: day === 2 ? "EZ Bar Curl" : "Bench Press",
          sets: 3,
          repMin: 8,
          repMax: 12,
          restSec: 90,
          group: null,
        }],
      })),
    };

    expect(
      routineBuildContextForRequest(requests[1], currentProgram, null).days,
    ).toEqual([currentProgram.days[1]]);
  });

  it("recognizes reordered exact names and flags material substitutions", () => {
    expect(
      exerciseNameSimilarity(
        "Incline Bench Press (Barbell)",
        "Incline Barbell Bench Press"
      )
    ).toBe(1);
    expect(
      exerciseNameSimilarity("Lat Pulldown (Cable)", "Lat Pulldown")
    ).toBe(1);
    expect(
      exerciseNameSimilarity("Incline Dumbbell Curl", "EZ-Bar Curl")
    ).toBeLessThan(0.67);
  });

  it("accepts structured warm-ups and per-set notes", () => {
    const parsed = routineBuildSchema.safeParse({
      data: {
        programName: "Demo Owner's Ideal 3-day",
        days: [
          {
            name: "Day 1",
            notes: "Target 40 minutes. Keep 1–2 RIR on work sets.",
            warmupNotes: "Five minutes easy before lifting.",
            exercises: [
              {
                requestedName: "Bench Press (Barbell)",
                exerciseId: "11111111-1111-4111-8111-111111111111",
                sets: 4,
                repMin: 5,
                repMax: 8,
                targetLoad: null,
                restSec: 120,
                supersetGroup: null,
                notes: "Keep work sets clean.",
                warmup: {
                  notes: "Ramp up before the work sets.",
                  sets: [
                    {
                      label: "Empty bar",
                      reps: 10,
                      load: null,
                      loadUnit: null,
                      loadPercent: null,
                      loadText: "empty bar",
                      notes: null,
                    },
                    {
                      label: "~55% work weight",
                      reps: 5,
                      load: null,
                      loadUnit: null,
                      loadPercent: 55,
                      loadText: null,
                      notes: null,
                    },
                  ],
                },
                setNotes: [
                  "Controlled descent.",
                  "Same setup.",
                  "Same setup.",
                  "Stop before grinding.",
                ],
              },
            ],
          },
        ],
        rationale: null,
      },
      ...cleanEnvelope,
    });
    expect(parsed.success).toBe(true);
  });

  it("requires the explicit warm-up and set-note fields", () => {
    const parsed = routineBuildSchema.safeParse({
      data: {
        days: [
          {
            name: "Day 1",
            exercises: [
              {
                exerciseId: "11111111-1111-4111-8111-111111111111",
                sets: 3,
                repMin: 8,
                repMax: 12,
                targetLoad: null,
                restSec: 90,
                supersetGroup: null,
                notes: null,
              },
            ],
          },
        ],
        rationale: null,
      },
      ...cleanEnvelope,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("requiresConfirmation (the iron rule)", () => {
  const base = { data: {}, confidence: 1, ambiguities: [], clarifyingQuestions: [], unparsed: [] };

  it("clean, confident parses skip confirmation prompting", () => {
    expect(requiresConfirmation(base)).toBe(false);
  });

  it("any ambiguity forces confirmation", () => {
    expect(
      requiresConfirmation({ ...base, ambiguities: [{ field: "x", issue: "?", options: null }] })
    ).toBe(true);
  });

  it("low confidence forces confirmation", () => {
    expect(
      requiresConfirmation({ ...base, confidence: CONFIDENCE_THRESHOLD - 0.01 })
    ).toBe(true);
  });

  it("unparsed fragments force confirmation", () => {
    expect(requiresConfirmation({ ...base, unparsed: ["???"] })).toBe(true);
  });
});

describe("quick-log regex fast path (plan §8: no AI for clean input)", () => {
  it("parses 'Bench 135x8,8,7'", () => {
    const entry = parseCleanLogLine("Bench 135x8,8,7");
    expect(entry).toEqual({
      kind: "sets",
      rawExercise: "Bench",
      sets: [
        { weight: 135, weightUnit: "lb", reps: 8, rpeHint: null },
        { weight: 135, weightUnit: "lb", reps: 8, rpeHint: null },
        { weight: 135, weightUnit: "lb", reps: 7, rpeHint: null },
      ],
    });
  });

  it("parses 'goblet squat 35 for 12, 12, 10'", () => {
    const entry = parseCleanLogLine("goblet squat 35 for 12, 12, 10");
    expect(entry?.kind).toBe("sets");
    if (entry?.kind === "sets") {
      expect(entry.rawExercise).toBe("goblet squat");
      expect(entry.sets.map((s) => s.reps)).toEqual([12, 12, 10]);
      expect(entry.sets[0].weight).toBe(35);
    }
  });

  it("preserves an explicit kilogram unit and uses the supplied default otherwise", () => {
    const explicit = parseCleanLogLine("Deadlift 100kg x5", "lb");
    const defaulted = parseCleanLogLine("Deadlift 100x5", "kg");
    expect(explicit?.kind === "sets" && explicit.sets[0].weightUnit).toBe("kg");
    expect(defaulted?.kind === "sets" && defaulted.sets[0].weightUnit).toBe("kg");
  });

  it("parses bodyweight lines 'push-ups 15, 12, 10'", () => {
    const entry = parseCleanLogLine("push-ups 15, 12, 10");
    expect(entry?.kind).toBe("sets");
    if (entry?.kind === "sets") expect(entry.sets[0].weight).toBeNull();
  });

  it("refuses messy input so it falls through to AI", () => {
    expect(parseCleanLogLine("Bench felt heavy, shoulder pinch on last set")).toBeNull();
    expect(
      parseCleanLog("Bench 135x8,8,7\nskipped curls because I ran out of time")
    ).toBeNull(); // one messy line poisons the whole input — all-or-nothing
  });

  it("multi-line clean input parses fully", () => {
    const entries = parseCleanLog("Bench 135x8,8,7\nDumbbell Row 35x10,10,10");
    expect(entries).toHaveLength(2);
  });
});
