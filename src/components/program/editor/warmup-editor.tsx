"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog, Field } from "@/components/program/editor/editor-ui";
import {
  setWarmupLoadPercent,
  setWarmupLoadText,
  setWarmupNumericLoad,
} from "@/lib/program-editor-client";
import type {
  ProgramDayWarmupItem,
  ProgramDocumentDayV3,
} from "@/lib/program-document";

function optionalText(value: string) { return value.trim() ? value : null; }
function nullableNumber(value: string) { if (!value.trim()) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }

function loadingMode(item: ProgramDayWarmupItem) {
  if (item.load != null) return "numeric" as const;
  if (item.loadPercent != null) return "percent" as const;
  if (item.loadText != null) return "instruction" as const;
  return "none" as const;
}

function matchingTimingIndexes(
  items: ProgramDayWarmupItem[],
  index: number,
) {
  const anchor = items[index]?.beforeSlotLineageId ?? null;
  return items
    .map((item, itemIndex) => ({ item, itemIndex }))
    .filter(({ item }) => (item.beforeSlotLineageId ?? null) === anchor)
    .map(({ itemIndex }) => itemIndex);
}

function moveWarmupAtSameTiming(
  items: ProgramDayWarmupItem[],
  index: number,
  direction: -1 | 1,
) {
  const indexes = matchingTimingIndexes(items, index);
  const target = indexes[indexes.indexOf(index) + direction];
  if (target == null) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function DayWarmupEditor({
  day,
  days,
  onChange,
  onItemsChange,
  onApply,
}: {
  day: ProgramDocumentDayV3;
  days: ProgramDocumentDayV3[];
  onChange: (value: string | null) => void;
  onItemsChange: (items: ProgramDayWarmupItem[]) => void;
  onApply: (
    targetIds: string[],
    value: string | null,
    items: ProgramDayWarmupItem[],
  ) => void;
}) {
  const [copyOpen, setCopyOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingTargets, setPendingTargets] = useState<string[] | null>(null);
  const value = day.warmupNotes ?? null;
  const hasWarmup = Boolean(value) || day.warmupItems.length > 0;
  const hasLiftTimedSteps = day.warmupItems.some(
    (item) => item.beforeSlotLineageId != null,
  );
  const requestApply = (targetIds: string[]) => {
    const differentNonEmpty = days.some((candidate) =>
      targetIds.includes(candidate.lineageId) &&
      (Boolean(candidate.warmupNotes) || candidate.warmupItems.length > 0) &&
      (candidate.warmupNotes !== value ||
        JSON.stringify(candidate.warmupItems) !== JSON.stringify(day.warmupItems)),
    );
    if (differentNonEmpty) setPendingTargets(targetIds);
    else onApply(targetIds, value, day.warmupItems);
  };
  const updateItem = (index: number, item: ProgramDayWarmupItem) =>
    onItemsChange(day.warmupItems.map((current, itemIndex) => itemIndex === index ? item : current));

  return (
    <section className="rounded-xl border border-violet-300/60 bg-violet-50/50 p-3 dark:bg-violet-950/20 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Warm-up</h3>
          <p className="text-xs text-muted-foreground">
            Write the instructions you want to see when this workout begins.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setCopyOpen(true)} disabled={!hasWarmup || days.length < 2 || hasLiftTimedSteps}>Copy to days</Button>
          <Button type="button" variant="outline" onClick={() => requestApply(days.map((candidate) => candidate.lineageId))} disabled={!hasWarmup || days.length < 2 || hasLiftTimedSteps}>Apply to all</Button>
          <Button type="button" variant="ghost" onClick={() => { onChange(null); onItemsChange([]); }} disabled={!hasWarmup}>Clear this day</Button>
        </div>
      </div>

      {hasLiftTimedSteps && (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Lift-timed steps cannot be copied to another day because their exercise
          identities are different. Change them to workout-start steps first, or
          recreate them against the intended exercises on the other day.
        </p>
      )}

      <Field
        id={`day-${day.lineageId}-warmup-overview`}
        label="Warm-up instructions (optional)"
        hint="Plain text is enough. Separate check-off steps are available below if you want them."
      >
        <Textarea
          id={`day-${day.lineageId}-warmup-overview`}
          className="min-h-20 bg-background"
          value={day.warmupNotes ?? ""}
          onChange={(event) => onChange(optionalText(event.target.value))}
          placeholder="Example: Move smoothly and stop if anything feels painful."
        />
      </Field>

      <details className="mt-4 rounded-lg border bg-background p-3">
        <summary className="min-h-11 cursor-pointer font-medium">
          Optional check-off steps
          <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
            Add separate boxes only when they are useful during the workout.
          </span>
        </summary>
        <div className="mt-3 space-y-3">
        {day.warmupItems.map((item, index) => (
          <article key={item.key} className="rounded-lg border bg-background p-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="font-medium">Step {index + 1}</h4>
              <div className="flex gap-2">
                <Button type="button" size="icon" variant="outline" aria-label={`Move warm-up step ${index + 1} earlier at this point`} disabled={matchingTimingIndexes(day.warmupItems, index).indexOf(index) === 0} onClick={() => onItemsChange(moveWarmupAtSameTiming(day.warmupItems, index, -1))}><ArrowUp /></Button>
                <Button type="button" size="icon" variant="outline" aria-label={`Move warm-up step ${index + 1} later at this point`} disabled={matchingTimingIndexes(day.warmupItems, index).indexOf(index) === matchingTimingIndexes(day.warmupItems, index).length - 1} onClick={() => onItemsChange(moveWarmupAtSameTiming(day.warmupItems, index, 1))}><ArrowDown /></Button>
                <Button type="button" size="icon" variant="destructive" aria-label={`Remove warm-up step ${index + 1}`} onClick={() => onItemsChange(day.warmupItems.filter((_, itemIndex) => itemIndex !== index))}><Trash2 /></Button>
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field id={`${item.key}-label`} label="Step">
                <Input id={`${item.key}-label`} value={item.label} onChange={(event) => updateItem(index, { ...item, label: event.target.value })} />
              </Field>
              <Field id={`${item.key}-reps`} label="Repetitions (optional)">
                <Input id={`${item.key}-reps`} type="number" min={0} max={1000} value={item.reps ?? ""} onChange={(event) => updateItem(index, { ...item, reps: nullableNumber(event.target.value) })} />
              </Field>
              <Field id={`${item.key}-timing`} label="When it happens">
                <select
                  id={`${item.key}-timing`}
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  value={item.beforeSlotLineageId ?? ""}
                  onChange={(event) =>
                    updateItem(index, {
                      ...item,
                      beforeSlotLineageId: event.target.value || null,
                    })
                  }
                >
                  <option value="">At the start of the workout</option>
                  {day.exercises.map((slot, slotIndex) => (
                    <option key={slot.lineageId} value={slot.lineageId}>
                      Before exercise {slotIndex + 1}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`${item.key}-load-mode`} label="Loading method">
                <select
                  id={`${item.key}-load-mode`}
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  value={loadingMode(item)}
                  onChange={(event) => {
                    const mode = event.target.value;
                    if (mode === "numeric") updateItem(index, setWarmupNumericLoad(item, 0));
                    else if (mode === "percent") updateItem(index, setWarmupLoadPercent(item, 0));
                    else if (mode === "instruction") updateItem(index, setWarmupLoadText(item, ""));
                    else updateItem(index, { ...item, load: null, loadUnit: null, loadPercent: null, loadText: null });
                  }}
                >
                  <option value="none">None</option>
                  <option value="numeric">Measured load</option>
                  <option value="percent">Percent of work load</option>
                  <option value="instruction">Written instruction</option>
                </select>
              </Field>
              {item.load != null && (
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <Field id={`${item.key}-load`} label="Load"><Input id={`${item.key}-load`} type="number" min={0} max={100000} value={item.load} onChange={(event) => updateItem(index, setWarmupNumericLoad(item, nullableNumber(event.target.value)))} /></Field>
                  <Field id={`${item.key}-unit`} label="Unit"><select id={`${item.key}-unit`} className="h-11 rounded-lg border border-input bg-background px-3" value={item.loadUnit ?? "lb"} onChange={(event) => updateItem(index, { ...item, loadUnit: event.target.value as "lb" | "kg" })}><option value="lb">lb</option><option value="kg">kg</option></select></Field>
                </div>
              )}
              {item.loadPercent != null && <Field id={`${item.key}-percent`} label="Percent"><Input id={`${item.key}-percent`} type="number" min={0} max={500} value={item.loadPercent} onChange={(event) => updateItem(index, setWarmupLoadPercent(item, nullableNumber(event.target.value)))} /></Field>}
              {item.loadText != null && <Field id={`${item.key}-instruction`} label="Loading instruction"><Input id={`${item.key}-instruction`} value={item.loadText} onChange={(event) => updateItem(index, setWarmupLoadText(item, event.target.value))} /></Field>}
              <Field id={`${item.key}-notes`} label="Notes (optional)"><Input id={`${item.key}-notes`} value={item.notes ?? ""} onChange={(event) => updateItem(index, { ...item, notes: optionalText(event.target.value) })} /></Field>
            </div>
          </article>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() => onItemsChange([...day.warmupItems, { key: crypto.randomUUID(), beforeSlotLineageId: null, label: "New warm-up step", reps: null, load: null, loadUnit: null, loadPercent: null, loadText: null, notes: null }])}
          disabled={day.warmupItems.length >= 24}
        >
          <Plus /> Add warm-up step
        </Button>
        </div>
      </details>

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Copy this warm-up</DialogTitle><DialogDescription>Select the other days that should use this overview and ordered steps.</DialogDescription></DialogHeader>
          <div className="space-y-2">
            {days.filter((candidate) => candidate.lineageId !== day.lineageId).map((candidate) => (
              <label key={candidate.lineageId} className="flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2">
                <input type="checkbox" className="size-5" checked={selected.includes(candidate.lineageId)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, candidate.lineageId] : current.filter((id) => id !== candidate.lineageId))} />
                {candidate.name}
              </label>
            ))}
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setCopyOpen(false)}>Cancel</Button><Button type="button" disabled={selected.length === 0} onClick={() => { setCopyOpen(false); requestApply(selected); }}>Copy warm-up</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingTargets != null}
        onOpenChange={(open) => !open && setPendingTargets(null)}
        title="Replace a different warm-up?"
        description="At least one selected day already has a different warm-up. Continuing replaces its overview and ordered steps; exercises and other notes stay unchanged."
        confirmLabel="Replace warm-ups"
        onConfirm={() => { if (pendingTargets) onApply(pendingTargets, value, day.warmupItems); setPendingTargets(null); setSelected([]); }}
      />
    </section>
  );
}
