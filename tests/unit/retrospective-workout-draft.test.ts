import { describe, expect, it } from "vitest";
import {
  addCompletedDraftSet,
  changeDraftOutcome,
  draftExercisesForProgramDay,
  initializeRetrospectiveDraft,
  parseRetrospectiveDraft,
  retrospectiveDraftKey,
  retrospectiveLegacyDraftKey,
  selectPerformedDraftExercise,
} from "@/lib/retrospective-workout-draft";
import type { ProgramPresentation } from "@/lib/program-presentation";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";

function ids() {
  let current = 0;
  return () => `00000000-0000-4000-8000-${String(++current).padStart(12, "0")}`;
}

const day: ProgramPresentation["days"][number] = {
  id: "10000000-0000-4000-8000-000000000001",
  lineageId: "10000000-0000-4000-8000-000000000002",
  name: "Day 3",
  notes: null,
  orderIdx: 2,
  intent: null,
  warmupLines: [],
  slots: [
    {
      id: "20000000-0000-4000-8000-000000000001",
      lineageId: "20000000-0000-4000-8000-000000000002",
      exercise: {
        id: "30000000-0000-4000-8000-000000000001",
        name: "Lat Pulldown",
        family: "Lat Pulldown",
        movementPattern: "vertical_pull",
      },
      orderIdx: 0,
      supersetGroupId: null,
      restSec: 90,
      notes: null,
      warmupNotes: null,
      warmupSets: [],
      prescription: {
        sets: 3,
        repRangeMin: 8,
        repRangeMax: 12,
        targetLoad: 80,
        targetLoadUnit: "lb",
        progressionRuleId: "40000000-0000-4000-8000-000000000001",
      },
      superset: null,
    },
  ],
};

describe("retrospective workout browser draft", () => {
  it("starts with stable write identities and no invented performed work", () => {
    const id = ids();
    const draft = initializeRetrospectiveDraft({
      ownerId: "owner",
      localDate: "2026-07-23",
      timezone: "America/Toronto",
      id,
    });
    const exercises = draftExercisesForProgramDay(
      day,
      id,
      new Map([[day.slots[0].exercise.id, "weight_reps"]]),
    );

    expect(draft.requestId).not.toBe(draft.sessionId);
    expect(exercises).toHaveLength(1);
    expect(exercises[0].sourceTemplateExerciseId).toBe(day.slots[0].id);
    expect(exercises[0].outcomes).toHaveLength(3);
    expect(exercises[0].outcomes.every((set) => set.outcome === "legacy_unrecorded")).toBe(true);
    expect(new Set(exercises[0].outcomes.map((set) => set.occurrenceId)).size).toBe(3);
  });

  it("keeps the occurrence identity while a reviewed outcome changes", () => {
    const id = ids();
    const unknown = draftExercisesForProgramDay(day, id)[0].outcomes[0];
    const completed = changeDraftOutcome(unknown, "completed", id);
    const skipped = changeDraftOutcome(completed, "skipped", id);

    expect(completed.occurrenceId).toBe(unknown.occurrenceId);
    expect(skipped.occurrenceId).toBe(unknown.occurrenceId);
    expect(completed.outcome).toBe("completed");
    expect(skipped).toMatchObject({
      outcome: "skipped",
      skipReason: null,
      legacySkipReason: null,
    });
  });

  it("adds one independently identified completed set", () => {
    const id = ids();
    const exercise = draftExercisesForProgramDay(day, id)[0];
    const next = addCompletedDraftSet(exercise, id);

    expect(next.outcomes).toHaveLength(4);
    expect(next.outcomes[3].outcome).toBe("completed");
    expect(next.outcomes[3].occurrenceId).not.toBe(
      next.outcomes[2].occurrenceId,
    );
  });

  it("keeps the planned slot while changing only the performed exercise", () => {
    const id = ids();
    const planned = draftExercisesForProgramDay(day, id)[0];
    const performed: ExerciseDiscoveryItem = {
      id: "30000000-0000-4000-8000-000000000099",
      name: "Overhead Cable Triceps Extension",
      family: "Triceps Extension",
      movementPattern: "isolation_arms",
      primaryMuscles: ["triceps"],
      secondaryMuscles: [],
      equipment: ["cable"],
      loadType: "external",
      metricType: "weight_reps",
      loadSemantics: "total",
      variantAttributes: {},
      cautionBodyParts: [],
      available: true,
      unavailableReason: null,
    };

    const completed = changeDraftOutcome(planned.outcomes[0], "completed", id);
    if (completed.outcome !== "completed") {
      throw new Error("Expected completed retrospective outcome.");
    }
    completed.weight = "45";
    completed.reps = "12";
    const substituted = selectPerformedDraftExercise(
      {
        ...planned,
        outcomes: [completed, ...planned.outcomes.slice(1)],
      },
      { ...performed, metricType: "reps" },
    );
    expect(substituted).toMatchObject({
      exerciseId: performed.id,
      name: performed.name,
      sourceTemplateExerciseId: day.slots[0].id,
      plannedExerciseId: day.slots[0].exercise.id,
      plannedExerciseName: day.slots[0].exercise.name,
      plannedSetCount: 3,
      substitutionReason: null,
    });
    expect(substituted.outcomes[0]).toMatchObject({
      outcome: "completed",
      weight: "",
      reps: "12",
    });
  });

  it("restores only the exact owner and date draft", () => {
    const draft = initializeRetrospectiveDraft({
      ownerId: "owner-a",
      localDate: "2026-07-23",
      timezone: "America/Toronto",
      id: ids(),
    });
    const raw = JSON.stringify(draft);

    expect(
      parseRetrospectiveDraft(raw, {
        ownerId: "owner-a",
        localDate: "2026-07-23",
      }),
    ).toEqual(draft);
    expect(
      parseRetrospectiveDraft(raw, {
        ownerId: "owner-b",
        localDate: "2026-07-23",
      }),
    ).toBeNull();
    expect(retrospectiveDraftKey("owner-a", "2026-07-23")).not.toBe(
      retrospectiveDraftKey("owner-a", "2026-07-22"),
    );
    expect(retrospectiveLegacyDraftKey("owner-a", "2026-07-23")).not.toBe(
      retrospectiveDraftKey("owner-a", "2026-07-23"),
    );
  });

  it("recovers a v1 skipped draft without reclassifying its legacy reason", () => {
    const id = ids();
    const draft = initializeRetrospectiveDraft({
      ownerId: "owner-a",
      localDate: "2026-07-23",
      timezone: "America/Toronto",
      id,
    });
    const [exercise] = draftExercisesForProgramDay(day, id);
    const legacy = {
      ...draft,
      version: 1,
      exercises: [{
        ...exercise,
        outcomes: [{
          occurrenceId: exercise.outcomes[0].occurrenceId,
          outcome: "skipped",
          skipReason: "time",
          note: "Old browser draft",
        }],
      }],
    };

    expect(parseRetrospectiveDraft(JSON.stringify(legacy), {
      ownerId: "owner-a",
      localDate: "2026-07-23",
    })).toMatchObject({
      version: 2,
      exercises: [{
        outcomes: [{
          outcome: "skipped",
          skipReason: null,
          legacySkipReason: "time",
          note: "Old browser draft",
        }],
      }],
    });
  });
});
