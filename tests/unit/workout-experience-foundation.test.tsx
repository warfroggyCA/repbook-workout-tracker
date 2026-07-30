import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StateNotice } from "@/components/ui/state-notice";
import { Button } from "@/components/ui/button";
import {
  FIXED_REDESIGN_WEIGHTS,
  MINIMUM_TOUCH_TARGET_PX,
  WORKOUT_EXPERIENCE_STATES,
  WORKOUT_EXPERIENCE_SURFACES,
  WORKOUT_EXPERIENCE_TEXT_SIZES,
  WORKOUT_EXPERIENCE_VIEWPORTS,
} from "@/lib/workout-experience-foundation";

describe("workout-experience foundation", () => {
  it("locks the fixed scope, supported sizes, and destination ownership", () => {
    expect(FIXED_REDESIGN_WEIGHTS).toEqual({
      phase0: 24,
      phase1: 8,
      phase2: 18,
      phase3: 10,
      phase4: 18,
      phase5: 9,
      phase6: 7,
      release: 6,
    });
    expect(Object.values(FIXED_REDESIGN_WEIGHTS).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(WORKOUT_EXPERIENCE_VIEWPORTS).toEqual([320, 375, 390, 440, 1440]);
    expect(WORKOUT_EXPERIENCE_TEXT_SIZES).toEqual([
      { key: "compact", percent: 100 },
      { key: "default", percent: 115 },
      { key: "large", percent: 130 },
      { key: "extra-large", percent: 145 },
    ]);
    expect(MINIMUM_TOUCH_TARGET_PX).toBe(44);
    expect(WORKOUT_EXPERIENCE_SURFACES.map(({ id, route, phase }) => [id, route, phase])).toEqual([
      ["today", "/today", 3],
      ["active-workout", "/session/[id]", 4],
      ["history", "/history", 5],
      ["review", "/coach", 5],
      ["program", "/program", 6],
      ["settings", "/settings", 6],
      ["recovery", "/recovery", 6],
      ["simulation", "/simulation", 6],
    ]);
    expect(
      WORKOUT_EXPERIENCE_SURFACES.every(
        ({ uiOwners, dataOwners }) => uiOwners.length > 0 && dataOwners.length > 0,
      ),
    ).toBe(true);
    expect(WORKOUT_EXPERIENCE_SURFACES.every(({ invariant }) => invariant.length > 80)).toBe(true);
  });

  it("keeps the shared status vocabulary complete and truthful", () => {
    expect(WORKOUT_EXPERIENCE_STATES).toEqual([
      "idle",
      "pending",
      "saving",
      "saved",
      "retrying",
      "needs_attention",
      "recovered",
    ]);

    const attention = renderToStaticMarkup(
      <StateNotice
        state="needs_attention"
        title="This exceptionally long save status still needs attention"
        description="Your record is still on this device. Retry before finishing."
        action={<Button size="touch">Retry save</Button>}
      />,
    );
    expect(attention).toContain('role="alert"');
    expect(attention).not.toContain('aria-live="polite"');
    expect(attention).toContain("break-words");
    expect(attention).toContain("flex-wrap");
    expect(attention).toContain("min-h-11");
    expect(attention).toContain("whitespace-normal");

    const saved = renderToStaticMarkup(
      <StateNotice state="saved" title="Saved" />,
    );
    expect(saved).toContain('role="status"');
    expect(saved).toContain('data-state="saved"');
  });
});
