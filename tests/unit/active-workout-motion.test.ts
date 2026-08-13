import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { activeWorkoutScrollBehavior } from "@/lib/active-workout-motion";

describe("active workout motion", () => {
  it("uses instant scrolling when reduced motion is requested", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });

    expect(activeWorkoutScrollBehavior({ matchMedia })).toBe("auto");
    expect(matchMedia).toHaveBeenCalledWith(
      "(prefers-reduced-motion: reduce)",
    );
  });

  it("uses smooth scrolling only when reduced motion is not requested", () => {
    expect(activeWorkoutScrollBehavior({
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    })).toBe("smooth");
  });

  it("keeps active-workout reveal paths on the shared motion policy", () => {
    const sources = [
      "src/components/session/session-runner.tsx",
      "src/components/session/exercise-card.tsx",
    ].map((path) => readFileSync(path, "utf8"));

    for (const source of sources) {
      expect(source).not.toContain('behavior: "smooth"');
      expect(source).not.toContain('revealWorkoutTarget(target, "smooth")');
    }
  });
});
