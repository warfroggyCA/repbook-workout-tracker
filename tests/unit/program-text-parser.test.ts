import { describe, expect, it } from "vitest";
import { parseProgramTextUpdate } from "@/lib/program-text-parser";
import {
  applyProgramTextChanges,
  buildProgramTextProposal,
} from "@/lib/program-text-update";
import { createDefaultProgramSlot } from "@/lib/program-editor-client";
import {
  createSuggestedDayIntent,
  programDocumentV3Schema,
} from "@/lib/program-document";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const names = [
  "Barbell Bench Press",
  "Barbell Back Squat",
  "Barbell Overhead Press",
  "Barbell Row",
  "Bulgarian Split Squat",
  "Incline Barbell Bench Press",
  "Romanian Deadlift",
  "Kettlebell Goblet Squat",
  "Single-Leg Calf Raise",
  "Dumbbell Bench Press",
  "Chest-Supported Dumbbell Row",
  "Wide-Grip Lat Pulldown",
  "Cable Leg Curl",
];
const library = names.map((name, i) => ({
  id: id(i + 100),
  name,
  available: true,
  metricType: "weight_reps",
  aliases: i === 0 ? ["flat bench"] : [],
}));
function current() {
  const days = [
    [0, 1, 11],
    [2, 3, 4, 12],
    [5, 6, 11],
    [7, 8, 9, 10, 12],
  ].map((indices, dayIndex) => {
    const exercises = indices.map((index, slotIndex) =>
      createDefaultProgramSlot(
        library[index].id,
        id(200 + dayIndex * 10 + slotIndex),
      ),
    );
    return {
      lineageId: id(10 + dayIndex),
      name: `Day ${dayIndex + 1}`,
      notes: "Preserve day intent",
      warmupNotes: "Old general guidance",
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
    name: "Synthetic plan",
    days,
  });
}
function run(text: string, document = current()) {
  const parsed = parseProgramTextUpdate(document, text, library);
  const proposal = buildProgramTextProposal(document, parsed, text, library);
  const after = applyProgramTextChanges(
    document,
    proposal,
    new Set(proposal.changes.map((change) => change.id)),
  );
  return { parsed, proposal, after };
}

// Synthetic loads and prescriptions exercise the same prose forms without
// publishing an owner's routine or training observations.
const complexWarmup = `WARM-UP UPDATE — FUTURE WORKOUTS ONLY

Keep working exercises, working sets, progression rules and
working-set supersets unchanged.

GENERAL RULES
• Mark every preparation set as WARM-UP, not a working set.
• Perform each exercise’s preparation immediately before that
  exercise—not all preparation sets at the session’s start.
• All barbell weights below INCLUDE the 20 kg bar.
• Dumbbell weights are PER dumbbell.
• Rest approximately 20–40 seconds between easy preparation
  sets and 60–120 seconds before the first working set.
  Take longer when needed to feel ready.

START OF EACH DAY — APPROXIMATELY 4 MINUTES
• Elliptical: 3 minutes easy.
• Arm circles: 5 forward + 5 backward, comfortable range.
• Scapular push-up: 5–7 easy repetitions.
  Use a stable bench-supported version if preferred.
• No hard push-up sets or fatiguing shoulder circuits.

DAY A — BENCH FIRST, THEN SQUAT
Immediately before Barbell Bench Press:
• 20 kg × 7.
• 30 kg × 3.
• Then working sets.
These preparation loads assume approximately 50 kg working
weight.

Immediately before Barbell Back Squat:
• Bodyweight squat × 5–7.
• 20 kg × 4.
• Then working sets.

DAY B — PRESS / ROW / UNILATERAL LEGS
Immediately before Barbell Overhead Press:
• 20 kg × 4 easy repetitions.
• Then working sets at the current approximately 30 kg load.
• Remove the separate “60% of working weight” preparation set
  while that calculation falls below the empty bar’s weight.
Immediately before Barbell Row:
• Unloaded hip hinge × 5–7.
• 20 kg × 5.
Immediately before Bulgarian Split Squat:
• Bodyweight split squat × 3 per side.

For the proposed Dumbbell Overhead Triceps Extension,
if that substitution is adopted:
• One light preparation set × 7 before the two working sets.
• Do not add this preparation set to the working-set count.

DAY C — INCLINE / HINGE
Immediately before Incline Barbell Bench Press:
• Use the same 15–25-degree bench angle as the working sets.
• 20 kg × 7.
Immediately before Romanian Deadlift:
• Unloaded hip hinge × 7.
• Glute bridge × 7.
• 20 kg × 5.
• 40 kg × 3.
• Then working sets.
These preparation loads assume approximately 60 kg working
weight. This does not approve a working-load change.

DAY D — ACCESSORIES
After the general warm-up:
• Before Goblet Squat: one light kettlebell set × 7.
• Before loaded Single-Leg Calf Raise: bodyweight × 5 per side.
• Before Dumbbell Bench Press: one easy set × 7 using a
  lighter owned pair, approximately half the working weight.
• Before Chest-Supported Dumbbell Row: one easy set × 5–7
  using a lighter owned pair.
• Round preparation loads to equipment actually available.
• Remove the old band straight-arm-pulldown warm-up if it
  remains solely from the previous version of Day D.

OTHER EXERCISE PREPARATION
• Before the first Wide-Grip Lat Pulldown and Cable Leg Curl
  of the day, use one easy preparation set × 5–7 at a lighter
  recorded load, with the same setup as the working sets.
• Cable-leg-curl preparation repetitions are per side.
• Other accessories do not need an automatic three-set
  warm-up sequence. Use a light rehearsal set when the
  movement is unfamiliar or does not yet feel comfortable.
• Never force a painful range or rush into a working set
  because a warm-up timer has expired.`;

describe("local Program text parsing", () => {
  it("treats a warm-up-only preamble as a scope constraint, not missing general guidance", () => {
    const { parsed } = run(
      "Update warm-up only. Keep all working prescriptions unchanged.\nDay A\nBefore Barbell Bench Press:\n• Easy rehearsal × 7.\n• 20 kg × 4.",
    );
    expect(parsed.questions).toEqual([]);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.changes[0].operations).toHaveLength(1);
  });
  it("parses a soft-wrapped multi-day preparation update without touching working prescriptions", () => {
    const before = current();
    const { after, proposal, parsed } = run(complexWarmup, before);
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.questions[0]).toContain("Conditional preparation");
    expect(parsed.questions[1]).toContain("Conditional removal");
    expect(proposal.changes).toHaveLength(19);
    for (const [index, day] of after.days.entries()) {
      expect(
        day.warmupItems.filter((item) => item.beforeSlotLineageId === null),
      ).toHaveLength(3);
      expect(day.warmupNotes).toContain("INCLUDE the 20 kg bar");
      expect(day.warmupNotes).toContain("APPROXIMATELY 4 MINUTES");
      expect(day.warmupNotes).toContain("60–120 seconds");
      expect(day.warmupNotes).toContain("Never force a painful range");
      expect(day.notes).toEqual(before.days[index].notes);
      expect(day.intent).toEqual(before.days[index].intent);
      expect(day.supersets).toEqual(before.days[index].supersets);
      for (const [slotIndex, slot] of day.exercises.entries()) {
        expect({
          ...slot,
          warmupNotes: before.days[index].exercises[slotIndex].warmupNotes,
        }).toEqual(before.days[index].exercises[slotIndex]);
        expect(
          day.warmupItems.some(
            (item) => item.beforeSlotLineageId === slot.lineageId,
          ),
        ).toBe(true);
      }
    }
    expect(
      after.days[0].warmupItems
        .filter((item) => item.beforeSlotLineageId === id(200))
        .map((item) => [item.reps, item.load, item.loadUnit]),
    ).toEqual([
      [7, 20, "kg"],
      [3, 30, "kg"],
    ]);
    expect(after.days[1].exercises[3].warmupNotes).toContain("per side");
    expect(
      after.days[3].warmupItems.find(
        (item) => item.beforeSlotLineageId === id(232),
      ),
    ).toMatchObject({ loadPercent: 50, load: null });
    expect(
      after.days[3].warmupItems.find(
        (item) => item.beforeSlotLineageId === id(233),
      ),
    ).toMatchObject({
      reps: null,
      notes: expect.stringContaining("5–7 repetitions"),
    });
    expect(after.days[2].exercises[1].warmupNotes).toContain(
      "does not approve a working-load change",
    );
    expect(before).toEqual(current());
  });

  it("matches aliases and named days and parses sets, ranges, and compound rests", () => {
    const document = current();
    document.days[0].name = "Upper";
    const { after, parsed } = run(
      "On Upper day, change flat bench to 4 sets of 5–7 reps with 2 min 30 sec rest. Leave everything else unchanged.",
      document,
    );
    expect(parsed.questions).toEqual([]);
    expect(after.days[0].exercises[0]).toMatchObject({
      sets: 4,
      repMin: 5,
      repMax: 7,
      restSec: 150,
    });
    expect(after.days.slice(1)).toEqual(document.days.slice(1));
  });

  it("matches an exact day name ending in Day before treating Day as a qualifier", () => {
    const document = current();
    document.days[0].name = "Leg Day";
    const { after, parsed } = run(
      "On Leg Day, change Barbell Back Squat to 4 sets.",
      document,
    );
    expect(parsed.questions).toEqual([]);
    expect(after.days[0].exercises[1].sets).toBe(4);
  });

  it("retains inline general preparation without requiring a following bullet", () => {
    const { after, parsed } = run("General warm-up: cycle for 5 minutes");
    expect(parsed.questions).toEqual([]);
    for (const day of after.days)
      expect(day.warmupItems).toEqual([
        expect.objectContaining({
          label: "cycle for 5 minutes",
          beforeSlotLineageId: null,
        }),
      ]);
  });

  it.each([
    "Remove Barbell Back Squat",
    "add another leg exercise",
    "replace Barbell Back Squat with Goblet Squat",
    "move Barbell Back Squat first",
  ])(
    "surfaces a structural command after preparation instead of storing it as guidance: %s",
    (command) => {
      const before = current();
      const { after, parsed } = run(
        `Day A\nBefore Barbell Bench Press:\n• 20 kg × 5.\n${command}`,
        before,
      );
      expect(parsed.questions).toEqual([
        expect.stringContaining("could not resolve"),
      ]);
      expect(parsed.changes).toHaveLength(1);
      expect(after.days[0].exercises[0].warmupNotes).toBeNull();
      expect(after.days[0].exercises).toEqual(before.days[0].exercises);
    },
  );

  it("preserves preparation on unmentioned anchors and replaces the mentioned ramp", () => {
    const document = current();
    const item = {
      key: id(400),
      label: "Existing rehearsal",
      reps: 5,
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: null,
      notes: null,
      beforeSlotLineageId: id(201),
    };
    document.days[0].warmupItems = [
      item,
      { ...item, key: id(401), beforeSlotLineageId: id(200) },
    ];
    const { after } = run(
      "Day A\nBefore Barbell Bench Press: 25 lb × 6.",
      document,
    );
    expect(after.days[0].warmupItems).toContainEqual(item);
    expect(
      after.days[0].warmupItems.filter(
        (step) => step.beforeSlotLineageId === id(200),
      ),
    ).toEqual([expect.objectContaining({ load: 25, reps: 6, loadUnit: "lb" })]);
    expect(after.days[0].warmupNotes).toBe(document.days[0].warmupNotes);
  });

  it.each([
    "0 sets of 5 reps",
    "25 sets of 5 reps",
    "3 sets of 8–4 reps",
    "3 sets of 5 reps with 2–3 min rest",
    "3 sets of 5 reps with -2 min rest",
  ])("asks instead of guessing malformed working prescriptions: %s", (dose) => {
    const { parsed, after } = run(`Change Barbell Back Squat to ${dose}.`);
    expect(parsed.changes).toEqual([]);
    expect(parsed.questions.length).toBeGreaterThan(0);
    expect(after).toEqual(current());
  });

  it.each([
    "-20 kg × 5",
    "20 kg × 8–3",
    "20 kg × 5000",
    "20 oz × 5",
    "20 kg × 2.5",
    "20 kg × 5–5000",
    "20 kg × 5 x 3",
  ])(
    "does not silently downgrade an invalid preparation dose into notes: %s",
    (dose) => {
      const { parsed, after } = run(
        `Day A\nBefore Barbell Bench Press:\n• ${dose}`,
      );
      expect(parsed.changes).toEqual([]);
      expect(parsed.questions.length).toBeGreaterThan(0);
      expect(after).toEqual(current());
    },
  );

  it("flags ambiguous variants, repeated prescriptions, and unsupported changes", () => {
    const ambiguous = run("Before Bench Press: 20 kg × 5.");
    expect(ambiguous.parsed.changes).toEqual([]);
    expect(ambiguous.parsed.questions[0]).toContain("more than one");
    const duplicate = run(
      "Day A\nBefore flat bench: 20 kg × 5.\nBefore flat bench: 30 kg × 5.",
    );
    expect(duplicate.parsed.changes).toEqual([]);
    expect(duplicate.after).toEqual(current());
    const unsupported = run("Make the entire plan much harder");
    expect(unsupported.parsed.changes).toEqual([]);
    expect(unsupported.parsed.questions[0]).toContain("could not resolve");
  });

  it("parses explicit load units without rounding or touching other targets", () => {
    const { after } = run("Change Barbell Back Squat load to 62.5 kg.");
    expect(after.days[0].exercises[1]).toMatchObject({
      targetLoad: 62.5,
      targetLoadUnit: "kg",
    });
    expect(after.days[1]).toEqual(current().days[1]);
  });

  it.each([
    ["4 sets", { sets: 4 }],
    ["7–9 reps", { repMin: 7, repMax: 9 }],
    ["90 seconds rest", { restSec: 90 }],
  ])(
    "parses an isolated %s target without altering the other fields",
    (dose, expected) => {
      const before = current();
      const { after, parsed } = run(
        `Set Barbell Back Squat to ${dose}.`,
        before,
      );
      expect(parsed.questions).toEqual([]);
      expect(after.days[0].exercises[1]).toMatchObject(expected);
      expect(after.days[0].exercises[0]).toEqual(before.days[0].exercises[0]);
    },
  );
});
