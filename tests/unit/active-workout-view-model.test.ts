import { describe, expect, it } from "vitest";
import type {
  LoggedSet,
  SessionEquipmentSetup,
  SessionExerciseData,
  SessionExerciseGroupData,
  SessionOccurrenceData,
} from "@/components/session/types";
import { projectActiveWorkoutViewModel } from "@/lib/active-workout-view-model";
import { projectSessionGuidance } from "@/lib/session-guidance";

function loggedSet(
  id: string,
  patch: Partial<LoggedSet> = {},
): LoggedSet {
  return {
    id,
    clientKey: null,
    setNo: 1,
    weight: 100,
    weightUnit: "lb",
    reps: 8,
    rpe: null,
    note: null,
    ...patch,
  };
}

function exercise(
  id: string,
  patch: Partial<SessionExerciseData> = {},
): SessionExerciseData {
  return {
    id,
    exerciseId: `library-${id}`,
    name: `Exercise ${id}`,
    family: null,
    loadType: "barbell",
    loadSemantics: "total",
    metricType: "weight_reps",
    movementPattern: "push",
    orderIdx: 0,
    supersetKey: null,
    restSec: 90,
    modificationType: "as_planned",
    skipReason: null,
    substitutedForExerciseId: null,
    substitutionReason: null,
    substitutedAt: null,
    plannedExerciseName: null,
    targetSets: 2,
    targetRepsMin: 8,
    targetRepsMax: 10,
    targetLoad: 100,
    targetLoadUnit: "lb",
    notes: null,
    warmupNotes: null,
    warmupSets: [],
    setNotes: [],
    cautionBodyParts: [],
    media: null,
    sets: [],
    last: null,
    ...patch,
  };
}

function occurrence(
  id: string,
  sessionExerciseId: string | null,
  sequenceIdx: number,
  patch: Partial<SessionOccurrenceData> = {},
): SessionOccurrenceData {
  return {
    id,
    sessionExerciseId,
    kind: "working_set",
    origin: "planned",
    sequenceIdx,
    kindOrdinal: sequenceIdx,
    label: null,
    plannedExerciseId: sessionExerciseId
      ? `planned-${sessionExerciseId}`
      : null,
    plannedNote: null,
    plannedRepsMin: 8,
    plannedRepsMax: 10,
    plannedLoad: 100,
    plannedLoadUnit: "lb",
    plannedLoadPercent: null,
    plannedLoadText: null,
    plannedRestSec: 90,
    groupSnapshotId: null,
    groupRound: null,
    groupMemberOrderIdx: null,
    outcome: "pending",
    outcomeReason: null,
    outcomeNote: null,
    revision: 0,
    resolvedAt: null,
    completedSetId: null,
    ...patch,
  };
}

function equipmentSetup(
  source: SessionExerciseData,
  label: string,
): SessionEquipmentSetup {
  return {
    sourceExerciseId: source.exerciseId,
    sourceTargetLoad: source.targetLoad,
    sourceTargetLoadUnit: source.targetLoadUnit,
    exact: true,
    status: "available",
    selectionRequired: false,
    currentSnapshotId: `snapshot-${source.id}`,
    currentEquipmentLabel: label,
    currentAttachmentLabel: null,
    currentGuidance: `Use ${label}.`,
    currentGuidanceByLoadEntryMeaning: {},
    currentSelectionAvailable: true,
    loadEntryMeaning: "total_system",
    loadEntryMeaningChoices: [],
    options: [],
  };
}

function exactComparable(sessionExerciseId: string) {
  return {
    status: "available" as const,
    currentSessionExerciseId: sessionExerciseId,
    exerciseId: `library-${sessionExerciseId}`,
    semantics: {
      version: 1 as const,
      metricType: "weight_reps" as const,
      loadType: "barbell",
      loadSemantics: "total" as const,
      loadEntryMeaning: "total_system" as const,
    },
    source: {
      workoutId: "prior-workout",
      localDate: "2026-08-20",
      startedAtISO: "2026-08-20T10:00:00.000Z",
      finishedAtISO: "2026-08-20T11:00:00.000Z",
      historyHref: "/history/prior-workout",
      workoutSource: "repbook",
    },
    sets: [{
      setId: "prior-set",
      setNo: 1,
      weight: 95,
      weightUnit: "lb" as const,
      reps: 9,
      distanceKm: null,
      durationSeconds: null,
      rpe: 8,
      rir: 2,
      observedCompletedAtISO: "2026-08-20T10:20:00.000Z",
      observedCompletionProvenance: "live_client" as const,
      observedCompletionQuality: "trustworthy" as const,
      correctionProvenance: { state: "original" as const, count: 0 },
    }],
  };
}

const noGroups: SessionExerciseGroupData[] = [];

describe("ActiveWorkoutViewModel", () => {
  it("projects the exact active set, target, safe defaults, comparable evidence, and ledger queue order", () => {
    const press = exercise("press", {
      name: "Barbell Press",
      orderIdx: 5,
      previousComparable: exactComparable("press"),
      setNotes: ["Brace before pressing"],
    });
    const row = exercise("row", {
      name: "Cable Row",
      orderIdx: 0,
      modificationType: "added",
      plannedExerciseName: "Chest-Supported Row",
    });
    const occurrences = [
      occurrence("press-warmup", press.id, -1, {
        kind: "exercise_warmup",
        kindOrdinal: 0,
        label: "Empty bar",
        outcome: "completed",
      }),
      occurrence("press-one", press.id, 0, { kindOrdinal: 0 }),
      occurrence("row-one", row.id, 1, {
        kindOrdinal: 0,
        origin: "ad_hoc",
      }),
    ];
    const guidance = projectSessionGuidance({
      exercises: [row, press],
      exerciseGroups: noGroups,
      equipmentSetups: {
        [press.id]: equipmentSetup(press, "Rack 1"),
        [row.id]: equipmentSetup(row, "Cable stack"),
      },
      occurrences,
    });

    const model = projectActiveWorkoutViewModel({
      guidance,
      exercises: [row, press],
      occurrences,
      unit: "lb",
      loadEntryMeaningByExerciseId: {
        [press.id]: "total_system",
        [row.id]: "total_system",
      },
      comparisonUnavailableByExerciseId: {
        [press.id]: false,
        [row.id]: false,
      },
      currentActionBlockingReason: "Complete the exact preparation first.",
    });

    expect(model.displayMode).toBe("action");
    expect(model.currentAction).toMatchObject({
      occurrenceId: "press-one",
      sessionExerciseId: press.id,
      exerciseName: "Barbell Press",
      setLabel: "Set 1",
      target: {
        setNumber: 1,
        repsMin: 8,
        repsMax: 10,
        load: 100,
        loadUnit: "lb",
      },
      inputDefaults: {
        metricType: "weight_reps",
        load: {
          status: "available",
          weight: 100,
          unit: "lb",
          source: "Program target",
        },
        reps: 10,
        note: "Brace before pressing",
      },
      blockingReason: "Complete the exact preparation first.",
    });
    expect(model.previousComparable).toMatchObject({
      state: "available",
      sessionExerciseId: press.id,
      set: { setId: "prior-set", setNo: 1, reps: 9 },
      source: { workoutId: "prior-workout" },
      reason: null,
    });
    expect(model.queue.map((item) => item.sessionExerciseId)).toEqual([
      press.id,
      row.id,
    ]);
    expect(model.queue[0]).toMatchObject({
      order: 1,
      isCurrent: true,
      warmups: { total: 1, completed: 1, pending: 0, skipped: 0 },
    });
    expect(model.queue[1]).toMatchObject({
      order: 2,
      modification: "added",
      plannedExerciseName: "Chest-Supported Row",
    });
    expect(model.equipmentAttention).toEqual([
      expect.objectContaining({
        placement: "upcoming",
        sessionExerciseId: row.id,
      }),
    ]);
  });

  it("lets stored rest replace the active set while preserving its exact source and destination", () => {
    const squat = exercise("squat", {
      name: "Back Squat",
      sets: [loggedSet("saved-one", { occurrenceId: "squat-one" })],
    });
    const occurrences = [
      occurrence("squat-one", squat.id, 0, {
        kindOrdinal: 0,
        outcome: "completed",
        completedSetId: "saved-one",
      }),
      occurrence("squat-two", squat.id, 1, { kindOrdinal: 1 }),
    ];
    const restTimer = {
      version: 1 as const,
      generationId: "rest-one",
      revision: 0,
      ownerId: "owner",
      sessionId: "session",
      startedAt: 100_000,
      sourceSessionExerciseId: squat.id,
      sourceOccurrenceId: "squat-one",
      sourceClientKey: null,
      sourceCompletedSetId: "saved-one",
      phase: "running" as const,
      endsAt: 190_000,
      totalSec: 90,
      readyAt: null,
      completionContext: null,
      completionCueOutcome: null,
      attemptedMilestones: [],
    };
    const guidance = projectSessionGuidance({
      exercises: [squat],
      exerciseGroups: noGroups,
      equipmentSetups: {
        [squat.id]: equipmentSetup(squat, "Rack 1"),
      },
      occurrences,
      restTimer,
    });

    const model = projectActiveWorkoutViewModel({
      guidance,
      exercises: [squat],
      occurrences,
      unit: "lb",
      loadEntryMeaningByExerciseId: { [squat.id]: "total_system" },
      restRemainingSeconds: 42,
    });

    expect(model.displayMode).toBe("rest");
    expect(model.rest).toEqual({
      phase: "running",
      remainingSeconds: 42,
      totalSeconds: 90,
      destinationLabel: "Back Squat, set 2",
    });
    expect(model.currentAction).toMatchObject({
      occurrenceId: "squat-one",
      sessionExerciseId: squat.id,
      target: null,
      inputDefaults: null,
    });
    expect(model.queue[0]).toMatchObject({
      isCurrent: false,
      isNext: true,
    });
  });

  it("keeps every occurrence outcome and modification explicit in the compact queue", () => {
    const mixed = exercise("mixed", {
      targetSets: 4,
      modificationType: "substituted",
      plannedExerciseName: "Planned Press",
      sets: [
        loggedSet("extra-result", {
          setNo: 5,
          occurrenceId: "mixed-extra",
        }),
      ],
    });
    const occurrences = [
      occurrence("warmup-complete", mixed.id, -2, {
        kind: "exercise_warmup",
        kindOrdinal: 0,
        outcome: "completed",
      }),
      occurrence("warmup-skipped", mixed.id, -1, {
        kind: "exercise_warmup",
        kindOrdinal: 1,
        outcome: "skipped",
      }),
      occurrence("mixed-skipped", mixed.id, 0, {
        kindOrdinal: 0,
        outcome: "skipped",
      }),
      occurrence("mixed-abandoned", mixed.id, 1, {
        kindOrdinal: 1,
        outcome: "abandoned",
      }),
      occurrence("mixed-legacy", mixed.id, 2, {
        kindOrdinal: 2,
        origin: "legacy",
        outcome: "legacy_unrecorded",
      }),
      occurrence("mixed-no-result", mixed.id, 3, {
        kindOrdinal: 3,
        outcome: "completed",
      }),
      occurrence("mixed-extra", mixed.id, 4, {
        kindOrdinal: 4,
        origin: "ad_hoc",
        plannedNote: "Added during this workout",
        outcome: "completed",
        completedSetId: "extra-result",
      }),
    ];
    const guidance = projectSessionGuidance({
      exercises: [mixed],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences,
    });
    const model = projectActiveWorkoutViewModel({
      guidance,
      exercises: [mixed],
      occurrences,
      unit: "lb",
    });

    expect(model.displayMode).toBe("finish");
    expect(model.queue[0]).toMatchObject({
      planned: 3,
      total: 5,
      extra: 1,
      performed: 1,
      extraPerformed: 1,
      skipped: 1,
      abandoned: 1,
      legacyUnknown: 1,
      completedWithoutResult: 1,
      modification: "substituted",
      plannedExerciseName: "Planned Press",
      warmups: { total: 2, completed: 1, skipped: 1, pending: 0 },
    });
    expect(model.completion).toMatchObject({
      ready: true,
      blocked: false,
      pendingActions: 0,
      evidenceLimited: true,
    });
  });

  it("reports exact comparison unavailability and actionable recovery without inventing evidence", () => {
    const press = exercise("press", {
      targetSets: 3,
      previousComparable: exactComparable("press"),
      sets: [
        loggedSet("failed-one", {
          occurrenceId: "press-one",
          clientKey: "client-one",
          saveState: "failed",
        }),
        loggedSet("failed-two", {
          setNo: 2,
          occurrenceId: "press-two",
          clientKey: "client-two",
          saveState: "failed",
        }),
      ],
    });
    const occurrences = [
      occurrence("press-one", press.id, 0, { kindOrdinal: 0 }),
      occurrence("press-two", press.id, 1, { kindOrdinal: 1 }),
      occurrence("press-three", press.id, 2, { kindOrdinal: 2 }),
    ];
    const guidance = projectSessionGuidance({
      exercises: [press],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences,
    });
    const model = projectActiveWorkoutViewModel({
      guidance,
      exercises: [press],
      occurrences,
      unit: "lb",
      loadEntryMeaningByExerciseId: { [press.id]: "per_loading_point" },
      finishBlocked: true,
      completionBlocker: "Retry or discard retained workout actions.",
      unreadableRecordedWork: true,
      occurrenceQueueError: true,
      unresolvedExerciseSkip: true,
    });

    expect(model.previousComparable).toMatchObject({
      state: "unavailable",
      set: null,
      source: null,
      reason: "incompatible_load_entry_meaning",
    });
    expect(model.saveState).toMatchObject({
      state: "failed",
      occurrenceId: "press-one",
      sessionExerciseId: press.id,
    });
    expect(model.recovery).toEqual([
      expect.objectContaining({ kind: "failed_set", count: 2 }),
      expect.objectContaining({ kind: "unreadable_recorded_work" }),
      expect.objectContaining({ kind: "occurrence_queue_error" }),
      expect.objectContaining({ kind: "unresolved_exercise_skip" }),
    ]);
    expect(model.currentAction?.blockingReason).toBe(
      "Resolve the exercise skip before continuing.",
    );
    expect(model.completion).toMatchObject({
      ready: false,
      blocked: true,
      blocker: "Retry or discard retained workout actions.",
    });

    const loading = projectActiveWorkoutViewModel({
      guidance,
      exercises: [press],
      occurrences,
      unit: "lb",
      comparisonUnavailableByExerciseId: { [press.id]: true },
    });
    expect(loading.previousComparable).toMatchObject({
      state: "temporarily_unavailable",
      reason: "comparison_loading",
    });
  });

  it("suppresses safe equipment but exposes a precise equipment choice or limitation", () => {
    const press = exercise("press");
    const occurrences = [occurrence("press-one", press.id, 0, {
      kindOrdinal: 0,
    })];
    const safeGuidance = projectSessionGuidance({
      exercises: [press],
      exerciseGroups: noGroups,
      equipmentSetups: {
        [press.id]: equipmentSetup(press, "Rack 1"),
      },
      occurrences,
    });
    const attentionGuidance = projectSessionGuidance({
      exercises: [press],
      exerciseGroups: noGroups,
      equipmentSetups: {
        [press.id]: {
          ...equipmentSetup(press, "Rack 1"),
          currentSnapshotId: null,
          selectionRequired: true,
          options: [
            {
              key: "rack-1",
              equipmentItemId: "rack-1",
              equipmentLabel: "Rack 1",
              attachmentItemId: null,
              attachmentLabel: null,
              guidance: null,
            },
            {
              key: "rack-2",
              equipmentItemId: "rack-2",
              equipmentLabel: "Rack 2",
              attachmentItemId: null,
              attachmentLabel: null,
              guidance: null,
            },
          ],
        },
      },
      occurrences,
    });

    const safe = projectActiveWorkoutViewModel({
      guidance: safeGuidance,
      exercises: [press],
      occurrences,
      unit: "lb",
    });
    const attention = projectActiveWorkoutViewModel({
      guidance: attentionGuidance,
      exercises: [press],
      occurrences,
      unit: "lb",
    });

    expect(safe.equipmentAttention).toEqual([]);
    expect(attention.equipmentAttention).toEqual([
      expect.objectContaining({
        placement: "current",
        sessionExerciseId: press.id,
        cue: expect.objectContaining({ status: "choice_required" }),
      }),
    ]);
  });

  it("projects every durable set-save state and keeps the exact current occurrence ahead of unrelated failures", () => {
    const press = exercise("press", { targetSets: 2 });
    const occurrences = [
      occurrence("press-one", press.id, 0, { kindOrdinal: 0 }),
      occurrence("press-two", press.id, 1, { kindOrdinal: 1 }),
    ];
    const guidance = projectSessionGuidance({
      exercises: [press],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences,
    });
    const stateCases = [
      ["pending", "retained_locally"],
      ["saving", "saving"],
      ["retrying", "retrying"],
      ["failed", "failed"],
      ["saved", "acknowledged"],
    ] as const;

    for (const [saveState, expected] of stateCases) {
      const withState = {
        ...press,
        sets: [loggedSet(`set-${saveState}`, {
          clientKey: `client-${saveState}`,
          occurrenceId: "press-one",
          saveState,
        })],
      };
      const model = projectActiveWorkoutViewModel({
        guidance,
        exercises: [withState],
        occurrences,
        unit: "lb",
      });
      expect(model.saveState, saveState).toMatchObject({
        state: expected,
        occurrenceId: "press-one",
        sessionExerciseId: press.id,
      });
    }

    const currentSavingWithEarlierFailure = {
      ...press,
      sets: [
        loggedSet("failed-elsewhere", {
          clientKey: "failed-client",
          occurrenceId: "press-two",
          setNo: 2,
          saveState: "failed",
        }),
        loggedSet("saving-current", {
          clientKey: "saving-client",
          occurrenceId: "press-one",
          saveState: "saving",
        }),
      ],
    };
    const currentFirst = projectActiveWorkoutViewModel({
      guidance,
      exercises: [currentSavingWithEarlierFailure],
      occurrences,
      unit: "lb",
    });
    expect(currentFirst.saveState).toMatchObject({
      state: "saving",
      occurrenceId: "press-one",
    });
    expect(currentFirst.recovery[0]).toMatchObject({
      kind: "failed_set",
      count: 1,
    });

    const noCurrentMatch = projectActiveWorkoutViewModel({
      guidance,
      exercises: [{
        ...press,
        sets: [
          loggedSet("saved-other", {
            occurrenceId: "resolved-saved",
            saveState: "saved",
          }),
          loggedSet("retrying-other", {
            occurrenceId: "resolved-retrying",
            setNo: 2,
            saveState: "retrying",
          }),
          loggedSet("failed-other", {
            occurrenceId: "resolved-failed",
            setNo: 3,
            saveState: "failed",
          }),
        ],
      }],
      occurrences,
      unit: "lb",
    });
    expect(noCurrentMatch.saveState).toMatchObject({
      state: "failed",
      occurrenceId: "resolved-failed",
    });
  });

  it("retains superset identity and immutable ledger order in queue summaries", () => {
    const press = exercise("press", {
      name: "Superset Press",
      orderIdx: 5,
      supersetKey: "A",
    });
    const row = exercise("row", {
      name: "Superset Row",
      orderIdx: 0,
      supersetKey: "A",
    });
    const group: SessionExerciseGroupData = {
      id: "group-a",
      name: "Upper pairing",
      plannedRounds: 1,
      memberCount: 2,
      orderIdx: 0,
    };
    const occurrences = [
      occurrence("press-one", press.id, 0, {
        kindOrdinal: 0,
        groupSnapshotId: group.id,
        groupRound: 0,
        groupMemberOrderIdx: 0,
      }),
      occurrence("row-one", row.id, 1, {
        kindOrdinal: 0,
        groupSnapshotId: group.id,
        groupRound: 0,
        groupMemberOrderIdx: 1,
      }),
    ];
    const guidance = projectSessionGuidance({
      exercises: [row, press],
      exerciseGroups: [group],
      equipmentSetups: {},
      occurrences,
    });
    const model = projectActiveWorkoutViewModel({
      guidance,
      exercises: [row, press],
      occurrences,
      unit: "lb",
    });

    expect(model.queue.map((item) => item.sessionExerciseId)).toEqual([
      press.id,
      row.id,
    ]);
    expect(model.queue).toEqual([
      expect.objectContaining({
        group: { id: group.id, name: "Upper pairing" },
        isCurrent: true,
        isNext: false,
      }),
      expect.objectContaining({
        group: { id: group.id, name: "Upper pairing" },
        isCurrent: false,
        isNext: true,
      }),
    ]);
  });
});
