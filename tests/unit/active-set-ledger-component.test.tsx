import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveSetLedger } from "@/components/session/active-set-ledger";
import { projectActiveSetRows } from "@/lib/active-set-row-projection";
import { ADDED_WORKOUT_SET_NOTE } from "@/lib/session-occurrences";
import {
  SET_ROW_CROSS_AXIS_FIXTURES,
  SET_ROW_STATE_FIXTURES,
  SET_ROW_VERSION_FIXTURES,
} from "../fixtures/active-workout-north-star";

const STATUS_BY_STATE = {
  planned: "Planned",
  current_editable: "Editable fields",
  retained_locally: "Unsaved on this device",
  saving: "Saving",
  retrying: "Retrying",
  failed: "Save failed",
  saved: "Saved",
  skipped: "Skipped",
  abandoned: "Abandoned",
  completed_without_result: "Needs review",
  unknown_legacy: "Unknown",
} as const;

function renderFixture(
  input: (typeof SET_ROW_STATE_FIXTURES)[keyof typeof SET_ROW_STATE_FIXTURES]["input"],
) {
  const projection = projectActiveSetRows(input);
  return renderToStaticMarkup(
    <ActiveSetLedger
      exerciseId={input.exercise.id}
      exerciseName={input.exercise.name}
      metricType="weight_reps"
      rows={projection.rows}
      diagnostics={projection.diagnostics}
      renderCurrentRow={() => <p>Editable fields</p>}
      renderSaveRecovery={() => <p>Recovery controls</p>}
      renderOutcomeStatus={() => <p>Outcome receipt</p>}
    />,
  );
}

describe("ActiveSetLedger", () => {
  it("renders every projected lifecycle state explicitly", () => {
    for (const [state, fixture] of Object.entries(SET_ROW_STATE_FIXTURES)) {
      const html = renderFixture(fixture.input);
      expect(html).toContain(`data-set-row-state="${state}"`);
      expect(html).toContain(STATUS_BY_STATE[state as keyof typeof STATUS_BY_STATE]);
    }
  });

  it("keeps the current prescription separate from editable performed fields", () => {
    const html = renderFixture(SET_ROW_STATE_FIXTURES.current_editable.input);
    expect(html).toContain("Target 8 reps · 95 lb");
    expect(html).toContain("Editable fields");
    expect(html).toContain(
      '<section id="set-entry-40000000-0000-4000-8000-000000000001-60000000-0000-4000-8000-000000000001" data-testid="current-set-entry" data-active-workout-focus-target="true" tabindex="-1" aria-label="Barbell Back Squat, Set 1"',
    );
    expect(html.indexOf("Target 8 reps · 95 lb")).toBeLessThan(
      html.indexOf("Editable fields"),
    );
  });

  it("keeps a frozen per-set note visible on a future planned row", () => {
    const input = SET_ROW_STATE_FIXTURES.planned.input;
    const projection = projectActiveSetRows({
      ...input,
      occurrences: [{
        ...input.occurrences[0],
        plannedNote: "Three-second eccentric",
      }],
    });
    const html = renderToStaticMarkup(
      <ActiveSetLedger
        exerciseId={input.exercise.id}
        exerciseName={input.exercise.name}
        metricType="weight_reps"
        rows={projection.rows}
        diagnostics={projection.diagnostics}
        renderCurrentRow={() => <p>Editable fields</p>}
      />,
    );
    expect(html).toContain("Three-second eccentric");
    expect(html).toContain("Planned");
  });

  it("keeps a newly added extra set editable without replacing the planned current row", () => {
    const extraOccurrence = SET_ROW_CROSS_AXIS_FIXTURES.failedExtra.input.occurrences[0];
    const plannedOccurrence = {
      ...extraOccurrence,
      id: "60000000-0000-4000-8000-000000000002",
      origin: "planned" as const,
      sequenceIdx: 10,
      kindOrdinal: 0,
      plannedNote: null,
    };
    const input = {
      ...SET_ROW_CROSS_AXIS_FIXTURES.failedExtra.input,
      occurrences: [
        plannedOccurrence,
        {
          ...extraOccurrence,
          sequenceIdx: 20,
          kindOrdinal: 1,
        },
      ],
      outboxEntries: [],
      runtimeSaveStates: {},
      currentOccurrenceId: plannedOccurrence.id,
    };
    const projection = projectActiveSetRows(input);
    const html = renderToStaticMarkup(
      <ActiveSetLedger
        exerciseId={input.exercise.id}
        exerciseName={input.exercise.name}
        metricType="weight_reps"
        rows={projection.rows}
        diagnostics={projection.diagnostics}
        renderCurrentRow={() => <p>Planned set editor</p>}
        renderPlannedRow={() => <p>Extra set editor</p>}
      />,
    );
    expect(html).toContain("Planned set editor");
    expect(html).toContain('data-testid="current-set-entry"');
    expect(html).toContain('data-testid="added-set-entry"');
    expect(html).toContain("Extra set 1");
    expect(html).toContain("Added to this workout");
    expect(html).not.toContain(ADDED_WORKOUT_SET_NOTE);
    expect(html).toContain("Extra set editor");
  });

  it("keeps the next planned set context available without making it editable", () => {
    const input = SET_ROW_STATE_FIXTURES.planned.input;
    const projection = projectActiveSetRows(input);
    const html = renderToStaticMarkup(
      <ActiveSetLedger
        exerciseId={input.exercise.id}
        exerciseName={input.exercise.name}
        metricType="weight_reps"
        rows={projection.rows}
        diagnostics={projection.diagnostics}
        renderCurrentRow={() => <p>Editable fields</p>}
        renderPlannedRowDetail={() => <p>Reach this set in the workout flow</p>}
      />,
    );
    expect(html).toContain("Reach this set in the workout flow");
    expect(html).toContain("Planned");
    expect(html).not.toContain("Editable fields");
  });

  it("shows exact retained and saved results without treating them as targets", () => {
    const retained = renderFixture(SET_ROW_STATE_FIXTURES.retained_locally.input);
    const saved = renderFixture(SET_ROW_STATE_FIXTURES.saved.input);
    expect(retained).toContain("95 lb × 8");
    expect(retained).toContain("Unsaved on this device");
    expect(retained).toContain("Exact device result");
    expect(retained).toContain("Effort: Hard");
    expect(retained).toContain("RIR 2");
    expect(saved).toContain("95 lb × 8");
    expect(saved).toContain("Saved");
  });

  it("renders correction and restore provenance independently of save state", () => {
    const corrected = renderFixture(SET_ROW_VERSION_FIXTURES.corrected.input);
    const versionRestored = renderFixture(
      SET_ROW_VERSION_FIXTURES.version_restored.input,
    );
    const snapshotRestored = renderFixture(
      SET_ROW_VERSION_FIXTURES.snapshot_restored.input,
    );
    expect(corrected).toContain("Latest: Corrected · 1 change");
    expect(versionRestored).toContain("Latest: Version restored · 1 change");
    expect(snapshotRestored).toContain("Latest: Snapshot restored · 1 change");
  });

  it("keeps retained technique, limitation, and pain evidence visible", () => {
    const input = SET_ROW_STATE_FIXTURES.retained_locally.input;
    const retainedSet = input.exercise.sets[0];
    const html = renderFixture({
      ...input,
      outboxEntries: input.outboxEntries?.map((entry) => ({
        ...entry,
        rpe: 8,
        rir: 2,
        techniqueIssue: "control",
        limitationCause: "grip",
        pain: {
          bodyPart: "wrist",
          severity: 3,
          note: "Felt sharp on the last rep",
        },
      })),
      exercise: {
        ...input.exercise,
        sets: [{
          ...retainedSet,
          techniqueIssue: "control",
          limitationCause: "grip",
          pain: {
            bodyPart: "wrist",
            severity: 3,
            note: "Felt sharp on the last rep",
          },
        }],
      },
    });
    expect(html).toContain("Technique: Control");
    expect(html).toContain("Limited by: Grip");
    expect(html).toContain("Pain: wrist 3/10");
    expect(html).toContain("Pain note: Felt sharp on the last rep");
  });

  it("labels unlinked evidence unknown while keeping its exact result visible", () => {
    const projection = projectActiveSetRows(
      SET_ROW_STATE_FIXTURES.planned.input,
    );
    const html = renderToStaticMarkup(
      <ActiveSetLedger
        exerciseId={SET_ROW_STATE_FIXTURES.planned.input.exercise.id}
        exerciseName={SET_ROW_STATE_FIXTURES.planned.input.exercise.name}
        metricType="weight_reps"
        rows={projection.rows}
        diagnostics={{
          ...projection.diagnostics,
          unlinkedSetIds: ["unlinked-set"],
        }}
        diagnosticRows={[
          {
            key: "unlinked-set",
            label: "Recorded set 4",
            summary: "125 lb × 5",
            result: {
              id: "unlinked-set",
              clientKey: null,
              setNo: 4,
              weight: 125,
              weightUnit: "lb",
              reps: 5,
              metricType: "weight_reps",
              distanceKm: null,
              durationSeconds: null,
              rpe: 9.5,
              rir: 0,
              techniqueIssue: "range_of_motion",
              limitationCause: "breathing_conditioning",
              pain: {
                bodyPart: "shoulder",
                severity: 4,
                note: "Pinched at the bottom",
              },
              note: "Stopped before another rep",
            },
            message: "This result cannot be linked safely.",
            version: { state: "version_restored", count: 2 },
          },
        ]}
        renderCurrentRow={() => null}
      />,
    );
    expect(html).toContain('data-set-membership="unknown"');
    expect(html).toContain("Recorded set 4");
    expect(html).toContain("125 lb × 5");
    expect(html).toContain("Unknown");
    expect(html).toContain("Latest: Version restored · 2 changes");
    expect(html).toContain("Stopped before another rep");
    expect(html).toContain("Effort: Grind");
    expect(html).toContain("RIR 0");
    expect(html).toContain("Technique: Range of motion");
    expect(html).toContain("Limited by: Breathing or conditioning");
    expect(html).toContain("Pain: shoulder 4/10");
    expect(html).toContain("Pain note: Pinched at the bottom");
    expect(html).not.toMatch(/<li[^>]*role="alert"/);
    expect(html).toMatch(/<li[^>]*><div role="alert">/);
    expect(html).not.toContain("Recorded set 4</span><span>Saved");
  });

  it("keeps restore evidence visible when a linked legacy row stays unknown", () => {
    const input = SET_ROW_VERSION_FIXTURES.snapshot_restored.input;
    const projection = projectActiveSetRows({
      ...input,
      exercise: {
        ...input.exercise,
        sets: input.exercise.sets.map((set) => ({
          ...set,
          techniqueIssue: "control",
          limitationCause: "grip",
          pain: {
            bodyPart: "wrist",
            severity: 3,
            note: "Sharp at lockout",
          },
        })),
      },
      occurrences: [{ ...input.occurrences[0], origin: "legacy" }],
    });
    const html = renderToStaticMarkup(
      <ActiveSetLedger
        exerciseId={input.exercise.id}
        exerciseName={input.exercise.name}
        metricType="weight_reps"
        rows={projection.rows}
        diagnostics={projection.diagnostics}
        renderCurrentRow={() => null}
      />,
    );
    expect(html).toContain('data-set-row-state="unknown_legacy"');
    expect(html).toContain("Latest: Snapshot restored · 1 change");
    expect(html).toContain("Exact performed result");
    expect(html).toContain("Effort: Hard");
    expect(html).toContain("RIR 2");
    expect(html).toContain("Technique: Control");
    expect(html).toContain("Limited by: Grip");
    expect(html).toContain("Pain: wrist 3/10");
    expect(html).toContain("Pain note: Sharp at lockout");
    expect(html).toContain("Unknown");
  });
});
