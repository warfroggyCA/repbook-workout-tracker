import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markWorkoutInteraction,
  WORKOUT_INTERACTION_MARKS,
} from "@/lib/workout-interaction-performance";

describe("workout interaction performance marks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses fixed athlete-content-free names for the package-one journey", () => {
    expect(WORKOUT_INTERACTION_MARKS).toEqual({
      workoutStartSubmit: "repbook:workout-start:submit",
      workoutStartPending: "repbook:workout-start:pending",
      sessionCockpitUsable: "repbook:session:cockpit-usable",
      setLogTap: "repbook:set-log:tap",
      setRetainedLocally: "repbook:set-log:retained-locally",
      setUiAdvanced: "repbook:set-log:ui-advanced",
      setAcknowledged: "repbook:set-log:acknowledged",
      setRecoveryRendered: "repbook:set-log:recovery-rendered",
    });
  });

  it("marks without attaching workout details", () => {
    const mark = vi.fn();
    vi.stubGlobal("performance", { mark });

    expect(
      markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.setRetainedLocally),
    ).toBe(true);
    expect(mark).toHaveBeenCalledExactlyOnceWith(
      "repbook:set-log:retained-locally",
    );
  });

  it("fails closed when the browser Performance API is unavailable or rejects", () => {
    vi.stubGlobal("performance", undefined);
    expect(
      markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.setLogTap),
    ).toBe(false);

    vi.stubGlobal("performance", {
      mark: vi.fn(() => {
        throw new Error("performance buffer unavailable");
      }),
    });
    expect(
      markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.setLogTap),
    ).toBe(false);
  });

  it("wires every set and cockpit milestone without dynamic mark details", () => {
    const runner = readFileSync(
      "src/components/session/session-runner.tsx",
      "utf8",
    );
    const card = readFileSync(
      "src/components/session/exercise-card.tsx",
      "utf8",
    );

    expect(card).toContain(
      "markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.setLogTap)",
    );
    for (const milestone of [
      "sessionCockpitUsable",
      "setRetainedLocally",
      "setUiAdvanced",
      "setAcknowledged",
      "setRecoveryRendered",
    ]) {
      expect(runner).toContain(
        `markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.${milestone})`,
      );
    }
  });
});
