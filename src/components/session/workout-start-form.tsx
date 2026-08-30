"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";
import { ChevronDown } from "lucide-react";
import { startSession } from "@/app/actions/sessions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  INITIAL_WORKOUT_START_STATE,
  retainedWorkoutStartRequestKey,
} from "@/lib/workout-start";
import {
  markWorkoutInteraction,
  WORKOUT_INTERACTION_MARKS,
} from "@/lib/workout-interaction-performance";

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
      aria-busy={pending}
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

function StartPendingStatus({ retryLabel }: { retryLabel: string }) {
  const { pending } = useFormStatus();

  useEffect(() => {
    if (pending) {
      markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.workoutStartPending);
    }
  }, [pending]);

  if (!pending) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-sm leading-relaxed text-muted-foreground"
    >
      Confirming {retryLabel}. Repbook will open the workout after its start is
      confirmed.
    </p>
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
  const [includeWarmups, setIncludeWarmups] = useState(false);
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
        markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.workoutStartSubmit);
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
        <details className="group rounded-lg border bg-muted/20">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <span>
              Workout options
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {includeWarmups
                  ? "Programmed warm-ups will be included"
                  : "Programmed warm-ups are off"}
              </span>
            </span>
            <ChevronDown
              className="size-4 shrink-0 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 border-t px-3 py-2.5 text-left">
            <input
              type="checkbox"
              name="includeWarmups"
              value="true"
              checked={includeWarmups}
              onChange={(event) =>
                setIncludeWarmups(event.currentTarget.checked)
              }
              className="mt-0.5 size-5 shrink-0 accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                Include programmed warm-ups
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                Select this to add the saved warm-up actions to this workout.
              </span>
            </span>
          </label>
        </details>
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
      <StartPendingStatus retryLabel={retryLabel} />
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
