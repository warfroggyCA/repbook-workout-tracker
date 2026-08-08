import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkoutGuidanceSummary } from "@/components/session/workout-guidance-summary";
import type { SessionGuidanceProjection } from "@/lib/session-guidance";

const guidance = {
  totals: { performed: 3, planned: 14, skipped: 0 },
  current: {
    sessionExerciseId: "exercise-1",
    occurrenceId: "set-1",
    kind: "working_set",
    actualExerciseName: "Single-Arm Supported Dumbbell Romanian Deadlift",
    planned: { setNumber: 1 },
    position: {
      kind: "set",
      number: 1,
      label: "Set 1",
      lowercaseLabel: "set 1",
    },
    group: null,
  },
  upNext: {
    sessionExerciseId: "exercise-1",
    occurrenceId: "set-2",
    kind: "working_set",
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
  currentAction: null,
  nextAction: null,
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
guidance.currentAction = guidance.current;
guidance.nextAction = guidance.upNext;

describe("WorkoutGuidanceSummary", () => {
  it("retains full action text while budgeting the smallest viewport", () => {
    const html = renderToStaticMarkup(
      <WorkoutGuidanceSummary guidance={guidance} compact />,
    );

    expect(html).toContain(
      "Now:</span> Single-Arm Supported Dumbbell Romanian Deadlift, set 1",
    );
    expect(html).toContain(
      "Next:</span> Single-Arm Supported Dumbbell Romanian Deadlift, set 2",
    );
    expect(html).toContain(
      "Single-Arm Supported Dumbbell Romanian Deadlift, set 2",
    );
    expect(html).toContain(
      "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm",
    );
    expect(html).toContain(
      "min-w-0 flex-1 basis-48 break-words leading-snug max-[359px]:line-clamp-2",
    );
    expect(html).toContain("Long Resistance Band With Door Anchor");
    expect(html).toContain("Prepare:</span>");
    expect(html).not.toContain("Use now:</span>");
    expect(html).toContain("break-words text-xs text-muted-foreground");
    expect(html).toContain("max-[359px]:hidden");
    expect(html).not.toContain("truncate");
  });

  it("defers duplicate next-work guidance when the current action card owns it", () => {
    const html = renderToStaticMarkup(
      <WorkoutGuidanceSummary
        guidance={guidance}
        compact
        deferNextActionToCurrentCard
      />,
    );

    expect(html).toContain(
      "Now:</span> Single-Arm Supported Dumbbell Romanian Deadlift, set 1",
    );
    expect(html).not.toContain("Next:</span>");
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
          nextAction: {
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

  it("leads with a pending warm-up and labels the first working set as next", () => {
    const html = renderToStaticMarkup(
      <WorkoutGuidanceSummary
        guidance={{
          ...guidance,
          currentAction: {
            kind: "day_warmup",
            occurrenceId: "warmup-1",
            sessionExerciseId: null,
            sequenceIdx: 0,
            label: "Elliptical 2 min easy",
            exerciseName: null,
          },
          nextAction: guidance.current,
        }}
        compact
      />,
    );

    expect(html).toContain("Now:</span> Elliptical 2 min easy");
    expect(html).toContain(
      "Next:</span> Single-Arm Supported Dumbbell Romanian Deadlift, set 1",
    );
    expect(html).not.toContain("Prepare:");
  });
});
