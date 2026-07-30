import { describe, it, expect } from "vitest";
import {
  routineParseSchema,
  repSpecToRange,
} from "@/ai/tasks/routine-parse/schema";
import { exerciseMapSchema } from "@/ai/tasks/exercise-map/schema";
import { sanitizeExerciseMappings } from "@/ai/tasks/exercise-map/validate";
import { missingRequirements } from "@/engine/equipment-filter";
import {
  normalizeExerciseText,
  scoreExerciseCandidate,
} from "@/services/exercise-map";

const cleanEnvelope = {
  confidence: 1,
  ambiguities: [],
  clarifyingQuestions: [],
  unparsed: [],
};

describe("routine_parse schema (plan §13 contract 3)", () => {
  it("accepts a canonical pasted routine with supersets, ranges, and nulls", () => {
    // "PPL — Day 1 Push: Bench press 3x8 @ 135, DB shoulder press 3x8-10,
    //  A1 lateral raise / A2 face pull 2x15, rest not stated anywhere"
    const parsed = routineParseSchema.safeParse({
      data: {
        programName: "PPL",
        days: [
          {
            name: "Day 1 Push",
            order: 0,
            exercises: [
              {
                rawName: "Bench press",
                sets: 3,
                reps: { kind: "range", min: 8, max: 8 },
                load: 135,
                loadUnit: null, // unit not stated — ambiguity below
                restSec: null,
                supersetKey: null,
                notes: null,
              },
              {
                rawName: "DB shoulder press",
                sets: 3,
                reps: { kind: "range", min: 8, max: 10 },
                load: null,
                loadUnit: null,
                restSec: null,
                supersetKey: null,
                notes: null,
              },
              {
                rawName: "lateral raise",
                sets: 2,
                reps: { kind: "perSet", perSet: [15, 15] },
                load: null,
                loadUnit: null,
                restSec: null,
                supersetKey: "A",
                notes: null,
              },
              {
                rawName: "face pull",
                sets: 2,
                reps: { kind: "perSet", perSet: [15, 15] },
                load: null,
                loadUnit: null,
                restSec: null,
                supersetKey: "A",
                notes: null,
              },
            ],
          },
        ],
      },
      confidence: 0.85,
      ambiguities: [
        { field: "days", issue: "load unit not stated", options: ["lb", "kg"] },
      ],
      clarifyingQuestions: ["Rest times weren't given — what do you use?"],
      unparsed: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects invented units, zero sets, and non-integer reps", () => {
    const exercise = {
      rawName: "Bench press",
      sets: 3,
      reps: { kind: "range", min: 8, max: 10 },
      load: 60,
      loadUnit: "stone", // not a real option
      restSec: 90,
      supersetKey: null,
      notes: null,
    };
    const day = (ex: object) => ({
      data: { programName: null, days: [{ name: "Day 1", order: 0, exercises: [ex] }] },
      ...cleanEnvelope,
    });
    expect(routineParseSchema.safeParse(day(exercise)).success).toBe(false);
    expect(
      routineParseSchema.safeParse(day({ ...exercise, loadUnit: "lb", sets: 0 })).success
    ).toBe(false);
    expect(
      routineParseSchema.safeParse(
        day({ ...exercise, loadUnit: "lb", reps: { kind: "range", min: 8.5, max: 10 } })
      ).success
    ).toBe(false);
  });

  it("rejects payloads missing the envelope", () => {
    expect(
      routineParseSchema.safeParse({ data: { programName: null, days: [] } }).success
    ).toBe(false);
  });

  it("collapses rep specs to prescription ranges", () => {
    expect(repSpecToRange({ kind: "range", min: 8, max: 10 })).toEqual({ min: 8, max: 10 });
    expect(repSpecToRange({ kind: "perSet", perSet: [8, 8, 6] })).toEqual({ min: 6, max: 8 });
    expect(repSpecToRange(null)).toBeNull();
  });
});

describe("exercise_map schema (plan §13 contract 4)", () => {
  it("accepts a mapping batch in the envelope", () => {
    const parsed = exerciseMapSchema.safeParse({
      data: {
        mappings: [
          {
            rawName: "DB incline press",
            exerciseId: "ex-1",
            matchType: "fuzzy",
            altCandidates: [{ exerciseId: "ex-2", why: "flat, not incline" }],
          },
          { rawName: "mystery move", exerciseId: null, matchType: "none", altCandidates: [] },
        ],
      },
      confidence: 0.9,
      ambiguities: [
        { field: "mappings[0].exerciseId", issue: "incline vs flat unclear", options: null },
      ],
      clarifyingQuestions: [],
      unparsed: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects invented matchType values", () => {
    expect(
      exerciseMapSchema.safeParse({
        data: {
          mappings: [
            { rawName: "x", exerciseId: "ex-1", matchType: "perfect", altCandidates: [] },
          ],
        },
        ...cleanEnvelope,
      }).success
    ).toBe(false);
  });
});

describe("exercise-name candidate ranking", () => {
  it("normalizes equipment annotations and common naming variants", () => {
    expect(normalizeExerciseText("Triceps Press-Down")).toBe("triceps pushdown");
    expect(normalizeExerciseText("Push Up")).toBe("pushup");
  });

  it("ranks the intended Day 2 exercise above a superficial word match", () => {
    const raw = "Rear Delt Reverse Fly (Dumbbell)";
    const intended = scoreExerciseCandidate(raw, "Dumbbell Rear Delt Fly", [
      "rear delt fly",
      "reverse fly",
    ]);
    const superficial = scoreExerciseCandidate(raw, "Dumbbell Reverse Lunge", [
      "reverse lunge",
    ]);
    expect(intended).toBeGreaterThan(superficial);
  });

  it("recognizes grip and equipment qualifiers without requiring an exact label", () => {
    expect(
      scoreExerciseCandidate("Seated Cable Row — Bar Grip", "Seated Cable Row", [
        "cable row",
      ])
    ).toBeGreaterThan(0);
    expect(
      scoreExerciseCandidate("Squat (Barbell)", "Barbell Back Squat", ["squat"])
    ).toBeGreaterThan(0);
  });
});

describe("sanitizeExerciseMappings (candidates-only enforcement)", () => {
  const request = [
    {
      rawName: "DB incline press",
      candidates: [
        { exerciseId: "ex-1", name: "Incline Dumbbell Bench Press" },
        { exerciseId: "ex-2", name: "Dumbbell Bench Press" },
      ],
    },
    {
      rawName: "lat pulldown",
      candidates: [{ exerciseId: "ex-3", name: "Band Lat Pulldown" }],
    },
  ];

  it("passes through a compliant mapping unchanged (as fuzzy)", () => {
    const { mappings, violations } = sanitizeExerciseMappings(
      [
        {
          rawName: "DB incline press",
          exerciseId: "ex-1",
          matchType: "fuzzy",
          altCandidates: [{ exerciseId: "ex-2", why: "flat variant" }],
        },
        { rawName: "lat pulldown", exerciseId: "ex-3", matchType: "fuzzy", altCandidates: [] },
      ],
      request
    );
    expect(violations).toEqual([]);
    expect(mappings[0]).toMatchObject({ exerciseId: "ex-1", matchType: "fuzzy" });
    expect(mappings[1]).toMatchObject({ exerciseId: "ex-3", matchType: "fuzzy" });
  });

  it("nulls out minted exercise IDs — the model cannot invent them", () => {
    const { mappings, violations } = sanitizeExerciseMappings(
      [
        {
          rawName: "DB incline press",
          exerciseId: "totally-made-up",
          matchType: "fuzzy",
          altCandidates: [],
        },
        { rawName: "lat pulldown", exerciseId: null, matchType: "none", altCandidates: [] },
      ],
      request
    );
    expect(mappings[0]).toMatchObject({ exerciseId: null, matchType: "none" });
    expect(violations.some((v) => v.includes("minted"))).toBe(true);
  });

  it("rejects IDs borrowed from another rawName's candidate slice", () => {
    const { mappings, violations } = sanitizeExerciseMappings(
      [
        // ex-3 is only a candidate for "lat pulldown"
        { rawName: "DB incline press", exerciseId: "ex-3", matchType: "fuzzy", altCandidates: [] },
        { rawName: "lat pulldown", exerciseId: "ex-3", matchType: "fuzzy", altCandidates: [] },
      ],
      request
    );
    expect(mappings[0].exerciseId).toBeNull();
    expect(mappings[1].exerciseId).toBe("ex-3");
    expect(violations).toHaveLength(1);
  });

  it("downgrades claimed exact/alias matches to fuzzy", () => {
    const { mappings, violations } = sanitizeExerciseMappings(
      [
        { rawName: "DB incline press", exerciseId: "ex-1", matchType: "exact", altCandidates: [] },
        { rawName: "lat pulldown", exerciseId: null, matchType: "none", altCandidates: [] },
      ],
      request
    );
    expect(mappings[0].matchType).toBe("fuzzy");
    expect(violations.some((v) => v.includes("downgraded"))).toBe(true);
  });

  it("restores dropped rawNames as unmapped and filters minted altCandidates", () => {
    const { mappings, violations } = sanitizeExerciseMappings(
      [
        {
          rawName: "DB incline press",
          exerciseId: "ex-1",
          matchType: "fuzzy",
          altCandidates: [{ exerciseId: "not-a-candidate", why: "?" }],
        },
        // "lat pulldown" missing entirely
      ],
      request
    );
    expect(mappings).toHaveLength(2);
    expect(mappings[0].altCandidates).toEqual([]);
    expect(mappings[1]).toMatchObject({
      rawName: "lat pulldown",
      exerciseId: null,
      matchType: "none",
    });
    expect(violations).toHaveLength(2);
  });
});

describe("import equipment gate (plan §5: red rows block confirmation)", () => {
  const inventory = [
    { type: "dumbbell", available: true, attrs: { maxWeight: 35 } },
    { type: "bench", available: true, attrs: {} },
  ];

  it("flags exercises whose equipment is not in inventory", () => {
    const missing = missingRequirements(
      [{ equipmentType: "cable", minWeight: null }],
      inventory
    );
    expect(missing.map((m) => m.equipmentType)).toEqual(["cable"]);
  });

  it("passes exercises fully covered by inventory", () => {
    expect(
      missingRequirements(
        [
          { equipmentType: "dumbbell", minWeight: 30 },
          { equipmentType: "bench", minWeight: null },
        ],
        inventory
      )
    ).toEqual([]);
  });
});
