import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkoutStatusBar } from "@/components/session/workout-status-bar";
import type { SessionExerciseData } from "@/components/session/types";
import type { SessionGuidanceAction } from "@/lib/session-guidance";

const exercise = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Barbell Squat",
  targetSets: 3,
  sets: [],
} as unknown as SessionExerciseData;

const callbacks = {
  onShowCurrent: () => undefined,
  onRestAdjust: () => undefined,
  onRestSkip: () => undefined,
  onRestContinue: () => undefined,
  onAddNote: () => undefined,
  onFinish: () => undefined,
};
const plannedPosition = {
  kind: "set" as const,
  number: 2,
  label: "Set 2",
  lowercaseLabel: "set 2",
};
const action = {
  kind: "working_set",
  actualExerciseName: "Barbell Squat",
  position: plannedPosition,
} as unknown as SessionGuidanceAction;

describe("WorkoutStatusBar", () => {
  it("keeps current-set identity, note, and finish in a thin non-scrolling bar", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
      />,
    );

    expect(html).toContain('aria-label="Workout status"');
    expect(html).toContain("Barbell Squat");
    expect(html).toContain("Set 2 of 3 · Next set");
    expect(html).toContain('aria-label="Add training note"');
    expect(html).toContain("Finish");
    expect(html).toContain("min-h-11 min-w-0 flex-1");
    expect(html).toContain("max-[360px]:sr-only");
    expect(html).toContain("bottom-[env(safe-area-inset-bottom)]");
    expect(html).not.toContain(
      "bottom-[calc(4rem+env(safe-area-inset-bottom))]",
    );
    expect(html).not.toContain("overflow-y-auto");
    expect(html).not.toContain("truncate");
  });

  it("shows a positive rest countdown without claiming the next set is ready", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{ phase: "running" } as never}
        restRemainingSec={75}
        {...callbacks}
      />,
    );

    expect(html).toContain("Set 2 of 3 · Resting");
    expect(html).toContain("1:15");
    expect(html).toContain('aria-label="Decrease rest by 15 seconds"');
    expect(html).toContain('aria-label="Increase rest by 15 seconds"');
    expect(html).toContain('aria-label="Skip rest"');
    expect(html).not.toContain("next set ready");
    expect(html).toContain('data-rest-state="running"');
    expect(html).toContain("border-amber-500");
    expect(html).toContain("bg-amber-100");
    expect(html).toContain("grid-cols-[minmax(0,1fr)_auto_auto]");
    expect(html).toContain("col-span-3");
  });

  it("turns the working-set dock into the immediate primary log action", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
        onPrimaryAction={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="active-workout-dock-primary"');
    expect(html).toContain('aria-label="Log Barbell Squat, Set 2"');
    expect(html).toContain("Set 2 of 3 · Log set");
    expect(html).toContain("bg-primary text-primary-foreground");
  });

  it("replaces the dock log action while an interrupted exercise skip reconciles", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
        onPrimaryAction={() => undefined}
        checkingExerciseSkip="Suspension Push-Up"
      />,
    );

    expect(html).toContain('aria-label="Checking skip for Suspension Push-Up"');
    expect(html).toContain("Checking skip…");
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain('aria-label="Log Barbell Squat, Set 2"');
    expect(html).not.toContain('data-testid="active-workout-dock-primary"');
    expect(html).not.toContain("Log set");
  });

  it("keeps confirmed future-exercise skip recovery dominant until resolved", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
        onPrimaryAction={() => undefined}
        recoveringSkippedExercise="Suspension Push-Up"
        onResolveSkippedExercise={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Resolve Suspension Push-Up"');
    expect(html).toContain("Suspension Push-Up");
    expect(html).toContain("Replace or continue");
    expect(html).toContain('data-testid="active-workout-dock-primary"');
    expect(html).not.toContain('aria-label="Log Barbell Squat, Set 2"');
    expect(html).not.toContain("Log set");
  });

  it("keeps failed future-exercise skip recovery dominant until reviewed", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
        onPrimaryAction={() => undefined}
        recoveringSkippedExercise="Suspension Push-Up"
        skippedExerciseRecoveryFailed
        onResolveSkippedExercise={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Resolve Suspension Push-Up"');
    expect(html).toContain("Review or try again");
    expect(html).toContain('data-testid="active-workout-dock-primary"');
    expect(html).not.toContain('aria-label="Log Barbell Squat, Set 2"');
    expect(html).not.toContain("Log set");
  });

  it("keeps the exact earlier blocker loggable while a later attempt is retained", () => {
    const retainedLaterAttempt = {
      ...exercise,
      sets: [{
        id: "optimistic-later",
        setNo: 2,
        saveState: "failed",
      }],
    } as unknown as SessionExerciseData;
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={retainedLaterAttempt}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
        onPrimaryAction={() => undefined}
        allowLogWithRetainedFailure
      />,
    );

    expect(html).toContain('data-testid="active-workout-dock-primary"');
    expect(html).toContain("Set 2 of 3 · Log set");
    expect(html).not.toContain("Set 2 of 3 · Failed");
  });

  it("names the ready-state transition instead of using a generic continue action", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{ phase: "ready" } as never}
        restRemainingSec={0}
        {...callbacks}
      />,
    );

    expect(html).toContain("Set 2 of 3 · Ready");
    expect(html).toContain("Dismiss rest timer");
    expect(html).not.toContain(">Continue<");
    expect(html).toContain("grid-cols-[minmax(0,1fr)_auto_auto]");
    expect(html).toContain("col-span-3");
    expect(html).toContain("w-full");
    expect(html).toContain("min-[520px]:flex");
    expect(html).toContain("border-emerald-600");
    expect(html).toContain('aria-live="polite"');
  });

  it("keeps an appended performance outside the planned-set denominator", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={{
          ...action,
          position: {
            kind: "extra",
            number: 1,
            label: "Extra set 1",
            lowercaseLabel: "extra set 1",
          },
        }}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
      />,
    );

    expect(html).toContain("Extra set 1 · Next set");
    expect(html).not.toContain("Set 4 of 3");
  });

  it("names the exact warm-up action without presenting a working set as current", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={{
          kind: "day_warmup",
          occurrenceId: "warmup-1",
          sessionExerciseId: null,
          sequenceIdx: 0,
          label: "Elliptical 2 min easy",
          exerciseName: null,
        }}
        exercise={null}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
      />,
    );

    expect(html).toContain("Elliptical 2 min easy");
    expect(html).toContain("Warm-up");
    expect(html).not.toContain("Barbell Squat");
    expect(html).not.toContain("Next set");
  });

  it("turns the warm-up dock into the immediate Complete action", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={{
          kind: "exercise_warmup",
          occurrenceId: "warmup-1",
          sessionExerciseId: exercise.id,
          sequenceIdx: 0,
          label: "Empty bar",
          exerciseName: "Barbell Squat",
        }}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
        onPrimaryAction={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="active-workout-dock-primary"');
    expect(html).toContain('aria-label="Complete Barbell Squat warm-up: Empty bar"');
    expect(html).toContain("Complete warm-up");
  });

  it("replaces a warm-up action when a future exercise skip is being checked", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={{
          kind: "day_warmup",
          occurrenceId: "warmup-1",
          sessionExerciseId: null,
          sequenceIdx: 0,
          label: "Elliptical 2 min easy",
          exerciseName: null,
        }}
        exercise={null}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
        onPrimaryAction={() => undefined}
        checkingExerciseSkip="Suspension Push-Up"
      />,
    );

    expect(html).toContain('aria-label="Checking skip for Suspension Push-Up"');
    expect(html).toContain("Suspension Push-Up");
    expect(html).toContain("Checking skip…");
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain('data-testid="active-workout-dock-primary"');
    expect(html).not.toContain("Complete warm-up");
    expect(html).not.toContain('aria-label="Complete Elliptical');
  });
});
