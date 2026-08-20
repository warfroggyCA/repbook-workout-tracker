"use client";

import { useActionState, useEffect, useId, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { startSession } from "@/app/actions/sessions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  INITIAL_WORKOUT_START_STATE,
  retainedWorkoutStartRequestKey,
} from "@/lib/workout-start";

type Props = {
  templateId: string;
  startRequestKey: string;
  fallbackTimezone: string;
  retryLabel: string;
  hasProgrammedWarmups: boolean;
  children: ReactNode;
  variant?: "default" | "outline";
  formClassName?: string;
  buttonClassName?: string;
  scheduledStart?: {
    scheduledProgramEventId: string;
    expectedEventRevision: number;
    programScheduleVersionId: string;
    programScheduleVersionHash: string;
  };
};

function StartButton({
  children,
  variant,
  className,
  retrying,
  statusUnknown,
  errorId,
  retryLabel,
}: {
  children: ReactNode;
  variant: "default" | "outline";
  className?: string;
  retrying: boolean;
  statusUnknown: boolean;
  errorId: string;
  retryLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      className={cn(className, retrying && "h-auto min-h-8 whitespace-normal py-2 text-balance")}
      disabled={pending}
      aria-describedby={retrying ? errorId : undefined}
    >
      {pending
        ? "Starting workout…"
        : retrying
          ? `${statusUnknown ? "Check status" : "Try again"} — ${retryLabel}`
          : children}
    </Button>
  );
}

export function WorkoutStartForm({
  templateId,
  startRequestKey,
  fallbackTimezone,
  retryLabel,
  hasProgrammedWarmups,
  children,
  variant = "default",
  formClassName,
  buttonClassName,
  scheduledStart,
}: Props) {
  const timezoneInput = useRef<HTMLInputElement>(null);
  const errorAlert = useRef<HTMLParagraphElement>(null);
  const errorId = useId();
  const [state, formAction] = useActionState(
    startSession.bind(null, templateId),
    INITIAL_WORKOUT_START_STATE,
  );
  const effectiveStartRequestKey = retainedWorkoutStartRequestKey(
    startRequestKey,
    state,
  );

  useEffect(() => {
    if (state.status === "error") {
      errorAlert.current?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [state]);

  return (
    <form
      action={formAction}
      className={cn("space-y-3", formClassName)}
      onSubmit={() => {
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (detected && timezoneInput.current) {
          timezoneInput.current.value = detected;
        }
      }}
    >
      <input
        ref={timezoneInput}
        type="hidden"
        name="timezone"
        defaultValue={fallbackTimezone}
      />
      <input
        type="hidden"
        name="startRequestKey"
        value={effectiveStartRequestKey}
      />
      {scheduledStart && (
        <>
          <input type="hidden" name="scheduledProgramEventId" value={scheduledStart.scheduledProgramEventId} />
          <input type="hidden" name="expectedEventRevision" value={scheduledStart.expectedEventRevision} />
          <input type="hidden" name="programScheduleVersionId" value={scheduledStart.programScheduleVersionId} />
          <input type="hidden" name="programScheduleVersionHash" value={scheduledStart.programScheduleVersionHash} />
        </>
      )}
      {hasProgrammedWarmups && (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-muted/20 px-3 py-2.5 text-left">
          <input
            type="checkbox"
            name="includeWarmups"
            value="true"
            className="mt-0.5 size-5 shrink-0 accent-primary"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              Include programmed warm-ups
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              Off by default. Turn this on only when you want warm-up actions in this workout.
            </span>
          </span>
        </label>
      )}
      <StartButton
        variant={variant}
        className={buttonClassName}
        retrying={state.status === "error"}
        statusUnknown={state.status === "error" && state.code === "status_unknown"}
        errorId={errorId}
        retryLabel={retryLabel}
      >
        {children}
      </StartButton>
      {state.status === "error" && (
        <p
          ref={errorAlert}
          id={errorId}
          role="alert"
          className="mt-2 rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
