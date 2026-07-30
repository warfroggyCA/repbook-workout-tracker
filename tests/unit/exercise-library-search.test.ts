import { describe, expect, it } from "vitest";
import type { LibraryExerciseOption } from "@/services/routine-import";
import { searchExerciseLibrary } from "@/services/exercise-library-search";

function exercise(
  id: string,
  name: string,
  equipment: string[],
  family = "Lunge",
  muscles = family === "Bench Press" ? ["chest"] : ["quads"]
): LibraryExerciseOption {
  return {
    id,
    familyId: "bench-press-family",
    name,
    activityClass: "strength",
    family,
    movementPattern: family === "Lunge" ? "lunge" : "horizontal_push",
    primaryMuscles: muscles,
    secondaryMuscles: family === "Bench Press" ? ["triceps", "shoulders"] : ["glutes"],
    loadType: equipment[0] ?? "bodyweight",
    equipment,
    metricType: "weight_reps",
    loadSemantics: "per_implement",
    variantAttributes: { assistance: "none", laterality: "unilateral" },
    available: true,
    missing: [],
    constraintBlocked: false,
    unavailableReason: null,
    cautionBodyParts: [],
  };
}

describe("full exercise-library search", () => {
  it("matches keywords across names and equipment in any order", () => {
    const library = [
      exercise("db-forward", "Dumbbell Forward Lunge", ["dumbbell"]),
      exercise("barbell-forward", "Barbell Forward Lunge", ["barbell"]),
      exercise("db-press", "Dumbbell Bench Press", ["dumbbell"], "Bench Press"),
    ];

    expect(searchExerciseLibrary("lunge dumbbell", library).map((item) => item.id))
      .toEqual(["db-forward"]);
  });

  it("returns every match instead of limiting results to a curated shortlist", () => {
    const library = Array.from({ length: 55 }, (_, index) =>
      exercise(`calf-${index}`, `Calf Raise ${index + 1}`, ["machine"], "Calf Raise")
    );

    expect(searchExerciseLibrary("calf", library)).toHaveLength(55);
  });

  it("matches common muscle wording such as barbell chest", () => {
    const library = [
      exercise("bb-bench", "Barbell Bench Press", ["barbell", "plates", "bench", "rack"], "Bench Press"),
      exercise("bb-row", "Chest-Supported Barbell Row", ["barbell", "plates", "bench"], "Row", ["back"]),
    ];

    expect(searchExerciseLibrary("barbell chest", library).map((item) => item.id))
      .toEqual(["bb-bench"]);
    expect(searchExerciseLibrary("chest supported barbell row", library).map((item) => item.id))
      .toEqual(["bb-row"]);
  });
});
