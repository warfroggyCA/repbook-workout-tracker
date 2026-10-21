import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkoutSwapSummary } from "@/components/exercises/workout-swap-summary";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";

const item: ExerciseDiscoveryItem = {
  id: "replacement", name: "Dumbbell Row", family: "Row", movementPattern: "horizontal_pull",
  primaryMuscles: ["back"], secondaryMuscles: [], equipment: ["dumbbell"],
  loadType: "dumbbell", metricType: "weight_reps", loadSemantics: "per_implement",
  variantAttributes: {}, cautionBodyParts: [], available: true, unavailableReason: null,
};
const render = (changes: Partial<ExerciseDiscoveryItem> = {}) => renderToStaticMarkup(
  <WorkoutSwapSummary item={{ ...item, ...changes }} currentExerciseName="Cable Row" />,
);

describe("workout swap review", () => {
  it("explains independent histories and workout-only scope before confirmation", () => {
    const html = render();
    expect(html).toContain("Cable Row");
    expect(html).toContain("keep separate records");
    expect(html).toContain("old exercise’s weight does not transfer");
    expect(html).toContain("own comparable sets");
    expect(html).toContain("Completed sets keep their original exercise");
    expect(html).toContain("saved routine stays unchanged");
  });
  it("names per-implement weight without inventing a pair count or starting load", () => {
    const html = render();
    expect(html).toContain("Weight per dumbbell");
    expect(html).toContain("Do not add a pair together");
    expect(html).not.toMatch(/\d+ (?:kg|lb)/);
  });
  it("preserves total and unknown conventions rather than inferring per-hand loads", () => {
    expect(render({ loadSemantics: "total" })).toContain("Total weight");
    expect(render({ loadSemantics: "legacy_unknown" })).toContain("weight convention is unclear");
    expect(render({ loadSemantics: "legacy_unknown" })).toContain("No per-hand or combined amount is calculated");
  });
  it("does not describe an unavailable or constrained exercise as an equipment match", () => {
    const unavailable = render({ available: false, unavailableReason: "No dumbbells are saved." });
    expect(unavailable).toContain("Equipment needs checking");
    expect(unavailable).toContain("No dumbbells are saved");
    expect(unavailable).not.toContain("Fits your saved equipment");
    expect(render({ constraintBlocked: true })).toContain("Check your constraints");
  });
  it("does not ask a reps-only replacement to enter an invented weight", () => {
    const html = render({ loadType: "bodyweight", metricType: "reps", loadSemantics: "bodyweight" });
    expect(html).toContain("Follow the new exercise’s reps or time entry");
    expect(html).not.toContain("starting load or assistance");
    expect(html).not.toContain('data-testid="swap-load-convention"');
  });
  it("keeps unknown tracking meaning explicit in a view-only candidate", () => {
    const html = render({ metricType: "legacy_unknown" });
    expect(html).toContain("numeric starting load cannot be inferred");
    expect(html).not.toContain("Follow the new exercise’s reps or time entry");
    expect(html).not.toContain('data-testid="swap-load-convention"');
  });
});
