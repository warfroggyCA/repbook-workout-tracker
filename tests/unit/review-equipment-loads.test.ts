import { describe, expect, it } from "vitest";
import { incrementalLoads } from "@/engine/plate-math";
import { mergeIncrementalEquipmentConfigs, progressionPlateConfigs, steppersForLoadType } from "@/services/progression";
import { evaluateSlot } from "@/engine/progression/rules";
import { defaultSnapshotName } from "@/services/snapshots";
import { buildReviewEvidenceItems } from "@/services/review-decisions";

const item = (attrs: Parameters<typeof mergeIncrementalEquipmentConfigs>[0][number]["attrs"], type = "dumbbell", available = true) => ({ type, available, attrs });

describe("exact owned handheld loads", () => {
  it("converts each item to the entry unit before merging, without changing inventory", () => {
    const inventory = [item({ unit: "kg", increments: [8, 12, 16, 24] }, "kettlebell"), item({ unit: "lb", increments: [35] }, "kettlebell")];
    const before = structuredClone(inventory);
    const merged = mergeIncrementalEquipmentConfigs(inventory, "lb");
    expect(merged.kettlebell.unit).toBe("lb");
    expect(incrementalLoads(merged.kettlebell)).toEqual([17.64, 26.46, 35, 35.27, 52.91]);
    expect(steppersForLoadType("kettlebell", {}, merged).nextLoadUp(35)).toBe(35.27);
    expect(inventory).toEqual(before);
    expect(mergeIncrementalEquipmentConfigs([item({ unit: "lb", increments: [10] })], "kg").dumbbell.increments).toEqual([4.54]);
  });
  it("preserves exact lb settings and ignores unavailable inventory", () => {
    const merged = mergeIncrementalEquipmentConfigs([item({ unit: "lb", increments: [5, 10, 15] }), item({ unit: "lb", increments: [20] }, "dumbbell", false)], "lb");
    expect(incrementalLoads(merged.dumbbell)).toEqual([5, 10, 15]);
  });
  it("does not invent range settings, while retaining known fixed loads", () => {
    expect(incrementalLoads({ minWeight: 2, maxWeight: 24 })).toEqual([]);
    expect(incrementalLoads({ minWeight: 16, maxWeight: 16 })).toEqual([16]);
    const merged = mergeIncrementalEquipmentConfigs([item({ unit: "lb", minWeight: 5, maxWeight: 52.5 }), item({ unit: "lb", increments: [60] })], "lb");
    expect(incrementalLoads(merged.dumbbell)).toEqual([60]);
    expect(mergeIncrementalEquipmentConfigs([item({ minWeight: 5, maxWeight: 80 })], "lb").dumbbell.increments).toEqual([]);
  });
  it("never falls back to invented increases or decreases without a known load grid", () => {
    for (const type of ["dumbbell", "kettlebell", "barbell", "ez_bar", "external"]) {
      const step = steppersForLoadType(type, {}, {});
      expect(step.nextLoadUp(20)).toBeNull();
      expect(step.roundDown(18)).toBeNull();
    }
  });
});

const bar = (id: string, weight = 45): Parameters<typeof progressionPlateConfigs>[0][number] => ({ id, userId: "owner", equipmentItemId: id, label: id, barType: "olympic", loadingKind: "olympic", unit: "lb", barWeight: weight, collarWeight: 0, quantity: 1, sharedPlatePoolCompatible: true });
const owned = (id: string, available = true) => ({ id, label: id, available });
const plates = [{ denomination: 2.5, quantity: 2, unit: "lb" as const }];
describe("progression implement selection", () => {
  it("uses the sole available compatible implement and ignores row order", () => {
    const bars = [bar("retired", 35), bar("current")];
    const inventory = [owned("retired", false), owned("current")];
    for (const rows of [bars, [...bars].reverse()]) {
      const configs = progressionPlateConfigs(rows, inventory, plates, "lb");
      expect(configs.barbell.barWeight).toBe(45);
      expect(steppersForLoadType("barbell", configs, {}).nextLoadUp(45)).toBe(50);
    }
  });
  it("withholds load guidance for ambiguity, legacy, unavailable or incompatible profiles", () => {
    expect(progressionPlateConfigs([bar("a"), bar("b", 35)], [owned("a"), owned("b")], plates, "lb")).toEqual({});
    expect(progressionPlateConfigs([bar("a")], [owned("a", false)], plates, "lb")).toEqual({});
    expect(progressionPlateConfigs([{ ...bar("a"), equipmentItemId: null }], [owned("a")], plates, "lb")).toEqual({});
    expect(progressionPlateConfigs([{ ...bar("a"), sharedPlatePoolCompatible: false }], [owned("a")], plates, "lb")).toEqual({});
  });
  it("does not classify a trap bar as an Olympic bar or mix units", () => {
    const configs = progressionPlateConfigs([{ ...bar("trap"), loadingKind: "trap_hex" }], [owned("trap")], [...plates, { denomination: 10, quantity: 2, unit: "kg" }], "lb");
    expect(configs.barbell).toBeUndefined();
    expect(configs.trap_bar.plates).toEqual([{ denomination: 2.5, countPerSide: 1 }]);
    expect(progressionPlateConfigs([bar("a")], [owned("a")], plates, "kg")).toEqual({});
  });
});

it("cites the recorded workout day regardless of the server timezone", () => {
  const result = evaluateSlot({
    exerciseName: "Synthetic press", prescription: { sets: 1, repRangeMin: 6, repRangeMax: 8, targetLoad: 95 },
    exposuresRequiredForIncrease: 1,
    exposures: [{ sessionId: "s", date: new Date("2026-09-13T00:30:00Z"), localDate: "2026-09-12", sets: [{ id: "set", weight: 95, reps: 8, rpe: 7 }] }],
    recentPain: [], nextLoadUp: () => 100, roundDown: () => 90,
  });
  expect(result?.reason).toContain("Sep 12");
  expect(result?.reason).not.toContain("Sep 13");
});
it("formats operational snapshot and release timestamps in the supplied timezone", () => {
  const instant = new Date("2026-09-13T00:30:00Z");
  expect(defaultSnapshotName(instant, "America/Toronto")).toContain("Sep 12");
  expect(defaultSnapshotName(instant, "Asia/Manila")).toContain("Sep 13");
  const evidence = { signals: { releaseAt: instant.toISOString() } };
  expect(buildReviewEvidenceItems(evidence, null, "America/Toronto")[0].value).toContain("Sep 12");
  expect(buildReviewEvidenceItems(evidence, null, "Asia/Manila")[0].value).toContain("Sep 13");
});
