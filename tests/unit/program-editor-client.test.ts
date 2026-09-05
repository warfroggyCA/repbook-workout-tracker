import { describe, expect, it } from "vitest";
import {
  applyProgramDayOptions,
  EMPTY_PROGRAM_TIME,
  parseProgramTimeInput,
  placeProgramSlotUnit,
  addSupersetGroup,
  addProgramExerciseToDay,
  appendProgramDocumentDay,
  canCreateSuperset,
  createDefaultProgramSlot,
  formatProgramReviewValue,
  isLocallyRecoverableProgramDocument,
  localProgramDraftKey,
  moveItem,
  moveProgramGroupMember,
  moveProgramSlotUnit,
  moveProgramSlotToDay,
  normalizeDaySupersets,
  parseLocalProgramDraft,
  parseProgramDraftResponse,
  parseProgramHistory,
  parseProgramReviewResponse,
  programDocumentFromRoutineDraft,
  programEditorResponseJson,
  programEditorSafeFilePart,
  removeProgramSlotFromDay,
  replaceProgramExercise,
  resizeProgramSlotSets,
  resizeSetNotes,
  setWarmupLoadPercent,
  setWarmupLoadText,
  setWarmupNumericLoad,
  updateProgramDayWarmupOverview,
  updateProgramDocumentDay,
  updateProgramSlotInDay,
} from "@/lib/program-editor-client";
import {
  createSuggestedDayIntent,
  programDocumentV3Schema,
  projectIntentProgramDocumentV2,
  type ProgramDocumentV3,
} from "@/lib/program-document";

const IDs = {
  program: "00000000-0000-4000-8000-000000000001",
  version: "00000000-0000-4000-8000-000000000002",
  day: "00000000-0000-4000-8000-000000000003",
  slotA: "00000000-0000-4000-8000-000000000004",
  slotB: "00000000-0000-4000-8000-000000000005",
  exerciseA: "00000000-0000-4000-8000-000000000006",
  exerciseB: "00000000-0000-4000-8000-000000000007",
  group: "00000000-0000-4000-8000-000000000008",
  owner: "00000000-0000-4000-8000-000000000009",
  draft: "00000000-0000-4000-8000-000000000010",
  slotC: "00000000-0000-4000-8000-000000000011",
  exerciseC: "00000000-0000-4000-8000-000000000012",
};

function document(): ProgramDocumentV3 {
  const first = {
    ...createDefaultProgramSlot(IDs.exerciseA, IDs.slotA),
    supersetKey: IDs.group,
    groupMemberOrderIdx: 0,
  };
  const second = {
    ...createDefaultProgramSlot(IDs.exerciseB, IDs.slotB),
    supersetKey: IDs.group,
    groupMemberOrderIdx: 1,
  };
  return {
    schemaVersion: "3",
    programId: IDs.program,
    baseVersionId: IDs.version,
    name: "Editor test",
    days: [
      {
        lineageId: IDs.day,
        name: "Day A",
        notes: null,
        warmupNotes: null,
        warmupItems: [],
        intent: createSuggestedDayIntent([first, second]),
        supersets: [{
          key: IDs.group,
          name: "Pair",
          structureStatus: "canonical",
          plannedRounds: 3,
          restBetweenMembersSec: 0,
          restBetweenRoundsSec: 90,
          restAfterRoundSec: 90,
        }],
        exercises: [first, second],
      },
    ],
  };
}

describe("Program editor client rules", () => {
  it("reorders without mutating the source and keeps set cues aligned", () => {
    const source = ["a", "b", "c"];
    expect(moveItem(source, 2, 0)).toEqual(["c", "a", "b"]);
    expect(source).toEqual(["a", "b", "c"]);
    expect(resizeSetNotes(["first", null], 4)).toEqual([
      "first",
      null,
      null,
      null,
    ]);
    expect(resizeSetNotes(["first", "second"], 1)).toEqual(["first"]);
  });

  it("moves a superset as one unit when an exercise is reordered", () => {
    const grouped = document().days[0].exercises;
    const standalone = createDefaultProgramSlot(IDs.exerciseC, IDs.slotC);
    const source = [...grouped, standalone];

    const movedDown = moveProgramSlotUnit(source, grouped[0].lineageId, 1);
    expect(movedDown.map((slot) => slot.lineageId)).toEqual([
      standalone.lineageId,
      grouped[0].lineageId,
      grouped[1].lineageId,
    ]);
    expect(source.map((slot) => slot.lineageId)).toEqual([
      grouped[0].lineageId,
      grouped[1].lineageId,
      standalone.lineageId,
    ]);

    const restored = moveProgramSlotUnit(
      movedDown,
      grouped[1].lineageId,
      -1,
    );
    expect(restored.map((slot) => slot.lineageId)).toEqual(
      source.map((slot) => slot.lineageId),
    );
  });

  it("resets lineage and superset membership on explicit replacement", () => {
    const original = document().days[0].exercises[0];
    const replaced = replaceProgramExercise(
      original,
      IDs.exerciseB,
      "00000000-0000-4000-8000-000000000011",
    );

    expect(replaced).toMatchObject({
      exerciseId: IDs.exerciseB,
      lineageId: "00000000-0000-4000-8000-000000000011",
      supersetKey: null,
      sets: original.sets,
      repMin: original.repMin,
      repMax: original.repMax,
    });
    expect(original).toMatchObject({
      exerciseId: IDs.exerciseA,
      lineageId: IDs.slotA,
    });
  });

  it("turns a Coach routine into a valid replacement draft", () => {
    let nextId = 20;
    const rebuilt = programDocumentFromRoutineDraft(
      document(),
      {
        days: [{
          name: "Full body",
          notes: "Target 45 minutes. Keep 1–2 RIR.",
          warmupNotes: null,
          exercises: [IDs.exerciseA, IDs.exerciseB].map((exerciseId) => ({
            exerciseId,
            name: "Exercise",
            sets: 3,
            repMin: 6,
            repMax: 10,
            targetLoad: null,
            targetLoadUnit: null,
            restSec: 120,
            supersetGroup: "A",
            notes: null,
            warmup: null,
            setNotes: [],
          })),
        }],
      },
      () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    );

    expect(rebuilt.programId).toBe(IDs.program);
    expect(rebuilt.baseVersionId).toBe(IDs.version);
    expect(rebuilt.days[0].notes).toBe("Target 45 minutes. Keep 1–2 RIR.");
    expect(rebuilt.days[0].supersets).toHaveLength(1);
    expect(rebuilt.days[0].exercises[0].supersetKey).toBe(
      rebuilt.days[0].supersets[0].key,
    );
    expect(rebuilt.days[0].exercises[1].supersetKey).toBe(
      rebuilt.days[0].supersets[0].key,
    );
    expect(rebuilt.days[0].exercises[0].setNotes).toEqual([null, null, null]);
    expect(isLocallyRecoverableProgramDocument(rebuilt)).toBe(true);
  });

  it("dissolves an undersized superset instead of leaving an orphan reference", () => {
    const day = document().days[0];
    const normalized = normalizeDaySupersets({
      ...day,
      exercises: [day.exercises[0], { ...day.exercises[1], supersetKey: null }],
    });

    expect(normalized.supersets).toEqual([]);
    expect(normalized.exercises.map((slot) => slot.supersetKey)).toEqual([
      null,
      null,
    ]);
  });

  it("removes a Program slot with its anchored warm-up and repairs day identity", () => {
    const day = document().days[0];
    const withAnchors = {
      ...day,
      warmupItems: [{
        key: "00000000-0000-4000-8000-000000000013",
        beforeSlotLineageId: IDs.slotA,
        label: "Empty bar",
        reps: 8,
        load: null,
        loadUnit: null,
        loadPercent: null,
        loadText: "empty bar",
        notes: null,
      }],
      intent: {
        ...day.intent,
        identity: {
          ...day.intent.identity,
          kind: "anchor_slots" as const,
          anchorSlotLineageIds: [IDs.slotA],
        },
      },
    };

    const removed = removeProgramSlotFromDay(withAnchors, IDs.slotA);

    expect(removed.exercises.map((slot) => slot.lineageId)).toEqual([
      IDs.slotB,
    ]);
    expect(removed.warmupItems).toEqual([]);
    expect(removed.intent.identity.anchorSlotLineageIds).toEqual([IDs.slotB]);
    expect(() => programDocumentV3Schema.parse({
      ...document(),
      days: [removed],
    })).not.toThrow();
  });

  it("preserves round rest when removing one member dissolves a two-exercise group", () => {
    const day = document().days[0];
    const withDistinctRest = {
      ...day,
      supersets: day.supersets.map((group) => ({
        ...group,
        restBetweenRoundsSec: 75,
        restAfterRoundSec: 75,
      })),
      exercises: day.exercises.map((slot) => ({ ...slot, restSec: 0 })),
    };

    const removed = removeProgramSlotFromDay(withDistinctRest, IDs.slotB);

    expect(removed.supersets).toEqual([]);
    expect(removed.exercises[0]).toMatchObject({
      lineageId: IDs.slotA,
      supersetKey: null,
      groupMemberOrderIdx: null,
      restSec: 75,
    });
  });

  it("keeps a three-exercise group and reindexes its remaining members", () => {
    const day = document().days[0];
    const third = {
      ...createDefaultProgramSlot(IDs.exerciseC, IDs.slotC),
      supersetKey: IDs.group,
      groupMemberOrderIdx: 2,
    };

    const removed = removeProgramSlotFromDay(
      { ...day, exercises: [...day.exercises, third] },
      IDs.slotB,
    );

    expect(removed.supersets).toHaveLength(1);
    expect(removed.exercises.map((slot) => ({
      lineageId: slot.lineageId,
      order: slot.groupMemberOrderIdx,
    }))).toEqual([
      { lineageId: IDs.slotA, order: 0 },
      { lineageId: IDs.slotC, order: 1 },
    ]);
  });

  it("refuses to remove the only exercise from a Program day", () => {
    const day = document().days[0];
    const only = normalizeDaySupersets({
      ...day,
      exercises: [{
        ...day.exercises[0],
        supersetKey: null,
        groupMemberOrderIdx: null,
      }],
    });

    expect(removeProgramSlotFromDay(only, IDs.slotA)).toBe(only);
  });

  it("creates supersets only from two ungrouped exercises", () => {
    const grouped = document().days[0];
    expect(canCreateSuperset(grouped)).toBe(false);
    expect(
      addSupersetGroup(grouped, {
        key: "00000000-0000-4000-8000-000000000013",
        name: "New pair",
        structureStatus: "canonical",
        plannedRounds: 3,
        restBetweenMembersSec: 0,
        restBetweenRoundsSec: 60,
        restAfterRoundSec: 60,
      }),
    ).toBe(grouped);

    const ungrouped = {
      ...grouped,
      supersets: [],
      exercises: grouped.exercises.map((slot) => ({
        ...slot,
        supersetKey: null,
      })),
    };
    const created = addSupersetGroup(ungrouped, {
      key: "00000000-0000-4000-8000-000000000013",
      name: "New pair",
      structureStatus: "canonical",
      plannedRounds: 4,
      restBetweenMembersSec: 0,
      restBetweenRoundsSec: 60,
      restAfterRoundSec: 60,
    });
    expect(canCreateSuperset(ungrouped)).toBe(true);
    expect(created.supersets).toHaveLength(1);
    expect(created.exercises.map((slot) => slot.supersetKey)).toEqual([
      "00000000-0000-4000-8000-000000000013",
      "00000000-0000-4000-8000-000000000013",
    ]);
    expect(created.exercises.map((slot) => ({
      sets: slot.sets,
      minimum: slot.intent.minimumDose.value,
      ideal: slot.intent.idealDose.value,
    }))).toEqual([
      { sets: 4, minimum: 1, ideal: 4 },
      { sets: 4, minimum: 1, ideal: 4 },
    ]);
    expect(() => programDocumentV3Schema.parse({ ...document(), days: [created] })).not.toThrow();
  });

  it("keeps canonical group rounds and member order aligned while editing", () => {
    const grouped = document().days[0];
    const reordered = normalizeDaySupersets({
      ...grouped,
      exercises: [grouped.exercises[1], grouped.exercises[0]],
    });
    expect(reordered.supersets[0]).toMatchObject({
      structureStatus: "canonical",
      plannedRounds: 3,
      restBetweenRoundsSec: 90,
      restAfterRoundSec: 90,
    });
    expect(reordered.exercises.map((slot) => slot.groupMemberOrderIdx)).toEqual([0, 1]);

    const moved = moveProgramGroupMember(
      reordered,
      IDs.group,
      reordered.exercises[1].lineageId,
      -1,
    );
    expect(moved.exercises.map((slot) => slot.lineageId)).toEqual([
      reordered.exercises[1].lineageId,
      reordered.exercises[0].lineageId,
    ]);
    expect(moved.exercises.map((slot) => slot.groupMemberOrderIdx)).toEqual([0, 1]);
  });

  it("changes only the selected member of an older unequal group", () => {
    const source = document().days[0];
    const unequal = normalizeDaySupersets({
      ...source,
      exercises: [
        source.exercises[0],
        resizeProgramSlotSets(source.exercises[1], 4),
      ],
    });
    expect(unequal.supersets[0]).toMatchObject({
      structureStatus: "legacy_unequal",
      plannedRounds: null,
    });
    const unchangedMember = structuredClone(unequal.exercises[1]);
    const editedMember = resizeProgramSlotSets(unequal.exercises[0], 2);
    const updated = normalizeDaySupersets(
      updateProgramSlotInDay(unequal, 0, editedMember),
    );

    expect(updated.exercises.map((slot) => slot.sets)).toEqual([2, 4]);
    expect(updated.exercises[1]).toEqual(unchangedMember);
    expect(updated.supersets[0]).toMatchObject({
      structureStatus: "legacy_unequal",
      plannedRounds: null,
    });
  });

  it("keeps warm-up load modes mutually exclusive", () => {
    const warmup = {
      label: "Primer",
      reps: 8,
      load: 20,
      loadUnit: "lb" as const,
      loadPercent: 25,
      loadText: "Empty bar",
      notes: null,
    };
    expect(setWarmupNumericLoad(warmup, 30)).toMatchObject({
      load: 30,
      loadUnit: "lb",
      loadPercent: null,
      loadText: null,
    });
    expect(setWarmupLoadPercent(warmup, 40)).toMatchObject({
      load: null,
      loadUnit: null,
      loadPercent: 40,
      loadText: null,
    });
    expect(setWarmupLoadText(warmup, "Light band")).toMatchObject({
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: "Light band",
    });
  });

  it("syncs only an untouched generated warm-up step with its overview", () => {
    const day = document().days[0];
    const generated = {
      ...day,
      warmupNotes: "Five minutes easy",
      warmupItems: [{
        key: day.lineageId,
        label: "Five minutes easy",
        reps: null,
        load: null,
        loadUnit: null,
        loadPercent: null,
        loadText: null,
        notes: null,
      }],
    };
    expect(
      updateProgramDayWarmupOverview(generated, "Two minutes easy"),
    ).toMatchObject({
      warmupNotes: "Two minutes easy",
      warmupItems: [{ label: "Two minutes easy" }],
    });

    const authored = {
      ...generated,
      warmupItems: [{
        ...generated.warmupItems[0],
        label: "Shoulder circles",
      }],
    };
    expect(
      updateProgramDayWarmupOverview(authored, "Two minutes easy"),
    ).toMatchObject({
      warmupNotes: "Two minutes easy",
      warmupItems: [{ label: "Shoulder circles" }],
    });
  });

  it("accepts only bounded, owner-and-draft-scoped valid local recovery data", () => {
    const recovery = {
      schemaVersion: "3",
      ownerId: IDs.owner,
      draftId: IDs.draft,
      serverRevision: 7,
      mutationId: "00000000-0000-4000-8000-000000000012",
      document: document(),
      savedAt: "2026-07-14T12:00:00.000Z",
    };
    expect(parseLocalProgramDraft(JSON.stringify(recovery))).toEqual(recovery);
    expect(localProgramDraftKey(IDs.owner, IDs.draft)).toContain(
      `${IDs.owner}:${IDs.draft}`,
    );
    expect(
      parseLocalProgramDraft(
        JSON.stringify({ ...recovery, serverRevision: -1.5 }),
      ),
    ).toBeNull();
    expect(
      parseLocalProgramDraft(
        JSON.stringify({ ...recovery, serverRevision: -1 }),
      ),
    ).toBeNull();
    expect(parseLocalProgramDraft("{".repeat(750_001))).toBeNull();
  });

  it("upgrades an older local recovery copy to writable v3", () => {
    const older = {
      schemaVersion: "2",
      ownerId: IDs.owner,
      draftId: IDs.draft,
      serverRevision: 7,
      mutationId: "00000000-0000-4000-8000-000000000012",
      document: projectIntentProgramDocumentV2(document()),
      savedAt: "2026-07-14T12:00:00.000Z",
    };
    const recovered = parseLocalProgramDraft(JSON.stringify(older));
    expect(recovered?.schemaVersion).toBe("3");
    expect(recovered?.document.schemaVersion).toBe("3");
    expect(recovered?.document.days[0].supersets[0]).toMatchObject({
      structureStatus: "canonical",
      plannedRounds: 3,
    });
  });

  it("recovers ordinary invalid edits but rejects malformed identities and shape", () => {
    const invalidInProgress = document();
    invalidInProgress.name = "x".repeat(500);
    invalidInProgress.days[0].exercises[0].targetLoad = -25;
    invalidInProgress.days[0].exercises[0].targetLoadUnit = null;
    invalidInProgress.days[0].exercises[0].warmupSets = [
      {
        label: "",
        reps: 4.5,
        load: -10,
        loadUnit: null,
        loadPercent: 700,
        loadText: "x".repeat(500),
        notes: "x".repeat(700),
      },
    ];
    expect(isLocallyRecoverableProgramDocument(invalidInProgress)).toBe(true);

    expect(
      isLocallyRecoverableProgramDocument({
        ...document(),
        programId: "not-a-program-id",
      }),
    ).toBe(false);
    expect(
      isLocallyRecoverableProgramDocument({
        ...document(),
        days: [{ ...document().days[0], exercises: "not-an-array" }],
      }),
    ).toBe(false);
  });

  it("strictly parses review and history evidence", () => {
    const review = {
      status: "publishable" as const,
      hash: "a".repeat(64),
      reviewedRevision: 2,
      changes: [
        {
          kind: "targets",
          path: "slots.one",
          label: "Targets",
          before: { sets: 3 },
          after: { sets: 4 },
        },
      ],
      programUpdates: [],
      blockingErrors: [],
      cautions: [],
      preflight: null,
      recommendationRevision: 1,
      recommendationConsequences: [],
      summary: {
        weeklySetsBefore: 3,
        weeklySetsAfter: 4,
        durationBefore: [],
        durationAfter: [],
        muscleSetsBefore: { chest: 3 },
        muscleSetsAfter: { chest: 4 },
      },
    };
    expect(parseProgramReviewResponse({ status: "reviewed", review })).toEqual(
      review,
    );
    expect(() =>
      parseProgramReviewResponse({ ...review, summary: {} }),
    ).toThrow("incomplete");
    expect(
      parseProgramReviewResponse({
        ...review,
        status: "blocked",
        hash: null,
        blockingErrors: ["Exercise equipment is unavailable."],
      }),
    ).toMatchObject({
      status: "blocked",
      hash: null,
      blockingErrors: ["Exercise equipment is unavailable."],
    });
    expect(() =>
      parseProgramReviewResponse({
        ...review,
        status: "blocked",
        hash: null,
        blockingErrors: [],
      }),
    ).toThrow("incomplete");
    expect(() =>
      parseProgramReviewResponse({
        ...review,
        hash: null,
      }),
    ).toThrow("incomplete");

    const history = [
      {
        id: IDs.version,
        versionNo: 1,
        name: "Editor test",
        activatedAt: "2026-07-14T12:00:00.000Z",
        source: "setup",
        summary: null,
        parentVersionId: null,
        restoredFromVersionId: null,
        sourceImportEventId: null,
        reviewHash: null,
        isCurrent: true,
      },
    ];
    expect(parseProgramHistory(history)).toEqual(history);
    expect(() =>
      parseProgramHistory([{ ...history[0], versionNo: 0 }]),
    ).toThrow("incomplete");
  });

  it("formats structured review details without raw JSON or object placeholders", () => {
    const formatted = formatProgramReviewValue({
      sets: 4,
      progressionRuleId: "hold",
      restSec: 90,
      warmupSets: [{ label: "Primer", reps: 8, loadText: "Light band" }],
    });
    expect(formatted).toContain("work sets: 4");
    expect(formatted).toContain("how weight should increase: Keep these targets");
    expect(formatted).toContain("1 min 30 sec");
    expect(formatted).not.toContain("[object Object]");
    expect(formatted).not.toContain('{"');
  });

  it("parses the durable draft transport boundary", () => {
    expect(
      parseProgramDraftResponse({
        status: "ok",
        draft: {
          id: IDs.draft,
          revision: 3,
          document: document(),
          reviewedRevision: null,
          reviewSummary: null,
          history: [],
        },
      }),
    ).toMatchObject({ id: IDs.draft, revision: 3, document: document() });
    expect(() =>
      parseProgramDraftResponse({ status: "ok", draft: { revision: 3 } }),
    ).toThrow("not valid");
  });

  it("loads an intact draft while expiring a pre-Phase-2 review projection", () => {
    // Exact historical review shape from 42c58bd^: it predates Preflight and
    // used estimated-minute totals instead of duration ranges.
    const oldReview = {
      hash: "c".repeat(64),
      reviewedRevision: 3,
      changes: [{
        kind: "rename",
        path: "name",
        label: "Program name",
        before: "Original",
        after: "Owner-authored draft",
      }],
      blockingErrors: [],
      cautions: [],
      recommendationRevision: 0,
      recommendationConsequences: [],
      summary: {
        weeklySetsBefore: 6,
        weeklySetsAfter: 7,
        estimatedMinutesBefore: 45,
        estimatedMinutesAfter: 50,
        muscleSetsBefore: { chest: 6 },
        muscleSetsAfter: { chest: 7 },
      },
    };
    const history = [{
      id: IDs.version,
      versionNo: 1,
      name: "Original",
      activatedAt: "2026-07-14T12:00:00.000Z",
      source: "setup",
      summary: null,
      parentVersionId: null,
      restoredFromVersionId: null,
      sourceImportEventId: null,
      reviewHash: null,
      isCurrent: true,
    }];
    const response = {
      status: "ok",
      draft: {
        id: IDs.draft,
        revision: 3,
        document: { ...document(), name: "Owner-authored draft" },
        reviewedRevision: 3,
        reviewHash: oldReview.hash,
        reviewSummary: oldReview,
        history,
      },
    };

    const first = parseProgramDraftResponse(response);
    const retry = parseProgramDraftResponse(response);
    expect(first).toMatchObject({
      id: IDs.draft,
      revision: 3,
      document: { name: "Owner-authored draft" },
      reviewSummary: null,
      reviewedRevision: null,
      reviewHash: null,
      reviewState: { status: "expired" },
      history,
    });
    expect(retry).toEqual(first);
  });

  it("separates malformed derived review evidence from an invalid source draft", () => {
    const recovered = parseProgramDraftResponse({
      status: "ok",
      draft: {
        id: IDs.draft,
        revision: 3,
        document: document(),
        reviewedRevision: 3,
        reviewHash: "d".repeat(64),
        reviewSummary: { malformed: true },
        history: [],
      },
    });
    expect(recovered.document).toEqual(document());
    expect(recovered.reviewState.status).toBe("expired");
    expect(recovered.reviewSummary).toBeNull();

    expect(() =>
      parseProgramDraftResponse({
        status: "ok",
        draft: {
          id: IDs.draft,
          revision: 3,
          document: { ...document(), days: "not-a-draft" },
          reviewedRevision: null,
          reviewHash: null,
          reviewSummary: null,
          history: [],
        },
      }),
    ).toThrow("saved Program draft is not valid");
  });

  it("keeps server failure copy at the shared response boundary", async () => {
    await expect(
      programEditorResponseJson(
        new Response(JSON.stringify({ reason: "Retry this save." }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("Retry this save.");
  });

  it("keeps document editing rules pure and stable-id based", () => {
    const source = document();
    const renamed = updateProgramDocumentDay(source, 0, (day) => ({
      ...day,
      name: "Renamed",
    }));
    expect(renamed.days[0].name).toBe("Renamed");
    expect(source.days[0].name).toBe("Day A");

    const addedSlotId = "00000000-0000-4000-8000-000000000011";
    const withExercise = addProgramExerciseToDay(
      source,
      0,
      IDs.exerciseA,
      addedSlotId,
    );
    expect(withExercise.days[0].exercises.at(-1)?.lineageId).toBe(addedSlotId);

    const dayId = "00000000-0000-4000-8000-000000000012";
    const slotId = "00000000-0000-4000-8000-000000000013";
    const withDay = appendProgramDocumentDay(
      source,
      IDs.exerciseA,
      dayId,
      slotId,
    );
    expect(withDay.days[1]).toMatchObject({ lineageId: dayId, name: "Day 2" });
    const moved = moveProgramSlotToDay(withDay, 0, 0, 1);
    expect(moved.days[1].exercises.at(-1)).toMatchObject({
      lineageId: IDs.slotA,
      supersetKey: null,
    });
    expect(source.days[0].exercises).toHaveLength(2);
    expect(programEditorSafeFilePart(" My Program: V2 ")).toBe("my-program-v2");
  });
});


describe("session-option editing and exact drop destinations", () => {
  it("recovers empty and invalid time edits without accepting or rewriting them", () => {
    for (const input of ["", "2", "601", "25.5"]) {
      const draft = document();
      draft.days[0].intent.targetDuration.minMinutes = parseProgramTimeInput(input);
      const original = structuredClone(draft);
      expect(programDocumentV3Schema.safeParse(draft).success).toBe(false);
      expect(isLocallyRecoverableProgramDocument(draft)).toBe(true);
      expect(draft).toEqual(original);
      const recovered = parseLocalProgramDraft(JSON.stringify({ schemaVersion: "3", ownerId: IDs.owner, draftId: IDs.draft, serverRevision: 1, mutationId: IDs.slotA, savedAt: "2026-01-01T00:00:00Z", document: draft }));
      expect(recovered?.document).toEqual(draft);
    }
    expect(parseProgramTimeInput("")).toBe(EMPTY_PROGRAM_TIME);
    expect(parseProgramTimeInput("50")).toBe(50);
  });

  it("copies options once while keeping destination identities and contents", () => {
    const draft = document();
    const day = draft.days[0];
    const target = structuredClone(day);
    target.lineageId = IDs.slotC;
    target.exercises = [createDefaultProgramSlot(IDs.exerciseC, IDs.slotC)];
    target.supersets = [];
    target.intent = createSuggestedDayIntent(target.exercises);
    target.intent.identity.anchorSlotLineageIds = [IDs.slotC];
    day.intent.identity.anchorSlotLineageIds = [IDs.slotA];
    day.intent.targetDuration = { minMinutes: 40, maxMinutes: 80 };
    draft.days.push(target);
    const result = applyProgramDayOptions(draft, day.lineageId);
    expect(programDocumentV3Schema.safeParse(result).success).toBe(true);
    expect(result.days[1].intent.targetDuration).toEqual({ minMinutes: 40, maxMinutes: 80 });
    expect(result.days[1].intent.identity.anchorSlotLineageIds).toEqual([IDs.slotC]);
    expect(result.days[1].exercises).toEqual(target.exercises);
    expect(result.days[1].warmupItems).toEqual(target.warmupItems);
    result.days[0].intent.targetDuration.minMinutes = 45;
    expect(result.days[1].intent.targetDuration.minMinutes).toBe(40);
    expect(applyProgramDayOptions(draft, "missing")).toBe(draft);
  });

  it.each(["movement_balance", "muscle_emphasis", "skill_practice", "conditioning_focus", "recovery_session"] as const)(
    "keeps %s and anchor-based day definitions valid when copying in either direction",
    (kind) => {
      const draft = appendProgramDocumentDay(document(), IDs.exerciseC, IDs.slotC, IDs.exerciseC);
      draft.days[0].intent.identity = { kind: "anchor_slots", anchorSlotLineageIds: [IDs.slotA] };
      draft.days[1].intent.identity = { kind, anchorSlotLineageIds: [] };
      draft.days[0].intent.targetDuration = { minMinutes: 40, maxMinutes: 80 };
      const original = structuredClone(draft);
      expect(programDocumentV3Schema.safeParse(draft).success).toBe(true);
      for (const source of draft.days) {
        const result = applyProgramDayOptions(draft, source.lineageId);
        expect(programDocumentV3Schema.safeParse(result).success).toBe(true);
        for (const [index, day] of result.days.entries()) {
          expect(day.intent.identity).toEqual(original.days[index].intent.identity);
          expect(day.intent.targetDuration).toEqual(source.intent.targetDuration);
          expect(day.exercises).toEqual(original.days[index].exercises);
        }
        const destination = result.days.find((day) => day.lineageId !== source.lineageId)!;
        destination.intent.identity.anchorSlotLineageIds.push(IDs.group);
        expect(draft).toEqual(original);
      }
    },
  );

  it("places a standalone slot before a non-contiguous group without changing its warm-up or members", () => {
    const draft = document();
    const day = draft.days[0];
    const standalone = createDefaultProgramSlot(IDs.exerciseC, IDs.slotC);
    const [a, b] = day.exercises;
    day.exercises = [a, standalone, b];
    day.warmupItems = [{ key: IDs.exerciseC, beforeSlotLineageId: IDs.slotC, label: "Practice", reps: 5, load: null, loadUnit: null, loadPercent: null, loadText: null, notes: null }];
    const result = { ...day, exercises: placeProgramSlotUnit(day.exercises, standalone.lineageId, a.lineageId, "before") };
    expect(result.exercises).toEqual([standalone, a, b]);
    expect(result.supersets).toEqual(day.supersets);
    expect(result.warmupItems[0].beforeSlotLineageId).toBe(standalone.lineageId);
    expect(placeProgramSlotUnit(result.exercises, standalone.lineageId, b.lineageId, "after")).toEqual([a, b, standalone]);
    expect(placeProgramSlotUnit(day.exercises, a.lineageId, b.lineageId, "before")).toBe(day.exercises);
    expect(day.exercises).toEqual([a, standalone, b]);
  });
});
