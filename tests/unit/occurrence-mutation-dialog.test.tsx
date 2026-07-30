import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OCCURRENCE_SKIP_REASONS,
  OccurrenceMutationDialogForm,
  formatOccurrencePrescription,
} from "@/components/session/occurrence-mutation-dialog";
import type { SessionOccurrenceData } from "@/components/session/types";

const occurrence: SessionOccurrenceData = {
  id: "10000000-0000-4000-8000-000000000001",
  sessionExerciseId: "20000000-0000-4000-8000-000000000001",
  kind: "exercise_warmup",
  origin: "planned",
  sequenceIdx: 0,
  kindOrdinal: 0,
  label: "Warm-up set 1",
  plannedExerciseId: "30000000-0000-4000-8000-000000000001",
  plannedNote: "Move smoothly",
  plannedRepsMin: 8,
  plannedRepsMax: 10,
  plannedLoad: 45,
  plannedLoadUnit: "lb",
  plannedLoadPercent: 50,
  plannedLoadText: "empty bar",
  plannedRestSec: 30,
  groupSnapshotId: null,
  groupRound: null,
  groupMemberOrderIdx: null,
  outcome: "pending",
  outcomeReason: null,
  outcomeNote: "Shoulder felt good",
  revision: 0,
  resolvedAt: null,
  completedSetId: null,
  restAfterSec: 30,
};

describe("occurrence mutation controls", () => {
  it("formats every stored warm-up prescription field", () => {
    expect(formatOccurrencePrescription(occurrence)).toBe(
      "8–10 reps · 45 lb · 50% of working load · empty bar",
    );
    expect(
      formatOccurrencePrescription({
        ...occurrence,
        plannedRepsMin: 5,
        plannedRepsMax: 5,
        plannedLoad: null,
        plannedLoadUnit: null,
        plannedLoadPercent: null,
        plannedLoadText: null,
      }),
    ).toBe("5 reps");
  });

  it("presents an accessible reason and optional-note flow for skips", () => {
    const html = renderToStaticMarkup(
      <OccurrenceMutationDialogForm
        mode="skip"
        itemLabel="set 2 of Back squat"
        reason="time"
        note=""
        saving={false}
        onReasonChange={() => undefined}
        onNoteChange={() => undefined}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("Skip set 2 of Back squat?");
    expect(html).toContain(">Reason</label>");
    expect(html).toContain(">Optional note</label>");
    expect(html).toContain('maxLength="500"');
    for (const reason of OCCURRENCE_SKIP_REASONS) {
      expect(html).toContain(reason.label);
    }
  });

  it("presents the existing note when a warm-up note is edited", () => {
    const html = renderToStaticMarkup(
      <OccurrenceMutationDialogForm
        mode="note"
        itemLabel="Bench press: Warm-up set 1"
        reason="time"
        note="Shoulder felt good"
        saving={false}
        onReasonChange={() => undefined}
        onNoteChange={() => undefined}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("Note for Bench press: Warm-up set 1");
    expect(html).toContain("gap-2 pr-10");
    expect(html).toContain("Workout-item note");
    expect(html).toContain("Shoulder felt good");
    expect(html).not.toContain(">Reason</label>");
  });

  it("allows an existing warm-up note to be cleared", () => {
    const html = renderToStaticMarkup(
      <OccurrenceMutationDialogForm
        mode="note"
        itemLabel="Warm-up set 1"
        reason="time"
        note="   "
        saving={false}
        onReasonChange={() => undefined}
        onNoteChange={() => undefined}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(html.match(/min-h-11/g)).toHaveLength(2);
    const saveButton = html.match(/<button[^>]*>Save note<\/button>/)?.[0];
    expect(saveButton).toBeDefined();
    expect(saveButton).not.toContain(' disabled=""');
  });
});
