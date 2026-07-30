import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkoutGuidanceSummary } from "@/components/session/workout-guidance-summary";
import type { SessionGuidanceProjection } from "@/lib/session-guidance";

const guidance = {
  totals: { performed: 3, planned: 14, skipped: 0 },
  current: null,
  upNext: {
    sessionExerciseId: "exercise-1",
    actualExerciseName: "Single-Arm Supported Dumbbell Romanian Deadlift",
    planned: { setNumber: 2 },
    position: {
      kind: "set",
      number: 2,
      label: "Set 2",
      lowercaseLabel: "set 2",
    },
    group: null,
  },
  currentEquipment: { status: "none" },
  upcomingEquipment: {
    status: "broad_only",
    equipmentLabel: "Long Resistance Band With Door Anchor",
    attachmentLabel: null,
    guidance: null,
    message: "Exact setup identity remains unknown.",
  },
  activeGroup: null,
} as unknown as SessionGuidanceProjection;

describe("WorkoutGuidanceSummary", () => {
  it("allows the compact next-work identity to wrap instead of truncating it", () => {
    const html = renderToStaticMarkup(
      <WorkoutGuidanceSummary guidance={guidance} compact />,
    );

    expect(html).toContain(
      "Single-Arm Supported Dumbbell Romanian Deadlift, set 2",
    );
    expect(html).toContain("min-w-0 break-words leading-snug");
    expect(html).toContain("Long Resistance Band With Door Anchor");
    expect(html).toContain("break-words text-xs text-muted-foreground");
    expect(html).not.toContain("truncate");
  });

  it("names appended performed work as an extra instead of extending planned numbering", () => {
    const html = renderToStaticMarkup(
      <WorkoutGuidanceSummary
        guidance={{
          ...guidance,
          upNext: {
            ...guidance.upNext!,
            planned: {
              setNumber: 4,
              repsMin: null,
              repsMax: null,
              load: null,
              loadUnit: null,
              loadPercent: null,
              loadText: null,
            },
            position: {
              kind: "extra",
              number: 1,
              label: "Extra set 1",
              lowercaseLabel: "extra set 1",
            },
          },
        }}
        compact
      />,
    );

    expect(html).toContain(
      "Single-Arm Supported Dumbbell Romanian Deadlift, extra set 1",
    );
    expect(html).not.toContain(", set 4");
  });
});
