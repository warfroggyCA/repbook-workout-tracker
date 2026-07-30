import { describe, expect, it } from "vitest";
import type { RoutineDraft } from "@/app/actions/setup";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import { createSuggestedDayIntent, type ProgramDocument } from "@/lib/program-document";
import { createDefaultProgramSlot } from "@/lib/program-editor-client";
import { applyProgramUpdateChanges, buildProgramUpdateProposal } from "@/lib/program-update-reconciliation";

const ids = Array.from({ length: 30 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const library = [
  { id: ids[4], name: "Bench Press" },
  { id: ids[5], name: "Cable Fly" },
  { id: ids[6], name: "Row" },
  { id: ids[29], name: "Shoulder Press" },
] as ExerciseDiscoveryItem[];

function current(): ProgramDocument {
  const exercises = [
    { ...createDefaultProgramSlot(ids[4], ids[7], 0), sets: 3, repMin: 8, repMax: 10, restSec: 90 },
    { ...createDefaultProgramSlot(ids[6], ids[8], 1), sets: 3, repMin: 8, repMax: 12, restSec: 75 },
  ];
  return {
    schemaVersion: "2", programId: ids[0], baseVersionId: ids[1], name: "Current",
    days: [{
      lineageId: ids[2], name: "Upper", notes: "Keep", warmupNotes: "Five minutes",
      intent: createSuggestedDayIntent(exercises),
      supersets: [],
      exercises,
    }],
  };
}

function routine(exercises: Array<{ id: string; sets?: number; min?: number; max?: number; rest?: number; group?: string | null }>): RoutineDraft {
  return { days: [{ name: "Upper", notes: null, warmupNotes: null, exercises: exercises.map((exercise) => ({
    exerciseId: exercise.id, name: library.find((item) => item.id === exercise.id)?.name ?? "Exercise",
    sets: exercise.sets ?? 3, repMin: exercise.min ?? 8, repMax: exercise.max ?? 12,
    targetLoad: null, targetLoadUnit: null, restSec: exercise.rest ?? 90,
    supersetGroup: exercise.group ?? null, notes: null, warmup: null, setNotes: [],
  })) }] };
}

function proposal(sourceText: string, candidate: RoutineDraft, mode: "update" | "replace" = "update") {
  let next = 10;
  return buildProgramUpdateProposal({ current: current(), candidate, library, sourceText, mode, createId: () => ids[next++] });
}

describe("incremental Program reconciliation", () => {
  it("cannot delete or alter content omitted from a partial paste", () => {
    const result = proposal("Change Bench Press to 4 sets of 6 reps with 2 min rest.", routine([{ id: ids[4], sets: 4, min: 6, max: 6, rest: 120 }]));
    const accepted = new Set(result.changes.filter((change) => change.acceptedByDefault).map((change) => change.id));
    const applied = applyProgramUpdateChanges(current(), result.changes, accepted);
    expect(applied.days[0].exercises).toHaveLength(2);
    expect(applied.days[0].exercises[0]).toMatchObject({
      lineageId: ids[7],
      sets: 4,
      repMin: 6,
      repMax: 6,
      restSec: 120,
      intent: {
        minimumDose: { unit: "sets", value: 2 },
        idealDose: { unit: "sets", value: 4 },
      },
    });
    expect(applied.days[0].exercises[1]).toEqual(current().days[0].exercises[1]);
    expect(applied.days[0]).toMatchObject({ notes: "Keep", warmupNotes: "Five minutes" });
  });

  it("uses a uniquely named exercise as day context when pasted day wording differs", () => {
    const candidate = routine([{ id: ids[4], sets: 5 }]);
    candidate.days[0].name = "Day A";
    const result = proposal("Change Bench Press to 5 sets.", candidate);
    expect(result.changes).toContainEqual(expect.objectContaining({ category: "changed", acceptedByDefault: true }));
    expect(result.changes).not.toContainEqual(expect.objectContaining({ category: "decision" }));
  });

  it("adds an explicitly named exercise at a selectable position", () => {
    const candidate = routine([{ id: ids[4] }, { id: ids[5] }]);
    candidate.days[0].name = "Day A";
    const result = proposal("Add Cable Fly to Upper.", candidate);
    const addition = result.changes.find((change) => change.operation.kind === "add_slot");
    expect(addition).toMatchObject({ category: "added", acceptedByDefault: true });
    const applied = applyProgramUpdateChanges(current(), result.changes, new Set([addition!.id]));
    expect(applied.days[0].exercises.map((slot) => slot.exerciseId)).toEqual([ids[4], ids[5], ids[6]]);
  });

  it("keeps fields scoped to each named exercise", () => {
    const result = proposal(
      "Set Bench Press to 5 sets and Row rest to 2 minutes.",
      routine([{ id: ids[4], sets: 5, rest: 30 }, { id: ids[6], sets: 6, rest: 120 }]),
    );
    const accepted = new Set(result.changes.filter((change) => change.acceptedByDefault).map((change) => change.id));
    const applied = applyProgramUpdateChanges(current(), result.changes, accepted);
    expect(applied.days[0].exercises[0]).toMatchObject({ sets: 5, restSec: 90 });
    expect(applied.days[0].exercises[1]).toMatchObject({ sets: 3, restSec: 120 });
  });

  it("uses a comma to separate fields for the next named exercise", () => {
    const result = proposal(
      "Set Bench Press to 5 sets, rest for Row to 2 minutes.",
      routine([{ id: ids[4], sets: 5, rest: 30 }, { id: ids[6], rest: 120 }]),
    );
    const accepted = new Set(result.changes.filter((change) => change.acceptedByDefault).map((change) => change.id));
    const applied = applyProgramUpdateChanges(current(), result.changes, accepted);
    expect(applied.days[0].exercises[0]).toMatchObject({ sets: 5, restSec: 90 });
    expect(applied.days[0].exercises[1]).toMatchObject({ sets: 3, restSec: 120 });
  });

  it("keeps compound fields before the next named exercise", () => {
    const result = proposal(
      "Set Bench Press to 5 sets and 2 minutes rest, and Row to 6 sets.",
      routine([{ id: ids[4], sets: 5, rest: 120 }, { id: ids[6], sets: 6, rest: 30 }]),
    );
    const accepted = new Set(result.changes.filter((change) => change.acceptedByDefault).map((change) => change.id));
    const applied = applyProgramUpdateChanges(current(), result.changes, accepted);
    expect(applied.days[0].exercises[0]).toMatchObject({ sets: 5, restSec: 120 });
    expect(applied.days[0].exercises[1]).toMatchObject({ sets: 6, restSec: 75 });
  });

  it("does not treat an exercise name inside another word as explicit", () => {
    const result = proposal(
      "Set Bench Press to 5 sets tomorrow.",
      routine([{ id: ids[4], sets: 5 }, { id: ids[6], sets: 6 }]),
    );
    const accepted = new Set(result.changes.filter((change) => change.acceptedByDefault).map((change) => change.id));
    const applied = applyProgramUpdateChanges(current(), result.changes, accepted);
    expect(applied.days[0].exercises[0]).toMatchObject({ sets: 5 });
    expect(applied.days[0].exercises[1]).toMatchObject({ sets: 3 });
  });

  it("recognizes ordinary exercise shorthand without requiring the library's equipment prefix", () => {
    const variantLibrary = library.map((item) =>
      item.id === ids[4] ? { ...item, name: "Barbell Bench Press" } : item,
    );
    let next = 20;
    const result = buildProgramUpdateProposal({
      current: current(),
      candidate: routine([{ id: ids[4], sets: 5 }, { id: ids[6] }]),
      library: variantLibrary,
      sourceText: "Bench Press: standardize to 5 sets.",
      mode: "update",
      createId: () => ids[next++],
    });
    const accepted = new Set(
      result.changes
        .filter((change) => change.acceptedByDefault)
        .map((change) => change.id),
    );
    const applied = applyProgramUpdateChanges(current(), result.changes, accepted);

    expect(applied.days[0].exercises[0].sets).toBe(5);
  });

  it("preserves candidate order when adding multiple exercises", () => {
    const result = proposal(
      "Add Cable Fly and Shoulder Press after Row on Upper.",
      routine([{ id: ids[4] }, { id: ids[6] }, { id: ids[5] }, { id: ids[29] }]),
    );
    const additions = result.changes.filter((change) => change.operation.kind === "add_slot");
    expect(additions.map((change) => change.operation.kind === "add_slot" ? change.operation.position : null)).toEqual([2, 2]);
    const accepted = new Set(result.changes.filter((change) => change.acceptedByDefault).map((change) => change.id));
    const applied = applyProgramUpdateChanges(current(), result.changes, accepted);
    expect(applied.days[0].exercises.map((slot) => slot.exerciseId)).toEqual([ids[4], ids[6], ids[5], ids[29]]);
    const onlyShoulder = applyProgramUpdateChanges(current(), result.changes, new Set([additions[1]!.id]));
    expect(onlyShoulder.days[0].exercises.map((slot) => slot.exerciseId)).toEqual([ids[4], ids[6], ids[29]]);
  });

  it("anchors an addition after a matched exercise in a partial candidate", () => {
    const result = proposal(
      "Add Cable Fly after Row on Upper.",
      routine([{ id: ids[6] }, { id: ids[5] }]),
    );
    const addition = result.changes.find((change) => change.operation.kind === "add_slot")!;
    expect(addition.operation).toMatchObject({ kind: "add_slot", position: 2 });
    const applied = applyProgramUpdateChanges(current(), result.changes, new Set([addition.id]));
    expect(applied.days[0].exercises.map((slot) => slot.exerciseId)).toEqual([ids[4], ids[6], ids[5]]);
  });

  it("requires explicit approval for removal and full replacement", () => {
    expect(proposal("Remove Row.", routine([{ id: ids[4] }]))).toMatchObject({ changes: expect.arrayContaining([expect.objectContaining({ category: "removed", acceptedByDefault: false })]) });
    expect(proposal("Replace everything with Bench Press.", routine([{ id: ids[4] }]), "replace").changes[0]).toMatchObject({ acceptedByDefault: false, operation: { kind: "replace" } });
  });

  it("applies an explicit exercise replacement as one add and one removal", () => {
    const result = proposal(
      "Replace Row with Cable Fly — 3×8–12.",
      routine([{ id: ids[4] }, { id: ids[5] }]),
    );
    const accepted = new Set(
      result.changes
        .filter((change) => change.acceptedByDefault)
        .map((change) => change.id),
    );
    const applied = applyProgramUpdateChanges(current(), result.changes, accepted);

    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "added", acceptedByDefault: true }),
      expect.objectContaining({
        category: "removed",
        acceptedByDefault: true,
        operation: expect.objectContaining({ kind: "remove_slot", slotId: ids[8] }),
      }),
    ]));
    expect(applied.days[0].exercises.map((slot) => slot.exerciseId)).toEqual([
      ids[4],
      ids[5],
    ]);
  });

  it("resolves a unique current exercise type during replacement", () => {
    const result = proposal(
      "Replace current row with Cable Fly — 3×8–12.",
      routine([{ id: ids[4] }, { id: ids[5] }]),
    );
    expect(result.changes).toContainEqual(expect.objectContaining({
      category: "removed",
      acceptedByDefault: true,
      operation: expect.objectContaining({ kind: "remove_slot", slotId: ids[8] }),
    }));
  });

  it("keeps repeated exercise prescriptions scoped to their natural day headings", () => {
    const multiDay = current();
    multiDay.days = [
      { ...multiDay.days[0], name: "Day 1" },
      {
        ...multiDay.days[0],
        lineageId: ids[9],
        name: "Day 2",
        exercises: multiDay.days[0].exercises.map((slot, index) => ({
          ...slot,
          lineageId: ids[10 + index],
        })),
      },
    ];
    const candidate = routine([{ id: ids[4], sets: 4 }, { id: ids[6] }]);
    candidate.days = [
      { ...candidate.days[0], name: "Day 1" },
      {
        ...routine([{ id: ids[4], sets: 2 }, { id: ids[6] }]).days[0],
        name: "Day 2",
      },
    ];
    let next = 20;
    const result = buildProgramUpdateProposal({
      current: multiDay,
      candidate,
      library,
      sourceText: "Day 1\n\n* Bench Press: 4 sets\n\nDay 2\n\n* Bench Press: 2 sets",
      mode: "update",
      createId: () => ids[next++],
    });
    const accepted = new Set(
      result.changes
        .filter((change) => change.acceptedByDefault)
        .map((change) => change.id),
    );
    const applied = applyProgramUpdateChanges(multiDay, result.changes, accepted);

    expect(applied.days[0].exercises[0].sets).toBe(4);
    expect(applied.days[1].exercises[0].sets).toBe(2);
  });

  it("does not guess between duplicate occurrences", () => {
    const duplicate = current();
    duplicate.days[0].exercises.push({ ...createDefaultProgramSlot(ids[4], ids[9]) });
    let next = 10;
    const result = buildProgramUpdateProposal({ current: duplicate, candidate: routine([{ id: ids[4], sets: 5 }]), library, sourceText: "Change Bench Press to 5 sets.", mode: "update", createId: () => ids[next++] });
    expect(result.changes).toContainEqual(expect.objectContaining({ category: "decision", acceptedByDefault: false }));
    expect(result.changes.some((change) => change.operation.kind === "update_slot")).toBe(false);
  });

  it("reorders matched exercises without changing their identities", () => {
    const result = proposal("Move Row before Bench Press.", routine([{ id: ids[6] }, { id: ids[4] }]));
    const reorder = result.changes.find((change) => change.operation.kind === "reorder")!;
    const applied = applyProgramUpdateChanges(current(), result.changes, new Set([reorder.id]));
    expect(applied.days[0].exercises.map((slot) => slot.lineageId)).toEqual([ids[8], ids[7]]);
  });

  it("adds and removes a whole superset without deleting exercises", () => {
    const grouped = proposal("Superset Bench Press and Row.", routine([{ id: ids[4], group: "A" }, { id: ids[6], group: "A" }]));
    const groupChange = grouped.changes.find((change) => change.operation.kind === "superset")!;
    const applied = applyProgramUpdateChanges(current(), grouped.changes, new Set([groupChange.id]));
    expect(applied.days[0].supersets).toHaveLength(1);
    expect(new Set(applied.days[0].exercises.map((slot) => slot.supersetKey))).toEqual(new Set([applied.days[0].supersets[0].key]));
    let next = 20;
    const ungrouped = buildProgramUpdateProposal({ current: applied, candidate: routine([{ id: ids[4] }, { id: ids[6] }]), library, sourceText: "Unpair Bench Press and Row and remove the superset.", mode: "update", createId: () => ids[next++] });
    const removal = ungrouped.changes.find((change) => change.operation.kind === "superset")!;
    const final = applyProgramUpdateChanges(applied, ungrouped.changes, new Set([removal.id]));
    expect(final.days[0].supersets).toEqual([]);
    expect(final.days[0].exercises).toHaveLength(2);
  });

  it("treats a requested tri-set as one three-exercise group", () => {
    const result = proposal(
      "Run Bench Press, Row, and Cable Fly as a tri-set.",
      routine([
        { id: ids[4], group: "A" },
        { id: ids[6], group: "A" },
        { id: ids[5], group: "A" },
      ]),
    );
    const applied = applyProgramUpdateChanges(
      current(),
      result.changes,
      new Set(
        result.changes
          .filter((change) => change.acceptedByDefault)
          .map((change) => change.id),
      ),
    );

    expect(applied.days[0].supersets).toHaveLength(1);
    expect(applied.days[0].exercises).toHaveLength(3);
    expect(new Set(applied.days[0].exercises.map((slot) => slot.supersetKey))).toEqual(
      new Set([applied.days[0].supersets[0].key]),
    );
  });

  it("removes an undersized superset when one of its exercises is removed", () => {
    const grouped = proposal("Superset Bench Press and Row.", routine([{ id: ids[4], group: "A" }, { id: ids[6], group: "A" }]));
    const groupChange = grouped.changes.find((change) => change.operation.kind === "superset")!;
    const applied = applyProgramUpdateChanges(current(), grouped.changes, new Set([groupChange.id]));
    const removal = buildProgramUpdateProposal({ current: applied, candidate: routine([{ id: ids[4] }]), library, sourceText: "Remove Row.", mode: "update", createId: () => ids[20] });
    const removeChange = removal.changes.find((change) => change.operation.kind === "remove_slot")!;
    const final = applyProgramUpdateChanges(applied, removal.changes, new Set([removeChange.id]));
    expect(final.days[0].supersets).toEqual([]);
    expect(final.days[0].exercises).toHaveLength(1);
    expect(final.days[0].exercises[0]).toMatchObject({ exerciseId: ids[4], supersetKey: null });
  });
});
