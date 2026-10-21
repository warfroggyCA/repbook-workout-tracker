import { describe, expect, it } from "vitest";
import { workoutFocusScrollDelta } from "@/lib/active-workout-layout";
describe("workout focus clearance", () => {
  it("moves a fitting input above the dock with an eight-pixel gap", () => {
    expect(workoutFocusScrollDelta({ targetTop: 400, targetBottom: 530, dockTop: 500 })).toBe(38);
  });
  it("leaves already clear controls and oversized group containers alone", () => {
    expect(workoutFocusScrollDelta({ targetTop: 100, targetBottom: 230, dockTop: 500 })).toBe(0);
    expect(workoutFocusScrollDelta({ targetTop: 0, targetBottom: 700, dockTop: 500 })).toBe(0);
  });
});
