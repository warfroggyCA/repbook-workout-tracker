"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { SessionOccurrenceData } from "./types";

export function formatOccurrencePrescription(
  occurrence: SessionOccurrenceData,
): string | null {
  const details: string[] = [];
  if (occurrence.plannedRepsMin != null || occurrence.plannedRepsMax != null) {
    const minimum = occurrence.plannedRepsMin ?? occurrence.plannedRepsMax;
    const maximum = occurrence.plannedRepsMax ?? occurrence.plannedRepsMin;
    details.push(
      minimum === maximum ? `${minimum} reps` : `${minimum}–${maximum} reps`,
    );
  }
  if (occurrence.plannedLoad != null) {
    details.push(
      `${occurrence.plannedLoad}${
        occurrence.plannedLoadUnit ? ` ${occurrence.plannedLoadUnit}` : ""
      }`,
    );
  }
  if (occurrence.plannedLoadPercent != null) {
    details.push(`${occurrence.plannedLoadPercent}% of working load`);
  }
  if (occurrence.plannedLoadText?.trim()) {
    details.push(occurrence.plannedLoadText.trim());
  }
  return details.length > 0 ? details.join(" · ") : null;
}

export const OCCURRENCE_SKIP_REASONS = [
  { value: "time", label: "Short on time" },
  { value: "pain", label: "Pain or discomfort" },
  { value: "fatigue", label: "Fatigue" },
  { value: "equipment", label: "Equipment unavailable" },
  { value: "other", label: "Other" },
] as const;

type OccurrenceMutationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "skip" | "note";
  itemLabel: string;
  initialNote: string | null;
  onConfirm: (input: {
    reason: string | null;
    note: string | null;
  }) => Promise<boolean>;
};

export function OccurrenceMutationDialog({
  open,
  onOpenChange,
  mode,
  itemLabel,
  initialNote,
  onConfirm,
}: OccurrenceMutationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [reason, setReason] = useState<string>(OCCURRENCE_SKIP_REASONS[0].value);
  const [note, setNote] = useState(initialNote ?? "");
  const [saving, setSaving] = useState(false);

  function resetAndClose() {
    setReason(OCCURRENCE_SKIP_REASONS[0].value);
    setNote(initialNote ?? "");
    onOpenChange(false);
  }

  async function submit() {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await onConfirm({
        reason: mode === "skip" ? reason : null,
        note: note.trim() || null,
      });
      if (saved) resetAndClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) resetAndClose();
      }}
    >
      <DialogContent aria-labelledby={titleId} aria-describedby={descriptionId}>
        <OccurrenceMutationDialogForm
          mode={mode}
          itemLabel={itemLabel}
          reason={reason}
          note={note}
          saving={saving}
          onReasonChange={setReason}
          onNoteChange={setNote}
          onCancel={resetAndClose}
          onSubmit={() => void submit()}
          titleId={titleId}
          descriptionId={descriptionId}
        />
      </DialogContent>
    </Dialog>
  );
}

export function OccurrenceMutationDialogForm({
  mode,
  itemLabel,
  reason,
  note,
  saving,
  onReasonChange,
  onNoteChange,
  onCancel,
  onSubmit,
  titleId: providedTitleId,
  descriptionId: providedDescriptionId,
}: {
  mode: "skip" | "note";
  itemLabel: string;
  reason: string;
  note: string;
  saving: boolean;
  onReasonChange: (reason: string) => void;
  onNoteChange: (note: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  titleId?: string;
  descriptionId?: string;
}) {
  const generatedTitleId = useId();
  const generatedDescriptionId = useId();
  const reasonId = useId();
  const noteId = useId();
  const titleId = providedTitleId ?? generatedTitleId;
  const descriptionId = providedDescriptionId ?? generatedDescriptionId;
  return (
    <>
      <div className="flex flex-col gap-2 pr-10">
        <h2 id={titleId} className="font-heading text-base leading-none font-medium">
          {mode === "skip" ? `Skip ${itemLabel}?` : `Note for ${itemLabel}`}
        </h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {mode === "skip"
            ? "Choose why you are skipping this item. You can also leave a note for your workout history."
            : "Add context you want saved with this warm-up item."}
        </p>
      </div>

      {mode === "skip" && (
        <div className="space-y-1.5">
          <label htmlFor={reasonId} className="text-sm font-medium">
            Reason
          </label>
          <select
            id={reasonId}
            className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            disabled={saving}
          >
            {OCCURRENCE_SKIP_REASONS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor={noteId} className="text-sm font-medium">
          {mode === "skip" ? "Optional note" : "Workout-item note"}
        </label>
        <Textarea
          id={noteId}
          value={note}
          maxLength={500}
          rows={3}
          placeholder={
            mode === "skip"
              ? "Anything useful to remember?"
              : "Add context for this warm-up…"
          }
          disabled={saving}
          onChange={(event) => onNoteChange(event.target.value)}
        />
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          className="min-h-11"
          disabled={saving}
          onClick={onSubmit}
        >
          {saving
            ? "Saving…"
            : mode === "skip"
              ? "Skip item"
              : "Save note"}
        </Button>
      </DialogFooter>
    </>
  );
}
