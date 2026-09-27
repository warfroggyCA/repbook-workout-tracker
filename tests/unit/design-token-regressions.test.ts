import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVE_WORKOUT_OVERLAY_BOTTOM_VARIABLE } from "@/lib/active-workout-layout";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:css|tsx?)$/.test(entry.name) ? [path] : [];
  });
}

describe("design token regressions", () => {
  it("never mixes colours in the oklch space", () => {
    // `--card` is `oklch(1 0 0)`: its hue is an explicit 0, not "none". Mixing
    // any tint toward it in oklch interpolates hue the short way round, so the
    // selected (blue) surface rendered magenta, amber borders teal, destructive
    // borders purple and the recovered (green) state pink. oklab has no hue
    // component and keeps each tint on its own hue.
    const offenders = sourceFiles("src").flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return /color-mix\(in[ _]oklch\b/.test(source) ? [file] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("keeps focused workout controls clear of the fixed workout dock", () => {
    // WCAG 2.4.11: the dock publishes its live height in this variable and
    // removes it on unmount, so scroll padding is zero outside a workout.
    const globals = readFileSync("src/app/globals.css", "utf8");
    const htmlRule = /(^|\n)html \{([^}]*)\}/.exec(globals)?.[2] ?? "";
    expect(htmlRule).toContain(
      `scroll-padding-bottom: var(${ACTIVE_WORKOUT_OVERLAY_BOTTOM_VARIABLE}, 0px);`,
    );
  });
});
