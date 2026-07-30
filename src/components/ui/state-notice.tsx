import * as React from "react";

import type { WorkoutExperienceState } from "@/lib/workout-experience-foundation";
import { cn } from "@/lib/utils";

const PRESENTATION: Record<
  WorkoutExperienceState,
  { live: "off" | "polite"; tone: string }
> = {
  idle: { live: "off", tone: "border-border bg-card text-card-foreground" },
  pending: { live: "polite", tone: "border-primary/30 bg-accent text-accent-foreground" },
  saving: { live: "polite", tone: "border-primary/30 bg-accent text-accent-foreground" },
  saved: { live: "polite", tone: "border-success/35 bg-success/10 text-foreground" },
  retrying: { live: "polite", tone: "border-primary/30 bg-accent text-accent-foreground" },
  needs_attention: {
    live: "polite",
    tone: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  recovered: { live: "polite", tone: "border-success/35 bg-success/10 text-foreground" },
};

type StateNoticeProps = Omit<
  React.ComponentProps<"div">,
  "role" | "aria-live" | "aria-atomic"
> & {
  state: WorkoutExperienceState;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
};

export function StateNotice({
  state,
  title,
  description,
  action,
  className,
  ...props
}: StateNoticeProps) {
  const presentation = PRESENTATION[state];
  const needsAttention = state === "needs_attention";

  return (
    <div
      {...props}
      data-slot="state-notice"
      data-state={state}
      role={needsAttention ? "alert" : "status"}
      aria-live={needsAttention ? undefined : presentation.live}
      aria-atomic="true"
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl border p-3 text-sm sm:flex-row sm:items-center sm:justify-between",
        presentation.tone,
        className,
      )}
    >
      <div className="min-w-0">
        <p className="font-medium break-words">{title}</p>
        {description ? (
          <div className="mt-0.5 text-sm leading-relaxed break-words text-current/80">
            {description}
          </div>
        ) : null}
      </div>
      {action ? (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
          {action}
        </div>
      ) : null}
    </div>
  );
}
