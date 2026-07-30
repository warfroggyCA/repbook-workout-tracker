import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scalableMicroLabelSurfaces = [
  "src/components/coach/activity-context.tsx",
  "src/components/history/activity-summary.tsx",
  "src/components/history/history-calendar.tsx",
  "src/components/history/history-calendar-workspace.tsx",
  "src/components/history/history-exercises-workspace.tsx",
  "src/components/history/history-insights-workspace.tsx",
  "src/components/history/history-lens-card.tsx",
  "src/components/history/history-more-menu.tsx",
  "src/components/history/history-workspace.tsx",
  "src/components/import/hevy-history-import.tsx",
  "src/components/import/routine-import.tsx",
  "src/components/session/live-coach-drawer.tsx",
] as const;

describe("micro-label sizing contract", () => {
  it.each(scalableMicroLabelSurfaces)(
    "%s keeps small labels tied to the account text-size preference",
    (path) => {
      const source = readFileSync(path, "utf8");

      expect(source).not.toMatch(/text-\[(?:9|10|11)px\]/);
    },
  );
});
