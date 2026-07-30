import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExerciseFamilyIcon } from "@/components/exercises/exercise-family-icon";
import { iconKeyForExerciseFamily } from "@/lib/exercise-family-icon";
import { exerciseLibrary } from "@/db/seed/exercise-library";
import { exerciseFamilyName } from "@/services/exercise-catalog";

describe("exercise family icons", () => {
  it("uses the family identity consistently across exercise variants", () => {
    expect(
      iconKeyForExerciseFamily({
        family: "Bench Press",
        exerciseName: "Barbell Bench Press",
        movementPattern: "horizontal_push",
      })
    ).toBe("bench_press");
    expect(
      iconKeyForExerciseFamily({
        family: "Bench Press",
        exerciseName: "Dumbbell Incline Bench Press",
        movementPattern: "horizontal_push",
      })
    ).toBe("bench_press");
  });

  it("distinguishes common family shapes before using movement fallbacks", () => {
    expect(
      iconKeyForExerciseFamily({
        family: "Deadlift",
        exerciseName: "Trap Bar Deadlift",
        movementPattern: "hinge",
      })
    ).toBe("hinge");
    expect(
      iconKeyForExerciseFamily({
        family: "Biceps Curl",
        exerciseName: "Cable Curl",
        movementPattern: "isolation_arms",
      })
    ).toBe("curl");
    expect(
      iconKeyForExerciseFamily({
        family: "Hanging Knee Raise",
        exerciseName: "Hanging Knee Raise",
        movementPattern: "core",
      })
    ).toBe("core");
    expect(
      iconKeyForExerciseFamily({
        family: "Calf Stretch",
        exerciseName: "Standing Calf Stretch",
        movementPattern: "stretch",
      })
    ).toBe("stretch");
  });

  it("gives every seeded exercise family a deliberate icon", () => {
    const families = [
      ...new Set(exerciseLibrary.map((exercise) => exerciseFamilyName(exercise))),
    ];

    expect(families).toHaveLength(106);
    for (const family of families) {
      const exercise = exerciseLibrary.find(
        (candidate) => exerciseFamilyName(candidate) === family
      )!;
      expect(
        iconKeyForExerciseFamily({
          family,
          exerciseName: exercise.name,
          movementPattern: exercise.pattern,
        }),
        family
      ).not.toBe("default");
    }
  });

  it("renders an SVG family symbol and a separate demonstration marker", () => {
    const html = renderToStaticMarkup(
      <ExerciseFamilyIcon
        family="Bench Press"
        exerciseName="Barbell Bench Press"
        movementPattern="horizontal_push"
        media={{
          kind: "image",
          images: [
            {
              url: "/exercise-media/bench.png",
              alt: "Bench press demonstration",
              width: 640,
              height: 480,
            },
          ],
        }}
      />
    );

    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
    expect(html).toContain("Image demonstration available");
  });

  it("renders distinct routine symbols instead of one generic dumbbell", () => {
    const html = renderToStaticMarkup(
      <div>
        <ExerciseFamilyIcon
          family="Bench Press"
          exerciseName="Barbell Bench Press"
          movementPattern="horizontal_push"
        />
        <ExerciseFamilyIcon
          family="Squat"
          exerciseName="Back Squat"
          movementPattern="squat"
        />
        <ExerciseFamilyIcon
          family="Seated Row"
          exerciseName="Seated Cable Row"
          movementPattern="horizontal_pull"
        />
      </div>
    );

    expect(html).toContain('data-exercise-icon="bench_press"');
    expect(html).toContain('data-exercise-icon="squat"');
    expect(html).toContain('data-exercise-icon="row"');
    expect(html).not.toContain('data-exercise-icon="default"');
  });

  it("uses movement drawings instead of interface-control symbols", () => {
    const html = renderToStaticMarkup(
      <div>
        <ExerciseFamilyIcon
          family="Seated Row"
          exerciseName="Seated Cable Row"
          movementPattern="horizontal_pull"
        />
        <ExerciseFamilyIcon
          family="Lateral Raise"
          exerciseName="Dumbbell Lateral Raise"
          movementPattern="isolation_shoulders"
        />
        <ExerciseFamilyIcon
          family="Pallof Press"
          exerciseName="Pallof Press"
          movementPattern="rotation"
        />
      </div>
    );

    expect(html).toContain('data-exercise-icon="row"');
    expect(html).toContain('data-exercise-icon="raise"');
    expect(html).toContain('data-exercise-icon="rotation"');
    expect(html).not.toContain("lucide-rows");
    expect(html).not.toContain("lucide-arrow");
    expect(html).not.toContain("lucide-rotate");
  });
});
