"use client";

import { Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type ActiveDurationChoice =
  | "wall_clock_no_stale_signal"
  | "owner_reported"
  | "interruption_unknown";

type Props = {
  wallClockLabel: string;
  reviewRequired: boolean;
  choice: ActiveDurationChoice | null;
  ownerReportedMinutes: string;
  onChoiceChange: (choice: ActiveDurationChoice) => void;
  onOwnerReportedMinutesChange: (value: string) => void;
};

function ChoiceRow({
  checked,
  description,
  label,
  name,
  onChange,
  value,
}: {
  checked: boolean;
  description: string;
  label: string;
  name: string;
  onChange: () => void;
  value: ActiveDurationChoice;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-background px-3 py-2.5 outline-none has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50">
      <input
        type="radio"
        className="mt-0.5 size-4 shrink-0"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-tight">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

export function ActiveWorkoutTimingReview({
  wallClockLabel,
  reviewRequired,
  choice,
  ownerReportedMinutes,
  onChoiceChange,
  onOwnerReportedMinutesChange,
}: Props) {
  const name = "active-workout-duration-basis";
  const interruptionSelected =
    choice === "owner_reported" || choice === "interruption_unknown";

  return (
    <section
      aria-labelledby="active-workout-timing-heading"
      className={cn(
        "rounded-xl border p-3",
        reviewRequired
          ? "border-amber-500/50 bg-amber-500/10"
          : "bg-muted/30",
      )}
    >
      <div className="flex items-start gap-2">
        <Clock3
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-4 shrink-0",
            reviewRequired && "text-amber-700 dark:text-amber-300",
          )}
        />
        <div className="min-w-0 flex-1">
          <h3 id="active-workout-timing-heading" className="text-sm font-semibold">
            {reviewRequired ? "Timing needs review" : "Workout timing"}
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Wall clock: {wallClockLabel}. Your recorded start and finish stay
            unchanged.
          </p>
          <p className="mt-1 text-sm font-medium">
            {choice === "wall_clock_no_stale_signal"
              ? `Active time: ${wallClockLabel}`
              : choice === "owner_reported" && ownerReportedMinutes.trim()
                ? `Active time: ${ownerReportedMinutes.trim()} min · owner reported`
                : "Active time unavailable"}
          </p>
        </div>
      </div>

      {reviewRequired ? (
        <fieldset className="mt-3 space-y-2">
          <legend className="mb-2 text-sm font-medium">
            What active time can you confirm?
          </legend>
          <ChoiceRow
            name={name}
            value="owner_reported"
            checked={choice === "owner_reported"}
            onChange={() => onChoiceChange("owner_reported")}
            label="Enter active time"
            description="Use the time you can personally confirm, excluding the interruption."
          />
          <ChoiceRow
            name={name}
            value="interruption_unknown"
            checked={choice === "interruption_unknown"}
            onChange={() => onChoiceChange("interruption_unknown")}
            label="Active time is unknown"
            description="Keep the workout, but exclude its duration from time-based insights."
          />
        </fieldset>
      ) : !interruptionSelected ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 min-h-11 w-full justify-start px-2"
          onClick={() => onChoiceChange("owner_reported")}
        >
          I was interrupted
        </Button>
      ) : (
        <fieldset className="mt-3 space-y-2">
          <legend className="mb-2 text-sm font-medium">
            Record interruption-aware timing
          </legend>
          <ChoiceRow
            name={name}
            value="wall_clock_no_stale_signal"
            checked={false}
            onChange={() => onChoiceChange("wall_clock_no_stale_signal")}
            label="Use wall-clock time"
            description="No long interruption affected this workout."
          />
          <ChoiceRow
            name={name}
            value="owner_reported"
            checked={choice === "owner_reported"}
            onChange={() => onChoiceChange("owner_reported")}
            label="Enter active time"
            description="Exclude the time you were away."
          />
          <ChoiceRow
            name={name}
            value="interruption_unknown"
            checked={choice === "interruption_unknown"}
            onChange={() => onChoiceChange("interruption_unknown")}
            label="Active time is unknown"
            description="Keep the workout without using its duration in insights."
          />
        </fieldset>
      )}

      {choice === "owner_reported" && (
        <div className="mt-3">
          <label
            htmlFor="owner-reported-active-minutes"
            className="text-sm font-medium"
          >
            Active minutes
          </label>
          <div className="mt-1 flex items-center gap-2">
            <Input
              id="owner-reported-active-minutes"
              data-testid="owner-reported-active-minutes"
              inputMode="numeric"
              pattern="[0-9]*"
              min="1"
              step="1"
              type="number"
              className="min-h-11"
              value={ownerReportedMinutes}
              onChange={(event) =>
                onOwnerReportedMinutesChange(event.currentTarget.value)
              }
              aria-describedby="owner-reported-active-minutes-help"
            />
            <span className="text-sm text-muted-foreground">min</span>
          </div>
          <p
            id="owner-reported-active-minutes-help"
            className="mt-1 text-xs leading-relaxed text-muted-foreground"
          >
            Must not exceed the recorded wall-clock time.
          </p>
        </div>
      )}
    </section>
  );
}
