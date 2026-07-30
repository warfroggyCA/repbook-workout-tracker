import { describe, expect, it } from "vitest";
import {
  prepareProgramDocumentForEditing,
  type LegacyProgramDocument,
} from "@/lib/program-document";
import {
  describeProgramReviewChange,
  formatProgramReviewValue,
  replaceProgramExercise,
  resizeProgramSlotSets,
  updateProgramDayWarmupOverview,
} from "@/lib/program-editor-client";
import { reviewProgramDocuments } from "@/services/program-documents";

const ids = {
  program: "10000000-0000-4000-8000-000000000001",
  version: "10000000-0000-4000-8000-000000000002",
  day: "10000000-0000-4000-8000-000000000003",
  slot: "10000000-0000-4000-8000-000000000004",
  exercise: "10000000-0000-4000-8000-000000000005",
  replacementSlot: "10000000-0000-4000-8000-000000000006",
  replacementExercise: "10000000-0000-4000-8000-000000000007",
  rowSlot: "10000000-0000-4000-8000-000000000008",
  rowExercise: "10000000-0000-4000-8000-000000000009",
  replacementDay: "10000000-0000-4000-8000-000000000010",
  fourthSlot: "10000000-0000-4000-8000-000000000011",
  fourthExercise: "10000000-0000-4000-8000-000000000012",
  firstGroup: "10000000-0000-4000-8000-000000000013",
  secondGroup: "10000000-0000-4000-8000-000000000014",
};

function legacyProgram(): LegacyProgramDocument {
  return {
    schemaVersion: "1",
    programId: ids.program,
    baseVersionId: ids.version,
    name: "Synthetic Program",
    days: [{
      lineageId: ids.day,
      name: "Day One",
      notes: null,
      warmupNotes: "Five minutes easy",
      supersets: [],
      exercises: [{
        lineageId: ids.slot,
        exerciseId: ids.exercise,
        sets: 3,
        repMin: 8,
        repMax: 10,
        targetLoad: 20,
        targetLoadUnit: "lb",
        progressionRuleId: "double_progression",
        restSec: 90,
        supersetKey: null,
        notes: null,
        warmupNotes: "Shoulder circles",
        warmupSets: [],
        setNotes: [null, null, null],
      }],
    }],
  };
}

const exerciseContext = {
  exercises: {
    [ids.exercise]: { name: "Synthetic Press", primaryMuscles: ["chest"] },
    [ids.replacementExercise]: {
      name: "Synthetic Row",
      primaryMuscles: ["back"],
    },
    [ids.rowExercise]: {
      name: "Synthetic Carry",
      primaryMuscles: ["back"],
    },
    [ids.fourthExercise]: {
      name: "Synthetic Curl",
      primaryMuscles: ["arms"],
    },
  },
};

describe("Program review trust contract", () => {
  it("separates an older-Program update from one deliberate warm-up edit", () => {
    const base = legacyProgram();
    const editingBaseline = prepareProgramDocumentForEditing(
      base,
      () => "Synthetic Press",
    );
    const next = {
      ...editingBaseline,
      days: editingBaseline.days.map((day) =>
        updateProgramDayWarmupOverview(
          day,
          "Two minutes easy\nShoulder circles\nTwo ramp-up sets",
        ),
      ),
    };

    const review = reviewProgramDocuments(base, next, 2, {
      ...exerciseContext,
      editingBaseline,
    });

    expect(review.status).toBe("publishable");
    expect(review.changes).toEqual([
      expect.objectContaining({
        kind: "warmup",
        label: "Day One warm-up",
      }),
    ]);
    expect(review.programUpdates.length).toBeGreaterThan(0);
    expect(review.summary).toMatchObject({
      weeklySetsBefore: 3,
      weeklySetsAfter: 3,
    });
    expect(next.days[0].warmupItems).toEqual([
      expect.objectContaining({ key: ids.day, label: "Two minutes easy" }),
      expect.objectContaining({ label: "Shoulder circles" }),
      expect.objectContaining({ label: "Two ramp-up sets" }),
    ]);
  });

  it("reviews a structured warm-up-only edit instead of calling it identical", () => {
    const base = prepareProgramDocumentForEditing(
      legacyProgram(),
      () => "Synthetic Press",
    );
    const next = structuredClone(base);
    next.days[0].warmupItems[0].label = "Two minutes easy";

    const review = reviewProgramDocuments(base, next, 3, exerciseContext);

    expect(review.status).toBe("publishable");
    expect(review.changes).toEqual([
      expect.objectContaining({ kind: "warmup" }),
    ]);
    expect(review.cautions).not.toContain(
      "This draft is identical to the active version.",
    );
  });

  it("accounts for the set change inside an exercise replacement", () => {
    const base = prepareProgramDocumentForEditing(
      legacyProgram(),
      () => "Synthetic Press",
    );
    const next = structuredClone(base);
    const replacement = resizeProgramSlotSets(
      replaceProgramExercise(
        next.days[0].exercises[0],
        ids.replacementExercise,
        ids.replacementSlot,
      ),
      4,
    );
    next.days[0].exercises[0] = replacement;
    next.days[0].intent.identity.anchorSlotLineageIds = [
      ids.replacementSlot,
    ];

    const review = reviewProgramDocuments(base, next, 4, exerciseContext);
    const targetChange = review.changes.find(
      (change) => change.kind === "targets",
    );

    expect(review.status).toBe("publishable");
    expect(review.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "replace" }),
        expect.objectContaining({ kind: "targets" }),
      ]),
    );
    expect(review.summary).toMatchObject({
      weeklySetsBefore: 3,
      weeklySetsAfter: 4,
    });
    expect(targetChange && describeProgramReviewChange(targetChange)).toContain(
      "3 → 4 work sets",
    );
  });

  it("fully reviews a replacement that is also moved", () => {
    const legacy = legacyProgram();
    legacy.days[0].exercises.push({
      ...legacy.days[0].exercises[0],
      lineageId: ids.rowSlot,
      exerciseId: ids.rowExercise,
      sets: 2,
      setNotes: [null, null],
    });
    const base = prepareProgramDocumentForEditing(
      legacy,
      (exerciseId) => exerciseContext.exercises[exerciseId]?.name ?? "Exercise",
    );
    const next = structuredClone(base);
    const replacement = resizeProgramSlotSets(
      replaceProgramExercise(
        next.days[0].exercises[0],
        ids.replacementExercise,
        ids.replacementSlot,
      ),
      4,
    );
    replacement.repMin = 5;
    replacement.repMax = 6;
    replacement.restSec = 180;
    replacement.notes = "Move smoothly";
    replacement.intent = {
      ...replacement.intent,
      priority: "must",
      minimumDose: { unit: "sets", value: 2 },
      idealDose: { unit: "sets", value: 4 },
    };
    next.days[0].exercises = [next.days[0].exercises[1], replacement];
    next.days[0].intent.identity.anchorSlotLineageIds = [
      ids.replacementSlot,
    ];

    const review = reviewProgramDocuments(base, next, 5, exerciseContext);

    expect(review.status).toBe("publishable");
    expect(review.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "replace",
          path: `slots.${ids.slot}.exerciseId`,
        }),
        expect.objectContaining({
          kind: "reorder",
          path: `slots.${ids.slot}.order`,
        }),
        expect.objectContaining({
          kind: "targets",
          path: `slots.${ids.slot}.targets`,
        }),
        expect.objectContaining({
          kind: "details",
          path: `slots.${ids.slot}.details`,
        }),
        expect.objectContaining({
          kind: "intent",
          path: `slots.${ids.slot}.intent`,
        }),
      ]),
    );
    expect(review.summary).toMatchObject({
      weeklySetsBefore: 5,
      weeklySetsAfter: 6,
    });
  });

  it("keeps every new-day prescription available in a full replacement review", () => {
    const base = prepareProgramDocumentForEditing(
      legacyProgram(),
      () => "Synthetic Press",
    );
    const next = structuredClone(base);
    const replacement = resizeProgramSlotSets(
      replaceProgramExercise(
        next.days[0].exercises[0],
        ids.replacementExercise,
        ids.replacementSlot,
      ),
      5,
    );
    replacement.repMin = 5;
    replacement.repMax = 6;
    replacement.targetLoad = 40;
    replacement.targetLoadUnit = "kg";
    replacement.progressionRuleId = "hold";
    replacement.restSec = 180;
    replacement.notes = "Synthetic replacement note";
    replacement.intent = {
      ...replacement.intent,
      priority: "must",
      minimumDose: { unit: "sets", value: 3 },
      idealDose: { unit: "sets", value: 5 },
    };
    next.name = "Synthetic Replacement";
    next.days = [{
      ...next.days[0],
      lineageId: ids.replacementDay,
      name: "New Day",
      warmupNotes: "Two minutes easy",
      warmupItems: [{
        key: ids.replacementDay,
        label: "Two minutes easy",
        reps: null,
        load: null,
        loadUnit: null,
        loadPercent: null,
        loadText: null,
        notes: null,
      }],
      exercises: [replacement],
      intent: {
        ...next.days[0].intent,
        primaryOutcome: "hypertrophy",
        identity: {
          ...next.days[0].intent.identity,
          anchorSlotLineageIds: [ids.replacementSlot],
        },
      },
    }];

    const review = reviewProgramDocuments(base, next, 6, exerciseContext);
    const addedDay = review.changes.find(
      (change) => change.path === `days.${ids.replacementDay}`,
    );

    expect(review.status).toBe("publishable");
    expect(addedDay).toMatchObject({
      kind: "add",
      after: {
        warmup: {
          overview: "Two minutes easy",
          steps: [expect.objectContaining({ label: "Two minutes easy" })],
        },
        advancedSessionOptions: expect.objectContaining({
          primaryOutcome: "hypertrophy",
        }),
        exercises: [expect.objectContaining({
          exercise: "Synthetic Row",
          targets: {
            sets: 5,
            repMin: 5,
            repMax: 6,
            targetLoad: 40,
            targetLoadUnit: "kg",
            progressionRuleId: "hold",
          },
          details: expect.objectContaining({
            restSec: 180,
            notes: "Synthetic replacement note",
          }),
          advancedSessionOptions: expect.objectContaining({
            priority: "must",
            minimumDose: { unit: "sets", value: 3 },
            idealDose: { unit: "sets", value: 5 },
          }),
        })],
      },
    });
  });

  it("names the before and after exercise group without exposing its key", () => {
    const base = prepareProgramDocumentForEditing(
      legacyProgram(),
      () => "Synthetic Press",
    );
    const source = base.days[0].exercises[0];
    base.days[0].supersets = [
      {
        key: ids.firstGroup,
        name: "Pair One",
        structureStatus: "canonical",
        plannedRounds: 3,
        restBetweenMembersSec: 0,
        restBetweenRoundsSec: 90,
        restAfterRoundSec: 90,
      },
      {
        key: ids.secondGroup,
        name: "Pair Two",
        structureStatus: "canonical",
        plannedRounds: 3,
        restBetweenMembersSec: 0,
        restBetweenRoundsSec: 90,
        restAfterRoundSec: 90,
      },
    ];
    base.days[0].exercises = [
      {
        ...source,
        supersetKey: ids.firstGroup,
        groupMemberOrderIdx: 0,
      },
      {
        ...source,
        lineageId: ids.rowSlot,
        exerciseId: ids.rowExercise,
        supersetKey: ids.firstGroup,
        groupMemberOrderIdx: 1,
      },
      {
        ...source,
        lineageId: ids.replacementSlot,
        exerciseId: ids.replacementExercise,
        supersetKey: ids.secondGroup,
        groupMemberOrderIdx: 0,
      },
      {
        ...source,
        lineageId: ids.fourthSlot,
        exerciseId: ids.fourthExercise,
        supersetKey: ids.secondGroup,
        groupMemberOrderIdx: 1,
      },
    ];
    const next = structuredClone(base);
    next.days[0].exercises[0].supersetKey = ids.secondGroup;
    next.days[0].exercises[2].supersetKey = ids.firstGroup;

    const review = reviewProgramDocuments(base, next, 7, exerciseContext);
    const pressDetails = review.changes.find(
      (change) => change.path === `slots.${ids.slot}.details`,
    );
    const rowDetails = review.changes.find(
      (change) => change.path === `slots.${ids.replacementSlot}.details`,
    );

    expect(review.status).toBe("publishable");
    expect(formatProgramReviewValue(pressDetails?.before)).toContain("Pair One");
    expect(formatProgramReviewValue(pressDetails?.after)).toContain("Pair Two");
    expect(formatProgramReviewValue(rowDetails?.before)).toContain("Pair Two");
    expect(formatProgramReviewValue(rowDetails?.after)).toContain("Pair One");
    expect(formatProgramReviewValue(pressDetails?.before)).toContain(
      "position inside the group: 1",
    );
    expect(formatProgramReviewValue(pressDetails?.before)).not.toContain(
      "position inside the group: 0",
    );
    expect(formatProgramReviewValue(pressDetails?.before)).not.toContain(
      ids.firstGroup,
    );
    expect(formatProgramReviewValue(pressDetails?.after)).not.toContain(
      ids.secondGroup,
    );
  });

  it("does not call automatic preparation a deliberate change", () => {
    const base = legacyProgram();
    const editingBaseline = prepareProgramDocumentForEditing(
      base,
      () => "Synthetic Press",
    );
    const review = reviewProgramDocuments(base, editingBaseline, 1, {
      ...exerciseContext,
      editingBaseline,
    });

    expect(review.status).toBe("publishable");
    expect(review.changes).toEqual([]);
    expect(review.programUpdates.length).toBeGreaterThan(0);
  });
});
