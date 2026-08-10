import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActiveWorkoutTimingReview } from "@/components/session/active-workout-timing-review";

describe("ActiveWorkoutTimingReview", () => {
  it("keeps a stale wall-clock span separate from unavailable active time", () => {
    const html = renderToStaticMarkup(
      <ActiveWorkoutTimingReview
        wallClockLabel="6 days"
        reviewRequired
        choice={null}
        ownerReportedMinutes=""
        onChoiceChange={vi.fn()}
        onOwnerReportedMinutesChange={vi.fn()}
      />,
    );

    expect(html).toContain("Timing needs review");
    expect(html).toContain("Wall clock: 6 days");
    expect(html).toContain("Active time unavailable");
    expect(html).toContain("Enter active time");
    expect(html).toContain("Active time is unknown");
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("Use wall-clock time");
  });

  it("labels a normal uninterrupted duration as active and wall-clock time", () => {
    const html = renderToStaticMarkup(
      <ActiveWorkoutTimingReview
        wallClockLabel="42 min"
        reviewRequired={false}
        choice="wall_clock_no_stale_signal"
        ownerReportedMinutes=""
        onChoiceChange={vi.fn()}
        onOwnerReportedMinutesChange={vi.fn()}
      />,
    );

    expect(html).toContain("Workout timing");
    expect(html).toContain("Wall clock: 42 min");
    expect(html).toContain("Active time: 42 min");
    expect(html).toContain("I was interrupted");
  });

  it("renders the owner-reported field without relabelling the wall clock", () => {
    const html = renderToStaticMarkup(
      <ActiveWorkoutTimingReview
        wallClockLabel="3 hr 15 min"
        reviewRequired
        choice="owner_reported"
        ownerReportedMinutes="57"
        onChoiceChange={vi.fn()}
        onOwnerReportedMinutesChange={vi.fn()}
      />,
    );

    expect(html).toContain("Active time: 57 min · owner reported");
    expect(html).toContain('data-testid="owner-reported-active-minutes"');
    expect(html).toContain("Your recorded start and finish stay unchanged");
  });
});
