import { describe, expect, it } from "vitest";
import { proposeContextualProgramEdit } from "@/lib/program-contextual-edit";
import { interpretProgramEdit } from "@/lib/program-edit-language";
import {
  rankEditExercises,
  mergeEffortNotes,
} from "@/lib/program-edit-resolution";
import { applyProgramTextChanges } from "@/lib/program-text-update";
import {
  createDefaultProgramSlot,
  resizeProgramSlotSets,
  addSupersetGroup,
} from "@/lib/program-editor-client";
import {
  createSuggestedDayIntent,
  programDocumentV3Schema,
} from "@/lib/program-document";
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const names = [
  "Barbell Bench Press",
  "Barbell Back Squat",
  "Barbell Overhead Press",
  "Barbell Row",
  "Triceps Pushdown",
  "Dumbbell Overhead Triceps Extension",
  "Incline Barbell Bench Press",
  "Romanian Deadlift",
  "Zottman Curl",
  "Hammer Curl",
  "Seated Overhead Dumbbell Triceps Extension",
  "One-Arm Dumbbell Triceps Extension",
  "Dumbbell Lateral Raise",
  "Chest-Supported Dumbbell Reverse Fly",
];
const library = names.map((name, index) => ({
  id: id(100 + index),
  name,
  aliases: index === 0 ? ["flat bench"] : [],
  available: true,
  metricType: "weight_reps",
}));
function current() {
  const days = [
    [0, 1],
    [2, 3, 4],
    [6, 7],
    [8, 4, 12, 13],
  ].map((indices, dayIndex) => {
    const exercises = indices.map((index, slotIndex) => ({
      ...resizeProgramSlotSets(
        createDefaultProgramSlot(
          library[index].id,
          id(200 + dayIndex * 10 + slotIndex),
        ),
        index === 4 ? 2 : index === 0 ? 4 : 3,
      ),
      notes: "Use a controlled lowering phase.",
      repMin: index === 0 ? 6 : 8,
      repMax: index === 0 ? 8 : 12,
      targetLoad: 30,
      targetLoadUnit: "kg" as const,
    }));
    return {
      lineageId: id(10 + dayIndex),
      name: `Day ${dayIndex + 1}`,
      notes: "Existing day note",
      warmupNotes: null,
      warmupItems: [],
      exercises,
      supersets: [],
      intent: createSuggestedDayIntent(exercises),
    };
  });
  return programDocumentV3Schema.parse({
    schemaVersion: "3",
    programId: id(1),
    baseVersionId: id(2),
    name: "Synthetic strength cycle",
    days,
  });
}

const propose = (text: string, doc = current(), catalog = library) =>
  proposeContextualProgramEdit(doc, text, catalog);
const apply = (proposal: ReturnType<typeof propose>) =>
  applyProgramTextChanges(
    proposal.baseDocument,
    proposal,
    new Set(proposal.changes.map((change) => change.id)),
  );

describe("contextual Program editing without a provider", () => {
  it("reviews a numbered four-day update with quoted notes and preservation lists", () => {
    const doc = current();
    const text = [
      "Apply these changes to future scheduled workouts only. Preserve all completed workout history.",
      ...doc.days.flatMap((day, dayIndex) => [
        `DAY ${dayIndex + 1}`,
        ...day.exercises.flatMap((slot, slotIndex) => [
          `${slotIndex + 1}. ${library.find((entry) => entry.id === slot.exerciseId)!.name}`,
          "- Preserve the current sets, reps, load target, rest time and exercise order.",
          '- Replace notes with: "Keep a steady tempo. Use rack safeties when applicable. Leave 3 RIR."',
        ]),
        `${day.exercises.length + 1}. All other Day ${dayIndex + 1} exercises`,
        "- Preserve the current exercises, set counts, rep ranges, load targets, rest times, exercise order and supersets.",
      ]),
      "ALL DAYS — NOTES ONLY",
      "The following are authored guidance only. Do not change logging validation, automatic progression logic, Coach rules, or historical records.",
      "- Record actual effort honestly.",
    ].join("\n");
    const p = propose(text, doc);
    expect(p.questions).toEqual([]);
    expect(p.changes).toHaveLength(4);
    const next = apply(p);
    for (const [dayIndex, day] of next.days.entries()) {
      expect(day.notes).toContain("Do not change logging validation");
      expect(day.exercises.map((slot) => ({ ...slot, notes: doc.days[dayIndex].exercises.find((old) => old.lineageId === slot.lineageId)!.notes }))).toEqual(doc.days[dayIndex].exercises);
      for (const slot of day.exercises) expect(slot.notes).toBe("Keep a steady tempo. Use rack safeties when applicable. Leave 3 RIR.");
    }
    expect(doc).toEqual(current());
  });
  it("retains source-specific questions beyond the provider question limit", () => {
    const text = "DAY 1\n1. Bench Press\n" + Array.from({ length: 24 }, (_, index) => `- Unsupported instruction ${index + 1}.`).join("\n");
    const p = propose(text);
    expect(p.questions).toHaveLength(24);
    expect(p.interpretation?.issues).toHaveLength(24);
    expect(p.interpretation?.issues[23].source).toContain("24");
    expect(p.questions.join(" ")).not.toContain("too many");
    expect(apply(p)).toEqual(current());
  });
  it("keeps numbered commands executable and unknown numbered headings isolated", () => {
    const p = propose("DAY 1\n1. Bench Press\nUse 3 RIR.\n2. Increase Bench Press by 2 kg.\n3. Unknown Movement\nSet to 99 kg.");
    expect(p.questions.length).toBeGreaterThan(0);
    expect(apply(p).days[0].exercises.every((slot) => slot.targetLoad !== 99)).toBe(true);
    const command = propose("DAY 1\n1. Increase Bench Press by 2 kg.");
    expect(command.questions).toEqual([]);
    expect(apply(command).days[0].exercises[0].targetLoad).toBe(32);
  });
  it("holds field preservation conflicts without blocking an unrelated day", () => {
    const p = propose("DAY 1\n1. Bench Press\nPreserve the current sets, reps, load target and rest time.\n3 × 5–7.\nDAY 2\n1. Barbell Row\nReplace notes with: Keep a steady torso.");
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(1);
    expect(apply(p).days[0]).toEqual(current().days[0]);
  });
  it("does not swallow an edit appended to an all-other preservation list", () => {
    const p = propose("DAY 1\n1. All other Day 1 exercises\nPreserve the current exercises, set counts and rep ranges and remove Bench Press.\nDAY 2\nBarbell Row:\nUse 3 RIR.");
    expect(p.questions.length).toBeGreaterThan(0);
    expect(apply(p)).toEqual(current());
  });
  it("preserving unspecified load asks instead of clearing a saved value", () => {
    const p = propose("DAY 1\n1. Bench Press\nDo not set a fixed load target. Preserve the current saved load setting as unspecified.\nReplace notes with: Keep a steady tempo.");
    expect(p.questions.length).toBeGreaterThan(0);
    expect(apply(p)).toEqual(current());
    const doc = current();
    doc.days[0].exercises[0].targetLoad = null;
    doc.days[0].exercises[0].targetLoadUnit = null;
    const accepted = propose("DAY 1\n1. Bench Press\nDo not set a fixed load target. Preserve the current saved load setting as unspecified.\nReplace notes with: Keep a steady tempo.", doc);
    expect(accepted.questions).toEqual([]);
    expect(apply(accepted).days[0].exercises[0].targetLoad).toBeNull();
  });
  it("retains indented numbered headings and verifies identity exclusions", () => {
    const p = propose("DAY 4\n  1. Zottman Curl\n  - Keep Zottman Curl as the exercise identity.\n  - Do not replace it with Hammer Curl.\n  - Replace notes with: Keep a steady tempo.\n  2. Triceps Pushdown\n  - Preserve the current exercise, sets, reps, load target and rest time.\n  - Replace notes with: Use 3 RIR.");
    expect(p.questions).toEqual([]);
    expect(p.changes).toHaveLength(2);
    expect(apply(p).days[3].exercises[0].exerciseId).toBe(library[8].id);
    const conflict = propose("DAY 4\n1. Zottman Curl\nDo not replace it with Hammer Curl.\nReplace Zottman Curl with Hammer Curl.");
    expect(conflict.questions).toHaveLength(1);
    expect(apply(conflict)).toEqual(current());
  });
  it("keeps preserved ordering and pending-load exclusions effective", () => {
    const p = propose("DAY 1\n1. Bench Press\nPreserve the current sets, reps and exercise order.\nMove Back Squat before Bench Press.\nDAY 3\n1. Romanian Deadlift\nDo not apply the pending load-change proposal through this request.\n40 kg.");
    expect(p.questions).toHaveLength(2);
    expect(apply(p)).toEqual(current());
  });
  it("keeps indented multi-sentence notes intact after a note label", () => {
    const p = propose('DAY 2\n1. Replace Triceps Pushdown with Seated Overhead Dumbbell Triceps Extension.\n- Sets: 2\n- Reps: 9–12\n- Rest: 75 seconds\n- Use one dumbbell held with both hands.\n- Record the load as the weight of the single dumbbell.\n- Notes:\n  "Maintain a steady torso. Keep the elbows comfortable. Start conservatively and use 3 RIR."\n2. Barbell Row\n- Replace notes with:\n  "Maintain a steady torso. Stop the set before control deteriorates."');
    expect(p.questions).toEqual([]);
    const next = apply(p);
    expect(next.days[1].exercises[1].notes).toBe("Maintain a steady torso. Stop the set before control deteriorates.");
    expect(next.days[1].exercises[2].notes).toContain("Record the load as the weight of the single dumbbell");
    expect(next.days[1].exercises[2].notes).toContain("Start conservatively and use 3 RIR.");
  });
  it("validates an inherited before-order assertion", () => {
    const p = propose('DAY 3\n1. Incline Barbell Bench Press\nKeep this exercise before Romanian Deadlift.\nReplace notes with: Keep a steady tempo.');
    expect(p.questions).toEqual([]);
    expect(p.changes).toHaveLength(1);
    const reverse = current();
    reverse.days[2].exercises.reverse();
    const blocked = propose('DAY 3\n1. Incline Barbell Bench Press\nKeep this exercise before Romanian Deadlift.\nReplace notes with: Keep a steady tempo.', reverse);
    expect(blocked.questions).toHaveLength(1);
    expect(apply(blocked)).toEqual(reverse);
  });
  it("does not mistake compound prose inside a scoped note for exercise families", () => {
    const p = propose('DAY 1\n1. Bench Press\nReplace notes with:\n  "Keep the trunk and arms steady. Use 3 RIR. The last set can reach RPE 8 if technique is steady and supports are available. Do not deliberately target failure."');
    expect(p.questions).toEqual([]);
    expect(p.changes).toHaveLength(1);
    expect(apply(p).days[0].exercises[0].notes).toContain("Do not deliberately target failure.");
  });
  it("offers the highest-ranked saved matches before limiting a long clarification list", () => {
    const doc = current();
    const catalog = Array.from({ length: 11 }, (_, index) => ({
      ...library[0], id: id(400 + index), aliases: [],
      name: index === 10 ? "Press" : `Accessory ${index} Press`,
    }));
    const exercises = catalog.map((exercise, index) =>
      createDefaultProgramSlot(exercise.id, id(500 + index)),
    );
    doc.days = [{ ...doc.days[0], exercises, intent: createSuggestedDayIntent(exercises) }];
    const text = "Press:\nReplace notes with: Keep a controlled lowering phase.";
    const proposal = propose(text, doc, catalog);
    const issue = proposal.interpretation!.issues[0];
    expect(issue.candidates).toHaveLength(8);
    expect(issue.candidates![0].id).toBe(exercises[10].lineageId);
    expect(new Set(issue.candidates!.map((candidate) => candidate.id)).size).toBe(8);
    const resolved = proposeContextualProgramEdit(doc, text, catalog, null, {
      [issue.key]: exercises[10].lineageId,
    });
    expect(resolved.questions).toEqual([]);
    const next = apply(resolved);
    expect(next.days[0].exercises[10].notes).toBe("Keep a controlled lowering phase");
    expect(next.days[0].exercises.slice(0, 10)).toEqual(exercises.slice(0, 10));
  });

  it("inherits day and exercise scope and treats matching KEEP as assertions", () => {
    const doc = current();
    const proposal = propose(
      `DAY 1 — ROUTINE A
Bench Press:
Keep 4 × 6–8.
Update the notes so the first three sets target 1–2 RIR and the
last set can reach RPE 9–9.5.
Back Squat:
Keep everything the same but update the note to target 2 RIR.
Everything else on Day 1 stays unchanged.`,
      doc,
    );
    expect(proposal.questions).toEqual([]);
    expect(proposal.changes).toHaveLength(2);
    expect(
      proposal.changes
        .flatMap((change) => change.operations)
        .every((op) => op.kind === "slot_text" && op.field === "notes"),
    ).toBe(true);
    const next = apply(proposal);
    expect(next.days[0].exercises[0].notes).toContain("controlled lowering");
    expect(next.days[0].exercises[0].notes).toContain("9–9.5");
    expect(next.days.slice(1)).toEqual(doc.days.slice(1));
    expect(doc).toEqual(current());
  });
  it("resolves a wrapped replacement with its complete prescription", () => {
    const p = propose(`DAY 2
Replace the two pushdown sets with seated overhead dumbbell
triceps extensions, 2 × 10–15, 90 sec rest.
Everything else stays the same.`);
    expect(p.questions).toEqual([]);
    expect(p.changes).toHaveLength(1);
    const slot = apply(p).days[1].exercises[2];
    expect(slot).toMatchObject({
      exerciseId: library[10].id,
      sets: 2,
      repMin: 10,
      repMax: 15,
      restSec: 90,
      targetLoad: null,
    });
  });
  it("understands a paragraph and does not invent early-set effort", () => {
    const doc = current();
    doc.days[1].exercises[0].notes = "Earlier sets: 3 RIR. Use rack safeties.";
    const p = propose(
      "On Day 2 replace pushdowns with seated overhead dumbbell triceps extensions, 2 sets of 10–15 with 90 seconds rest. Keep everything else the same. On OHP, let the final set go to 9–9.5 if form is good.",
      doc,
    );
    expect(p.questions).toEqual([]);
    expect(p.changes).toHaveLength(2);
    expect(apply(p).days[1].exercises[0].notes).toContain(
      "Earlier sets: 3 RIR",
    );
    expect(apply(p).days[1].exercises[0].notes).not.toContain("1–2 RIR");
  });
  it("holds a replacement and its prescription together, allowing an independent note", () => {
    const text = `DAY 2
Replace pushdowns with overhead dumbbell triceps extensions.
Sets: 2
Reps: 10–15
Rest: 90 seconds
Notes: Use one dumbbell held in both hands.
OHP:
Use 2 RIR.`;
    const p = propose(
      text,
      current(),
      library.filter((item) => item.id !== library[5].id),
    );
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(1);
    const next = apply(p);
    expect(next.days[1].exercises[2]).toEqual(
      p.baseDocument.days[1].exercises[2],
    );
    const issue = p.interpretation!.issues[0];
    expect(issue.candidates?.some((item) => item.id === library[10].id)).toBe(
      true,
    );
    const resolved = proposeContextualProgramEdit(
      next,
      text,
      library.filter((item) => item.id !== library[5].id),
      null,
      { [issue.key]: library[10].id },
      p.changes.flatMap((change) => change.instructionKeys ?? []),
    );
    expect(resolved.questions).toEqual([]);
    expect(resolved.changes).toHaveLength(1);
    expect(apply(resolved).days[1].exercises[2].notes).toContain("both hands");
  });
  it("does not accept an arbitrary exercise id as a clarification answer", () => {
    const text = "DAY 2\nReplace pushdowns with seated triceps extensions.";
    const p = propose(text);
    const issue = p.interpretation!.issues[0];
    expect(issue).toBeDefined();
    const forged = proposeContextualProgramEdit(
      current(),
      text,
      library,
      null,
      { [issue.key]: library[0].id },
    );
    expect(forged.questions).not.toEqual([]);
    expect(forged.changes).toHaveLength(0);
  });
  it("reports preservation mismatches only for the affected exercise", () => {
    const p = propose(
      "DAY 1\nBench Press:\nKeep 3 × 8–10.\nUse 2 RIR.\nBack Squat:\nUse 2 RIR.",
    );
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]).toContain("KEEP differs");
    expect(p.changes).toHaveLength(1);
    expect(apply(p).days[0].exercises[0]).toEqual(
      p.baseDocument.days[0].exercises[0],
    );
  });
  it("does not interpret executable conditions as notes", () => {
    const p = propose(
      "DAY 1\nBench Press:\nIf reps reach 12, automatically increase weight by 5 lb.\nBack Squat:\nStop if technique deteriorates.",
    );
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(1);
    expect(apply(p).days[0].exercises[1].notes).toContain("technique");
  });
  it("updates an exact effort target and preserves technique", () => {
    expect(
      mergeEffortNotes(
        "Use 2 RIR. Keep the bar close.",
        "Change the RIR target from 2 to 1–2",
        "modify",
      ),
    ).toEqual({ value: "Use 1–2 RIR. Keep the bar close." });
    expect(
      mergeEffortNotes("Use 2 RIR.", "Take every set to failure", "append")
        .question,
    ).toBeTruthy();
    expect(
      mergeEffortNotes(
        "Use 2 RIR. Keep the bar close.",
        "Take every set to failure",
        "replace",
      ).warning,
    ).toBeTruthy();
  });
  it("resolves family guidance within its day", () => {
    const p = propose(
      "On Day 4, curls, pushdowns, lateral raises and reverse flyes should use 1–2 RIR.",
    );
    expect(p.questions).toEqual([]);
    expect(p.changes).toHaveLength(4);
    expect(apply(p).days.slice(0, 3)).toEqual(p.baseDocument.days.slice(0, 3));
  });
  it("asks only about an ambiguous family term", () => {
    const doc = current();
    doc.days[3].exercises.push(
      createDefaultProgramSlot(library[9].id, id(998)),
    );
    const p = propose(
      "On Day 4, curls, pushdowns and lateral raises should use 1–2 RIR.",
      doc,
    );
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(2);
  });
  it("never treats material variants as equivalent library matches", () => {
    const ranked = rankEditExercises(
      "seated overhead dumbbell triceps extensions",
      library,
    );
    expect(ranked[0]).toMatchObject({ id: library[10].id, equivalent: true });
    expect(
      ranked.find((item) => item.id === library[11].id)?.equivalent,
    ).not.toBe(true);
    expect(
      rankEditExercises("overhead dumbbell triceps extensions", [
        library[10],
      ])[0].equivalent,
    ).toBe(false);
  });
  it("keeps request-level constraints effective even after later headings", () => {
    const p = propose(
      "Do not create any new supersets.\nDAY 1\nSuperset Bench Press with Back Squat; 3 rounds, 0s between members, 90s between rounds, 90s after round.\nDAY 2\nOHP:\nUse 2 RIR.",
    );
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(1);
    expect(apply(p).days[0].supersets).toEqual([]);
  });
  it("asks about group timing without inventing rest", () => {
    const p = propose("DAY 1\nSuperset Bench Press with Back Squat.");
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]).toContain("rest");
    expect(p.changes).toHaveLength(0);
  });
  it("removes a member while preserving the remaining group's timing", () => {
    const doc = current();
    doc.days[1] = addSupersetGroup(
      doc.days[1],
      {
        key: id(900),
        name: "Superset 1",
        structureStatus: "canonical",
        plannedRounds: 2,
        restBetweenMembersSec: 10,
        restBetweenRoundsSec: 80,
        restAfterRoundSec: 80,
      },
      doc.days[1].exercises.map((slot) => slot.lineageId),
    );
    const p = propose("DAY 2\nKeep pushdowns separate.", doc);
    expect(p.questions).toEqual([]);
    const day = apply(p).days[1];
    expect(day.exercises[2].supersetKey).toBeNull();
    expect(day.supersets[0]).toMatchObject({
      plannedRounds: 2,
      restBetweenMembersSec: 10,
      restBetweenRoundsSec: 80,
      restAfterRoundSec: 80,
    });
  });
  it("prevents applying against a stale draft", () => {
    const p = propose("DAY 1\nBench Press:\nUse 2 RIR.");
    const doc = current();
    doc.name = "Changed";
    expect(() =>
      applyProgramTextChanges(
        doc,
        p,
        new Set(p.changes.map((change) => change.id)),
      ),
    ).toThrow("draft changed");
  });
  it("does not replay an applied relative change when another item is clarified", () => {
    const text =
      "DAY 1\nIncrease Bench Press by 5 kg.\nBack Squat:\nChange the note to target 2 RIR.";
    const p = propose(text);
    expect(p.questions).toEqual([]);
    const only = new Set([p.changes[0].id]);
    const next = applyProgramTextChanges(p.baseDocument, p, only);
    const second = proposeContextualProgramEdit(
      next,
      text,
      library,
      null,
      {},
      p.changes[0].instructionKeys,
    );
    expect(second.changes).toHaveLength(1);
    expect(apply(second).days[0].exercises[0].targetLoad).toBe(35);
  });
  it("holds a KEEP/edit conflict while retaining an independent edit", () => {
    const p = propose(
      "DAY 1\nBench Press:\nKeep 4 × 6–8.\n3 × 8–10.\nBack Squat:\nUse 2 RIR.",
    );
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(1);
    expect(apply(p).days[0].exercises[0].sets).toBe(4);
  });
  it.each([
    "Use 2 RIR and increase weight by 5 kg",
    "Use 2 RIR then remove this exercise",
    "Use 2 RIR and change rest to 30 seconds",
  ])("does not hide a structured command inside coaching: %s", (note) => {
    const p = propose(`DAY 1\nBench Press:\n${note}.\nBack Squat:\nUse 2 RIR.`);
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(1);
  });
  it.each([
    "0 × 8",
    "3 × 12–8",
    "3 × 8, rest 5000 seconds",
    "3 × 8, 400000 kg",
  ])("keeps invalid prescriptions out of the draft: %s", (dose) => {
    const p = propose(`DAY 1\nBench Press:\n${dose}.`);
    expect(p.questions.length).toBeGreaterThan(0);
    expect(p.changes).toHaveLength(0);
  });
  it("a new unknown heading cannot inherit the previous exercise", () => {
    const p = propose(
      "DAY 1\nBench Press:\nUse 2 RIR.\nUnrecognized exercise:\nSet to 99 kg.",
    );
    expect(p.questions.length).toBeGreaterThan(0);
    expect(apply(p).days[0].exercises[0].targetLoad).toBe(30);
  });
  it("recognizes explicit replacement and appended notes", () => {
    const p = propose(
      "DAY 1\nBench Press:\nReplace notes with:\n“Use 2 RIR.”\nBack Squat:\nAdd note: Use rack safeties.",
    );
    expect(p.questions).toEqual([]);
    const next = apply(p);
    expect(next.days[0].exercises[0].notes).toBe("Use 2 RIR.");
    expect(next.days[0].exercises[1].notes).toContain("controlled lowering");
    expect(next.days[0].exercises[1].notes).toContain("rack safeties");
  });
  it("changing an unrelated sentence in a paragraph does not replay an applied increment", () => {
    const text =
      "On Day 1 increase Bench Press by 5 kg. On Back Squat, use 2 RIR.";
    const p = propose(text);
    expect(p.questions).toEqual([]);
    const first = p.changes.find((change) =>
      change.operations.some((op) => op.kind === "load"),
    )!;
    const next = applyProgramTextChanges(
      p.baseDocument,
      p,
      new Set([first.id]),
    );
    const remaining = proposeContextualProgramEdit(
      next,
      text.replace("2 RIR", "3 RIR"),
      library,
      null,
      {},
      first.instructionKeys,
    );
    expect(remaining.questions).toEqual([]);
    expect(apply(remaining).days[0].exercises[0].targetLoad).toBe(35);
  });
  it("does not silently replace two conflicting authored effort targets", () => {
    const p = propose(
      "DAY 1\nBench Press:\nUse 2 RIR.\nUse 3 RIR.\nBack Squat:\nUse 2 RIR.",
    );
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(1);
  });
  it("keeps complementary effort sentences together", () => {
    const p = propose(
      "DAY 1\nBench Press:\nStart light, leaving 2–3 RIR while learning the movement.\nDo not initially target RPE 9.5.",
    );
    expect(p.questions).toEqual([]);
    const note = apply(p).days[0].exercises[0].notes;
    expect(note).toContain("2–3 RIR");
    expect(note).toContain("Do not initially target RPE 9.5");
  });
  it("preserving the current load blocks a later conflicting load edit", () => {
    const p = propose(
      "DAY 1\nBench Press:\nPreserve the current load target.\n40 kg.\nBack Squat:\nUse 2 RIR.",
    );
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(1);
  });
  it("combines an inherited family label with final-set guidance", () => {
    const p = propose(
      "DAY 4\nEstablished curls, pushdowns, lateral raises and reverse flyes: approximately 1–2 RIR on most sets.\nThe final set may occasionally reach RPE 9–9.5, provided technique is stable.",
    );
    expect(p.questions).toEqual([]);
    expect(p.changes).toHaveLength(4);
    expect(
      apply(p).days[3].exercises.every((slot) =>
        slot.notes?.includes("final set"),
      ),
    ).toBe(true);
  });
  it("validates contradictory day/routine headings", () => {
    const p = propose("DAY 1 — ROUTINE C\nBench Press:\nUse 2 RIR.");
    expect(p.questions.length).toBeGreaterThan(0);
    expect(p.changes).toHaveLength(0);
  });
  it("uses named day headings and KEEP ordering assertions", () => {
    const doc = current();
    doc.days[0].name = "Upper";
    const p = propose(
      "Upper:\nKEEP:\nBench Press before Back Squat.\nCHANGE:\nBench Press:\nUse 2 RIR.",
      doc,
    );
    expect(p.questions).toEqual([]);
    expect(p.changes).toHaveLength(1);
  });
  it.each([
    "DAY 1\nBench Press:\nReplace notes with:",
    "DAY 1\nBench Press:\nReplace notes with:\nBack Squat:\nUse 2 RIR.",
  ])("does not consume another heading as a missing note", (text) => {
    const p = propose(text);
    expect(p.questions.length).toBeGreaterThan(0);
    expect(apply(p).days[0].exercises[0].notes).toBe(
      current().days[0].exercises[0].notes,
    );
  });
  it("allows an explicit new load on the replacement", () => {
    const p = propose(
      "DAY 2\nReplace pushdowns with seated overhead dumbbell triceps extensions, 2 × 10–15, 90 sec rest, 10 kg.",
    );
    expect(p.questions).toEqual([]);
    expect(apply(p).days[1].exercises[2].targetLoad).toBe(10);
  });
  it("does not clear load or guidance for an equivalent same-exercise replacement", () => {
    const p = propose("DAY 2\nReplace pushdowns with Triceps Pushdown.");
    expect(p.questions).toEqual([]);
    expect(apply(p)).toEqual(current());
  });
  it("can detach a member under a no-new-supersets constraint", () => {
    const doc = current();
    doc.days[1] = addSupersetGroup(
      doc.days[1],
      {
        key: id(902),
        name: "Superset 1",
        structureStatus: "canonical",
        plannedRounds: 2,
        restBetweenMembersSec: 10,
        restBetweenRoundsSec: 80,
        restAfterRoundSec: 80,
      },
      doc.days[1].exercises.map((slot) => slot.lineageId),
    );
    const p = propose(
      "Do not create any new supersets.\nDAY 2\nKeep pushdowns separate.",
      doc,
    );
    expect(p.questions).toEqual([]);
    expect(apply(p).days[1].exercises[2].supersetKey).toBeNull();
  });
  it("does not let a later reorder bypass an earlier KEEP assertion", () => {
    const p = propose(
      "DAY 1\nKEEP:\nBench Press before Back Squat.\nCHANGE:\nMove Back Squat before Bench Press.",
    );
    expect(p.questions).toHaveLength(1);
    expect(p.changes).toHaveLength(0);
  });
  it("distinguishes repeated exercises by saved position in a clarification", () => {
    const doc = current();
    doc.days[0].exercises.push(
      createDefaultProgramSlot(library[0].id, id(995)),
    );
    const text = "DAY 1\nBench Press:\nUse 2 RIR.";
    const p = propose(text, doc);
    expect(p.questions).toHaveLength(1);
    const issue = p.interpretation!.issues[0];
    expect(issue.candidates?.map((item) => item.name)).toEqual([
      expect.stringContaining("exercise 1"),
      expect.stringContaining("exercise 3"),
    ]);
    const chosen = proposeContextualProgramEdit(doc, text, library, null, {
      [issue.key]: id(995),
    });
    expect(chosen.questions).toEqual([]);
    const next = apply(chosen);
    expect(next.days[0].exercises[0]).toEqual(doc.days[0].exercises[0]);
    expect(next.days[0].exercises[2].notes).toBe("Use 2 RIR");
  });
  it.each([
    "Use 2 RIR with a controlled lowering phase.",
    "Use 2 reps in reserve and brace tightly, with rack safeties.",
  ])("does not erase an inseparable technique cue: %s", (saved) => {
    const result = mergeEffortNotes(saved, "Use 1–2 RIR", "modify");
    expect(result.question).toBeTruthy();
    expect(result.value).toBe(saved);
  });
  it("does not erase earlier targets when an old sentence covers all sets", () => {
    const saved = "Target 2 RIR on all sets.";
    expect(
      mergeEffortNotes(saved, "The final set may reach RPE 9–9.5", "modify"),
    ).toMatchObject({ value: saved, question: expect.any(String) });
    expect(
      mergeEffortNotes(
        "Earlier sets: 2 RIR. Final set: RPE 8.",
        "Earlier sets: 1–2 RIR",
        "modify",
      ).value,
    ).toContain("Final set: RPE 8");
  });
  it.each(["", "x".repeat(20001), "Use 2 RIR\u202e"])(
    "rejects invalid input before interpretation",
    (text) => {
      expect(propose(text).changes).toHaveLength(0);
      expect(propose(text).questions).toHaveLength(1);
    },
  );
  it("exposes language intent before Program lookup", () => {
    const parsed = interpretProgramEdit(
      "DAY 1\nBench Press:\nKeep 4 × 6–8.\nUse 2 RIR.",
    );
    expect(parsed.instructions.map((item) => item.intent)).toEqual([
      "preserve",
      "notes",
    ]);
    expect(parsed.instructions[1].scope).toEqual({
      day: "DAY 1",
      exercise: "Bench Press",
    });
  });
});
