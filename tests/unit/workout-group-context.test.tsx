import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  SessionEquipmentSetup,
  SessionExerciseData,
  SessionExerciseGroupData,
  SessionOccurrenceData,
} from "@/components/session/types";
import { WorkoutGroupContext } from "@/components/session/workout-group-context";
import { projectSessionGuidance } from "@/lib/session-guidance";

function exercise(
  id: string,
  name: string,
  orderIdx: number,
): SessionExerciseData {
  return {
    id,
    exerciseId: `catalog-${id}`,
    name,
    family: null,
    loadType: "dumbbell",
    loadSemantics: "per_implement",
    movementPattern: "pull",
    orderIdx,
    supersetKey: "saved-pair",
    restSec: 60,
    modificationType: "as_planned",
    skipReason: null,
    substitutedForExerciseId: null,
    substitutionReason: null,
    substitutedAt: null,
    plannedExerciseName: null,
    targetSets: 2,
    targetRepsMin: 8,
    targetRepsMax: 10,
    targetLoad: 30,
    targetLoadUnit: "lb",
    notes: null,
    warmupNotes: null,
    warmupSets: [],
    setNotes: [],
    cautionBodyParts: [],
    media: null,
    sets: [],
    last: null,
  };
}

function occurrence(
  id: string,
  sessionExerciseId: string,
  sequenceIdx: number,
  round: number,
  memberOrder: number,
): SessionOccurrenceData {
  return {
    id,
    sessionExerciseId,
    kind: "working_set",
    origin: "planned",
    sequenceIdx,
    kindOrdinal: round - 1,
    label: null,
    plannedExerciseId: `catalog-${sessionExerciseId}`,
    plannedNote: null,
    plannedRepsMin: 8,
    plannedRepsMax: 10,
    plannedLoad: 30,
    plannedLoadUnit: "lb",
    plannedLoadPercent: null,
    plannedLoadText: null,
    plannedRestSec: memberOrder === 0 ? 0 : 75,
    groupSnapshotId: "group-snapshot",
    groupRound: round,
    groupMemberOrderIdx: memberOrder,
    outcome: "pending",
    outcomeReason: null,
    outcomeNote: null,
    revision: 0,
    resolvedAt: null,
    completedSetId: null,
    restAfterSec: memberOrder === 0 ? 0 : 75,
  };
}

function setup(
  source: SessionExerciseData,
  patch: Partial<SessionEquipmentSetup> = {},
): SessionEquipmentSetup {
  return {
    sourceExerciseId: source.exerciseId,
    sourceTargetLoad: source.targetLoad,
    sourceTargetLoadUnit: source.targetLoadUnit,
    exact: true,
    status: "available",
    selectionRequired: false,
    currentSnapshotId: "snapshot-row",
    currentEquipmentLabel: "Pair of 30 lb dumbbells",
    currentAttachmentLabel: null,
    currentGuidance: "Use the reviewed pair.",
    currentGuidanceByLoadEntryMeaning: {},
    currentSelectionAvailable: true,
    loadEntryMeaning: "total_system",
    loadEntryMeaningChoices: [],
    options: [],
    ...patch,
  };
}

const group: SessionExerciseGroupData = {
  id: "group-snapshot",
  name: "Upper-body pair",
  plannedRounds: 2,
  memberCount: 2,
  orderIdx: 0,
};

describe("active workout group presentation", () => {
  it("shows saved order, current and next members, rest truth, and exact next setup as guidance only", () => {
    const press = exercise("press", "Press", 0);
    const row = exercise("row", "Row", 1);
    const occurrences = [
      occurrence("press-r1", press.id, 0, 1, 0),
      occurrence("row-r1", row.id, 1, 1, 1),
      occurrence("press-r2", press.id, 2, 2, 0),
      occurrence("row-r2", row.id, 3, 2, 1),
    ];
    const original = structuredClone(occurrences);
    const guidance = projectSessionGuidance({
      exercises: [press, row],
      exerciseGroups: [group],
      occurrences,
      equipmentSetups: { [row.id]: setup(row) },
    });
    const html = renderToStaticMarkup(
      <WorkoutGroupContext guidance={guidance} />,
    );

    expect(html).toContain("Current exercise group");
    expect(html).toContain("Upper-body pair");
    expect(html).toContain("Round 1 of 2");
    expect(html).toContain("Current member:</span> 1 of 2 · Press");
    expect(html).toContain("Up next in group:</span> 2 of 2 · Row");
    expect(html).toContain("No planned rest is saved after the current set.");
    expect(html).toContain('href="#exercise-press"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("1. Press");
    expect(html).toContain("2. Row");
    expect(html).toContain("Prepare for Row");
    expect(html).toContain("Reviewed setup selected");
    expect(html).toContain("Pair of 30 lb dumbbells");
    expect(html).toContain("Preparation is guidance only");
    expect(occurrences).toEqual(original);
  });

  it("states unavailable and unknown equipment without inventing setup detail", () => {
    const press = exercise("press", "Press", 0);
    const row = exercise("row", "Row", 1);
    const unavailable = projectSessionGuidance({
      exercises: [press, row],
      exerciseGroups: [group],
      occurrences: [
        occurrence("press-r1", press.id, 0, 1, 0),
        occurrence("row-r1", row.id, 1, 1, 1),
      ],
      equipmentSetups: {
        [row.id]: setup(row, {
          status: "unavailable",
          currentSnapshotId: null,
          currentEquipmentLabel: null,
          currentGuidance: null,
        }),
      },
    });
    const unavailableHtml = renderToStaticMarkup(
      <WorkoutGroupContext guidance={unavailable} />,
    );
    expect(unavailableHtml).toContain("Required setup unavailable");
    expect(unavailableHtml).toContain(
      "No reviewed equipment setup is currently available.",
    );
    expect(unavailableHtml).not.toContain("Pair of 30 lb dumbbells");

    const unknown = projectSessionGuidance({
      exercises: [press, row],
      exerciseGroups: [group],
      occurrences: [
        occurrence("press-r1", press.id, 0, 1, 0),
        occurrence("row-r1", row.id, 1, 1, 1),
      ],
      equipmentSetups: {},
    });
    const unknownHtml = renderToStaticMarkup(
      <WorkoutGroupContext guidance={unknown} />,
    );
    expect(unknownHtml).toContain("Exact setup unknown");
    expect(unknownHtml).toContain(
      "The exact physical setup is not recorded.",
    );
  });

  it("keeps saved rest wording truthful when later group work was resolved out of order", () => {
    const press = exercise("press", "Press", 0);
    const row = exercise("row", "Row", 1);
    const performedLater = occurrence("press-r2", press.id, 2, 2, 0);
    const guidance = projectSessionGuidance({
      exercises: [press, row],
      exerciseGroups: [group],
      occurrences: [
        {
          ...occurrence("press-r1", press.id, 0, 1, 0),
          outcome: "completed",
          completedSetId: "saved-press-r1",
        },
        occurrence("row-r1", row.id, 1, 1, 1),
        {
          ...performedLater,
          outcome: "completed",
          completedSetId: "saved-press-r2",
        },
        occurrence("row-r2", row.id, 3, 2, 1),
      ],
      equipmentSetups: {},
    });
    const html = renderToStaticMarkup(
      <WorkoutGroupContext guidance={guidance} />,
    );

    expect(html).toContain("1 min 15 sec saved after the current set.");
    expect(html).toContain("Later group work is already recorded.");
    expect(html).not.toContain("before the next member");
    expect(html).not.toContain("after this round");
  });
});
