"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { correctAcknowledgedSet } from "@/app/actions/sessions";
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
import { Textarea } from "@/components/ui/textarea";
import { createClientUuid } from "@/lib/client-uuid";
import {
  SET_CORRECTION_CATEGORIES,
  SET_CORRECTION_CATEGORY_LABELS,
  type SetCorrectionCategory,
} from "@/lib/set-correction";
import type { PerformedMetricType } from "@/lib/set-metric-semantics";
import type { LoadUnit } from "@/lib/units";

export type CorrectedSetValues = {
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
  rpe: number | null;
  note: string | null;
};

type Props = CorrectedSetValues & {
  setId: string;
  setNo: number;
  metricType: PerformedMetricType;
  historyRevision: number;
  source: "active_workout" | "workout_history";
  onOpenChange?: (open: boolean) => void;
  onAcknowledged?: (result: {
    values: CorrectedSetValues;
    historyRevision: number;
  }) => void;
};

function performedSummary(
  metricType: PerformedMetricType,
  values: CorrectedSetValues,
) {
  let measurement: string;
  if (metricType === "duration") {
    measurement = `${values.durationSeconds ?? "Not recorded"} sec`;
  } else if (metricType === "distance_duration") {
    measurement = `${values.distanceKm ?? "Not recorded"} km${
      values.durationSeconds == null ? "" : ` · ${values.durationSeconds} sec`
    }`;
  } else if (metricType === "reps") {
    measurement = `${values.reps ?? "Not recorded"} reps`;
  } else {
    const label = metricType === "assisted_reps" ? "Assistance" : "Load";
    measurement = `${label}: ${values.weight ?? "Not recorded"}${
      values.weightUnit == null ? "" : ` ${values.weightUnit}`
    } · ${values.reps ?? "Not recorded"} reps`;
  }
  return `${measurement}${
    values.rpe == null ? "" : ` · RPE ${values.rpe}`
  }${values.note ? ` · ${values.note}` : ""}`;
}

function valuesEqual(left: CorrectedSetValues, right: CorrectedSetValues) {
  return (
    left.weight === right.weight &&
    left.weightUnit === right.weightUnit &&
    left.reps === right.reps &&
    left.distanceKm === right.distanceKm &&
    left.durationSeconds === right.durationSeconds &&
    left.rpe === right.rpe &&
    left.note === right.note
  );
}

function correctedShapeIsValid(
  metricType: PerformedMetricType,
  values: CorrectedSetValues,
) {
  const loadPair = (values.weight == null) === (values.weightUnit == null);
  if (!loadPair) return false;
  if (metricType === "weight_reps" || metricType === "assisted_reps") {
    return (
      values.weight != null &&
      values.weightUnit != null &&
      values.reps != null &&
      values.distanceKm == null &&
      values.durationSeconds == null
    );
  }
  if (metricType === "reps") {
    return (
      values.weight == null &&
      values.weightUnit == null &&
      values.reps != null &&
      values.distanceKm == null &&
      values.durationSeconds == null
    );
  }
  if (metricType === "duration") {
    return (
      values.weight == null &&
      values.weightUnit == null &&
      values.reps == null &&
      values.distanceKm == null &&
      values.durationSeconds != null
    );
  }
  if (metricType === "distance_duration") {
    return (
      values.weight == null &&
      values.weightUnit == null &&
      values.reps == null &&
      values.distanceKm != null
    );
  }
  return false;
}

export function CompletedSetCorrection(props: Props) {
  const router = useRouter();
  const liveOriginal: CorrectedSetValues = {
    weight: props.weight,
    weightUnit: props.weightUnit,
    reps: props.reps,
    distanceKm: props.distanceKm,
    durationSeconds: props.durationSeconds,
    rpe: props.rpe,
    note: props.note,
  };
  const [open, setOpen] = useState(false);
  const [original, setOriginal] = useState<CorrectedSetValues>(liveOriginal);
  const [reviewing, setReviewing] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [draft, setDraft] = useState<CorrectedSetValues>(original);
  const [category, setCategory] = useState<SetCorrectionCategory | "">("");
  const [reasonNote, setReasonNote] = useState("");
  const [attemptFailed, setAttemptFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [clientMutationId, setClientMutationId] = useState(createClientUuid);
  const changed = !valuesEqual(original, draft);
  const validShape = correctedShapeIsValid(props.metricType, draft);
  const isHistory = props.source === "workout_history";

  function reset(nextOriginal: CorrectedSetValues) {
    setOriginal(nextOriginal);
    setReviewing(false);
    setReviewed(false);
    setDraft(nextOriginal);
    setCategory("");
    setReasonNote("");
    setAttemptFailed(false);
  }

  function setOpenState(next: boolean) {
    setOpen(next);
    props.onOpenChange?.(next);
    if (!attemptFailed) reset(liveOriginal);
  }

  const loaded =
    props.metricType === "weight_reps" ||
    props.metricType === "assisted_reps";
  const repetitions =
    loaded || props.metricType === "reps";

  return (
    <Drawer open={open} onOpenChange={setOpenState}>
      <DrawerTrigger
        render={<Button type="button" variant="outline" size="sm" />}
      >
        Correct set
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_input]:min-h-11 [&_textarea]:min-h-11">
        <DrawerHeader>
          <DrawerTitle>
            Correct {isHistory ? "saved" : "acknowledged"} set {props.setNo}
          </DrawerTitle>
        </DrawerHeader>
        <div className="max-h-[65dvh] overflow-y-auto px-4">
          {!reviewing ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                The original assertion remains in Edit history. The workout
                prescription and recorded exercise meaning will not change.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {loaded && (
                  <>
                    <label className="text-sm font-medium">
                      {props.metricType === "assisted_reps"
                        ? "Assistance"
                        : "Load"}
                      <Input
                        className="mt-1"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={2000}
                        value={draft.weight ?? ""}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            weight:
                              event.target.value === ""
                                ? null
                                : Number(event.target.value),
                            weightUnit:
                              event.target.value === ""
                                ? null
                                : current.weightUnit ?? props.weightUnit ?? "lb",
                          }))
                        }
                      />
                    </label>
                    <label className="text-sm font-medium">
                      Unit
                      <select
                        className="mt-1 min-h-11 w-full rounded-md border bg-background px-3"
                        value={draft.weightUnit ?? ""}
                        disabled={draft.weight == null}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            weightUnit: event.target.value as LoadUnit,
                          }))
                        }
                      >
                        <option value="">None</option>
                        <option value="lb">lb</option>
                        <option value="kg">kg</option>
                      </select>
                    </label>
                  </>
                )}
                {repetitions && (
                  <label className="text-sm font-medium">
                    Reps
                    <Input
                      className="mt-1"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      value={draft.reps ?? ""}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          reps:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                )}
                {props.metricType === "distance_duration" && (
                  <label className="text-sm font-medium">
                    Distance (km)
                    <Input
                      className="mt-1"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={10000}
                      step="any"
                      value={draft.distanceKm ?? ""}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          distanceKm:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                )}
                {(props.metricType === "duration" ||
                  props.metricType === "distance_duration") && (
                  <label className="text-sm font-medium">
                    Duration (seconds)
                    <Input
                      className="mt-1"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={604800}
                      value={draft.durationSeconds ?? ""}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          durationSeconds:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                )}
                <label className="text-sm font-medium">
                  RPE
                  <Input
                    className="mt-1"
                    type="number"
                    inputMode="decimal"
                    min={1}
                    max={10}
                    step={0.5}
                    value={draft.rpe ?? ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        rpe:
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                      }))
                    }
                  />
                </label>
              </div>
              <label className="block text-sm font-medium">
                Set note
                <Textarea
                  className="mt-1"
                  maxLength={500}
                  rows={3}
                  value={draft.note ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      note: event.target.value || null,
                    }))
                  }
                />
              </label>
              <label className="block text-sm font-medium">
                Why are you correcting this?
                <select
                  className="mt-1 min-h-11 w-full rounded-md border bg-background px-3"
                  value={category}
                  onChange={(event) =>
                    setCategory(event.target.value as SetCorrectionCategory)
                  }
                >
                  <option value="">Choose a reason</option>
                  {SET_CORRECTION_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {SET_CORRECTION_CATEGORY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium">
                Reason detail <span className="font-normal text-muted-foreground">(optional)</span>
                <Textarea
                  className="mt-1"
                  maxLength={240}
                  rows={2}
                  value={reasonNote}
                  onChange={(event) => setReasonNote(event.target.value)}
                />
              </label>
              {!validShape && (
                <p role="alert" className="text-sm text-destructive">
                  Enter the complete measurement for this set type.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm font-medium">
                Review the correction before saving
              </p>
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Original
                </p>
                <p className="mt-1">{performedSummary(props.metricType, original)}</p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Corrected
                </p>
                <p className="mt-1">{performedSummary(props.metricType, draft)}</p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Reason
                </p>
                <p className="mt-1">
                  {category
                    ? SET_CORRECTION_CATEGORY_LABELS[category]
                    : "Not selected"}
                  {reasonNote.trim() ? ` · ${reasonNote.trim()}` : ""}
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
                  I reviewed these values and want this correction to supersede
                  the saved assertion without erasing it.
                </span>
              </label>
              {attemptFailed && (
                <p role="alert" className="text-sm text-destructive">
                  The correction is still unsaved. The same correction identity
                  will be reused if you try again.
                </p>
              )}
            </div>
          )}
        </div>
        <DrawerFooter>
          {!reviewing ? (
            <Button
              type="button"
              disabled={!changed || !validShape || category === ""}
              onClick={() => setReviewing(true)}
            >
              Review correction
            </Button>
          ) : (
            <>
              <Button
                type="button"
                disabled={!reviewed || pending}
                onClick={() =>
                  startTransition(async () => {
                    try {
                      const result = await correctAcknowledgedSet({
                        setId: props.setId,
                        values: draft,
                        expected: original,
                        expectedHistoryRevision: props.historyRevision,
                        clientMutationId,
                        category: category as SetCorrectionCategory,
                        reasonNote: reasonNote.trim() || null,
                        source: props.source,
                        reviewed: true,
                      });
                      if (!result.ok) {
                        setAttemptFailed(true);
                        toast.error(result.message);
                        return;
                      }
                      toast.success("Set correction acknowledged", {
                        description:
                          "The original assertion remains available in Edit history.",
                      });
                      props.onAcknowledged?.({
                        values: draft,
                        historyRevision:
                          result.historyRevision ?? props.historyRevision,
                      });
                      setOpenState(false);
                      setClientMutationId(createClientUuid());
                      router.refresh();
                    } catch {
                      setAttemptFailed(true);
                      toast.error(
                        "The correction was not acknowledged. Review the values and try the same correction again.",
                      );
                    }
                  })
                }
              >
                {pending
                  ? "Saving correction…"
                  : attemptFailed
                    ? "Try save again"
                    : "Save reviewed correction"}
              </Button>
              {!attemptFailed && (
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
              )}
            </>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
