import { describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { exerciseLibrary } from "@/db/seed/exercise-library";
import {
  exerciseActivityClass,
  exerciseFamilyName,
  exerciseLoadSemantics,
  exerciseMetricType,
  exerciseVariantKey,
} from "@/services/exercise-catalog";
import { resolveExerciseName } from "@/services/exercise-map";

type TestExercise = {
  id: string;
  name: string;
  aliases: Array<{ alias: string }>;
  family: { name: string };
  equipmentRequirements: Array<{ equipmentType: string }>;
  loadType: string;
  metricType: string;
  loadSemantics: string;
  variantAttributes: { assistance?: "none" | "weighted" | "assisted" };
};

function exercise(
  id: string,
  name: string,
  equipment: string,
  options: Partial<TestExercise> = {}
): TestExercise {
  return {
    id,
    name,
    aliases: [],
    family: { name: name.replace(/^(Barbell|Dumbbell|Cable|Machine|Assisted) /, "") },
    equipmentRequirements: [{ equipmentType: equipment }],
    loadType: equipment === "dumbbell" ? "dumbbell" : equipment === "barbell" ? "barbell" : "external",
    metricType: "weight_reps",
    loadSemantics: equipment === "bodyweight" ? "bodyweight" : "total",
    variantAttributes: {},
    ...options,
  };
}

function fakeDb(rows: TestExercise[]): Db {
  return {
    query: { exercises: { findMany: async () => rows } },
  } as unknown as Db;
}

describe("trusted exercise catalog", () => {
  it("ships a broad, metadata-complete core with unique names and variant keys", () => {
    expect(exerciseLibrary.length).toBeGreaterThanOrEqual(300);
    expect(exerciseLibrary.length).toBeLessThanOrEqual(500);

    const names = new Set<string>();
    const signatures = new Set<string>();
    for (const item of exerciseLibrary) {
      expect(names.has(item.name.toLowerCase())).toBe(false);
      names.add(item.name.toLowerCase());

      const family = exerciseFamilyName(item);
      const signature = `${family.toLowerCase()}|${exerciseVariantKey(item)}`;
      expect(signatures.has(signature)).toBe(false);
      signatures.add(signature);

      expect(item.equipment.length).toBeGreaterThan(0);
      expect(item.muscles.length).toBeGreaterThan(0);
      expect(exerciseActivityClass(item)).toBeTruthy();
      expect(exerciseMetricType(item)).toBeTruthy();
      expect(exerciseLoadSemantics(item)).toBeTruthy();
      expect(item.source?.name ?? "Workout Tracker curated catalog").toBeTruthy();
    }
  });

  it("never cross-matches equipment or assistance variants", async () => {
    const db = fakeDb([
      exercise("bb-bench", "Barbell Bench Press", "barbell"),
      exercise("db-bench", "Dumbbell Bench Press", "dumbbell"),
      exercise("cable-row", "Cable Row", "cable"),
      exercise("machine-row", "Machine Row", "machine"),
      exercise("pushup", "Push-Up", "bodyweight", {
        aliases: [{ alias: "Push Up" }],
        metricType: "reps",
        loadSemantics: "bodyweight",
      }),
      exercise("pullup", "Pull-Up", "bodyweight", {
        metricType: "reps",
        loadSemantics: "bodyweight",
      }),
      exercise("assisted-pullup", "Assisted Pull-Up", "machine", {
        metricType: "assisted_reps",
        loadSemantics: "assistance",
        variantAttributes: { assistance: "assisted" },
      }),
      exercise("db-lunge", "Dumbbell Walking Lunge", "dumbbell", {
        aliases: [{ alias: "Walking Lunge" }],
      }),
      exercise("db-forward-lunge", "Dumbbell Forward Lunge", "dumbbell", {
        aliases: [{ alias: "Dumbbell Lunge" }],
      }),
      exercise("db-calf-raise", "Dumbbell Calf Raise", "dumbbell", {
        aliases: [{ alias: "Standing Calf Raise (Dumbbell)" }],
      }),
      exercise("bw-lunge", "Bodyweight Walking Lunge", "bodyweight", {
        metricType: "reps",
        loadSemantics: "bodyweight",
      }),
    ]);

    await expect(resolveExerciseName(db, "Bench Press (Dumbbell)", "user")).resolves.toMatchObject({
      exerciseId: "db-bench",
    });
    await expect(resolveExerciseName(db, "Bench Press (Barbell)", "user")).resolves.toMatchObject({
      exerciseId: "bb-bench",
    });
    await expect(resolveExerciseName(db, "Bench Press", "user")).resolves.toMatchObject({
      exerciseId: null,
    });
    await expect(resolveExerciseName(db, "Cable Row", "user")).resolves.toMatchObject({
      exerciseId: "cable-row",
    });
    await expect(resolveExerciseName(db, "Push Up (Bodyweight)", "user")).resolves.toMatchObject({
      exerciseId: "pushup",
    });
    await expect(resolveExerciseName(db, "Pull-Up (Assisted)", "user")).resolves.toMatchObject({
      exerciseId: "assisted-pullup",
    });
    await expect(resolveExerciseName(db, "Walking Lunge", "user")).resolves.toMatchObject({
      exerciseId: null,
    });
    await expect(resolveExerciseName(db, "Lunge (Dumbbell)", "user")).resolves.toMatchObject({
      exerciseId: "db-forward-lunge",
      exerciseName: "Dumbbell Forward Lunge",
      matchType: "alias",
    });
    await expect(resolveExerciseName(db, "Standing Calf Raise (Dumbbell)", "user")).resolves.toMatchObject({
      exerciseId: "db-calf-raise",
      exerciseName: "Dumbbell Calf Raise",
      matchType: "alias",
    });
  });

  it("requires an owner choice for an unqualified family label with material variants", async () => {
    const family = { name: "Lat Pulldown" };
    const db = fakeDb([
      exercise("cable-lat-pulldown", "Lat Pulldown", "cable", {
        aliases: [{ alias: "Pulldown" }],
        family,
        loadSemantics: "machine_stack",
      }),
      exercise(
        "plate-loaded-lat-pulldown",
        "Plate-Loaded Lat Pulldown",
        "machine",
        {
          aliases: [{ alias: "Plate Loaded Pulldown" }],
          family,
          loadSemantics: "machine_stack",
        },
      ),
    ]);

    await expect(resolveExerciseName(db, "Lat Pulldown", "user")).resolves.toMatchObject({
      exerciseId: null,
      exerciseName: null,
      matchType: "none",
      requiresOwnerChoice: true,
      candidates: [
        { id: "cable-lat-pulldown", equipment: ["cable"] },
        { id: "plate-loaded-lat-pulldown", equipment: ["machine"] },
      ],
    });
    await expect(
      resolveExerciseName(db, "Lat Pulldown (Cable)", "user"),
    ).resolves.toMatchObject({
      exerciseId: "cable-lat-pulldown",
      matchType: "exact",
      requiresOwnerChoice: false,
    });
    await expect(
      resolveExerciseName(db, "Plate-Loaded Lat Pulldown", "user"),
    ).resolves.toMatchObject({
      exerciseId: "plate-loaded-lat-pulldown",
      matchType: "exact",
      requiresOwnerChoice: false,
    });
  });

  it("activates only reviewed exact setup variants without reclassifying generic machines or bars", () => {
    const byName = (name: string) =>
      exerciseLibrary.find((exercise) => exercise.name === name);

    expect(byName("Lat Pulldown")).toMatchObject({
      equipment: ["cable"],
      exactExecutionRequirement: {
        requiredProfileKind: "cable_machine",
        requiredAttachmentKind: "lat_bar",
        requiresKnownGeometry: true,
      },
    });
    expect(byName("Plate-Loaded Lat Pulldown")).toMatchObject({
      family: "Lat Pulldown",
      equipment: ["machine"],
      exactExecutionRequirement: {
        requiredProfileKind: "plate_loaded_machine",
        requiresKnownGeometry: true,
      },
    });
    expect(byName("Trap Bar Deadlift")).toMatchObject({
      loadType: "trap_bar",
      equipment: ["trap_bar", "plates"],
    });

    for (const name of [
      "Leg Press",
      "Leg Extension",
      "EZ-Bar Curl",
      "Barbell Back Squat",
      "Trap Bar Deadlift",
    ]) {
      expect(
        byName(name)?.exactExecutionRequirement,
        `${name} must retain its established broad/load-type lifecycle`,
      ).toBeUndefined();
    }
  });

  it("keeps loaded and bodyweight Bulgarian split squats as distinct reviewed variants", () => {
    const loaded = exerciseLibrary.find(
      (exercise) => exercise.name === "Bulgarian Split Squat",
    );
    const bodyweight = exerciseLibrary.find(
      (exercise) => exercise.name === "Bodyweight Bulgarian Split Squat",
    );

    expect(loaded).toMatchObject({
      loadType: "dumbbell",
      equipment: ["dumbbell", "bench"],
    });
    expect(exerciseMetricType(loaded!)).toBe("weight_reps");
    expect(exerciseLoadSemantics(loaded!)).toBe("per_implement");

    expect(bodyweight).toMatchObject({
      family: "Bulgarian Split Squat",
      loadType: "bodyweight",
      equipment: ["bodyweight", "bench"],
      metricType: "reps",
      loadSemantics: "bodyweight",
      variantKey: "bodyweight",
      variantAttributes: {
        laterality: "unilateral",
        assistance: "none",
      },
      source: {
        name: "Workout Tracker curated catalog",
        id: "bodyweight_bulgarian_split_squat",
      },
    });
    expect(exerciseFamilyName(bodyweight!)).toBe("Bulgarian Split Squat");
  });
});
