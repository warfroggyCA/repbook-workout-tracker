"use client";

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
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
  /** Visible trigger text. */
  triggerLabel?: string;
  /** Exact accessible name when the visible label is abbreviated. */
  triggerAriaLabel?: string;
  /** Replaces the default outline button styling for a compact row trigger. */
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
  onAcknowledged?: (result: {
    values: CorrectedSetValues;
    historyRevision: number;
  }) => void;
};

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
  if (metricType === "weight_duration_per_side")
    return (
      values.weight != null &&
      values.weightUnit != null &&
      values.reps == null &&
      values.distanceKm == null &&
      values.durationSeconds != null &&
      values.durationSeconds > 0
    );
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

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
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
  const [draft, setDraft] = useState<CorrectedSetValues>(original);
  const [attemptFailed, setAttemptFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [clientMutationId, setClientMutationId] = useState(createClientUuid);
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const saveInFlight = useRef(false);
  const lastAttempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const changed = !valuesEqual(original, draft);
  const validShape = correctedShapeIsValid(props.metricType, draft);

  function reset(nextOriginal: CorrectedSetValues) {
    setOriginal(nextOriginal);
    setDraft(nextOriginal);
    setAttemptFailed(false);
  }

  function setOpenState(next: boolean) {
    if (saveInFlight.current) return;
    setOpen(next);
    props.onOpenChange?.(next);
    reset(liveOriginal);
    lastAttempt.current = null;
    setClientMutationId(createClientUuid());
  }

  function saveCorrection() {
    if (saveInFlight.current || !online || !changed || !validShape) return;
    // Reuse an identity only for the same payload after an uncertain response.
    const fingerprint = JSON.stringify([draft, original]);
    const mutationId =
      lastAttempt.current?.fingerprint === fingerprint
        ? lastAttempt.current.id
        : lastAttempt.current
          ? createClientUuid()
          : clientMutationId;
    lastAttempt.current = { fingerprint, id: mutationId };
    saveInFlight.current = true;
    startTransition(async () => {
      try {
        const result = await correctAcknowledgedSet({
          setId: props.setId,
          values: draft,
          expected: original,
          expectedHistoryRevision: props.historyRevision,
          clientMutationId: mutationId,
          category: "other",
          reasonNote: null,
          source: props.source,
          reviewed: true,
        });
        if (!result.ok) {
          setAttemptFailed(true);
          toast.error(result.message);
          return;
        }
        toast.success("Set saved");
        props.onAcknowledged?.({
          values: draft,
          historyRevision: result.historyRevision ?? props.historyRevision,
        });
        saveInFlight.current = false;
        setOpenState(false);
        setClientMutationId(createClientUuid());
        router.refresh();
      } catch {
        setAttemptFailed(true);
        toast.error(
          "Couldn’t confirm the save. Your changes are still here; try Save again when connected.",
        );
      } finally {
        saveInFlight.current = false;
      }
    });
  }

  const loaded =
    props.metricType === "weight_reps" ||
    props.metricType === "assisted_reps" ||
    props.metricType === "weight_duration_per_side";
  const repetitions =
    props.metricType === "weight_reps" ||
    props.metricType === "assisted_reps" ||
    props.metricType === "reps";

  return (
    <Drawer open={open} onOpenChange={setOpenState}>
      <DrawerTrigger
        render={
          props.triggerClassName ? (
            <button
              type="button"
              className={props.triggerClassName}
              aria-label={props.triggerAriaLabel}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={props.triggerAriaLabel}
            />
          )
        }
      >
        {props.triggerLabel ?? "Correct set"}
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_input]:min-h-11 [&_textarea]:min-h-11">
        <DrawerHeader>
          <DrawerTitle>Edit set {props.setNo}</DrawerTitle>
        </DrawerHeader>
        <div className="max-h-[65dvh] overflow-y-auto px-4">
          <fieldset disabled={pending} className="space-y-4">
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
                              : (current.weightUnit ??
                                props.weightUnit ??
                                "lb"),
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
                props.metricType === "weight_duration_per_side" ||
                props.metricType === "distance_duration") && (
                <label className="text-sm font-medium">
                  {props.metricType === "weight_duration_per_side"
                    ? "Seconds per side (both sides)"
                    : "Duration (seconds)"}
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
            {!validShape && (
              <p role="alert" className="text-sm text-destructive">
                Enter the complete measurement for this set type.
              </p>
            )}
          </fieldset>
        </div>
        <DrawerFooter>
          {!online && (
            <p role="status" className="text-sm text-muted-foreground">
              You’re offline. Reconnect to save changes.
            </p>
          )}
          {attemptFailed && (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t confirm the save. Try again when connected.
            </p>
          )}
          <>
            <Button
              type="button"
              disabled={!changed || !validShape || pending || !online}
              onClick={saveCorrection}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setOpenState(false)}
            >
              Cancel
            </Button>
          </>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
