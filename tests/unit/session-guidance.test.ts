import { describe, expect, it } from "vitest";
import type {
  LoggedSet,
  SessionEquipmentSetup,
  SessionExerciseData,
  SessionExerciseGroupData,
  SessionOccurrenceData,
} from "@/components/session/types";
import {
  projectEquipmentPreparationCue,
  projectSessionGuidance,
  sessionNonPerformedOutcomeParts,
} from "@/lib/session-guidance";

function set(
  id: string,
  patch: Partial<LoggedSet> = {},
): LoggedSet {
  return {
    id,
    clientKey: null,
    setNo: 1,
    weight: 95,
    weightUnit: "lb",
    reps: 7,
    rpe: 8,
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
    loadType: "dumbbell",
    loadSemantics: "per_implement",
    movementPattern: "pull",
    orderIdx: 0,
    supersetKey: null,
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
    plannedExerciseId: sessionExerciseId ? `planned-${sessionExerciseId}` : null,
    plannedNote: null,
    plannedRepsMin: 8,
    plannedRepsMax: 10,
    plannedLoad: 100,
    plannedLoadUnit: "lb",
    plannedLoadPercent: null,
    plannedLoadText: null,
    plannedRestSec: 60,
    groupSnapshotId: null,
    groupRound: null,
    groupMemberOrderIdx: null,
    outcome: "pending",
    outcomeReason: null,
    outcomeNote: null,
    revision: 0,
    resolvedAt: null,
    completedSetId: null,
    restAfterSec: 60,
    ...patch,
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
    currentSnapshotId: "snapshot-1",
    currentEquipmentLabel: "Selected equipment",
    currentAttachmentLabel: null,
    currentGuidance: "Recorded exact setup.",
    currentGuidanceByLoadEntryMeaning: {},
    currentSelectionAvailable: true,
    loadEntryMeaning: "total_system",
    loadEntryMeaningChoices: [],
    options: [],
    ...patch,
  };
}

const noGroups: SessionExerciseGroupData[] = [];

describe("GUIDE-02 session guidance truth", () => {
  it("counts only completed occurrences with a retained linked result as performed", () => {
    const item = exercise("one", {
      targetSets: 6,
      sets: [
        set("retained"),
        set("pending-device", { saveState: "pending", setNo: 6 }),
      ],
    });
    const projection = projectSessionGuidance({
      exercises: [item],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences: [
        occurrence("performed", item.id, 0, {
          outcome: "completed",
          completedSetId: "retained",
        }),
        occurrence("missing-result", item.id, 1, {
          outcome: "completed",
          completedSetId: "archived-or-missing",
        }),
        occurrence("skipped", item.id, 2, { outcome: "skipped" }),
        occurrence("abandoned", item.id, 3, { outcome: "abandoned" }),
        occurrence("legacy", item.id, 4, { outcome: "legacy_unrecorded" }),
        occurrence("pending", item.id, 5),
      ],
    });

    expect(projection.totals).toEqual({
      planned: 6,
      performed: 1,
      skipped: 1,
      abandoned: 1,
      pending: 1,
      legacyUnknown: 1,
      completedWithoutResult: 1,
      remainingAfterCurrent: 0,
    });
    expect(projection.actions.map((action) => action.truth)).toEqual([
      "performed",
      "completed_without_result",
      "skipped",
      "abandoned",
      "legacy_unknown",
      "pending",
    ]);
    expect(projection.exercises[0]).toMatchObject({
      planned: 6,
      performed: 1,
      skipped: 1,
      status: "current",
    });
    expect(sessionNonPerformedOutcomeParts(projection.totals)).toEqual([
      "1 skipped",
      "1 still pending",
      "1 abandoned",
      "1 legacy outcome unknown",
      "1 missing saved-result evidence",
    ]);
  });

  it("keeps the immutable plan separate from the actual substituted performance", () => {
    const item = exercise("actual", {
      exerciseId: "actual-exercise",
      name: "Dumbbell row",
      modificationType: "substituted",
      substitutedForExerciseId: "planned-exercise",
      plannedExerciseName: "Barbell row",
      sets: [set("actual-result", { weight: 80, reps: 7 })],
    });
    const projection = projectSessionGuidance({
      exercises: [item],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences: [occurrence("done", item.id, 0, {
        outcome: "completed",
        completedSetId: "actual-result",
        plannedExerciseId: "planned-exercise",
        plannedLoad: 100,
        plannedRepsMin: 8,
        plannedRepsMax: 10,
      })],
    });

    expect(projection.actions[0]).toMatchObject({
      actualExerciseId: "actual-exercise",
      actualExerciseName: "Dumbbell row",
      plannedExerciseId: "planned-exercise",
      plannedExerciseName: "Barbell row",
      planned: { load: 100, repsMin: 8, repsMax: 10 },
      performed: { exerciseId: "actual-exercise", load: 80, reps: 7 },
    });
  });

  it("keeps a durable added set current for its selected exercise before moving on", () => {
    const first = exercise("first", {
      targetSets: 4,
      sets: [
        set("first-1", { setNo: 1 }),
        set("first-2", { setNo: 2 }),
        set("first-3", { setNo: 3 }),
      ],
    });
    const second = exercise("second", { orderIdx: 1 });
    const projection = projectSessionGuidance({
      exercises: [first, second],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      selectedSessionExerciseId: first.id,
      occurrences: [
        occurrence("first-1-occurrence", first.id, 0, {
          kindOrdinal: 0,
          outcome: "completed",
          completedSetId: "first-1",
        }),
        occurrence("first-2-occurrence", first.id, 1, {
          kindOrdinal: 1,
          outcome: "completed",
          completedSetId: "first-2",
        }),
        occurrence("first-3-occurrence", first.id, 2, {
          kindOrdinal: 2,
          outcome: "completed",
          completedSetId: "first-3",
        }),
        occurrence("second-1-occurrence", second.id, 3, {
          kindOrdinal: 0,
        }),
        occurrence("first-added-occurrence", first.id, 99, {
          origin: "ad_hoc",
          kindOrdinal: 3,
          plannedNote: "Added during this workout",
        }),
      ],
    });

    expect(projection.current).toMatchObject({
      occurrenceId: "first-added-occurrence",
      sessionExerciseId: first.id,
      position: {
        kind: "extra",
        number: 1,
        label: "Extra set 1",
        lowercaseLabel: "extra set 1",
      },
      planned: { setNumber: 4 },
    });
    expect(projection.upNext).toMatchObject({
      occurrenceId: "second-1-occurrence",
      sessionExerciseId: second.id,
    });
  });

  it("labels initial workout-only ordinals as sets and only appended work as extras", () => {
    const added = exercise("workout-only", {
      modificationType: "added",
      targetSets: null,
    });
    const projection = projectSessionGuidance({
      exercises: [added],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences: [
        occurrence("initial-1", added.id, 0, {
          origin: "ad_hoc",
          kindOrdinal: 0,
        }),
        occurrence("initial-2", added.id, 1, {
          origin: "ad_hoc",
          kindOrdinal: 1,
        }),
        occurrence("extra-1", added.id, 2, {
          origin: "ad_hoc",
          kindOrdinal: 2,
          plannedNote: "Added during this workout",
        }),
        occurrence("extra-2", added.id, 3, {
          origin: "ad_hoc",
          kindOrdinal: 3,
          plannedNote: "Added during this workout",
        }),
      ],
    });

    expect(projection.actions.map((action) => action.position)).toEqual([
      {
        kind: "set",
        number: 1,
        label: "Set 1",
        lowercaseLabel: "set 1",
      },
      {
        kind: "set",
        number: 2,
        label: "Set 2",
        lowercaseLabel: "set 2",
      },
      {
        kind: "extra",
        number: 1,
        label: "Extra set 1",
        lowercaseLabel: "extra set 1",
      },
      {
        kind: "extra",
        number: 2,
        label: "Extra set 2",
        lowercaseLabel: "extra set 2",
      },
    ]);
    expect(projection.current?.position.label).toBe("Set 1");
    expect(projection.upNext?.position.label).toBe("Set 2");
  });

  it("projects tri-set round/member order and never calls a skipped round performed", () => {
    const members = [
      exercise("a", { name: "Press" }),
      exercise("b", { name: "Raise" }),
      exercise("c", { name: "Fly" }),
    ];
    const group: SessionExerciseGroupData = {
      id: "group",
      name: "Shoulders tri-set",
      plannedRounds: 2,
      memberCount: 3,
      orderIdx: 0,
    };
    members[0].sets = [set("a1")];
    const occurrences = members.flatMap((member, memberIndex) => [
      occurrence(`r1-${memberIndex}`, member.id, memberIndex, {
        kindOrdinal: 0,
        groupSnapshotId: group.id,
        groupRound: 1,
        groupMemberOrderIdx: memberIndex,
        ...(memberIndex === 0
          ? { outcome: "completed" as const, completedSetId: "a1" }
          : memberIndex === 1
            ? { outcome: "skipped" as const }
            : {}),
      }),
      occurrence(`r2-${memberIndex}`, member.id, 3 + memberIndex, {
        kindOrdinal: 1,
        groupSnapshotId: group.id,
        groupRound: 2,
        groupMemberOrderIdx: memberIndex,
      }),
    ]).sort((left, right) => left.sequenceIdx - right.sequenceIdx);
    const projection = projectSessionGuidance({
      exercises: members,
      exerciseGroups: [group],
      equipmentSetups: {},
      occurrences,
      selectedSessionExerciseId: members[0].id,
    });

    expect(projection.current).toMatchObject({
      actualExerciseName: "Fly",
      group: { name: "Shoulders tri-set", round: 1, member: 3, memberCount: 3 },
    });
    expect(projection.upNext).toMatchObject({
      actualExerciseName: "Press",
      group: { round: 2, member: 1, memberCount: 3 },
    });
    expect(projection.groups[0].rounds).toEqual([
      expect.objectContaining({ round: 1, performed: 1, skipped: 1, pending: 1, status: "in_progress" }),
      expect.objectContaining({ round: 2, performed: 0, skipped: 0, pending: 3, status: "not_started" }),
    ]);
    expect(projection.activeGroup).toMatchObject({
      name: "Shoulders tri-set",
      plannedRounds: 2,
      currentRound: 1,
      currentMemberOrder: 3,
      currentMemberName: "Fly",
      upNextMemberOrder: 1,
      upNextMemberName: "Press",
      restAfterCurrentSec: 60,
      hasLaterResolvedWork: false,
      members: [
        expect.objectContaining({ order: 1, exerciseName: "Press" }),
        expect.objectContaining({ order: 2, exerciseName: "Raise" }),
        expect.objectContaining({ order: 3, exerciseName: "Fly" }),
      ],
    });
  });

  it("describes unequal, partial, abandoned, substituted, and out-of-order group evidence without inventing round totals", () => {
    const first = exercise("unequal-a", {
      name: "Press",
      sets: [set("a-r1")],
    });
    const second = exercise("unequal-b", {
      exerciseId: "replacement-row",
      name: "Cable row",
      plannedExerciseName: "Dumbbell row",
      modificationType: "substituted",
      substitutedForExerciseId: "planned-row",
      sets: [set("b-r1")],
    });
    const group: SessionExerciseGroupData = {
      id: "unequal-group",
      name: "Upper pair",
      plannedRounds: null,
      memberCount: 2,
      orderIdx: 0,
    };
    const projection = projectSessionGuidance({
      exercises: [first, second],
      exerciseGroups: [group],
      equipmentSetups: {},
      occurrences: [
        occurrence("a-r1", first.id, 0, {
          kindOrdinal: 0,
          groupSnapshotId: group.id,
          groupRound: 1,
          groupMemberOrderIdx: 0,
          outcome: "completed",
          completedSetId: "a-r1",
        }),
        occurrence("b-r1", second.id, 1, {
          kindOrdinal: 0,
          plannedExerciseId: "planned-row",
          groupSnapshotId: group.id,
          groupRound: 1,
          groupMemberOrderIdx: 1,
          outcome: "completed",
          completedSetId: "b-r1",
        }),
        occurrence("a-r2", first.id, 2, {
          kindOrdinal: 1,
          groupSnapshotId: group.id,
          groupRound: 2,
          groupMemberOrderIdx: 0,
          outcome: "skipped",
        }),
        occurrence("b-r2", second.id, 3, {
          kindOrdinal: 1,
          plannedExerciseId: "planned-row",
          groupSnapshotId: group.id,
          groupRound: 2,
          groupMemberOrderIdx: 1,
        }),
        occurrence("a-r3", first.id, 4, {
          kindOrdinal: 2,
          groupSnapshotId: group.id,
          groupRound: 3,
          groupMemberOrderIdx: 0,
          outcome: "abandoned",
        }),
      ],
    });

    expect(projection.groups[0]).toMatchObject({
      plannedRounds: null,
      status: "in_progress",
      members: [
        expect.objectContaining({
          order: 1,
          exerciseName: "Press",
          status: "partial",
          totals: expect.objectContaining({
            planned: 3,
            performed: 1,
            skipped: 1,
            abandoned: 1,
          }),
        }),
        expect.objectContaining({
          order: 2,
          exerciseName: "Cable row",
          plannedExerciseName: "Dumbbell row",
          substituted: true,
          status: "in_progress",
        }),
      ],
      rounds: [
        expect.objectContaining({ round: 1, status: "performed" }),
        expect.objectContaining({ round: 2, status: "in_progress" }),
        expect.objectContaining({ round: 3, status: "abandoned" }),
      ],
    });
    expect(projection.activeGroup).toMatchObject({
      plannedRounds: null,
      currentRound: 2,
      currentMemberName: "Cable row",
      upNextMemberName: null,
      hasLaterResolvedWork: true,
    });
  });

  it("supports deliberate ungrouped selection while keeping the earliest other unresolved work next", () => {
    const first = exercise("first", { orderIdx: 0 });
    const second = exercise("second", { orderIdx: 1 });
    const third = exercise("third", { orderIdx: 2 });
    const projection = projectSessionGuidance({
      exercises: [first, second, third],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences: [
        occurrence("first-set", first.id, 0),
        occurrence("second-set", second.id, 1),
        occurrence("third-set", third.id, 2),
      ],
      selectedSessionExerciseId: second.id,
    });

    expect(projection.current?.sessionExerciseId).toBe(second.id);
    expect(projection.upNext?.sessionExerciseId).toBe(first.id);
    expect(projection.totals.remainingAfterCurrent).toBe(2);
  });

  it("tracks warm-ups separately from working-set progress", () => {
    const item = exercise("one");
    const projection = projectSessionGuidance({
      exercises: [item],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences: [
        occurrence("work", item.id, 2),
        occurrence("warm-complete", item.id, 0, { kind: "exercise_warmup", outcome: "completed" }),
        occurrence("warm-skip", null, 1, { kind: "day_warmup", outcome: "skipped" }),
      ],
    });
    expect(projection.warmups).toEqual({ planned: 2, completed: 1, skipped: 1, remaining: 0 });
    expect(projection.totals.planned).toBe(1);
  });
});

describe("GUIDE-03 upcoming equipment preparation", () => {
  it("shows the current one-set setup even when there is no later occurrence", () => {
    const ez = exercise("one-set-ez", {
      exerciseId: "ez-curl-definition",
      name: "EZ-Bar Curl",
      loadType: "ez_bar",
      loadSemantics: "total",
      targetSets: 1,
      targetLoad: 38,
      targetLoadUnit: "lb",
    });
    const projection = projectSessionGuidance({
      exercises: [ez],
      exerciseGroups: noGroups,
      equipmentSetups: {
        [ez.id]: setup(ez, {
          currentEquipmentLabel: "EZ curl bar (18 lb)",
          currentGuidance:
            "Per side: 10 lb · Empty bar and collars: 18 lb · Total: 38 lb",
        }),
      },
      occurrences: [occurrence("only", ez.id, 0)],
    });

    expect(projection.currentEquipment).toMatchObject({
      status: "selected",
      equipmentLabel: "EZ curl bar (18 lb)",
      guidance: expect.stringContaining("Per side: 10 lb"),
    });
    expect(projection.currentEquipment.guidance).toContain("18 lb");
    expect(projection.upcomingEquipment.status).toBe("none");
  });

  it("keeps a one-set current attachment visible without inventing geometry", () => {
    const cable = exercise("one-set-cable", {
      name: "Cable Pulldown",
      loadType: "cable",
      targetSets: 1,
    });
    const projection = projectSessionGuidance({
      exercises: [cable],
      exerciseGroups: noGroups,
      equipmentSetups: {
        [cable.id]: setup(cable, {
          currentEquipmentLabel: "Cable tower",
          currentAttachmentLabel: "Lat bar",
          currentGuidance:
            "Cable geometry is unknown. Record the displayed stack setting only; effective load is unknown.",
        }),
      },
      occurrences: [occurrence("only-cable", cable.id, 0)],
    });

    expect(projection.currentEquipment).toMatchObject({
      status: "selected",
      equipmentLabel: "Cable tower",
      attachmentLabel: "Lat bar",
      preciseClaimAllowed: false,
    });
  });

  it("reuses the selected exact 18 lb EZ setup and every owned-plate result", () => {
    const current = exercise("current");
    const ez = exercise("ez", {
      exerciseId: "ez-curl-definition",
      name: "EZ-Bar Curl",
      loadType: "ez_bar",
      loadSemantics: "total",
      targetLoad: 43,
      targetLoadUnit: "lb",
    });
    const ezSetup = setup(ez, {
      currentEquipmentLabel: "EZ curl bar (18 lb)",
      currentGuidance:
        "Per side: 10 + 2.5 lb · Empty bar and collars: 18 lb · Total: 43 lb",
    });
    const projection = projectSessionGuidance({
      exercises: [current, ez],
      exerciseGroups: noGroups,
      equipmentSetups: { [ez.id]: ezSetup },
      occurrences: [
        occurrence("current", current.id, 0),
        occurrence("ez-next", ez.id, 1),
      ],
    });

    expect(projection.upcomingEquipment).toMatchObject({
      status: "selected",
      exerciseName: "EZ-Bar Curl",
      equipmentLabel: "EZ curl bar (18 lb)",
      guidance: expect.stringContaining("10 + 2.5 lb"),
      preciseClaimAllowed: true,
    });
    expect(projection.upcomingEquipment.guidance).toContain("18 lb");
  });

  it("withholds precise loading while a unique setup is only pending confirmation", () => {
    const item = exercise("pending");
    const cue = projectEquipmentPreparationCue(
      {
        ...projectSessionGuidance({
          exercises: [item],
          exerciseGroups: noGroups,
          equipmentSetups: {},
          occurrences: [occurrence("pending", item.id, 0)],
        }).current!,
      },
      item,
      setup(item, {
        currentSnapshotId: null,
        currentEquipmentLabel: null,
        currentGuidance: null,
        options: [{
          key: "only",
          equipmentItemId: "bar",
          equipmentLabel: "Only reviewed bar",
          attachmentItemId: null,
          attachmentLabel: null,
          guidance: "Exact plates: 10 per side",
        }],
      }),
    );
    expect(cue).toMatchObject({
      status: "pending_confirmation",
      equipmentLabel: "Only reviewed bar",
      guidance: null,
      preciseClaimAllowed: false,
    });
  });

  it("makes ambiguous, unavailable, and broad-only states explicitly non-precise", () => {
    const item = exercise("item", { loadType: "dumbbell" });
    const action = projectSessionGuidance({
      exercises: [item],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences: [occurrence("item", item.id, 0)],
    }).current!;
    const option = {
      key: "one",
      equipmentItemId: "one",
      equipmentLabel: "One",
      attachmentItemId: null,
      attachmentLabel: null,
      guidance: "Exact setup",
    };
    expect(projectEquipmentPreparationCue(action, item, setup(item, {
      currentSnapshotId: null,
      currentEquipmentLabel: null,
      currentGuidance: null,
      selectionRequired: true,
      options: [option, { ...option, key: "two", equipmentItemId: "two", equipmentLabel: "Two" }],
    }))).toMatchObject({ status: "choice_required", guidance: null, preciseClaimAllowed: false });
    expect(projectEquipmentPreparationCue(action, item, setup(item, {
      status: "unavailable",
      currentSnapshotId: null,
    }))).toMatchObject({ status: "unavailable", guidance: null, preciseClaimAllowed: false });
    expect(projectEquipmentPreparationCue(action, item, setup(item, {
      currentSelectionAvailable: false,
      currentGuidance: "Old exact load: 25 lb per side",
    }))).toMatchObject({
      status: "unavailable",
      equipmentLabel: "Selected equipment",
      guidance: null,
      preciseClaimAllowed: false,
    });
    expect(projectEquipmentPreparationCue(action, item, null)).toMatchObject({
      status: "broad_only",
      equipmentLabel: "Dumbbells",
      guidance: null,
      preciseClaimAllowed: false,
    });
  });

  it("suppresses stale substitution and target guidance until the server projection matches", () => {
    const item = exercise("changed", {
      exerciseId: "new-exercise",
      targetLoad: 55,
      targetLoadUnit: "lb",
    });
    const action = projectSessionGuidance({
      exercises: [item],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences: [occurrence("changed", item.id, 0)],
    }).current!;
    const staleExercise = setup(item, {
      sourceExerciseId: "old-exercise",
      currentGuidance: "Old precise plates",
    });
    const staleTarget = setup(item, {
      sourceTargetLoad: 50,
      currentGuidance: "Old precise plates",
    });
    for (const stale of [staleExercise, staleTarget]) {
      expect(projectEquipmentPreparationCue(action, item, stale)).toMatchObject({
        status: "updating",
        equipmentLabel: null,
        guidance: null,
        preciseClaimAllowed: false,
      });
    }
  });

  it("preserves unknown geometry wording without authorizing a precise claim", () => {
    const item = exercise("cable", { loadType: "cable" });
    const action = projectSessionGuidance({
      exercises: [item],
      exerciseGroups: noGroups,
      equipmentSetups: {},
      occurrences: [occurrence("cable", item.id, 0)],
    }).current!;
    const cue = projectEquipmentPreparationCue(action, item, setup(item, {
      currentEquipmentLabel: "Cable tower",
      currentAttachmentLabel: "Lat bar",
      currentGuidance:
        "Cable geometry is unknown. Record the displayed stack setting only; effective load is unknown.",
    }));
    expect(cue).toMatchObject({
      status: "selected",
      equipmentLabel: "Cable tower",
      attachmentLabel: "Lat bar",
      preciseClaimAllowed: false,
    });
    expect(cue.guidance).toContain("effective load is unknown");
  });
});
