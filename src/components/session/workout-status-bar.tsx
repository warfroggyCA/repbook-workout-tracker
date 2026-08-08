"use client";

import { FilePenLine, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  formatSessionGuidanceAction,
  type SessionGuidanceFocusAction,
} from "@/lib/session-guidance";
import { cn } from "@/lib/utils";
import type { DurableRestTimer } from "@/lib/rest-timer";
import type { SessionExerciseData } from "./types";

type Props = {
  action: SessionGuidanceFocusAction | null;
  exercise: SessionExerciseData | null;
  timer: DurableRestTimer | null;
  restRemainingSec: number | null;
  onShowCurrent: () => void;
  onRestAdjust: (deltaSec: number) => void;
  onRestSkip: () => void;
  onRestContinue: () => void;
  onAddNote: () => void;
  onFinish: () => void;
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
  onShowCurrent,
  onRestAdjust,
  onRestSkip,
  onRestContinue,
  onAddNote,
  onFinish,
}: Props) {
  const saving = action?.kind === "working_set" ? saveStatus(exercise) : null;
  const timerRunning = timer?.phase === "running" && restRemainingSec != null;
  const timerReady = timer?.phase === "ready" || timer?.phase === "skipped";
  const status = saving ?? (
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
  const title = action
    ? action.kind === "working_set"
      ? action.actualExerciseName
      : formatSessionGuidanceAction(action)
    : "Workout";

  return (
    <aside
      id="workout-rest-status"
      aria-label="Workout status"
      className={cn(
        "fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t bg-background shadow-[0_-5px_18px_rgb(0_0_0/0.12)] max-[360px]:bottom-[env(safe-area-inset-bottom)] lg:bottom-0 lg:left-[var(--main-sidebar-width)]",
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
          onClick={onShowCurrent}
          className={cn(
            "min-w-0 flex-1 rounded-md px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
            timerRunning &&
              "col-span-2 col-start-1 row-start-1 min-[400px]:col-span-3 min-[520px]:col-span-1 min-[520px]:col-start-auto min-[520px]:row-start-auto",
            timerReady &&
              "col-span-2 col-start-1 row-start-1 min-[400px]:col-span-3 min-[520px]:col-span-1 min-[520px]:col-start-auto min-[520px]:row-start-auto",
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
              timerReady &&
                "font-semibold text-emerald-900 dark:text-emerald-100",
            )}
          >
            {setPosition
              ? setPosition.kind === "extra"
                ? `${setPosition.label} · ${status}`
                : `${setPosition.label} of ${exercise?.targetSets ?? "open"} · ${status}`
              : status}
          </span>
        </button>

        {timerRunning && (
          <div
            role="region"
            aria-label="Rest timer"
            className="col-span-2 col-start-1 row-start-2 flex min-w-0 w-full shrink-0 items-center justify-between gap-0.5 min-[400px]:col-span-1 min-[400px]:col-start-auto min-[400px]:row-start-auto min-[400px]:w-auto min-[400px]:justify-start"
          >
            <span className="min-w-10 text-center text-sm font-semibold tabular-nums">
              {Math.floor(restRemainingSec / 60)}:{String(restRemainingSec % 60).padStart(2, "0")}
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
            className="col-span-2 col-start-1 row-start-2 min-h-11 w-full shrink-0 px-2 min-[400px]:col-span-1 min-[400px]:col-start-auto min-[400px]:row-start-auto min-[400px]:w-auto"
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
              "col-start-3 row-start-1 justify-self-end min-[400px]:col-start-auto min-[400px]:row-start-auto",
          )}
          onClick={onAddNote}
          aria-label="Add training note"
        >
          <FilePenLine className="size-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          className={cn(
            "min-h-11 shrink-0 px-2",
            (timerRunning || timerReady) &&
              "col-start-3 row-start-2 min-[400px]:col-start-auto min-[400px]:row-start-auto",
          )}
          onClick={onFinish}
        >
          Finish
        </Button>
      </div>
    </aside>
  );
}
