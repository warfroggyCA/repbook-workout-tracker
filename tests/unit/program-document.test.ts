import { describe, expect, it } from "vitest";
import {
  convertLegacyProgramGuidance,
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
  normalizeLegacyProgramWarmupSet,
  normalizeProgramDocumentLoads,
  programDocumentSchema,
  programDocumentV3Schema,
  storedProgramDocumentSchema,
  upgradeStoredProgramDocumentToV3,
} from "@/lib/program-document";

function documentWithWarmup(warmup: Record<string, unknown>) {
  const slot = {
    lineageId: crypto.randomUUID(),
    exerciseId: crypto.randomUUID(),
    sets: 3,
    repMin: 8,
    repMax: 12,
    targetLoad: 100,
    targetLoadUnit: "lb" as const,
    progressionRuleId: "double_progression",
    restSec: 90,
    supersetKey: null,
    notes: null,
    warmupNotes: null,
    warmupSets: [{
      label: "Warm-up",
      reps: 8,
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: null,
      notes: null,
      ...warmup,
    }],
    setNotes: [null, null, null],
    intent: createSuggestedSlotIntent(3, 0),
  };
  return {
    schemaVersion: "2",
    programId: crypto.randomUUID(),
    baseVersionId: crypto.randomUUID(),
    name: "Program",
    days: [{
      lineageId: crypto.randomUUID(),
      name: "Day A",
      notes: null,
      warmupNotes: null,
      intent: createSuggestedDayIntent([slot]),
      supersets: [],
      exercises: [slot],
    }],
  };
}

describe("Program document warm-up loading", () => {
  it.each([
    { load: 45, loadUnit: "lb" },
    { loadPercent: 50 },
    { loadText: "empty bar" },
    {},
  ])("accepts one loading representation %#", (warmup) => {
    expect(programDocumentSchema.safeParse(documentWithWarmup(warmup)).success)
      .toBe(true);
  });

  it("rejects contradictory warm-up loading representations", () => {
    const result = programDocumentSchema.safeParse(documentWithWarmup({
      load: 45,
      loadUnit: "lb",
      loadPercent: 50,
      loadText: "empty bar",
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "Use only one warm-up loading method: a measured load, a percentage, or a written instruction."
      );
    }
  });

  it("accepts legacy unloaded warm-ups that omitted nullable fields", () => {
    const legacy = documentWithWarmup({});
    const legacyInput = {
      ...legacy,
      days: legacy.days.map((day) => ({
        ...day,
        exercises: day.exercises.map((exercise) => ({
          ...exercise,
          warmupSets: [{ label: "Warm-up", reps: 8 }],
        })),
      })),
    };

    const parsed = programDocumentSchema.parse(legacyInput);
    expect(parsed.days[0].warmupNotes).toBeNull();
    expect(parsed.days[0].exercises[0].warmupSets[0]).toMatchObject({
      label: "Warm-up",
      reps: 8,
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: null,
      notes: null,
    });
  });

  it("moves legacy guidance into a new editable document without mutating the source", () => {
    const source = programDocumentSchema.parse(documentWithWarmup({ loadText: "empty bar" }));
    source.days[0].exercises[0].warmupNotes = "Shoulder circles";
    source.days[0].exercises[0].setNotes = ["Pause", null, "No grinding"];
    const converted = convertLegacyProgramGuidance(source, () => "Bench Press");
    expect(converted.changed).toBe(true);
    expect(converted.document.days[0].warmupNotes).toContain("Before Bench Press");
    expect(converted.document.days[0].warmupNotes).toContain("Shoulder circles");
    expect(converted.document.days[0].exercises[0]).toMatchObject({
      warmupNotes: null,
      warmupSets: [],
      setNotes: [null, null, null],
    });
    expect(converted.document.days[0].exercises[0].notes).toContain("Set 1: Pause");
    expect(source.days[0].exercises[0].warmupNotes).toBe("Shoulder circles");
    expect(source.days[0].exercises[0].warmupSets).toHaveLength(1);
  });

  it("consolidates duplicate legacy warm-up loading descriptions", () => {
    const normalized = normalizeLegacyProgramWarmupSet({
      label: "~55% work weight",
      reps: 5,
      load: null,
      loadUnit: null,
      loadPercent: 55,
      loadText: "55% of work weight",
      notes: null,
    });

    expect(normalized).toMatchObject({
      load: null,
      loadUnit: null,
      loadPercent: 55,
      loadText: null,
    });
    expect(
      programDocumentSchema.safeParse(documentWithWarmup(normalized)).success,
    ).toBe(true);
  });

  it("normalizes durable targets and enforces numeric(7,2) capacity", () => {
    const rounded = documentWithWarmup({});
    rounded.days[0].exercises[0].targetLoad = 32.305;
    expect(
      normalizeProgramDocumentLoads(programDocumentSchema.parse(rounded))
        .days[0].exercises[0].targetLoad
    ).toBe(32.31);

    const maximum = documentWithWarmup({});
    maximum.days[0].exercises[0].targetLoad = 99_999.99;
    expect(programDocumentSchema.safeParse(maximum).success).toBe(true);

    const overflow = documentWithWarmup({});
    overflow.days[0].exercises[0].targetLoad = 100_000;
    expect(programDocumentSchema.safeParse(overflow).success).toBe(false);
  });
});

describe("Program document v3 durable workout structure", () => {
  it("adapts v2 text and a three-member group deterministically without changing the source", () => {
    const source = programDocumentSchema.parse(documentWithWarmup({}));
    source.days[0].warmupNotes = "Shoulder circles and band pull-aparts";
    const groupKey = crypto.randomUUID();
    source.days[0].supersets = [{
      key: groupKey,
      name: "Shoulders tri-set",
      restAfterRoundSec: 90,
    }];
    const first = source.days[0].exercises[0];
    source.days[0].exercises = [0, 1, 2].map((index) => ({
      ...structuredClone(first),
      lineageId: crypto.randomUUID(),
      exerciseId: crypto.randomUUID(),
      supersetKey: groupKey,
      intent: createSuggestedSlotIntent(3, index),
    }));
    source.days[0].intent = createSuggestedDayIntent(source.days[0].exercises);
    const before = structuredClone(source);

    const firstUpgrade = upgradeStoredProgramDocumentToV3(source);
    const secondUpgrade = upgradeStoredProgramDocumentToV3(source);

    expect(firstUpgrade).toEqual(secondUpgrade);
    expect(source).toEqual(before);
    expect(firstUpgrade.days[0].warmupItems).toEqual([
      expect.objectContaining({
        key: source.days[0].lineageId,
        label: "Shoulder circles and band pull-aparts",
      }),
    ]);
    expect(firstUpgrade.days[0].supersets[0]).toMatchObject({
      structureStatus: "canonical",
      plannedRounds: 3,
      restBetweenMembersSec: 0,
      restBetweenRoundsSec: 90,
    });
    expect(
      firstUpgrade.days[0].exercises.map((slot) => slot.groupMemberOrderIdx),
    ).toEqual([0, 1, 2]);
    expect(storedProgramDocumentSchema.parse(firstUpgrade)).toEqual(firstUpgrade);
  });

  it("rejects invalid canonical rounds and preserves unequal legacy groups honestly", () => {
    const source = programDocumentSchema.parse(documentWithWarmup({}));
    const groupKey = crypto.randomUUID();
    source.days[0].supersets = [{
      key: groupKey,
      name: "Legacy unequal group",
      restAfterRoundSec: 75,
    }];
    const first = source.days[0].exercises[0];
    source.days[0].exercises = [2, 3, 4].map((sets, index) => ({
      ...structuredClone(first),
      lineageId: crypto.randomUUID(),
      exerciseId: crypto.randomUUID(),
      sets,
      setNotes: Array.from({ length: sets }, () => null),
      supersetKey: groupKey,
      intent: createSuggestedSlotIntent(sets, index),
    }));
    source.days[0].intent = createSuggestedDayIntent(source.days[0].exercises);

    const upgraded = upgradeStoredProgramDocumentToV3(source);
    expect(upgraded.days[0].supersets[0]).toMatchObject({
      structureStatus: "legacy_unequal",
      plannedRounds: null,
    });

    const falselyCanonical = structuredClone(upgraded);
    falselyCanonical.days[0].supersets[0].structureStatus = "canonical";
    falselyCanonical.days[0].supersets[0].plannedRounds = 4;
    expect(programDocumentV3Schema.safeParse(falselyCanonical).success).toBe(false);
  });

  it("accepts the established warm-up percentage range through 500", () => {
    const upgraded = upgradeStoredProgramDocumentToV3(
      programDocumentSchema.parse(documentWithWarmup({ loadPercent: 500 })),
    );
    upgraded.days[0].warmupItems = [{
      key: crypto.randomUUID(),
      label: "Band tension scale",
      reps: 10,
      load: null,
      loadUnit: null,
      loadPercent: 500,
      loadText: null,
      notes: null,
    }];
    expect(programDocumentV3Schema.safeParse(upgraded).success).toBe(true);
  });

  it("resizes older work-set cues to the prescribed set count during upgrade", () => {
    const source = programDocumentSchema.parse(documentWithWarmup({}));
    source.days[0].exercises[0].sets = 4;
    source.days[0].exercises[0].setNotes = ["Keep the first cue"];

    const upgraded = upgradeStoredProgramDocumentToV3(source);

    expect(upgraded.days[0].exercises[0].setNotes).toEqual([
      "Keep the first cue",
      null,
      null,
      null,
    ]);
  });

  it("rejects duplicate structured warm-up identities within one day", () => {
    const upgraded = upgradeStoredProgramDocumentToV3(
      programDocumentSchema.parse(documentWithWarmup({})),
    );
    const key = crypto.randomUUID();
    upgraded.days[0].warmupItems = ["First", "Second"].map((label) => ({
      key,
      label,
      reps: null,
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: null,
      notes: null,
    }));
    expect(programDocumentV3Schema.safeParse(upgraded).success).toBe(false);
  });
});
