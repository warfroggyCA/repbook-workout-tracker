import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXERCISE_FILTERS,
  activeAdvancedExerciseFilterCount,
  discoverExerciseFamilies,
  exerciseDiscoveryItemFromLibrary,
  type ExerciseDiscoveryItem,
} from "@/lib/exercise-discovery";

function exercise(
  id: string,
  name: string,
  options: Partial<ExerciseDiscoveryItem> = {}
): ExerciseDiscoveryItem {
  return {
    id,
    name,
    family: "Bench Press",
    movementPattern: "horizontal_push",
    primaryMuscles: ["chest"],
    secondaryMuscles: ["triceps", "shoulders"],
    equipment: ["dumbbell", "bench"],
    loadType: "dumbbell",
    metricType: "weight_reps",
    loadSemantics: "per_implement",
    variantAttributes: { angle: "flat" },
    cautionBodyParts: [],
    available: true,
    unavailableReason: null,
    ...options,
  };
}

describe("exercise discovery", () => {
  const library = [
    exercise("db-flat", "Dumbbell Flat Bench Press"),
    exercise("bb-flat", "Barbell Flat Bench Press", {
      equipment: ["barbell", "bench", "rack"],
      available: false,
      unavailableReason: "equipment needed",
    }),
    exercise("cable-row", "Seated Cable Row", {
      family: "Seated Row",
      movementPattern: "horizontal_pull",
      primaryMuscles: ["back"],
      secondaryMuscles: ["biceps"],
      equipment: ["cable"],
    }),
    exercise("bb-chest-supported-row", "Chest-Supported Barbell Row", {
      family: "Row",
      movementPattern: "horizontal_pull",
      primaryMuscles: ["back"],
      secondaryMuscles: ["biceps"],
      equipment: ["barbell", "plates", "bench"],
    }),
    exercise("db-curl", "Dumbbell Curl", {
      family: "Biceps Curl",
      movementPattern: "isolation_arms",
      primaryMuscles: ["biceps"],
      secondaryMuscles: [],
      equipment: ["dumbbell"],
    }),
  ];

  it("groups exact variants beneath their exercise family", () => {
    const groups = discoverExerciseFamilies(library, {
      ...DEFAULT_EXERCISE_FILTERS,
      availability: "all",
    });
    const bench = groups.find((group) => group.name === "Bench Press");

    expect(bench?.variants.map((variant) => variant.id)).toEqual(["db-flat", "bb-flat"]);
    expect(groups).toHaveLength(4);
  });

  it("combines equipment, body-area, movement, and availability filters", () => {
    const groups = discoverExerciseFamilies(library, {
      ...DEFAULT_EXERCISE_FILTERS,
      equipment: ["dumbbell"],
      bodyAreas: ["chest"],
      movements: ["horizontal_push"],
      availability: "available",
    });

    expect(groups.flatMap((group) => group.variants).map((item) => item.id)).toEqual(["db-flat"]);
  });

  it("keeps exact and strong search matches ahead of weaker matches", () => {
    const groups = discoverExerciseFamilies(
      [
        exercise("exact", "Bench Press", {
          available: false,
          unavailableReason: "equipment needed",
        }),
        exercise("prefix", "Bench Press Machine", {
          family: "Machine Bench Press",
        }),
        exercise("family", "Dumbbell Flat Press"),
      ],
      { ...DEFAULT_EXERCISE_FILTERS, query: "bench press", availability: "all" }
    );

    expect(groups[0]?.variants[0]?.id).toBe("exact");
    expect(groups[1]?.variants[0]?.id).toBe("prefix");
  });

  it("treats muscle words as muscle intent unless the exercise name is explicit", () => {
    const availableSearch = discoverExerciseFamilies(library, {
      ...DEFAULT_EXERCISE_FILTERS,
      query: "barbell chest",
      availability: "available",
    });
    expect(availableSearch.flatMap((group) => group.variants)).toEqual([]);

    const allSearch = discoverExerciseFamilies(library, {
      ...DEFAULT_EXERCISE_FILTERS,
      query: "barbell chest",
      availability: "all",
    });
    expect(allSearch[0]?.name).toBe("Bench Press");
    expect(allSearch[0]?.variants.map((variant) => variant.id)).toEqual(["bb-flat"]);

    const exactNameSearch = discoverExerciseFamilies(library, {
      ...DEFAULT_EXERCISE_FILTERS,
      query: "chest supported barbell row",
      availability: "available",
    });
    expect(exactNameSearch[0]?.variants.map((variant) => variant.id)).toEqual([
      "bb-chest-supported-row",
    ]);
  });

  it("defaults to available results and retains unavailable results in all mode", () => {
    const defaults = discoverExerciseFamilies(library, DEFAULT_EXERCISE_FILTERS);
    expect(
      defaults
        .flatMap((group) => group.variants)
        .some((item) => item.id === "bb-flat")
    ).toBe(false);
    expect(activeAdvancedExerciseFilterCount(DEFAULT_EXERCISE_FILTERS)).toBe(0);

    const all = discoverExerciseFamilies(library, {
      ...DEFAULT_EXERCISE_FILTERS,
      availability: "all",
    });
    const unavailable = all
      .flatMap((group) => group.variants)
      .find((item) => item.id === "bb-flat");

    expect(unavailable).toMatchObject({
      available: false,
      unavailableReason: "equipment needed",
    });
    expect(
      discoverExerciseFamilies(library, {
        ...DEFAULT_EXERCISE_FILTERS,
        availability: "available",
      })
        .flatMap((group) => group.variants)
        .some((item) => item.id === "bb-flat")
    ).toBe(false);
  });

  it("supports programme, recent, and frequent shortcuts from server signals", () => {
    const signalled = [
      exercise("program", "Programme Press", { inCurrentProgram: true }),
      exercise("recent", "Recent Press", { recentRank: 0 }),
      exercise("frequent", "Frequent Press", {
        frequentlyUsed: true,
        useCount: 12,
      }),
      exercise("other", "Other Press"),
    ];
    const results = discoverExerciseFamilies(signalled, {
      ...DEFAULT_EXERCISE_FILTERS,
      shortcuts: ["current_program", "recent", "frequent"],
    }).flatMap((group) => group.variants);

    expect(new Set(results.map((item) => item.id))).toEqual(
      new Set(["program", "recent", "frequent"])
    );
  });

  it("projects only training fields and leaves provenance bookkeeping internal", () => {
    const internalRecord = {
      ...exercise("projected", "Projected Exercise"),
      sourceName: "Internal catalogue source",
      license: "Unlicense",
      attribution: "Internal attribution",
      provenance: { import: "internal" },
    };
    const item = exerciseDiscoveryItemFromLibrary(internalRecord);

    expect(item.media).toBeUndefined();
    expect(item).not.toHaveProperty("sourceName");
    expect(item).not.toHaveProperty("license");
    expect(item).not.toHaveProperty("attribution");
    expect(item).not.toHaveProperty("provenance");
  });

  it("carries exact training details and optional reviewed media into inspection", () => {
    const item = exerciseDiscoveryItemFromLibrary(
      exercise("detail", "Detailed Exercise", {
        metricType: "time_reps",
        variantAttributes: {
          position: "half_kneeling",
          assistance: "assisted",
        },
        cautionBodyParts: ["shoulder"],
      }),
      {
        media: {
          kind: "video",
          images: [
            {
              url: "/exercise.jpg",
              alt: "Detailed Exercise setup",
              width: 960,
              height: 540,
            },
          ],
          video: {
            url: "/exercise.mp4",
            title: "Detailed Exercise demonstration",
          },
        },
      }
    );

    expect(item).toMatchObject({
      metricType: "time_reps",
      variantAttributes: { position: "half_kneeling", assistance: "assisted" },
      cautionBodyParts: ["shoulder"],
      media: {
        kind: "video",
        images: [
          {
            url: "/exercise.jpg",
            alt: "Detailed Exercise setup",
            width: 960,
            height: 540,
          },
        ],
        video: {
          url: "/exercise.mp4",
          title: "Detailed Exercise demonstration",
        },
      },
    });
  });
});
