import { describe, expect, it } from "vitest";
import { parseProgramTextUpdate } from "@/lib/program-text-parser";
import {
  applyProgramTextChanges,
  buildProgramTextProposal,
} from "@/lib/program-text-update";
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
    [8, 4],
  ].map((indices, dayIndex) => {
    const exercises = indices.map((index, slotIndex) => ({
      ...resizeProgramSlotSets(
        createDefaultProgramSlot(
          library[index].id,
          id(200 + dayIndex * 10 + slotIndex),
        ),
        index === 4 ? 2 : 3,
      ),
      notes: "Use a controlled lowering phase.",
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
function check(text: string, document = current(), catalog = library) {
  const snapshot = structuredClone(document);
  const parsed = parseProgramTextUpdate(document, text, catalog);
  let serial = 800;
  const proposal = buildProgramTextProposal(
    document,
    parsed,
    text,
    catalog,
    () => id(serial++),
  );
  const selected = new Set(proposal.changes.map((change) => change.id));
  if (parsed.questions.length)
    expect(() => applyProgramTextChanges(document, proposal, selected)).toThrow(
      /clarification/,
    );
  const after = parsed.questions.length
    ? document
    : applyProgramTextChanges(document, proposal, selected);
  expect(document).toEqual(snapshot);
  expect(parseProgramTextUpdate(document, text, catalog)).toEqual(parsed);
  return { parsed, proposal, after };
}

describe("conservative Program text interpreter", () => {
  it.each([
    "4 × 6–10; rest 90 seconds",
    "4x6-10 with 1 min 30 sec rest",
    "four sets of six to ten repetitions with 90s rest",
    "4 sets of 6–10 reps; 90 seconds rest",
  ])("consumes common complete prescriptions: %s", (prescription) => {
    const { parsed, after } = check(
      `Day A\nSet flat bench to ${prescription}.`,
    );
    expect(parsed.questions).toEqual([]);
    expect(after.days[0].exercises[0]).toMatchObject({
      sets: 4,
      repMin: 6,
      repMax: 10,
      restSec: 90,
      targetLoad: 30,
      targetLoadUnit: "kg",
    });
  });
  it("treats one replacement plus its prescription and notes as one indivisible selectable change", () => {
    const text = `DAY 2 — ROUTINE B\nCHANGE:\nReplace the 2 sets of Triceps Pushdown with 2 sets of Dumbbell Overhead Triceps Extension, in the same exercise slot.\nSuggested starting prescription: 2 × 9–13; rest 75 seconds.\nUse one fixed dumbbell held with both hands. Record the weight of that single dumbbell.\nStart light, leaving 3 repetitions in reserve.`;
    const before = current(),
      { parsed, after, proposal } = check(text, before);
    expect(parsed.questions).toEqual([]);
    expect(parsed.changes).toHaveLength(1);
    const slot = after.days[1].exercises[2];
    expect(slot).toMatchObject({
      exerciseId: library[5].id,
      sets: 2,
      repMin: 9,
      repMax: 13,
      restSec: 75,
      targetLoad: null,
      targetLoadUnit: null,
      progressionRuleId: before.days[1].exercises[2].progressionRuleId,
    });
    expect(slot.notes).toContain("single dumbbell");
    expect(slot.notes).not.toContain("controlled lowering");
    expect(slot.lineageId).not.toBe(before.days[1].exercises[2].lineageId);
    expect(after.days[1].exercises.slice(0, 2)).toEqual(
      before.days[1].exercises.slice(0, 2),
    );
    expect(applyProgramTextChanges(before, proposal, new Set())).toEqual(
      before,
    );
    expect(
      applyProgramTextChanges(
        before,
        proposal,
        new Set(proposal.changes.map((c) => c.id)),
      ),
    ).toEqual(after);
  });
  it("lets an explicit new load replace the cleared replacement load, and resolves the new name", () => {
    const { parsed, after } = check(
      "Day B\nReplace Triceps Pushdown with Dumbbell Overhead Triceps Extension\nSet Dumbbell Overhead Triceps Extension to 2 × 10–14 at 12.5 kg; rest 60 seconds",
    );
    expect(parsed.questions).toEqual([]);
    expect(after.days[1].exercises[2]).toMatchObject({
      targetLoad: 12.5,
      targetLoadUnit: "kg",
      sets: 2,
      repMin: 10,
      repMax: 14,
      restSec: 60,
    });
  });
  it("preserves group membership and starts fresh lineage on replacement", () => {
    const before = current();
    before.days[1].exercises[1] = resizeProgramSlotSets(
      before.days[1].exercises[1],
      2,
    );
    before.days[1] = addSupersetGroup(
      before.days[1],
      {
        key: id(700),
        name: "Pair",
        structureStatus: "canonical",
        plannedRounds: 2,
        restBetweenMembersSec: 0,
        restBetweenRoundsSec: 80,
        restAfterRoundSec: 80,
      },
      [id(211), id(212)],
    );
    const { parsed, after } = check(
      "Day B\nReplace Triceps Pushdown with Dumbbell Overhead Triceps Extension\nUse one light dumbbell.",
      before,
    );
    expect(parsed.questions).toEqual([]);
    expect(after.days[1].supersets).toEqual(before.days[1].supersets);
    expect(after.days[1].exercises[2].supersetKey).toBe(id(700));
    expect(after.days[1].exercises[2].groupMemberOrderIdx).toBe(1);
  });
  it("appends exact guidance without changing loads, work sets, or progression", () => {
    const before = current();
    const { parsed, after } = check(
      "Day C\nCLARIFY:\nIncline Bench: Leave 2 repetitions in reserve.\nDo not aim for failure.\nRomanian Deadlift: Keep a controlled range.\nThis request does not approve the pending RDL load proposal.",
      before,
    );
    expect(parsed.questions).toEqual([]);
    expect(after.days[2].exercises[0].notes).toBe(
      "Use a controlled lowering phase.\nLeave 2 repetitions in reserve\nDo not aim for failure",
    );
    for (const [i, slot] of after.days[2].exercises.entries())
      expect({ ...slot, notes: before.days[2].exercises[i].notes }).toEqual(
        before.days[2].exercises[i],
      );
  });
  it("can explicitly replace or clear notes", () => {
    const replaced = check("Replace notes for flat bench: Use the safeties.");
    expect(replaced.parsed.questions).toEqual([]);
    expect(replaced.after.days[0].exercises[0].notes).toBe("Use the safeties");
    const cleared = check("Clear notes for flat bench");
    expect(cleared.parsed.questions).toEqual([]);
    expect(cleared.after.days[0].exercises[0].notes).toBeNull();
  });
  it("updates a standalone effort target while preserving technique and safety guidance", () => {
    const before = current();
    before.days[0].exercises[0].notes =
      "Use approximately 2 RIR during normal training. Use the safeties. Keep a controlled lowering phase.";
    const { parsed, after } = check(
      "Day A\nBench effort: Leave 3 repetitions in reserve.",
      before,
    );
    expect(parsed.questions).toEqual([]);
    expect(after.days[0].exercises[0].notes).toBe(
      "Use the safeties. Keep a controlled lowering phase.\nLeave 3 repetitions in reserve",
    );
    before.days[0].exercises[0].notes = "Use 2 RIR, keeping both feet planted.";
    expect(
      check(
        "Day A\nBench effort: Leave 3 repetitions in reserve.",
        before,
      ).parsed.questions.join(),
    ).toContain("mixed with other notes");
  });
  it("supports explicitly selected existing progression rules and rejects inferred formulas", () => {
    const { parsed, after } = check("Set progression for flat bench to hold");
    expect(parsed.questions).toEqual([]);
    expect(after.days[0].exercises[0].progressionRuleId).toBe("hold");
    expect(
      check("Set progression for flat bench to add 2 kg every week").parsed
        .questions.length,
    ).toBeGreaterThan(0);
    expect(
      check(
        "Set progression for flat bench to hold\nKeep existing progression rules",
      ).parsed.questions.join(),
    ).toContain("KEEP");
  });
  it("stores explicitly labelled all-day guidance as notes without changing logging or progression", () => {
    const { parsed, after } = check(
      "All days — Notes\nRecord actual effort honestly.\nCompare progress at similar technique and range.",
    );
    expect(parsed.questions).toEqual([]);
    for (const [i, day] of after.days.entries()) {
      expect(day.notes).toContain("Record actual effort honestly");
      expect(day.exercises).toEqual(current().days[i].exercises);
    }
  });
  it("supports exact loads and relative changes against a known same-unit saved target only", () => {
    expect(
      check("Increase Barbell Back Squat load by 2.5 kg").after.days[0]
        .exercises[1].targetLoad,
    ).toBe(32.5);
    expect(
      check("Decrease Barbell Back Squat load by 5 lb").parsed.questions.join(),
    ).toContain("no saved target load in lb");
  });
  it("reorders a single exercise and leaves other days unchanged", () => {
    const before = current(),
      { parsed, after } = check(
        "Day A\nMove Barbell Back Squat before flat bench",
        before,
      );
    expect(parsed.questions).toEqual([]);
    expect(after.days[0].exercises.map((slot) => slot.lineageId)).toEqual([
      id(201),
      id(200),
    ]);
    expect(after.days.slice(1)).toEqual(before.days.slice(1));
  });
  it("adds a fully prescribed available movement at an explicit position", () => {
    const { parsed, after } = check(
      "Day D\nAdd Hammer Curl: 2 × 10–12; rest 60 seconds; last",
    );
    expect(parsed.questions).toEqual([]);
    expect(after.days[3].exercises.at(-1)).toMatchObject({
      exerciseId: library[9].id,
      sets: 2,
      repMin: 10,
      repMax: 12,
      restSec: 60,
      targetLoad: null,
    });
  });
  it("removes only the named exercise from the named day", () => {
    const before = current(),
      { parsed, after } = check("Day B\nRemove Triceps Pushdown", before);
    expect(parsed.questions).toEqual([]);
    expect(after.days[1].exercises).toEqual(
      before.days[1].exercises.slice(0, 2),
    );
    expect(after.days[3]).toEqual(before.days[3]);
  });
  it.each([
    "Set flat bench to 0 sets",
    "Set flat bench to 3 × 10–5",
    "Set flat bench to 3 × 5.5",
    "Set flat bench to 3 × 5–1000",
    "Set flat bench to 3 × 5; rest -60 sec",
    "Set flat bench to 3 × 5; rest 60–90 sec",
    "Set flat bench to 100 oz",
    "Set flat bench to 100",
    "Set flat bench to 0.123 kg",
    "Set flat bench to 100000 kg",
    "Set flat bench to 3 × 5 and remove squat",
    "flat bench: 0 sets",
    "flat bench: -20 kg",
    "flat bench: 3 × 10–5",
    "Set flat bench to 3 sets. Keep squat at 900 kg",
  ])("blocks malformed or partly understood doses: %s", (text) => {
    const { parsed, after } = check(text);
    expect(parsed.questions.length).toBeGreaterThan(0);
    expect(after).toEqual(current());
  });
  it.each([
    "Day Z\nBench: Leave 2 RIR",
    "Day 1 — Routine C\nBench: Leave 2 RIR",
    "Day A\nBench: Leave 2 RIR\nUnknown exercise: Leave 1 RIR\nUse less weight",
    "Day A\nBench: Leave 2 RIR\nEstablished curls and presses: Leave 1 RIR",
    "Day A\nIf the substitution is adopted, replace flat bench with Hammer Curl",
    "Day A\nReplace flat bench with an easier press",
    "Day A\nSet flat bench to 4 sets\nSet flat bench to 5 sets",
    "Day A\nRemove flat bench\nSet flat bench to 4 sets",
    "Day A\nMove flat bench last\nMove Barbell Back Squat last",
    "Day A\nSet flat bench to 4 sets\nUpdate yesterday's workout too",
    "Day A\nSet flat bench to 4 sets\nKeep the eight-day rotation",
    "Day A\nBench: Increase load automatically every week",
    "Day A\nBench: Do not set the squat load to 30 kg\nSet Barbell Back Squat load to 30 kg",
    "Day B\nReplace Triceps Pushdown with Dumbbell Overhead Triceps Extension\nMove Barbell Row last",
  ])("blocks ambiguity and conflicts across the entire request: %s", (text) => {
    const { parsed, after } = check(text);
    expect(parsed.questions.length).toBeGreaterThan(0);
    expect(after).toEqual(current());
  });
  it("checks KEEP values rather than interpreting them as edits", () => {
    const { parsed } = check(
      "Day A\nKEEP:\nBarbell Bench Press first: 4 × 6–8\nCHANGE:\nSet Barbell Back Squat to 4 sets",
    );
    expect(parsed.questions.join()).toContain("KEEP does not match");
  });
  it("checks preservation constraints after all edits, in either order", () => {
    for (const text of [
      "KEEP:\nflat bench: 3 × 8–12\nCHANGE:\nSet flat bench to 4 sets",
      "CHANGE:\nSet flat bench to 4 sets\nKEEP:\nflat bench: 3 × 8–12",
    ]) {
      expect(check(`Day A\n${text}`).parsed.questions.join()).toContain(
        "conflicts with a KEEP",
      );
    }
  });
  it("does not substitute Zottman Curl or permit a later conflicting replacement", () => {
    const { parsed, after } = check(
      "Day D\nKeep Zottman Curl as Zottman Curl—not Hammer Curl\nReplace Zottman Curl with Hammer Curl",
    );
    expect(parsed.questions.join()).toContain("KEEP");
    expect(after.days[3].exercises[0].exerciseId).toBe(library[8].id);
  });
  it("refuses unavailable replacements and alias collisions", () => {
    const unavailable = library.map((item, index) =>
      index === 5 ? { ...item, available: false } : item,
    );
    expect(
      check(
        "Day B\nReplace Triceps Pushdown with Dumbbell Overhead Triceps Extension",
        current(),
        unavailable,
      ).parsed.questions.join(),
    ).toContain("unavailable");
    const ambiguous = library.map((item, index) =>
      index < 2 ? { ...item, aliases: ["shared movement"] } : item,
    );
    expect(
      check(
        "Set shared movement to 4 sets",
        current(),
        ambiguous,
      ).parsed.questions.join(),
    ).toContain("more than one");
  });
  it("requires the day when the same movement occurs more than once", () => {
    expect(
      check("Set Triceps Pushdown to 3 sets").parsed.questions.join(),
    ).toContain("more than one");
  });
  it("recognizes identical repeated instructions without conflicting or duplicating them", () => {
    const { parsed } = check(
      "Set flat bench to 4 sets\nSet flat bench to 4 sets",
    );
    expect(parsed.questions).toEqual([]);
    expect(parsed.changes[0].operations).toHaveLength(1);
  });
  it("keeps oversized notes, oversized input, and hidden control characters unapplied", () => {
    for (const text of [
      `Append notes for flat bench: Use ${"a".repeat(2001)}`,
      "a".repeat(20001),
      "Set flat bench to 4 sets\u202e",
    ]) {
      const { parsed } = check(text);
      expect(parsed.questions.length).toBeGreaterThan(0);
    }
  });
  it("bounds unknown-line output without claiming the remainder was understood", () => {
    const { parsed } = check(
      Array.from(
        { length: 50 },
        (_, i) => `Unrecognized instruction ${i}`,
      ).join("\n"),
    );
    expect(parsed.questions).toHaveLength(20);
    expect(parsed.questions[19]).toContain("more unresolved instructions");
  });
  it("supports named-day headings and explicit current-day scope", () => {
    const before = current();
    before.days[0].name = "Upper";
    expect(
      check("Upper:\nSet flat bench to 4 sets", before).parsed.questions,
    ).toEqual([]);
    const parsed = parseProgramTextUpdate(
      before,
      "On current day, set flat bench to 4 sets",
      library,
      before.days[0].lineageId,
    );
    expect(parsed.questions).toEqual([]);
    expect(
      parseProgramTextUpdate(
        before,
        "On current day, set flat bench to 4 sets",
        library,
        null,
      ).questions.length,
    ).toBeGreaterThan(0);
  });
  it.each([
    "Infinity kg",
    "NaN lb",
    "ten oz",
    "three × zero",
    "4 sets at 20",
    "1e3 kg",
  ])("does not save an invalid dose as prose: %s", (text) => {
    expect(
      check(`Day A\nflat bench: ${text}`).parsed.questions.length,
    ).toBeGreaterThan(0);
  });
  it.each([
    "Keep existing exercises and add twenty new sets",
    "Update request — remove squats",
    "Day A — remove squats",
    "Do not change the bench working sets",
    "Increase the load whenever this feels easy",
    "Use the most recent logged weight instead",
    "No more than 10 weekly sets",
    "Use the lightest owned pair and round up",
    "Use pounds except on odd weeks",
    "Change this in completed workouts too",
  ])(
    "does not silently ignore an unsupported constraint beside a valid change: %s",
    (constraint) => {
      const { parsed, after } = check(
        `Set flat bench to 4 sets\n${constraint}`,
      );
      expect(parsed.questions.length).toBeGreaterThan(0);
      expect(after).toEqual(current());
    },
  );
  it("is bounded and non-mutating for a deterministic malformed-input corpus", () => {
    let seed = 12345;
    const chars = "abcABC019.-×:;[]<>%?\n\t lbkg";
    const before = current(),
      snapshot = structuredClone(before);
    for (let trial = 0; trial < 250; trial++) {
      let text = "";
      for (let n = 0; n < 100; n++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        text += chars[seed % chars.length];
      }
      const result = parseProgramTextUpdate(before, text, library);
      expect(result.questions.length).toBeGreaterThan(0);
      expect(result.questions.length).toBeLessThanOrEqual(20);
      expect(result.changes).toEqual([]);
    }
    expect(before).toEqual(snapshot);
  });
});
