import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActiveWorkoutTimingReview } from "@/components/session/active-workout-timing-review";

describe("ActiveWorkoutTimingReview", () => {
  it("keeps a stale wall-clock span separate from unavailable active time", () => {
    const html = renderToStaticMarkup(
      <ActiveWorkoutTimingReview
        wallClockLabel="6 days"
        wallClockSeconds={518_400}
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
        wallClockSeconds={2_520}
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
        wallClockSeconds={11_700}
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

  it("renders zero minutes as valid owner evidence instead of unavailable", () => {
    const html = renderToStaticMarkup(
      <ActiveWorkoutTimingReview
        wallClockLabel="42 min"
        wallClockSeconds={2_520}
        reviewRequired
        choice="owner_reported"
        ownerReportedMinutes="0"
        onChoiceChange={vi.fn()}
        onOwnerReportedMinutesChange={vi.fn()}
      />,
    );

    expect(html).toContain("Active time: 0 min · owner reported");
    expect(html).toContain('min="0"');
    expect(html).toContain('max="10080"');
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("does not present a decimal as confirmed evidence and explains the constraint accessibly", () => {
    const html = renderToStaticMarkup(
      <ActiveWorkoutTimingReview
        wallClockLabel="6 days"
        wallClockSeconds={518_400}
        reviewRequired
        choice="owner_reported"
        ownerReportedMinutes="1.5"
        onChoiceChange={vi.fn()}
        onOwnerReportedMinutesChange={vi.fn()}
      />,
    );

    expect(html).toContain("Active time unavailable");
    expect(html).not.toContain("Active time: 1.5 min · owner reported");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(
      'aria-describedby="owner-reported-active-minutes-help owner-reported-active-minutes-error"',
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("whole number of minutes");
  });

  it("reports the global maximum before wall-clock validation for a very old session", () => {
    const html = renderToStaticMarkup(
      <ActiveWorkoutTimingReview
        wallClockLabel="20 days"
        wallClockSeconds={1_728_000}
        reviewRequired
        choice="owner_reported"
        ownerReportedMinutes="10081"
        onChoiceChange={vi.fn()}
        onOwnerReportedMinutesChange={vi.fn()}
      />,
    );

    expect(html).toContain("Active time unavailable");
    expect(html).toContain("between 0 and 10,080 minutes");
    expect(html).not.toContain("cannot exceed the recorded wall-clock time of");
  });

  it("accepts the global maximum when the wall clock supports it and distinguishes wall-clock overruns", () => {
    const maximumHtml = renderToStaticMarkup(
      <ActiveWorkoutTimingReview
        wallClockLabel="7 days"
        wallClockSeconds={604_800}
        reviewRequired
        choice="owner_reported"
        ownerReportedMinutes="10080"
        onChoiceChange={vi.fn()}
        onOwnerReportedMinutesChange={vi.fn()}
      />,
    );
    const overrunHtml = renderToStaticMarkup(
      <ActiveWorkoutTimingReview
        wallClockLabel="42 min"
        wallClockSeconds={2_520}
        reviewRequired
        choice="owner_reported"
        ownerReportedMinutes="43"
        onChoiceChange={vi.fn()}
        onOwnerReportedMinutesChange={vi.fn()}
      />,
    );

    expect(maximumHtml).toContain(
      "Active time: 10080 min · owner reported",
    );
    expect(maximumHtml).not.toContain('aria-invalid="true"');
    expect(overrunHtml).toContain("Active time unavailable");
    expect(overrunHtml).toContain(
      "cannot exceed the recorded wall-clock time of 42 min",
    );
  });
});
