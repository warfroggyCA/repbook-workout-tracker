// Sanitized copy of the legacy warm-up representation observed in the
// production Program during the July 22 iPhone start failure. The source
// intentionally retains both the structured percentage and its redundant
// written description because released Program evidence must not be rewritten.
export const PRODUCTION_WORKOUT_START_WARMUP = [
  {
    label: "empty bar",
    reps: 10,
    load: null,
    loadUnit: null,
    loadPercent: null,
    loadText: "empty bar",
    notes: "warm-up only",
  },
  {
    label: "~55% work weight",
    reps: 5,
    load: null,
    loadUnit: null,
    loadPercent: 55,
    loadText: "55% of work weight",
    notes: "warm-up only",
  },
  {
    label: "~72% work weight",
    reps: 3,
    load: null,
    loadUnit: null,
    loadPercent: 72,
    loadText: "72% of work weight",
    notes: "warm-up only",
  },
  {
    label: "~88% work weight",
    reps: 2,
    load: null,
    loadUnit: null,
    loadPercent: 88,
    loadText: "88% of work weight",
    notes: "warm-up only",
  },
] as const;

const warmupItem = (
  label: string,
  reps: number | null,
  loadText: string | null = null,
) => ({
  label,
  reps,
  load: null,
  loadUnit: null,
  loadPercent: null,
  loadText,
  notes: "warm-up only",
});

const percentRamp = (percent: number, reps: number) => ({
  label: `~${percent}% work weight`,
  reps,
  load: null,
  loadUnit: null,
  loadPercent: percent,
  loadText: `${percent}% of work weight`,
  notes: "warm-up only",
});

// Sanitized, structurally exact copy of the active production Program confirmed
// by the authorized July 22 read-only inspection. Day/slot order, shared
// exercise identities, group membership, warm-up row counts, and representation
// presence match production. Loads, repetitions, and prose remain deterministic
// acceptance values rather than a byte-for-byte export of personal training data.
export const PRODUCTION_WORKOUT_START_PROGRAM = {
  name: "Cuba Plan — workout-start regression",
  days: [
    {
      name: "Day 1 — Heavy chest + lat width + arms",
      notes: "35–45 minutes; controlled work with optional accessories only if time allows.",
      warmupNotes:
        "Elliptical 2 min easy; Push-Up 1×8–10; Arm Circles 10 forward + 10 backward; Scap Push-Up 1×8–10. Bench ramp-up: empty bar ×10, ~55% ×5, ~72% ×3, ~88% ×1–2.",
      exercises: [
        {
          name: "Barbell Bench Press",
          sets: 4,
          repMin: 5,
          repMax: 8,
          targetLoad: 115,
          restSec: 120,
          supersetKey: null,
          notes: "Keep one to two clean repetitions in reserve.",
          warmupNotes: "Complete the general warm-up and bench ramp before work sets.",
          warmupSets: [
            warmupItem("Elliptical 2 min easy", null, "2 min easy"),
            warmupItem("Push-Up", 8),
            warmupItem("Arm Circles", 20, "10 forward + 10 backward"),
            warmupItem("Scap Push-Up", 8),
            warmupItem("empty bar", 10, "empty bar"),
            percentRamp(55, 5),
            percentRamp(72, 3),
            percentRamp(88, 2),
          ],
          setNotes: [null, null, null, null],
        },
        { name: "Lat Pulldown", sets: 4, repMin: 8, repMax: 12, targetLoad: 70, restSec: 75, supersetKey: null, notes: "Control the top stretch.", setNotes: [null, null, null, null] },
        { name: "Bulgarian Split Squat", sets: 2, repMin: 8, repMax: 12, targetLoad: 25, restSec: 75, supersetKey: null, notes: "Two sets per side.", setNotes: [null, null] },
        { name: "Dumbbell Lateral Raise", sets: 3, repMin: 12, repMax: 20, targetLoad: 10, restSec: 0, supersetKey: "day-1-a", supersetRestAfterRoundSec: 60, notes: "Move directly to pressdowns.", setNotes: [null, null, null] },
        { name: "Triceps Pushdown", sets: 3, repMin: 10, repMax: 15, targetLoad: 25, restSec: 60, supersetKey: "day-1-a", supersetRestAfterRoundSec: 60, notes: "Rest after the pair.", setNotes: [null, null, null] },
        { name: "EZ-Bar Curl", sets: 3, repMin: 8, repMax: 12, targetLoad: 18, restSec: 75, supersetKey: null, notes: "Use a controlled lower.", setNotes: [null, null, null] },
        { name: "Cable Face Pull", sets: 2, repMin: 15, repMax: 20, targetLoad: 15, restSec: 60, supersetKey: null, notes: "Optional: one set minimum, two ideal when time allows.", setNotes: [null, null] },
      ],
    },
    {
      name: "Day 2 — Squat + hinge + back thickness",
      notes: "40–44 minutes; lower-body anchors followed by a controlled tri-set.",
      warmupNotes:
        "Jump Rope 2 min easy; Bodyweight Squat ×10; Hip Hinge ×10; Glute Bridge ×10; Reverse Lunge ×5 per side. Squat ramp-up: empty bar ×8–10, ~55% ×5, ~72% ×3, ~88% ×1.",
      exercises: [
        {
          name: "Barbell Back Squat",
          sets: 4,
          repMin: 5,
          repMax: 8,
          targetLoad: 135,
          restSec: 120,
          supersetKey: null,
          notes: "Use a strong repeatable stance.",
          warmupNotes: "Complete the general warm-up and squat ramp before work sets.",
          warmupSets: [
            warmupItem("Jump Rope 2 min easy", null, "2 min easy"),
            warmupItem("Bodyweight Squat", 10),
            warmupItem("Hip Hinge", 10),
            warmupItem("Glute Bridge", 10),
            warmupItem("Reverse Lunge", 10, "5 per side"),
            warmupItem("empty bar", 10, "empty bar"),
            percentRamp(55, 5),
            percentRamp(72, 3),
          ],
          setNotes: [null, null, null, null],
        },
        { name: "Romanian Deadlift", sets: 3, repMin: 8, repMax: 10, targetLoad: 115, restSec: 105, supersetKey: null, notes: "Do one lighter prep set first.", warmupNotes: "One lighter prep set ×5.", warmupSets: [warmupItem("lighter prep set", 5)], setNotes: [null, null, null] },
        { name: "Seated Cable Row", sets: 3, repMin: 10, repMax: 12, targetLoad: 70, restSec: 75, supersetKey: null, notes: "Use the bar grip and pause at the torso.", setNotes: [null, null, null] },
        { name: "Dumbbell Rear Delt Fly", sets: 2, repMin: 15, repMax: 20, targetLoad: 10, restSec: 30, supersetKey: "day-2-a", supersetRestAfterRoundSec: 90, notes: "Move to Zottman curls.", setNotes: [null, null] },
        { name: "Hammer Curl", sets: 2, repMin: 10, repMax: 12, targetLoad: 15, restSec: 90, supersetKey: "day-2-a", supersetRestAfterRoundSec: 90, notes: "Use a slow lowering phase.", setNotes: [null, null] },
        { name: "Side Plank", sets: 2, repMin: 1, repMax: 1, targetLoad: null, restSec: 45, supersetKey: null, notes: "Optional; two holds per side.", setNotes: ["per side", "per side"] },
      ],
    },
    {
      name: "Day 3 — Chest / shoulders / lats / arms",
      notes: "41–45 minutes; upper-chest and shoulder focus with paired arm work.",
      warmupNotes:
        "Elliptical 2 min easy; Push-Up ×8; Arm Circles 10 forward + 10 backward; Scap Push-Up ×8–10. Incline bench ramp-up: empty bar ×10, ~55% ×5, ~72% ×2–3.",
      exercises: [
        {
          name: "Incline Barbell Bench Press",
          sets: 3,
          repMin: 8,
          repMax: 12,
          targetLoad: 85,
          restSec: 120,
          supersetKey: null,
          notes: "Use a low incline and controlled arch.",
          warmupNotes: "Complete the general warm-up and incline ramp before work sets.",
          warmupSets: [
            warmupItem("Elliptical 2 min easy", null, "2 min easy"),
            warmupItem("Push-Up", 8),
            warmupItem("Arm Circles", 20, "10 forward + 10 backward"),
            warmupItem("Scap Push-Up", 8),
            warmupItem("empty bar", 10, "empty bar"),
            percentRamp(55, 5),
            percentRamp(72, 3),
          ],
          setNotes: [null, null, null],
        },
        { name: "Barbell Overhead Press", sets: 3, repMin: 6, repMax: 10, targetLoad: 55, restSec: 90, supersetKey: null, notes: "Brace without excessive lean.", warmupNotes: "Empty bar ×5 before work sets.", warmupSets: [warmupItem("empty bar", 5, "empty bar")], setNotes: [null, null, null] },
        { name: "Lat Pulldown", sets: 3, repMin: 10, repMax: 15, targetLoad: 70, restSec: 75, supersetKey: null, notes: "Control the top stretch.", setNotes: [null, null, null] },
        { name: "Triceps Pushdown", sets: 3, repMin: 10, repMax: 15, targetLoad: 20, restSec: 30, supersetKey: "day-3-a", supersetRestAfterRoundSec: 60, notes: "Move directly to EZ-bar curls.", setNotes: [null, null, null] },
        { name: "EZ-Bar Curl", sets: 3, repMin: 10, repMax: 15, targetLoad: 18, restSec: 60, supersetKey: "day-3-a", supersetRestAfterRoundSec: 60, notes: "Strict controlled curls.", setNotes: [null, null, null] },
        { name: "Dumbbell Lateral Raise", sets: 2, repMin: 15, repMax: 25, targetLoad: 10, restSec: 45, supersetKey: null, notes: "Shoulder-width finisher.", setNotes: [null, null] },
        { name: "Cable Face Pull", sets: 2, repMin: 15, repMax: 20, targetLoad: 15, restSec: 60, supersetKey: null, notes: "Optional when the shoulder feels good and time remains.", setNotes: [null, null] },
      ],
    },
  ],
} as const;
