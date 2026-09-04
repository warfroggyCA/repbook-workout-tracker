import { readFileSync } from "node:fs";
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
  it("keeps one fixed Log action with note and Finish for the revealed current set", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        currentSetFormId="active-set-form-2"
        {...callbacks}
      />,
    );

    expect(html).toContain('aria-label="Workout status"');
    expect(html).toContain("Barbell Squat");
    expect(html).not.toContain("Set 2 of 3");
    expect(html).toContain('data-testid="active-log-set"');
    expect(html).toContain('form="active-set-form-2"');
    const fixedLogButton = html.match(
      /<button[^>]*data-testid="active-log-set"[^>]*>/,
    )?.[0];
    expect(fixedLogButton).toContain('disabled=""');
    expect(html).toContain("Log set 2");
    expect(html).toContain('aria-label="Add training note"');
    expect(html).toContain("Finish");
    expect(html).toContain("bottom-[env(safe-area-inset-bottom)]");
    expect(html).not.toContain(
      "bottom-[calc(4rem+env(safe-area-inset-bottom))]",
    );
    expect(html).not.toContain("overflow-y-auto");
    expect(html).not.toContain("truncate");
    expect(
      readFileSync(
        "src/components/session/workout-status-bar.tsx",
        "utf8",
      ),
    ).toContain("key={currentSetFormId}");
  });

  it("names the exact available action for equipment decisions", () => {
    const choose = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        currentSetBlockingReason="Choose equipment before logging this set."
        onPrimaryAction={() => undefined}
        {...callbacks}
      />,
    );
    const replace = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        currentSetBlockingReason="Equipment unavailable. Replace for today or skip exercise."
        onPrimaryAction={() => undefined}
        {...callbacks}
      />,
    );

    expect(choose).toContain("Choose equipment");
    expect(replace).toContain("Replace for today");
    expect(replace).not.toContain("Log set 2");
  });

  it("makes planned-work completion explicit without adding another action", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        pendingPlannedCount={7}
        {...callbacks}
      />,
    );

    expect(html).toContain(">Review</span>");
    expect(html).toContain(">Review and finish</span>");
    expect(html).toContain('aria-label="Review and finish workout"');
  });

  it("shows a positive rest countdown without claiming the next set is ready", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{ phase: "running" } as never}
        restRemainingSec={75}
        currentSetFormId="active-set-form-2"
        {...callbacks}
      />,
    );

    expect(html).toContain("Next: Barbell Squat, set 2");
    expect(html).toContain("1:15");
    expect(html).toContain('aria-label="Rest alert: sound"');
    expect(html).toContain('aria-label="Decrease rest by 15 seconds"');
    expect(html).toContain('aria-label="Increase rest by 15 seconds"');
    expect(html).toContain("End rest");
    expect(html).not.toContain("Skip rest");
    expect(html).not.toContain("next set ready");
    expect(html).toContain('data-rest-state="running"');
    expect(html).not.toContain("border-amber-500");
    expect(html).not.toContain("bg-amber-100");
    expect(html).toContain("rounded-xl");
    expect(html).toContain("border-primary/40");
    expect(html).toContain("bg-[var(--surface-selected)]");
    expect(html).toContain('data-testid="rest-cockpit"');
    expect(html).not.toContain('aria-live="polite"');
    expect(html).toContain('data-testid="active-log-set"');
    expect(html).toContain("Log set 2");
    expect(html).not.toContain("Set 2 of 3 · Resting");
  });

  it("names the action the rest period is preparing for", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={{
          kind: "rest",
          actionId: "rest-1",
          sequenceIdx: 0,
          phase: "running",
          restKind: "straight_set",
          totalSec: 75,
          source: null,
          destination: action,
        }}
        exercise={exercise}
        timer={{ phase: "running" } as never}
        restRemainingSec={75}
        {...callbacks}
      />,
    );

    expect(html).toContain("Next: Barbell Squat, set 2");
    expect(html).not.toContain("Rest after");
  });

  it("distinguishes returning to earlier planned work from a forward rest destination", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{ phase: "running" } as never}
        restRemainingSec={75}
        restDestinationLabel={null}
        restResumeLabel="Barbell Squat, set 2"
        currentSetFormId="active-set-form-2"
        {...callbacks}
      />,
    );

    expect(html).toContain("Resume plan: Barbell Squat, set 2");
    expect(html).not.toContain("No further work");
    expect(html).not.toContain("Next: Barbell Squat, set 2");
    expect(html).toContain('data-testid="active-log-set"');
  });

  it("shows an explicitly visual-only timer mode instead of implying sound", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{ phase: "running" } as never}
        restRemainingSec={45}
        restAlertPreference="visual_only"
        {...callbacks}
      />,
    );

    expect(html).toContain('aria-label="Rest alert: visual only"');
    expect(html).toContain(">· Visual</span>");
    expect(html).not.toContain('aria-label="Rest alert: sound"');
  });

  it("states when requested timer sound is blocked or unavailable", () => {
    const blocked = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{ phase: "running" } as never}
        restRemainingSec={45}
        restAlertPreference="sound"
        restSoundState="blocked"
        {...callbacks}
      />,
    );
    const unavailable = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{ phase: "running" } as never}
        restRemainingSec={45}
        restAlertPreference="sound"
        restSoundState="unavailable"
        {...callbacks}
      />,
    );

    expect(blocked).toContain('aria-label="Rest alert: sound blocked"');
    expect(blocked).toContain(">· Sound blocked</span>");
    expect(unavailable).toContain(
      'aria-label="Rest alert: sound unavailable"',
    );
    expect(unavailable).toContain(">· Sound unavailable</span>");
  });

  it("keeps the working-set dock as neutral navigation while the cockpit owns logging", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
        onPrimaryAction={() => undefined}
        currentWorkingSetRevealed={false}
      />,
    );

    expect(html).not.toContain('data-testid="active-workout-dock-primary"');
    expect(html).toContain('aria-label="Show Barbell Squat, Set 2"');
    expect(html).toContain("Set 2 of 3 · Show current set");
    expect(html).not.toContain(">Log set</span>");
    expect(html).not.toContain("bg-primary text-primary-foreground");
  });

  it("truthfully reveals a collapsed current set before offering to log it", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={null}
        restRemainingSec={null}
        {...callbacks}
        onPrimaryAction={() => undefined}
        currentWorkingSetRevealed={false}
      />,
    );

    expect(html).toContain('aria-label="Show Barbell Squat, Set 2"');
    expect(html).toContain("Set 2 of 3 · Show current set");
    expect(html).not.toContain('data-testid="active-workout-dock-primary"');
    expect(html).not.toContain('aria-label="Log Barbell Squat, Set 2"');
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
        currentWorkingSetRevealed={false}
      />,
    );

    expect(html).not.toContain('data-testid="active-workout-dock-primary"');
    expect(html).toContain('aria-label="Show Barbell Squat, Set 2"');
    expect(html).toContain("Set 2 of 3 · Failed · Show current set");
    expect(html).not.toContain(">Log set</span>");
  });

  it("announces the brief ready state without adding a dismiss action", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{
          phase: "ready",
          generationId: "rest-ready",
          readyAt: 1_000,
        } as never}
        restRemainingSec={0}
        currentSetFormId="active-set-form-2"
        {...callbacks}
      />,
    );

    expect(html).toContain("Rest complete");
    expect(html).toContain("Next: Barbell Squat, set 2");
    expect(html).not.toContain("Dismiss rest timer");
    expect(html).not.toContain(">Continue<");
    expect(html).toContain('data-testid="rest-cockpit"');
    expect(html).toContain("border-emerald-600");
    expect(html).toContain('aria-live="polite"');
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="active-log-set"');
    expect(
      readFileSync(
        "src/components/session/workout-status-bar.tsx",
        "utf8",
      ),
    ).toContain("REST_CONFIRMATION_DURATION_MS = 4_000");
  });

  it("keeps one completion announcement when the destination is collapsed or absent", () => {
    const collapsedDestination = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{
          phase: "ready",
          generationId: "rest-ready-collapsed",
          readyAt: 1_000,
        } as never}
        restRemainingSec={0}
        currentWorkingSetRevealed={false}
        {...callbacks}
      />,
    );
    const noFurtherWork = renderToStaticMarkup(
      <WorkoutStatusBar
        action={null}
        exercise={null}
        timer={{
          phase: "ready",
          generationId: "rest-ready-finished",
          readyAt: 1_000,
        } as never}
        restRemainingSec={0}
        {...callbacks}
      />,
    );
    const athleteEndedCollapsed = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{
          phase: "skipped",
          generationId: "rest-ended-collapsed",
          readyAt: 1_000,
        } as never}
        restRemainingSec={0}
        currentWorkingSetRevealed={false}
        {...callbacks}
      />,
    );

    expect(collapsedDestination).toContain("Rest complete");
    expect(collapsedDestination).toContain("Set 2 of 3 · Show current set");
    expect(collapsedDestination.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(collapsedDestination.match(/role="status"/g)).toHaveLength(1);
    expect(noFurtherWork).toContain("Rest complete");
    expect(noFurtherWork).toContain("No further work");
    expect(noFurtherWork.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(noFurtherWork.match(/role="status"/g)).toHaveLength(1);
    expect(athleteEndedCollapsed).toContain("Rest ended");
    expect(athleteEndedCollapsed).not.toContain('aria-live="polite"');
    expect(athleteEndedCollapsed).not.toContain('role="status"');
  });

  it("shows an athlete-ended rest as neutral context", () => {
    const html = renderToStaticMarkup(
      <WorkoutStatusBar
        action={action}
        exercise={exercise}
        timer={{
          phase: "skipped",
          generationId: "rest-ended",
          readyAt: 1_000,
        } as never}
        restRemainingSec={0}
        currentSetFormId="active-set-form-2"
        {...callbacks}
      />,
    );

    expect(html).toContain("Rest ended");
    expect(html).toContain("Next: Barbell Squat, set 2");
    expect(html).not.toContain('aria-live="polite"');
    expect(html).not.toContain("border-emerald-600");
    expect(html).not.toContain("Dismiss rest timer");
    expect(html).toContain('data-testid="active-log-set"');
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
        currentWorkingSetRevealed={false}
        {...callbacks}
      />,
    );

    expect(html).toContain("Extra set 1 · Show current set");
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
    expect(html).toContain('aria-label="Complete Barbell Squat — preparation set: Empty bar"');
    expect(html).toContain("Complete warm-up");
    expect(html).toContain("Barbell Squat — preparation set: Empty bar");
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
