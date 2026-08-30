"use client";

import { useEffect, useRef } from "react";
import { FilePenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  formatSessionGuidanceAction,
  type SessionGuidanceFocusAction,
} from "@/lib/session-guidance";
import { cn } from "@/lib/utils";
import type { DurableRestTimer } from "@/lib/rest-timer";
import type { RestAlertPreference } from "@/lib/rest-alert-preference";
import type { RestCueChannelOutcome } from "@/lib/rest-timer";
import { ACTIVE_WORKOUT_OVERLAY_BOTTOM_VARIABLE } from "@/lib/active-workout-layout";
import type { SessionExerciseData } from "./types";
import { RestCockpit } from "./rest-cockpit";

type Props = {
  action: SessionGuidanceFocusAction | null;
  exercise: SessionExerciseData | null;
  timer: DurableRestTimer | null;
  restRemainingSec: number | null;
  restAlertPreference?: RestAlertPreference;
  restSoundState?: RestCueChannelOutcome;
  restDestinationLabel?: string | null;
  onShowCurrent: () => void;
  onPrimaryAction?: () => void;
  currentWorkingSetRevealed?: boolean;
  checkingExerciseSkip?: string | null;
  recoveringSkippedExercise?: string | null;
  skippedExerciseRecoveryFailed?: boolean;
  onResolveSkippedExercise?: () => void;
  onRestAdjust: (deltaSec: number) => void;
  onRestSkip: () => void;
  onRestContinue: () => void;
  onAddNote: () => void;
  onFinish: () => void;
  finishReady?: boolean;
  pendingPlannedCount?: number;
};

function saveStatus(exercise: SessionExerciseData | null) {
  const unconfirmed = exercise?.sets.find(
    (set) => set.saveState != null && set.saveState !== "saved",
  );
  if (unconfirmed?.saveState === "pending") return "Pending";
  if (unconfirmed?.saveState === "saving") return "Saving";
  if (unconfirmed?.saveState === "retrying") return "Retrying";
  if (unconfirmed?.saveState === "failed") return "Failed";
  return null;
}

export function WorkoutStatusBar({
  action,
  exercise,
  timer,
  restRemainingSec,
  restAlertPreference = "sound",
  restSoundState = "not_requested",
  restDestinationLabel = null,
  onShowCurrent,
  onPrimaryAction,
  currentWorkingSetRevealed = true,
  checkingExerciseSkip = null,
  recoveringSkippedExercise = null,
  skippedExerciseRecoveryFailed = false,
  onResolveSkippedExercise,
  onRestAdjust,
  onRestSkip,
  onRestContinue,
  onAddNote,
  onFinish,
  finishReady,
  pendingPlannedCount = 0,
}: Props) {
  const statusBarRef = useRef<HTMLElement>(null);
  const saving = action?.kind === "working_set" ? saveStatus(exercise) : null;
  const timerRunning = timer?.phase === "running" && restRemainingSec != null;
  const timerReady = timer?.phase === "ready" || timer?.phase === "skipped";
  const skipRecoveryPending =
    checkingExerciseSkip == null && recoveringSkippedExercise != null;
  const showsCurrentSet =
    action?.kind === "working_set" &&
    checkingExerciseSkip == null &&
    !skipRecoveryPending &&
    !currentWorkingSetRevealed;
  const hidesRevealedCurrentSet =
    action?.kind === "working_set" &&
    checkingExerciseSkip == null &&
    !skipRecoveryPending &&
    currentWorkingSetRevealed;
  const status = checkingExerciseSkip != null
    ? "Checking skip…"
    : skipRecoveryPending
      ? skippedExerciseRecoveryFailed
        ? "Review or try again"
        : "Replace or continue"
      : saving ?? (
    timerRunning
      ? "Resting"
      : timerReady
        ? "Ready"
        : action?.kind === "working_set"
          ? "Next set"
          : action
            ? "Warm-up"
            : "Ready to finish"
  );
  const setPosition = action?.kind === "working_set" ? action.position : null;
  const title = checkingExerciseSkip ?? recoveringSkippedExercise ?? (action
    ? action.kind === "working_set"
      ? action.actualExerciseName
      : formatSessionGuidanceAction(action)
    : "Workout");
  const canFinishNow = finishReady ?? action == null;
  const isFinishingEarly = pendingPlannedCount > 0;
  const completesCurrentWarmup =
    checkingExerciseSkip == null &&
    !skipRecoveryPending &&
    action != null &&
    action.kind !== "working_set" &&
    action.kind !== "rest" &&
    onPrimaryAction != null;
  const resolvesSkippedExercise =
    skipRecoveryPending && onResolveSkippedExercise != null;
  const runsPrimaryAction =
    resolvesSkippedExercise || completesCurrentWarmup;
  const workingSetStatus = showsCurrentSet
    ? saving == null
      ? "Show current set"
      : `${saving} · Show current set`
    : status;
  const restAlertLabel = restAlertPreference === "visual_only"
    ? "Visual"
    : restAlertPreference === "vibration"
      ? "Vibrate"
      : restSoundState === "blocked"
        ? "Sound blocked"
        : restSoundState === "unavailable"
          ? "Sound unavailable"
          : restAlertPreference === "sound_and_vibration"
            ? "Sound + vibrate"
            : "Sound";
  const restAlertAriaLabel = restAlertPreference === "visual_only"
    ? "visual only"
    : restAlertLabel.toLowerCase();
  const resolvedRestDestinationLabel = restDestinationLabel ?? (
    action?.kind === "rest"
      ? action.destination
        ? formatSessionGuidanceAction(action.destination)
        : null
      : action
        ? formatSessionGuidanceAction(action)
        : null
  );
  useEffect(() => {
    const element = statusBarRef.current;
    if (!element) return;
    const root = document.documentElement;
    const previousValue = root.style.getPropertyValue(
      ACTIVE_WORKOUT_OVERLAY_BOTTOM_VARIABLE,
    );
    const updateOverlayOffset = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      root.style.setProperty(
        ACTIVE_WORKOUT_OVERLAY_BOTTOM_VARIABLE,
        `calc(${height}px + 0.75rem + env(safe-area-inset-bottom))`,
      );
    };
    updateOverlayOffset();
    const observer = new ResizeObserver(updateOverlayOffset);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (previousValue) {
        root.style.setProperty(
          ACTIVE_WORKOUT_OVERLAY_BOTTOM_VARIABLE,
          previousValue,
        );
      } else {
        root.style.removeProperty(ACTIVE_WORKOUT_OVERLAY_BOTTOM_VARIABLE);
      }
    };
  }, []);
  return (
    <aside
      ref={statusBarRef}
      id="workout-rest-status"
      aria-label="Workout status"
      data-rest-state={
        timerRunning ? "running" : timerReady ? "ready" : "inactive"
      }
      className={cn(
        "fixed inset-x-0 bottom-[env(safe-area-inset-bottom)] z-30 border-t bg-background shadow-[0_-5px_18px_rgb(0_0_0/0.12)] lg:bottom-0 lg:left-[var(--main-sidebar-width)]",
        timerRunning &&
          "border-amber-500 bg-amber-100 dark:border-amber-500 dark:bg-amber-950",
        timerReady &&
          "border-emerald-600 bg-emerald-50 dark:bg-emerald-950",
      )}
    >
      <div
        className="mx-auto flex min-h-14 max-w-3xl flex-wrap items-center gap-1 px-1 py-1 min-[400px]:px-2 sm:gap-2 sm:px-3"
      >
        {!timerRunning && !timerReady && !hidesRevealedCurrentSet ? (
          <button
          type="button"
          data-testid={runsPrimaryAction ? "active-workout-dock-primary" : undefined}
          disabled={checkingExerciseSkip != null}
          aria-label={completesCurrentWarmup
              ? `Complete ${title}`
              : checkingExerciseSkip != null
                ? `Checking skip for ${checkingExerciseSkip}`
                : resolvesSkippedExercise
                  ? `Resolve ${recoveringSkippedExercise}`
                  : showsCurrentSet
                    ? `Show ${title}, ${setPosition?.label ?? "current set"}`
              : undefined}
          onClick={
            resolvesSkippedExercise
              ? onResolveSkippedExercise
              : runsPrimaryAction
                ? onPrimaryAction
                : onShowCurrent
          }
          className={cn(
            "min-h-11 min-w-0 flex-1 rounded-lg border border-primary/20 bg-primary/5 px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
            runsPrimaryAction &&
              "border-primary bg-primary text-primary-foreground",
          )}
        >
          <span
            data-ui-essential="true"
            className={cn(
              "block break-words text-xs font-semibold leading-tight max-[360px]:sr-only min-[520px]:text-sm",
              completesCurrentWarmup && "sr-only",
            )}
          >
            {title}
          </span>
          <span
            role="status"
            aria-live="polite"
            className={cn(
              "block break-words text-[0.6875rem] leading-tight text-muted-foreground min-[520px]:text-[0.8125rem]",
              saving === "Failed" && "font-semibold text-destructive",
              runsPrimaryAction && "text-primary-foreground/85",
              timerRunning &&
                "font-semibold text-amber-950 dark:text-amber-100",
              timerReady &&
                "font-semibold text-emerald-900 dark:text-emerald-100",
            )}
          >
            {checkingExerciseSkip != null || skipRecoveryPending
              ? status
              : setPosition
              ? setPosition.kind === "extra"
                ? `${setPosition.label} · ${workingSetStatus}`
                : `${setPosition.label} of ${exercise?.targetSets ?? "open"} · ${workingSetStatus}`
              : completesCurrentWarmup
                ? "Complete warm-up"
                : status}
          </span>
          </button>
        ) : null}

        {(timerRunning || timerReady) && timer ? (
          <RestCockpit
            phase={timer.phase === "continued" ? "ready" : timer.phase}
            remainingSeconds={restRemainingSec}
            alertLabel={restAlertLabel}
            alertAriaLabel={restAlertAriaLabel}
            destinationLabel={resolvedRestDestinationLabel}
            onAdjust={onRestAdjust}
            onSkip={onRestSkip}
            onContinue={onRestContinue}
          />
        ) : null}

        <Button
          data-testid="contextual-note-trigger-workout"
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(
            "min-h-11 min-w-11 shrink-0",
            (timerRunning || timerReady) && "ml-auto",
          )}
          onClick={onAddNote}
          aria-label="Add training note"
        >
          <FilePenLine className="size-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant={canFinishNow ? "default" : "outline"}
          className="min-h-11 shrink-0 px-2"
          onClick={onFinish}
          aria-label={canFinishNow ? "Finish workout" : "Review workout finish"}
        >
          {isFinishingEarly ? (
            <>
              <span className="min-[400px]:hidden">End</span>
              <span className="max-[399px]:hidden">Finish early</span>
            </>
          ) : "Finish"}
        </Button>
      </div>
    </aside>
  );
}
