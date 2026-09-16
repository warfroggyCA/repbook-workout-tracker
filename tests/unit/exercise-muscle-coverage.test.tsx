import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  reviewedExerciseMuscles,
  REVIEWED_COVERAGE,
} from "@/lib/exercise-muscle-coverage";
import {
  aggregateMuscleWork,
  hasMuscleArtwork,
  muscleKey,
  MUSCLE_KEYS,
  type MuscleWork,
} from "@/lib/muscle-coverage";
import regions from "@/lib/froggy-muscle-regions.json";
import { FroggyMuscleMap } from "@/components/muscle-map/froggy-muscle-map";
const identity = {
  id: "synthetic",
  userId: null,
  variantKey: "zottman_curl",
  catalogReviewed: true,
  loadType: "dumbbell",
  isUnilateral: false,
  variantAttributes: {},
};

describe("reviewed coverage roles", () => {
  it.each(["dumbbell_overhead_triceps_extension", "single_dumbbell_overhead_triceps_extension"])("maps %s to triceps without invented secondary regions", variantKey => {
    const entry = { ...identity, variantKey };
    expect(reviewedExerciseMuscles(entry)).toMatchObject({ primary: ["triceps"], supporting: [] });
    expect(reviewedExerciseMuscles({ ...entry, variantAttributes: { position: "standing" } })).toBeNull();
  });

  it("resolves exact identity independently of animation visibility, without changing the catalog", () => {
    const before = structuredClone(identity);
    const mapping = reviewedExerciseMuscles(identity)!;
    expect(mapping.primary).toEqual(["biceps", "brachioradialis"]);
    expect(mapping.supporting).toEqual(["forearmflexors", "forearmextensors"]);
    expect(mapping.coverageReview).toMatchObject({ version: "coverage-v2" });
    expect(identity).toEqual(before);
    mapping.primary.pop();
    expect(reviewedExerciseMuscles(identity)!.primary).toHaveLength(2);
  });
  it.each([
    { userId: "custom" },
    { variantKey: "unknown" },
    { catalogReviewed: false },
    { loadType: "barbell" },
    { isUnilateral: true },
    { variantAttributes: { grip: "neutral" } },
  ])("retains catalog fallback for an ambiguous identity: %j", (change) => {
    expect(reviewedExerciseMuscles({ ...identity, ...change })).toBeNull();
  });
  it("uses valid non-overlapping roles for every existing demo variant", () => {
    expect(Object.keys(REVIEWED_COVERAGE)).toHaveLength(22);
    for (const mapping of Object.values(REVIEWED_COVERAGE)) {
      expect(mapping.primary.length).toBeGreaterThan(0);
      const keys = [...mapping.primary, ...mapping.supporting];
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) {
        expect(MUSCLE_KEYS).toContain(key);
        expect(muscleKey(key)).toBe(key);
      }
    }
    expect(
      REVIEWED_COVERAGE["standing-dumbbell-lateral-raise-v138"].primary,
    ).toEqual(["sidedelts"]);
    expect(REVIEWED_COVERAGE["incline-press-v107"].primary).toEqual(["chest"]);
    expect(REVIEWED_COVERAGE["dead-bug-v133"].primary).toContain("deepabs");
  });
  it("does not infer precise heads or deep surface patches from broad catalog words", () => {
    for (const key of [
      "shoulders",
      "core",
      "forearms",
      "deepabs",
      "rotatorcuff",
      "hipflexors",
    ]) {
      expect(hasMuscleArtwork(key)).toBe(false);
    }
    expect(muscleKey("forearm flexors")).toBe("forearmflexors");
    expect(muscleKey("abdominals")).toBe("abs");
    expect(muscleKey("core")).toBe("core");
  });
});

describe("anatomy regions and additive badges", () => {
  it("supplies 23 unique surface groups and in-view badge anchors", () => {
    const all = [...regions.front, ...regions.back];
    expect(new Set(all.map((r) => r.muscle)).size).toBe(23);
    for (const [view, shapes] of Object.entries(regions)) {
      expect(new Set(shapes.map((r) => r.muscle)).size).toBe(shapes.length);
      for (const shape of shapes) {
        expect(hasMuscleArtwork(shape.muscle)).toBe(true);
        expect(MUSCLE_KEYS).toContain(shape.muscle);
        expect(shape.label[0]).toBeGreaterThan(view === "front" ? 40 : 1380);
        expect(shape.label[0]).toBeLessThan(view === "front" ? 385 : 1725);
        expect(shape.label[1]).toBeGreaterThan(65);
        expect(shape.label[1]).toBeLessThan(790);
      }
    }
  });
  it("keeps narrow-region numbers above selection outlines", () => {
    const html = renderToStaticMarkup(<FroggyMuscleMap coverage={{brachioradialis:{direct:3,supporting:15,directDays:1,rows:[]}}} selected={new Set(["brachioradialis"])} />);
    expect(html.indexOf('data-set-number="brachioradialis"')).toBeGreaterThan(html.lastIndexOf('stroke="#008da8"'));
  });
  it("shows one number per paired region, adds selected days, and excludes supporting sets", () => {
    const row: MuscleWork = {
      dayId: "a",
      dayName: "Day A",
      dayIndex: 0,
      slotId: "s",
      exerciseId: "e",
      exerciseName: "Synthetic",
      sets: 3,
      direct: ["chest"],
      supporting: ["triceps"],
      catalogReviewed: true,
      missingPrimary: false,
    };
    const work = [row, { ...row, dayId: "b", slotId: "t", sets: 4 }];
    const render = (days?: Set<string>) =>
      renderToStaticMarkup(
        <FroggyMuscleMap coverage={aggregateMuscleWork(work, days)} />,
      );
    const all = render();
    expect(all.match(/data-set-number="chest"/g)).toHaveLength(1);
    expect(all).toMatch(/data-set-number="chest"[^>]*>7<\/text>/);
    expect(all).not.toContain('data-set-number="triceps"');
    expect(render(new Set(["a"]))).toMatch(
      /data-set-number="chest"[^>]*>3<\/text>/,
    );
    expect(render(new Set())).not.toContain("data-set-number");
  });
});
