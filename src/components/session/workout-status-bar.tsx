"use client";

import { FilePenLine, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  formatSessionGuidanceAction,
  type SessionGuidanceFocusAction,
} from "@/lib/session-guidance";
import { cn } from "@/lib/utils";
import type { DurableRestTimer } from "@/lib/rest-timer";
import type { RestAlertPreference } from "@/lib/rest-alert-preference";
import type { SessionExerciseData } from "./types";

type Props = {
  action: SessionGuidanceFocusAction | null;
  exercise: SessionExerciseData | null;
  timer: DurableRestTimer | null;
  restRemainingSec: number | null;
  restAlertPreference?: RestAlertPreference;
  onShowCurrent: () => void;
  onPrimaryAction?: () => void;
  currentWorkingSetRevealed?: boolean;
  allowLogWithRetainedFailure?: boolean;
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
  onShowCurrent,
  onPrimaryAction,
  currentWorkingSetRevealed = true,
  allowLogWithRetainedFailure = false,
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
}: Props) {
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
  const logsCurrentSet =
    action?.kind === "working_set" &&
    checkingExerciseSkip == null &&
    !skipRecoveryPending &&
    currentWorkingSetRevealed &&
    onPrimaryAction != null &&
    (saving == null || (saving === "Failed" && allowLogWithRetainedFailure));
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
    resolvesSkippedExercise || logsCurrentSet || completesCurrentWarmup;
  const workingSetStatus = logsCurrentSet
    ? "Log set"
    : showsCurrentSet
      ? "Show current set"
      : status;

  return (
    <aside
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
        className={cn(
          "mx-auto min-h-14 max-w-3xl items-center gap-0.5 px-1 py-1 min-[400px]:gap-1 min-[400px]:px-2 sm:gap-2 sm:px-3",
          timerRunning
            ? "grid grid-cols-[minmax(0,1fr)_auto_auto] min-[520px]:flex"
            : timerReady
              ? "grid grid-cols-[minmax(0,1fr)_auto_auto] min-[520px]:flex"
              : "flex",
        )}
      >
        <button
          type="button"
          data-testid={runsPrimaryAction ? "active-workout-dock-primary" : undefined}
          disabled={checkingExerciseSkip != null}
          aria-label={logsCurrentSet
            ? `Log ${title}, ${setPosition?.label ?? "current set"}`
            : completesCurrentWarmup
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
            timerRunning &&
              "col-span-2 col-start-1 row-start-1 min-[520px]:col-span-1 min-[520px]:col-start-auto min-[520px]:row-start-auto",
            timerReady &&
              "col-span-2 col-start-1 row-start-1 min-[520px]:col-span-1 min-[520px]:col-start-auto min-[520px]:row-start-auto",
          )}
        >
          <span className="block break-words text-xs font-semibold leading-tight max-[360px]:sr-only sm:text-sm">
            {title}
          </span>
          <span
            role="status"
            aria-live="polite"
            className={cn(
              "block break-words text-[11px] leading-tight text-muted-foreground",
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

        {timerRunning && (
          <div
            role="region"
            aria-label="Rest timer"
            className="col-span-3 col-start-1 row-start-2 flex min-w-0 w-full shrink-0 items-center justify-between gap-0.5 min-[360px]:col-span-2 min-[520px]:col-span-1 min-[520px]:col-start-auto min-[520px]:row-start-auto min-[520px]:w-auto min-[520px]:justify-start"
          >
            <span
              className="flex min-w-12 flex-col items-center text-center font-semibold text-amber-950 dark:text-amber-100"
              aria-label={`Rest alert: ${restAlertPreference.replaceAll("_", " ")}`}
            >
              <span className="text-sm tabular-nums">
                {Math.floor(restRemainingSec / 60)}:{String(restRemainingSec % 60).padStart(2, "0")}
              </span>
              <span className="text-[9px] leading-none">
                {restAlertPreference === "visual_only"
                  ? "Visual"
                  : restAlertPreference === "vibration"
                    ? "Vibrate"
                    : restAlertPreference === "sound_and_vibration"
                      ? "Sound + vibrate"
                      : "Sound"}
              </span>
            </span>
            <Button type="button" variant="ghost" size="icon-sm" className="min-h-11 min-w-11" onClick={() => onRestAdjust(-15)} aria-label="Decrease rest by 15 seconds">
              <Minus className="size-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" className="min-h-11 min-w-11" onClick={() => onRestAdjust(15)} aria-label="Increase rest by 15 seconds">
              <Plus className="size-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" className="min-h-11 min-w-11" onClick={onRestSkip} aria-label="Skip rest">
              <X className="size-4" />
            </Button>
          </div>
        )}

        {timerReady && (
          <Button
            type="button"
            size="sm"
            className="col-span-3 col-start-1 row-start-2 min-h-11 w-full shrink-0 px-2 min-[360px]:col-span-2 min-[520px]:col-span-1 min-[520px]:col-start-auto min-[520px]:row-start-auto min-[520px]:w-auto"
            onClick={onRestContinue}
          >
            Dismiss rest timer
          </Button>
        )}

        <Button
          data-testid="contextual-note-trigger-workout"
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(
            "min-h-11 min-w-11 shrink-0",
            (timerRunning || timerReady) &&
              "col-start-3 row-start-1 justify-self-end min-[520px]:col-start-auto min-[520px]:row-start-auto",
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
          className={cn(
            "min-h-11 shrink-0 px-2",
            (timerRunning || timerReady) &&
              "col-span-3 col-start-1 row-start-3 w-full min-[360px]:col-span-1 min-[360px]:col-start-3 min-[360px]:row-start-2 min-[360px]:w-auto min-[520px]:col-start-auto min-[520px]:row-start-auto",
          )}
          onClick={onFinish}
          aria-label={canFinishNow ? "Finish workout" : "Review workout finish"}
        >
          Finish
        </Button>
      </div>
    </aside>
  );
}
