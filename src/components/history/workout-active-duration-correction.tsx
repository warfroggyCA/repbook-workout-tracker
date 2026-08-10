"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { correctWorkoutActiveDuration } from "@/app/actions/sessions";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { formatWallClockDuration } from "@/lib/active-session-timing";
import { MAX_ACTIVE_WORKOUT_DURATION_SECONDS } from "@/lib/workout-duration-quality";

type Props = {
  sessionId: string;
  historyRevision: number;
  startedAtISO: string;
  finishedAtISO: string | null;
  activeDurationSemanticsVersion: number | null;
  activeDurationSeconds: number | null;
  activeDurationBasis: string | null;
};

export type ActiveDurationCorrectionChoice =
  | "owner_reported"
  | "interruption_unknown";

export function activeDurationCorrectionDraftState(input: Props & {
  choice: ActiveDurationCorrectionChoice | null;
  activeMinutes: string;
}) {
  const wallClockSeconds = input.finishedAtISO == null
    ? null
    : Math.max(
        0,
        Math.floor(
          (new Date(input.finishedAtISO).getTime() -
            new Date(input.startedAtISO).getTime()) /
            1_000,
        ),
      );
  const parsedMinutes = Number(input.activeMinutes);
  const activeSeconds = Math.round(parsedMinutes * 60);
  const ownerReportedValid =
    input.choice === "owner_reported" &&
    input.activeMinutes.trim().length > 0 &&
    Number.isFinite(parsedMinutes) &&
    Number.isInteger(parsedMinutes) &&
    parsedMinutes >= 0 &&
    activeSeconds <= MAX_ACTIVE_WORKOUT_DURATION_SECONDS &&
    (wallClockSeconds == null || activeSeconds <= wallClockSeconds);
  const unchanged =
    input.activeDurationSemanticsVersion === 1 &&
    ((input.choice === "interruption_unknown" &&
      input.activeDurationBasis === "interruption_unknown" &&
      input.activeDurationSeconds == null) ||
      (input.choice === "owner_reported" &&
        input.activeDurationBasis === "owner_reported" &&
        input.activeDurationSeconds === activeSeconds));
  return {
    wallClockSeconds,
    maxActiveMinutes: wallClockSeconds == null
      ? MAX_ACTIVE_WORKOUT_DURATION_SECONDS / 60
      : Math.min(
          MAX_ACTIVE_WORKOUT_DURATION_SECONDS / 60,
          Math.floor(wallClockSeconds / 60),
        ),
    activeSeconds,
    ownerReportedValid,
    unchanged,
    valid:
      (input.choice === "interruption_unknown" || ownerReportedValid) &&
      !unchanged,
  };
}

function currentActiveDurationLabel(props: Props) {
  if (
    props.activeDurationSemanticsVersion === 1 &&
    props.activeDurationBasis !== "interruption_unknown" &&
    props.activeDurationSeconds != null
  ) {
    return `Active ${formatWallClockDuration(props.activeDurationSeconds)}${
      props.activeDurationBasis === "owner_reported" ? " · owner reported" : ""
    }`;
  }
  return "Active time unavailable";
}

export function WorkoutActiveDurationCorrection(props: Props) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ActiveDurationCorrectionChoice | null>(null);
  const [activeMinutes, setActiveMinutes] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [clientMutationId, setClientMutationId] = useState(() =>
    crypto.randomUUID(),
  );
  const {
    wallClockSeconds,
    maxActiveMinutes,
    activeSeconds,
    unchanged,
    valid,
  } = activeDurationCorrectionDraftState({
    ...props,
    choice,
    activeMinutes,
  });

  function reset() {
    setChoice(null);
    setActiveMinutes("");
    setReviewed(false);
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <DrawerTrigger
        render={
          <Button type="button" variant="outline" className="min-h-11" />
        }
      >
        Correct active duration
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_input]:min-h-11">
        <DrawerHeader>
          <DrawerTitle>Correct active workout duration</DrawerTitle>
        </DrawerHeader>
        <div className="max-h-[65dvh] space-y-4 overflow-y-auto px-4">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{currentActiveDurationLabel(props)}</p>
            <p className="mt-1 text-muted-foreground">
              Wall clock {wallClockSeconds == null
                ? "unavailable"
                : formatWallClockDuration(wallClockSeconds)}
            </p>
          </div>

          <p className="text-sm text-muted-foreground">
            This changes the active-time evidence used by duration insights. It
            never changes the original start or finish timestamps. The prior
            value remains in Edit history.
          </p>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Correct active time</legend>
            <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50">
              <input
                type="radio"
                name="correct-active-duration"
                className="mt-0.5 size-5"
                checked={choice === "owner_reported"}
                onChange={() => setChoice("owner_reported")}
              />
              <span>
                <span className="block font-medium">Enter active time</span>
                <span className="mt-0.5 block text-muted-foreground">
                  Exclude time when the workout was interrupted.
                </span>
              </span>
            </label>
            <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50">
              <input
                type="radio"
                name="correct-active-duration"
                className="mt-0.5 size-5"
                checked={choice === "interruption_unknown"}
                onChange={() => setChoice("interruption_unknown")}
              />
              <span>
                <span className="block font-medium">Active time is unknown</span>
                <span className="mt-0.5 block text-muted-foreground">
                  Preserve the workout but exclude its duration from insights.
                </span>
              </span>
            </label>
          </fieldset>

          {choice === "owner_reported" && (
            <label className="block text-sm font-medium">
              Active minutes
              <div className="mt-1 flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={maxActiveMinutes}
                  step={1}
                  value={activeMinutes}
                  aria-describedby="active-duration-correction-help"
                  onChange={(event) => setActiveMinutes(event.target.value)}
                />
                <span className="text-sm text-muted-foreground">min</span>
              </div>
              <span
                id="active-duration-correction-help"
                className="mt-1 block text-xs font-normal text-muted-foreground"
              >
                {wallClockSeconds == null
                  ? "Must be a whole number from 0 to 10,080 minutes. No wall-clock limit is inferred for this date-only workout."
                  : "Must be a whole number no longer than the recorded wall-clock time."}
              </span>
            </label>
          )}

          {unchanged && (
            <p role="status" className="text-sm text-muted-foreground">
              This matches the current active-duration evidence. Choose a
              different value to save a correction.
            </p>
          )}

          <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-5"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            <span>
              I reviewed the active time and understand the source timestamps
              will remain unchanged.
            </span>
          </label>
        </div>
        <DrawerFooter>
          <Button
            type="button"
            disabled={!valid || !reviewed || pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  const result = await correctWorkoutActiveDuration({
                    sessionId: props.sessionId,
                    clientMutationId,
                    expectedHistoryRevision: props.historyRevision,
                    expected: {
                      activeDurationSemanticsVersion:
                        props.activeDurationSemanticsVersion,
                      activeDurationSeconds: props.activeDurationSeconds,
                      activeDurationBasis: props.activeDurationBasis,
                    },
                    decision:
                      choice === "owner_reported"
                        ? {
                            basis: "owner_reported",
                            activeDurationSeconds: activeSeconds,
                          }
                        : { basis: "interruption_unknown" },
                  });
                  if (!result.ok) {
                    toast.error(result.message);
                    return;
                  }
                  toast.success(
                    result.outcome === "replayed"
                      ? "Active duration was already corrected"
                      : "Active duration corrected with revision evidence",
                  );
                  setOpen(false);
                  setClientMutationId(crypto.randomUUID());
                  reset();
                  window.location.reload();
                } catch {
                  toast.error(
                    "The correction was not saved. Reload and review the latest workout before trying again.",
                  );
                }
              })
            }
          >
            {pending ? "Saving…" : "Save active-duration correction"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
