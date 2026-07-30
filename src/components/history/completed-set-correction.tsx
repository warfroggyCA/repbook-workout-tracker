"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { correctCompletedSet } from "@/app/actions/sessions";
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
import type { LoadUnit } from "@/lib/units";

type SetValues = {
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  rpe: number | null;
  note: string | null;
};

type Props = SetValues & {
  setId: string;
  setNo: number;
  historyRevision: number;
};

function summary(values: SetValues) {
  const load = values.weight == null
    ? "No load"
    : `${values.weight} ${values.weightUnit}`;
  return `${load}${values.reps == null ? "" : ` × ${values.reps} reps`}${values.rpe == null ? "" : ` · RPE ${values.rpe}`}${values.note ? ` · ${values.note}` : ""}`;
}

export function CompletedSetCorrection(props: Props) {
  const router = useRouter();
  const original: SetValues = {
    weight: props.weight,
    weightUnit: props.weightUnit,
    reps: props.reps,
    rpe: props.rpe,
    note: props.note,
  };
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [draft, setDraft] = useState<SetValues>(original);
  const [pending, startTransition] = useTransition();
  const [clientMutationId, setClientMutationId] = useState(() => crypto.randomUUID());
  const changed = summary(original) !== summary(draft);
  const validLoad = (draft.weight == null) === (draft.weightUnit == null);

  function reset() {
    setReviewing(false);
    setReviewed(false);
    setDraft(original);
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DrawerTrigger render={<Button type="button" variant="outline" size="sm" />}>
        Correct set
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_input]:min-h-11 [&_textarea]:min-h-11">
        <DrawerHeader>
          <DrawerTitle>Correct completed set {props.setNo}</DrawerTitle>
        </DrawerHeader>
        <div className="max-h-[65dvh] overflow-y-auto px-4">
          {!reviewing ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                The original values remain in revision history. Recorded equipment evidence and the planned workout are not changed.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm font-medium">
                  Load
                  <Input
                    className="mt-1"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={2000}
                    value={draft.weight ?? ""}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      weight: event.target.value === "" ? null : Number(event.target.value),
                      weightUnit: event.target.value === "" ? null : current.weightUnit ?? props.weightUnit ?? "lb",
                    }))}
                  />
                </label>
                <label className="text-sm font-medium">
                  Unit
                  <select
                    className="mt-1 min-h-11 w-full rounded-md border bg-background px-3"
                    value={draft.weightUnit ?? ""}
                    disabled={draft.weight == null}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      weightUnit: event.target.value as LoadUnit,
                    }))}
                  >
                    <option value="">None</option>
                    <option value="lb">lb</option>
                    <option value="kg">kg</option>
                  </select>
                </label>
                <label className="text-sm font-medium">
                  Reps
                  <Input
                    className="mt-1"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    value={draft.reps ?? ""}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      reps: event.target.value === "" ? null : Number(event.target.value),
                    }))}
                  />
                </label>
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
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      rpe: event.target.value === "" ? null : Number(event.target.value),
                    }))}
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
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    note: event.target.value || null,
                  }))}
                />
              </label>
              {!validLoad && <p role="alert" className="text-sm text-destructive">Choose a unit for the corrected load.</p>}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm font-medium">Review the correction before saving</p>
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Original</p>
                <p className="mt-1">{summary(original)}</p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Corrected</p>
                <p className="mt-1">{summary(draft)}</p>
              </div>
              <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                <span>I reviewed these values and want to save this correction with revision evidence.</span>
              </label>
            </div>
          )}
        </div>
        <DrawerFooter>
          {!reviewing ? (
            <Button type="button" disabled={!changed || !validLoad} onClick={() => setReviewing(true)}>
              Review correction
            </Button>
          ) : (
            <>
              <Button
                type="button"
                disabled={!reviewed || pending}
                onClick={() => startTransition(async () => {
                  try {
                    const result = await correctCompletedSet({
                      setId: props.setId,
                      ...draft,
                      expected: original,
                      expectedHistoryRevision: props.historyRevision,
                      clientMutationId,
                      reviewed: true,
                    });
                    if (!result.ok) {
                      toast.error(result.message);
                      return;
                    }
                    toast.success("Completed set corrected with revision evidence");
                    setOpen(false);
                    setClientMutationId(crypto.randomUUID());
                    reset();
                    router.refresh();
                  } catch {
                    toast.error("The correction was not saved. Reload and review the latest values before trying again.");
                  }
                })}
              >
                {pending ? "Saving…" : "Save reviewed correction"}
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => {
                setReviewing(false);
                setReviewed(false);
              }}>
                Back
              </Button>
            </>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
