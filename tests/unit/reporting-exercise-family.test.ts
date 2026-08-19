import { describe, expect, it } from "vitest";
import {
  projectReportingExerciseFamily,
  REPORTING_EXERCISE_FAMILY_RULE_VERSION,
} from "@/lib/reporting-exercise-family";

describe("reporting exercise families", () => {
  it("normalizes related variants without replacing their exact identity", () => {
    const bench = projectReportingExerciseFamily({
      exerciseName: "Barbell Bench Press",
      catalogFamily: "Bench Press",
      movementPattern: "horizontal_push",
    });
    const chestPress = projectReportingExerciseFamily({
      exerciseName: "Machine Chest Press",
      catalogFamily: "Chest Press",
      movementPattern: "horizontal_push",
    });

    expect(bench.family).toBe("Chest Press");
    expect(chestPress.family).toBe("Chest Press");
    expect(bench.variant).toBe("Barbell Bench Press");
    expect(chestPress.variant).toBe("Machine Chest Press");
    expect(bench.ruleVersion).toBe(REPORTING_EXERCISE_FAMILY_RULE_VERSION);
  });

  it("groups squat and row variants at the reporting layer", () => {
    expect(
      projectReportingExerciseFamily({
        exerciseName: "Barbell Back Squat",
        catalogFamily: "Squat",
        movementPattern: "squat",
      }).family,
    ).toBe("Squat");
    expect(
      projectReportingExerciseFamily({
        exerciseName: "Barbell Row",
        catalogFamily: "Row",
        movementPattern: "horizontal_pull",
      }).family,
    ).toBe("Row");
    expect(
      projectReportingExerciseFamily({ exerciseName: "Squat" }).family,
    ).toBe("Squat");
  });

  it("does not collapse chest-isolation or arm-isolation variants into presses", () => {
    expect(
      projectReportingExerciseFamily({
        exerciseName: "Cable Fly",
        catalogFamily: "Chest Fly",
        movementPattern: "horizontal_push",
      }).family,
    ).toBe("Chest Isolation");
    expect(
      projectReportingExerciseFamily({
        exerciseName: "EZ-Bar Curl",
        movementPattern: "isolation_arms",
      }).family,
    ).toBe("Curl");
    expect(
      projectReportingExerciseFamily({
        exerciseName: "Cable Triceps Pushdown",
        movementPattern: "isolation_arms",
      }).family,
    ).toBe("Triceps Extension");
  });

  it("keeps unsupported historical classification explicit", () => {
    expect(
      projectReportingExerciseFamily({ exerciseName: "Legacy mystery lift" }),
    ).toMatchObject({
      family: "Unclassified",
      variant: "Legacy mystery lift",
      movementPattern: null,
    });
  });
});
