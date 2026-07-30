"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { correctWorkoutTiming } from "@/app/actions/history";
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
import { resolveRetrospectiveWallTime } from "@/lib/retrospective-workout";

type Precision = "instant" | "date_only";

type Props = {
  sessionId: string;
  historyRevision: number;
  startedAtISO: string;
  finishedAtISO: string | null;
  timezone: string;
  localDate: string;
  precision: Precision;
  excludeDurationFromAnalytics: boolean;
  sourceLabel: string;
  programLinkLabel: string;
};

function localTime(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.hour}:${values.minute}:${values.second}`;
}

function durationSeconds(startedAtISO: string, finishedAtISO: string | null) {
  if (!finishedAtISO) return null;
  return Math.max(
    0,
    Math.round(
      (new Date(finishedAtISO).getTime() - new Date(startedAtISO).getTime()) /
        1_000,
    ),
  );
}

function timingSummary(input: {
  localDate: string;
  timezone: string;
  precision: Precision;
  localStartTime: string;
  durationSeconds: number | null;
}) {
  if (input.precision === "date_only") {
    return `${input.localDate} · Date only · time and duration unknown · ${input.timezone}`;
  }
  const duration =
    input.durationSeconds == null
      ? "duration unknown"
      : `${Math.round((input.durationSeconds / 60) * 10) / 10} min`;
  return `${input.localDate} at ${input.localStartTime} · ${duration} · ${input.timezone}`;
}

export function WorkoutTimingCorrection(props: Props) {
  const original = useMemo(
    () => ({
      localDate: props.localDate,
      timezone: props.timezone,
      precision: props.precision,
      localStartTime: localTime(props.startedAtISO, props.timezone),
      durationSeconds: durationSeconds(
        props.startedAtISO,
        props.finishedAtISO,
      ),
    }),
    [
      props.finishedAtISO,
      props.localDate,
      props.precision,
      props.startedAtISO,
      props.timezone,
    ],
  );
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [clientMutationId, setClientMutationId] = useState(() =>
    crypto.randomUUID(),
  );
  const [draft, setDraft] = useState(original);
  const [ambiguityChoice, setAmbiguityChoice] = useState<
    "earlier" | "later" | null
  >(null);

  const resolution = useMemo(() => {
    if (draft.precision !== "instant") return null;
    try {
      return resolveRetrospectiveWallTime({
        localDate: draft.localDate,
        localTime: draft.localStartTime,
        timezone: draft.timezone,
      });
    } catch {
      return null;
    }
  }, [
    draft.localDate,
    draft.localStartTime,
    draft.precision,
    draft.timezone,
  ]);
  const changed = timingSummary(original) !== timingSummary(draft);
  const valid =
    draft.localDate.length === 10 &&
    draft.timezone.trim().length > 0 &&
    (draft.precision === "date_only" ||
      (resolution != null &&
        resolution.outcome !== "nonexistent" &&
        (resolution.outcome !== "ambiguous" || ambiguityChoice != null)));

  function reset() {
    setReviewing(false);
    setReviewed(false);
    setDraft(original);
    setAmbiguityChoice(null);
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (next) {
          reset();
        }
        setOpen(next);
        if (!next) {
          setReviewing(false);
          setReviewed(false);
          setAmbiguityChoice(null);
        }
      }}
    >
      <DrawerTrigger
        render={<Button type="button" variant="outline" />}
      >
        Correct workout timing
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_input]:min-h-11">
        <DrawerHeader>
          <DrawerTitle>Correct completed workout timing</DrawerTitle>
        </DrawerHeader>
        <div className="max-h-[65dvh] overflow-y-auto px-4">
          {!reviewing ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Earlier values remain in Edit history. Logged sets, Program
                linkage, source provenance, and the Program itself are not
                changed.
              </p>
              <label className="block text-sm font-medium">
                Workout date
                <Input
                  className="mt-1"
                  type="date"
                  value={draft.localDate}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      localDate: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block text-sm font-medium">
                Workout timezone
                <Input
                  className="mt-1"
                  value={draft.timezone}
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      timezone: event.target.value,
                    }))
                  }
                />
              </label>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Time precision</legend>
                <label className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm">
                  <input
                    type="radio"
                    className="size-5"
                    checked={draft.precision === "instant"}
                    onChange={() =>
                      setDraft((current) => ({
                        ...current,
                        precision: "instant",
                      }))
                    }
                  />
                  Exact local start
                </label>
                <label className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm">
                  <input
                    type="radio"
                    className="size-5"
                    checked={draft.precision === "date_only"}
                    onChange={() =>
                      setDraft((current) => ({
                        ...current,
                        precision: "date_only",
                        durationSeconds: null,
                      }))
                    }
                  />
                  Date only — time and duration unknown
                </label>
              </fieldset>
              {draft.precision === "instant" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm font-medium">
                    Local start time
                    <Input
                      className="mt-1"
                      type="time"
                      step={1}
                      value={draft.localStartTime}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          localStartTime: event.target.value,
                        }));
                        setAmbiguityChoice(null);
                      }}
                    />
                  </label>
                  <label className="text-sm font-medium">
                    Duration (minutes, optional)
                    <Input
                      className="mt-1"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={10_080}
                      step={0.1}
                      value={
                        draft.durationSeconds == null
                          ? ""
                          : draft.durationSeconds / 60
                      }
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          durationSeconds:
                            event.target.value === ""
                              ? null
                              : Math.round(
                                  Number(event.target.value) * 60,
                                ),
                        }))
                      }
                    />
                  </label>
                </div>
              )}
              {resolution?.outcome === "nonexistent" && (
                <p role="alert" className="text-sm text-destructive">
                  That local start time does not exist in {draft.timezone}
                  because of daylight-saving time.
                </p>
              )}
              {resolution?.outcome === "ambiguous" && (
                <fieldset className="space-y-2 rounded-lg border p-3">
                  <legend className="px-1 text-sm font-medium">
                    Workout start time occurs twice
                  </legend>
                  <p className="text-xs text-muted-foreground">
                    Choose which offset matches the completed workout.
                  </p>
                  {(["earlier", "later"] as const).map((choice) => (
                    <label
                      key={choice}
                      className="flex min-h-11 items-center gap-3 text-sm"
                    >
                      <input
                        type="radio"
                        className="size-5"
                        checked={ambiguityChoice === choice}
                        onChange={() => setAmbiguityChoice(choice)}
                      />
                      {choice === "earlier"
                        ? "Earlier occurrence"
                        : "Later occurrence"}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm font-medium">
                Review the timing correction before saving
              </p>
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Original
                </p>
                <p className="mt-1">{timingSummary(original)}</p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Corrected
                </p>
                <p className="mt-1">{timingSummary(draft)}</p>
              </div>
              <div className="rounded-lg border p-3 text-sm">
                <p className="font-medium">Unchanged evidence</p>
                <p className="mt-1 text-muted-foreground">
                  {props.sourceLabel} · {props.programLinkLabel}. Logged sets
                  and earlier Coach output remain historical records.
                </p>
                <p className="mt-2 text-muted-foreground">
                  Calendar placement, current reports, Today rotation, and new
                  progression review will use the corrected timing. Pending
                  suggestions based on superseded history may expire; accepted
                  decisions are retained.
                </p>
              </div>
              <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                <span>
                  I reviewed the original and corrected timing and want to save
                  this correction with revision evidence.
                </span>
              </label>
            </div>
          )}
        </div>
        <DrawerFooter>
          {!reviewing ? (
            <Button
              type="button"
              disabled={!changed || !valid}
              onClick={() => setReviewing(true)}
            >
              Review timing correction
            </Button>
          ) : (
            <>
              <Button
                type="button"
                disabled={!reviewed || pending}
                onClick={() =>
                  startTransition(async () => {
                    try {
                      const result = await correctWorkoutTiming({
                        sessionId: props.sessionId,
                        clientMutationId,
                        expectedHistoryRevision: props.historyRevision,
                        reviewed: true,
                        expected: {
                          startedAtISO: props.startedAtISO,
                          finishedAtISO: props.finishedAtISO,
                          timezone: props.timezone,
                          localDate: props.localDate,
                          precision: props.precision,
                          excludeDurationFromAnalytics:
                            props.excludeDurationFromAnalytics,
                        },
                        proposed: {
                          localDate: draft.localDate,
                          timezone: draft.timezone,
                          timing:
                            draft.precision === "date_only"
                              ? { precision: "date_only" }
                              : {
                                  precision: "instant",
                                  localStartTime: draft.localStartTime,
                                  ambiguityChoice,
                                  durationSeconds: draft.durationSeconds,
                                },
                        },
                      });
                      if (!result.ok) {
                        toast.error(result.reason);
                        return;
                      }
                      toast.success(
                        result.outcome === "replayed"
                          ? "Workout timing was already corrected"
                          : "Workout timing corrected with revision evidence",
                      );
                      setOpen(false);
                      setClientMutationId(crypto.randomUUID());
                      reset();
                      window.location.reload();
                    } catch {
                      toast.error(
                        "The correction was not saved. Reload and review the latest timing before trying again.",
                      );
                    }
                  })
                }
              >
                {pending ? "Saving…" : "Save reviewed timing correction"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setReviewing(false);
                  setReviewed(false);
                }}
              >
                Back
              </Button>
            </>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
