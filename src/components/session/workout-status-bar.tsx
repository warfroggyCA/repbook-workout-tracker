"use client";

import { useEffect, useRef, useState } from "react";
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

const REST_CONFIRMATION_DURATION_MS = 4_000;

type Props = {
  action: SessionGuidanceFocusAction | null;
  exercise: SessionExerciseData | null;
  timer: DurableRestTimer | null;
  restRemainingSec: number | null;
  restAlertPreference?: RestAlertPreference;
  restSoundState?: RestCueChannelOutcome;
  onEnableRestSound?: () => void;
  restDestinationLabel?: string | null;
  restResumeLabel?: string | null;
  onShowCurrent: () => void;
  onPrimaryAction?: () => void;
  currentWorkingSetRevealed?: boolean;
  currentSetFormId?: string | null;
  currentSetBlockingReason?: string | null;
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
  onEnableRestSound,
  restDestinationLabel = null,
  restResumeLabel = null,
  onShowCurrent,
  onPrimaryAction,
  currentWorkingSetRevealed = true,
  currentSetFormId = null,
  currentSetBlockingReason = null,
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
  const [currentSetFormState, setCurrentSetFormState] = useState<{
    formId: string | null;
    disabled: boolean;
  }>({ formId: null, disabled: true });
  const currentSetLogDisabled =
    currentSetFormState.formId !== currentSetFormId ||
    currentSetFormState.disabled;
  const saving = action?.kind === "working_set" ? saveStatus(exercise) : null;
  const timerRunning = timer?.phase === "running" && restRemainingSec != null;
  const timerElapsed = timer?.phase === "ready";
  const timerEnded = timer?.phase === "skipped";
  const timerReady = timerElapsed || timerEnded;
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
  const logsRevealedCurrentSet =
    hidesRevealedCurrentSet && currentSetFormId != null;
  const reviewsRevealedCurrentSet =
    hidesRevealedCurrentSet && currentSetFormId == null;
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
  const blockedCurrentSetAction = currentSetBlockingReason?.startsWith(
    "Resolve the exercise skip",
  )
    ? "Resolve skipped exercise"
    : currentSetBlockingReason?.startsWith("Complete ")
      ? currentSetBlockingReason.startsWith("Complete equipment setup")
        ? "Complete equipment setup"
        : "Complete preparation"
      : currentSetBlockingReason?.startsWith("Choose equipment")
        ? "Choose equipment"
        : currentSetBlockingReason?.startsWith("Equipment unavailable") ||
            currentSetBlockingReason?.startsWith("Equipment setup incompatible")
          ? "Replace for today"
        : currentSetBlockingReason?.startsWith("This exercise measurement")
          ? "Review measurement"
          : currentSetBlockingReason
            ? "Review save problem"
            : "Review current set";
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
  const resolvedRestDestinationLabel = restDestinationLabel ??
    (restResumeLabel == null
      ? action?.kind === "rest"
        ? action.destination
          ? formatSessionGuidanceAction(action.destination)
          : null
        : action
          ? formatSessionGuidanceAction(action)
          : null
      : null);
  const restConfirmationGenerationId = timerReady
    ? timer?.generationId ?? null
    : null;
  const restConfirmationReadyAt = timerReady ? timer?.readyAt ?? null : null;
  useEffect(() => {
    if (
      restConfirmationGenerationId == null ||
      restConfirmationReadyAt == null
    ) return;
    const remainingDuration = Math.max(
      0,
      restConfirmationReadyAt + REST_CONFIRMATION_DURATION_MS - Date.now(),
    );
    const timeout = window.setTimeout(onRestContinue, remainingDuration);
    return () => window.clearTimeout(timeout);
  }, [
    onRestContinue,
    restConfirmationGenerationId,
    restConfirmationReadyAt,
  ]);
  useEffect(() => {
    if (currentSetFormId == null) return;
    const form = document.getElementById(currentSetFormId);
    if (!(form instanceof HTMLFormElement)) return;
    const updateDisabledState = () => {
      setCurrentSetFormState({
        formId: currentSetFormId,
        disabled: form.dataset.logDisabled !== "false",
      });
    };
    updateDisabledState();
    const observer = new MutationObserver(updateDisabledState);
    observer.observe(form, {
      attributes: true,
      attributeFilter: ["data-log-disabled"],
    });
    return () => observer.disconnect();
  }, [currentSetFormId]);
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
      tabIndex={-1}
      data-active-workout-focus-target="true"
      aria-label="Workout status"
      data-rest-state={
        timerRunning ? "running" : timerReady ? "ready" : "inactive"
      }
      className="fixed inset-x-0 bottom-[env(safe-area-inset-bottom)] z-30 border-t bg-background shadow-[0_-5px_18px_rgb(0_0_0/0.12)] lg:bottom-0 lg:left-[var(--main-sidebar-width)]"
    >
      <div
        className="mx-auto grid min-h-14 max-w-3xl grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1 px-1 py-1 min-[400px]:px-2 sm:gap-2 sm:px-3"
      >
        {(timerRunning || timerReady) && timer ? (
          <RestCockpit
            phase={timer.phase === "continued" ? "ready" : timer.phase}
            remainingSeconds={restRemainingSec}
            alertLabel={restAlertLabel}
            alertAriaLabel={restAlertAriaLabel}
            destinationLabel={resolvedRestDestinationLabel}
            resumeLabel={restResumeLabel}
            onAdjust={onRestAdjust}
            onEnd={onRestSkip}
            onEnableSound={restSoundState === "blocked" ? onEnableRestSound : undefined}
          />
        ) : null}

        {logsRevealedCurrentSet ? (
          <>
            <Button
              key={currentSetFormId}
              data-testid="active-log-set"
              data-ui-essential="true"
              type="submit"
              form={currentSetFormId}
              disabled={currentSetLogDisabled}
              className="min-h-12 min-w-0 whitespace-normal px-3 text-base font-semibold leading-tight"
              aria-describedby={`${currentSetFormId}-context`}
            >
              Log {setPosition?.lowercaseLabel ?? "current set"}
            </Button>
            <span id={`${currentSetFormId}-context`} className="sr-only">
              {title}
            </span>
          </>
        ) : null}

        {reviewsRevealedCurrentSet ? (
          <button
            type="button"
            data-testid="active-workout-dock-primary"
            onClick={onPrimaryAction ?? onShowCurrent}
            className="min-h-11 min-w-0 rounded-lg border border-primary/20 bg-primary/5 px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="block break-words text-sm font-semibold leading-tight">
              {blockedCurrentSetAction}
            </span>
            <span className="block break-words text-[0.6875rem] leading-tight text-muted-foreground min-[520px]:text-[0.8125rem]">
              {currentSetBlockingReason ?? `${title} · ${setPosition?.label ?? "Current set"}`}
            </span>
          </button>
        ) : null}

        {!hidesRevealedCurrentSet ? (
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
            role={timerReady ? undefined : "status"}
            aria-live={timerReady ? undefined : "polite"}
            className={cn(
              "block break-words text-[0.6875rem] leading-tight text-muted-foreground min-[520px]:text-[0.8125rem]",
              saving === "Failed" && "font-semibold text-destructive",
              runsPrimaryAction && "text-primary-foreground/85",
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

        <Button
          data-testid="contextual-note-trigger-workout"
          type="button"
          variant="ghost"
          size="icon-sm"
          className="min-h-11 min-w-11 shrink-0"
          onClick={onAddNote}
          aria-label="Add training note"
        >
          <FilePenLine className="size-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant={canFinishNow ? "default" : "outline"}
          className="min-h-11 shrink-0 px-2 max-[420px]:px-1.5"
          onClick={onFinish}
          aria-label={
            canFinishNow ? "Finish workout" : "Review and finish workout"
          }
        >
          {isFinishingEarly ? (
            <span className="leading-tight max-[420px]:flex max-[420px]:flex-col max-[420px]:text-[0.6875rem]">
              <span>Review</span>
              <span className="max-[420px]:hidden"> </span>
              <span>and finish</span>
            </span>
          ) : "Finish"}
        </Button>
      </div>
    </aside>
  );
}
