"use client";

import { useActionState, useEffect, useId, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { startSession } from "@/app/actions/sessions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { INITIAL_WORKOUT_START_STATE } from "@/lib/workout-start";

type Props = {
  templateId: string;
  fallbackTimezone: string;
  retryLabel: string;
  children: ReactNode;
  variant?: "default" | "outline";
  formClassName?: string;
  buttonClassName?: string;
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
  fallbackTimezone,
  retryLabel,
  children,
  variant = "default",
  formClassName,
  buttonClassName,
}: Props) {
  const timezoneInput = useRef<HTMLInputElement>(null);
  const errorAlert = useRef<HTMLParagraphElement>(null);
  const errorId = useId();
  const [state, formAction] = useActionState(
    startSession.bind(null, templateId),
    INITIAL_WORKOUT_START_STATE,
  );

  useEffect(() => {
    if (state.status === "error") {
      errorAlert.current?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [state]);

  return (
    <form
      action={formAction}
      className={formClassName}
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
