import { describe, expect, it } from "vitest";
import { hasFroggyFormDemo, matchFroggyFormDemo, type FroggyCatalogIdentity } from "@/lib/froggy-form-demo";
import { exerciseDiscoveryItemFromLibrary } from "@/lib/exercise-discovery";
import { exerciseVariantKey } from "@/services/exercise-catalog";
import { exerciseLibrary } from "@/db/seed/exercise-library";
import anchors from "@/lib/froggy-incline-curl-anchors.json";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FROGGY_FORMS } from "@/lib/froggy-form-config";

const curl: FroggyCatalogIdentity = {
  id: "synthetic-exercise-a", userId: null, variantKey: "incline_dumbbell_curl",
  catalogReviewed: true, loadType: "dumbbell", isUnilateral: false, variantAttributes: {},
};

describe("Froggy form demo identity and presentation", () => {
  it("matches the actual seeded variant key, with environment-specific IDs", () => {
    expect(exerciseVariantKey({ name: "Incline Dumbbell Curl", pattern: "isolation_arms", muscles: ["biceps"], loadType: "dumbbell", equipment: ["dumbbell", "bench"] })).toBe(curl.variantKey);
    for (const id of ["synthetic-exercise-a", "synthetic-exercise-b"]) {
      expect(matchFroggyFormDemo({ ...curl, id }, true)?.exerciseId).toBe(id);
    }
  });
  it("is off unless explicitly enabled", () => expect(matchFroggyFormDemo(curl, false)).toBeNull());
  it.each([null, undefined, true, 42, "", "bilateral", []])("rejects malformed stored variant attributes %j", variantAttributes => {
    const exercise = { ...curl, variantAttributes } as unknown as FroggyCatalogIdentity;
    expect(matchFroggyFormDemo(exercise, true)).toBeNull();
  });
  it.each([
    { userId: "synthetic-custom-owner" }, { catalogReviewed: false }, { variantKey: "hammer_curl" },
    { loadType: "barbell" }, { isUnilateral: true }, { variantAttributes: { grip: "neutral" } },
    { variantAttributes: { angle: "45" } }, { variantAttributes: { laterality: "alternating" } },
  ])("rejects unreviewed or conflicting identity %j", patch => {
    expect(matchFroggyFormDemo({ ...curl, ...patch }, true)).toBeNull();
  });
  it("does not retain a planned exercise demo after substitution", () => {
    const demo = matchFroggyFormDemo(curl, true);
    expect(hasFroggyFormDemo(demo, curl.id)).toBe(true);
    expect(hasFroggyFormDemo(demo, "synthetic-replacement")).toBe(false);
    expect(hasFroggyFormDemo(null, curl.id)).toBe(false);
  });
  it("preserves bound identity through discovery projection", () => {
    const formDemo = matchFroggyFormDemo(curl, true);
    const projected = exerciseDiscoveryItemFromLibrary({ id: curl.id, name: "Renamed display label",
      family: "Biceps Curl", movementPattern: "isolation_arms", primaryMuscles: ["biceps"],
      secondaryMuscles: [], equipment: ["dumbbell", "bench"], loadType: "dumbbell", metricType: "weight_reps",
      loadSemantics: "per_implement", variantAttributes: {}, cautionBodyParts: [], available: true,
      unavailableReason: null, formDemo });
    expect(projected.formDemo).toEqual(formDemo);
  });
  it("ships one complete loop of finite in-frame tracking anchors", () => {
    expect(anchors).toHaveLength(144);
    for (const frame of anchors) for (const value of [...frame.upper_arm, ...frame.forearm]) {
      expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThan(0); expect(value).toBeLessThan(1);
    }
    // A moving forearm and steady upper arm are intentional, not a disconnected pointer.
    expect(Math.max(...anchors.map(f => f.forearm[1])) - Math.min(...anchors.map(f => f.forearm[1]))).toBeGreaterThan(.04);
    expect(Math.max(...anchors.map(f => f.upper_arm[1])) - Math.min(...anchors.map(f => f.upper_arm[1]))).toBeLessThan(.01);
  });
});


describe("Froggy live-program batch identity", () => {
  it("ships every offered mode, thumbnail and complete tracking loop", () => {
    for (const config of Object.values(FROGGY_FORMS)) {
      if (config.animatedThumbnail) expect(existsSync(join(process.cwd(), "public", config.animatedThumbnail))).toBe(true);
      for (const file of [...config.modes.map(mode => `${mode}.mp4`), config.thumbnail, "poster.png"]) {
        expect(existsSync(join(process.cwd(), "public", config.media, file))).toBe(true);
      }
    }
    for (const key of ["incline-press", "lat-pulldown", "goblet-squat", "romanian-deadlift", "barbell-bench", "back-squat", "overhead-press", "barbell-row", "bulgarian-split-squat", "ez-bar-curl", "standing-cable-leg-curl", "rope-pushdown", "chest-supported-row", "chest-supported-reverse-fly", "single-leg-dumbbell-calf-raise", "dead-bug", "zottman-curl", "kettlebell-suitcase-carry", "standing-dumbbell-lateral-raise", "flat-dumbbell-bench-press", "seated-overhead-triceps-extension"]) {
      const frames: number[][][] = JSON.parse(readFileSync(join(process.cwd(), `src/lib/froggy-${key}-anchors.json`), "utf8"));
      expect(frames).toHaveLength(144);
      for (const frame of frames) {
        expect(frame).toHaveLength(2);
        for (const point of frame) {
          expect(point).toHaveLength(2);
          for (const value of point) {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThan(0); expect(value).toBeLessThan(1);
          }
        }
      }
      // The baked return loop and tracking must meet without a visible jump.
      frames[0].flat().forEach((value, i) => expect(Math.abs(value - frames[143].flat()[i])).toBeLessThan(.002));
    }
  });
  it.each([
    ["incline_barbell_bench_press", "barbell", "incline-press-v107"],
    ["wide_grip_lat_pulldown", "external", "lat-pulldown-v107"],
    ["kettlebell_goblet_squat", "kettlebell", "goblet-squat-v107"],
    ["romanian_deadlift", "barbell", "romanian-deadlift-v107"],
    ["barbell_bench_press", "barbell", "barbell-bench-v108"],
    ["barbell_back_squat", "barbell", "back-squat-v108"],
    ["barbell_overhead_press", "barbell", "overhead-press-v108"],
    ["barbell_row", "barbell", "barbell-row-v108"],
    ["ez_bar_curl", "ez_bar", "ez-bar-curl-v109"],
    ["triceps_pushdown", "external", "rope-pushdown-v117"],
    ["chest_supported_dumbbell_row", "dumbbell", "chest-supported-row-v117"],
    ["chest_supported_dumbbell_reverse_fly", "dumbbell", "chest-supported-reverse-fly-v117"],
  ])("binds only the reviewed %s variant", (variantKey, loadType, key) => {
    const exercise = { ...curl, variantKey, loadType };
    expect(matchFroggyFormDemo(exercise, true)).toEqual({ key, exerciseId: exercise.id });
    expect(matchFroggyFormDemo(exercise, false)).toBeNull();
    expect(matchFroggyFormDemo({ ...exercise, loadType: "bodyweight" }, true)).toBeNull();
    expect(matchFroggyFormDemo({ ...exercise, isUnilateral: true }, true)).toBeNull();
    expect(matchFroggyFormDemo({ ...exercise, variantAttributes: { grip: "neutral" } }, true)).toBeNull();
    expect(matchFroggyFormDemo({ ...exercise, userId: "synthetic-owner" }, true)).toBeNull();
    const demo = matchFroggyFormDemo(exercise, true);
    expect(hasFroggyFormDemo(demo, exercise.id)).toBe(true);
    expect(hasFroggyFormDemo(demo, "replacement-id")).toBe(false);
  });
  it.each(["neutral_grip_lat_pulldown", "lat_pulldown", "dumbbell_romanian_deadlift", "dumbbell_goblet_squat", "incline_dumbbell_bench_press", "push_press", "front_squat", "pendlay_row"])("does not substitute related movement %s", variantKey => {
    expect(matchFroggyFormDemo({ ...curl, variantKey }, true)).toBeNull();
  });
});


describe("Froggy unilateral split-squat identity", () => {
  const split = { ...curl, variantKey: "bulgarian_split_squat", isUnilateral: true, variantAttributes: { laterality: "unilateral" } };
  it("binds the exact reviewed dumbbell unilateral variant", () => {
    const demo = matchFroggyFormDemo(split, true);
    expect(demo).toEqual({ key: "bulgarian-split-squat-v109", exerciseId: split.id });
    expect(matchFroggyFormDemo(split, false)).toBeNull();
    expect(hasFroggyFormDemo(demo, "another-exercise")).toBe(false);
  });
  it.each([
    { isUnilateral: false }, { variantAttributes: {} }, { variantAttributes: { laterality: "bilateral" } },
    { variantAttributes: { laterality: "unilateral", loadPosition: "goblet" } },
    { loadType: "barbell" }, { loadType: "bodyweight" }, { variantKey: "bodyweight_bulgarian_split_squat" },
    { userId: "synthetic-owner" }, { catalogReviewed: false },
  ])("rejects a conflicting or unreviewed split-squat identity %j", patch => {
    expect(matchFroggyFormDemo({ ...split, ...patch }, true)).toBeNull();
  });
});


describe("Froggy cable setup boundaries", () => {
  const leg = { ...curl, variantKey: "cable_leg_curl", loadType: "external", isUnilateral: true, variantAttributes: { laterality: "unilateral" } };
  it("requires the reviewed unilateral cable identity and discloses the standing setup", () => {
    expect(matchFroggyFormDemo(leg, true)).toEqual({ key: "standing-cable-leg-curl-v117", exerciseId: leg.id });
    expect(matchFroggyFormDemo(leg, false)).toBeNull();
    expect(FROGGY_FORMS["standing-cable-leg-curl-v117"].setup).toContain("ankle cuff");
    expect(FROGGY_FORMS["rope-pushdown-v117"].setup).toContain("Rope attachment");
  });
  it.each([
    { isUnilateral: false }, { variantAttributes: {} },
    { variantAttributes: { laterality: "unilateral", position: "seated" } },
    { variantKey: "lying_leg_curl" }, { variantKey: "seated_leg_curl" },
    { loadType: "dumbbell" }, { catalogReviewed: false }, { userId: "synthetic-owner" },
  ])("rejects a different leg curl setup %j", patch => {
    expect(matchFroggyFormDemo({ ...leg, ...patch }, true)).toBeNull();
  });
  it.each(["straight_bar_triceps_pushdown", "reverse_grip_triceps_pushdown", "single_arm_cable_pushdown"])("does not display rope motion for %s", variantKey => {
    expect(matchFroggyFormDemo({ ...curl, variantKey, loadType: "external" }, true)).toBeNull();
  });
});


it.each([
  ["Cable Leg Curl", "standing-cable-leg-curl-v117"],
  ["Triceps Pushdown", "rope-pushdown-v117"],
  ["Chest-Supported Dumbbell Row", "chest-supported-row-v117"],
  ["Chest-Supported Dumbbell Reverse Fly", "chest-supported-reverse-fly-v117"],
])("matches the actual seeded identity for %s", (name, key) => {
  const seed = exerciseLibrary.find(e => e.name === name)!;
  expect(seed).toBeDefined();
  expect(matchFroggyFormDemo({ ...curl, variantKey: exerciseVariantKey(seed), loadType: seed.loadType,
    isUnilateral: seed.unilateral ?? false,
    variantAttributes: { ...(seed.unilateral ? { laterality: "unilateral" } : {}), ...seed.variantAttributes },
  }, true)?.key).toBe(key);
});


// Names select test metadata only; runtime matching uses the structured identity.
it.each([
  ["Single-Leg Dumbbell Calf Raise", "single-leg-dumbbell-calf-raise-v133"],
  ["Dead Bug", "dead-bug-v133"],
  ["Zottman Curl", "zottman-curl-v133"],
  ["Kettlebell Suitcase Carry", "kettlebell-suitcase-carry-v133"],
  ["Dumbbell Lateral Raise", "standing-dumbbell-lateral-raise-v138"],
  ["Dumbbell Bench Press", "flat-dumbbell-bench-press-v138"],
])("binds the seeded %s without admitting conflicting variations", (name, key) => {
  const seed = exerciseLibrary.find(e => e.name === name)!;
  expect(seed).toBeDefined();
  const exercise = { ...curl, variantKey: exerciseVariantKey(seed), loadType: seed.loadType,
    isUnilateral: seed.unilateral ?? false,
    variantAttributes: { ...(seed.unilateral ? { laterality: "unilateral" } : {}), ...seed.variantAttributes },
  };
  const demo = matchFroggyFormDemo(exercise, true);
  expect(demo).toEqual({ key, exerciseId: exercise.id });
  expect(matchFroggyFormDemo(exercise, false)).toBeNull();
  expect(hasFroggyFormDemo(demo, "synthetic-replacement")).toBe(false);
  for (const patch of [
    { loadType: "barbell" }, { isUnilateral: !exercise.isUnilateral },
    { userId: "synthetic-owner" }, { catalogReviewed: false },
    { variantAttributes: { ...exercise.variantAttributes, grip: "neutral" } },
    ...(exercise.isUnilateral && exercise.variantKey !== "kettlebell_suitcase_carry" ? [{ variantAttributes: {} }] : []),
  ]) expect(matchFroggyFormDemo({ ...exercise, ...patch }, true)).toBeNull();
});

describe("migrated kettlebell suitcase carry identity", () => {
  // Migration 0087 records laterality in is_unilateral and writes empty attributes.
  // Fresh catalog seeding also includes laterality in the attribute object.
  const migratedCarry: FroggyCatalogIdentity = {
    ...curl, variantKey: "kettlebell_suitcase_carry", loadType: "kettlebell",
    isUnilateral: true, variantAttributes: {},
  };

  it("shows the same approved carry for the migrated and seeded representations", () => {
    for (const variantAttributes of [{}, { laterality: "unilateral" }]) {
      expect(matchFroggyFormDemo({ ...migratedCarry, variantAttributes }, true)).toEqual({
        key: "kettlebell-suitcase-carry-v133", exerciseId: migratedCarry.id,
      });
    }
    expect(matchFroggyFormDemo(migratedCarry, false)).toBeNull();
  });

  it.each([
    { isUnilateral: false }, { loadType: "dumbbell" },
    { variantKey: "dumbbell_suitcase_carry" }, { variantKey: "farmer_carry" },
    { catalogReviewed: false }, { userId: "synthetic-owner" },
    { variantAttributes: { laterality: "bilateral" } },
    { variantAttributes: { laterality: "unilateral", grip: "overhead" } },
    { variantAttributes: { position: "overhead" } },
  ])("still rejects conflicting carry identity %j", patch => {
    expect(matchFroggyFormDemo({ ...migratedCarry, ...patch }, true)).toBeNull();
  });
});

it.each([
  ["single_leg_bodyweight_calf_raise", "bodyweight", true],
  ["dumbbell_suitcase_carry", "dumbbell", true],
  ["dumbbell_rear_delt_fly", "dumbbell", false],
  ["incline_dumbbell_press", "dumbbell", false],
])("leaves the unbound %s variant without a substituted clip", (variantKey, loadType, isUnilateral) => {
  expect(matchFroggyFormDemo({ ...curl, variantKey, loadType, isUnilateral,
    variantAttributes: isUnilateral ? { laterality: "unilateral" } : {},
  }, true)).toBeNull();
});


it.each(["dumbbell_lateral_raise", "dumbbell_bench_press"])("rejects conflicting setup attributes for %s", variantKey => {
  for (const variantAttributes of [{ position: "seated" }, { angle: 30 }, { support: "chest" }]) {
    expect(matchFroggyFormDemo({ ...curl, variantKey, variantAttributes }, true)).toBeNull();
  }
});


describe("seated single-dumbbell extension presentation", () => {
  it.each(["Dumbbell Overhead Triceps Extension", "Single-Dumbbell Overhead Triceps Extension"])("binds the reviewed %s catalog entry and discloses the seated setup", name => {
    const seed = exerciseLibrary.find(e => e.name === name)!;
    expect(seed).toBeDefined();
    const identity = { ...curl, variantKey: exerciseVariantKey(seed), loadType: seed.loadType,
      isUnilateral: seed.unilateral ?? false, variantAttributes: seed.variantAttributes ?? {} };
    const demo = matchFroggyFormDemo(identity, true);
    expect(demo).toEqual({ key: "seated-overhead-triceps-extension-v155", exerciseId: curl.id });
    expect(hasFroggyFormDemo(demo, "replacement")).toBe(false);
    expect(matchFroggyFormDemo(identity, false)).toBeNull();
    const config = FROGGY_FORMS[demo!.key];
    expect(config.setup).toContain("Seated");
    expect(config.setup).toContain("one fixed dumbbell");
    expect(config.setup).toContain("both hands");
    for (const patch of [{ isUnilateral: true }, { loadType: "external" },
      { catalogReviewed: false }, { userId: "custom" },
      { variantAttributes: { position: "standing" } }, { variantAttributes: { implements: 2 } }]) {
      expect(matchFroggyFormDemo({ ...identity, ...patch }, true)).toBeNull();
    }
  });
  it.each(["Two-Dumbbell Overhead Triceps Extension", "Single-Arm Dumbbell Overhead Triceps Extension", "Cable Overhead Triceps Extension"])("does not substitute the two-handed seated demo for %s", name => {
    const key = exerciseVariantKey({ name, pattern: "isolation_arms", muscles: ["triceps"], loadType: "dumbbell", equipment: ["dumbbell"] });
    expect(matchFroggyFormDemo({ ...curl, variantKey: key }, true)).toBeNull();
  });
});
