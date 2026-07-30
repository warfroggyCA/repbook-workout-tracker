import { PRODUCTION_WORKOUT_START_WARMUP } from "./production-workout-start-contract";

export const BA_WORKOUT_EMAIL = "ba.iphone.e2e@example.com";

export const BA_WORKOUT_FIXTURE = {
  identity: {
    email: BA_WORKOUT_EMAIL,
    name: "BA iPhone acceptance",
  },
  profile: {
    ageRange: "50-59",
    experience: "intermediate" as const,
    goals: ["strength", "consistency", "muscle tone"],
    sessionLengthMin: 45,
    weeklyFrequency: 3,
    unit: "lb" as const,
    timezone: "America/Toronto",
  },
  constraints: [
    {
      bodyPart: "shoulder",
      affectedPatterns: ["vertical_push", "horizontal_push"],
      cautious: true,
      painStopThreshold: 3,
      note: "Pressing and overhead work require caution.",
    },
    {
      bodyPart: "knee",
      affectedPatterns: ["squat", "lunge"],
      cautious: true,
      painStopThreshold: 3,
      note: "Deep knee flexion and lower-body volume require caution.",
    },
  ],
  equipment: {
    items: [
      { type: "rack" as const, label: "Power rack", attrs: {} },
      {
        type: "bench" as const,
        label: "Adjustable bench",
        attrs: { adjustableBench: true },
      },
      {
        type: "barbell" as const,
        label: "Olympic barbell — 45 lb",
        attrs: { notes: "Uses Olympic plates." },
      },
      {
        type: "ez_bar" as const,
        label: "EZ curl bar — 18 lb",
        attrs: { notes: "Acceptance total-load baseline is an unloaded 18 lb." },
      },
      {
        type: "dumbbell" as const,
        label: "Adjustable dumbbells — 5 to 50 lb pair",
        attrs: {
          minWeight: 5,
          maxWeight: 50,
          unit: "lb" as const,
          adjustable: true,
          pair: true,
          increments: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50],
        },
      },
      {
        type: "bands" as const,
        label: "Resistance bands",
        attrs: { levels: ["light", "medium", "heavy"] },
      },
      {
        type: "cable" as const,
        label: "Single adjustable cable station",
        attrs: { notes: "One adjustable pulley with a rope attachment." },
      },
      {
        type: "machine" as const,
        label: "Plate-loaded lat pulldown",
        attrs: { notes: "Plate-loaded; displayed loads are assembled totals." },
      },
    ],
    plates: [
      { denomination: 45, quantity: 2 },
      { denomination: 25, quantity: 2 },
      { denomination: 10, quantity: 4 },
      { denomination: 5, quantity: 4 },
      { denomination: 2.5, quantity: 2 },
      { denomination: 1.25, quantity: 2 },
    ],
    bars: [
      { barType: "olympic", barWeight: 45, label: "Olympic bar" },
      { barType: "ez", barWeight: 18, label: "EZ curl bar" },
    ],
  },
  program: {
    name: "BA Three-Day Workout Acceptance",
    days: [
      {
        name: "Day A — Technique and superset",
        notes: "Use controlled repetitions and keep the paired work in order.",
        warmupNotes: "Five minutes easy, then complete the listed ramp-up sets.",
        exercises: [
          {
            name: "Barbell Back Squat",
            sets: 3,
            repMin: 6,
            repMax: 8,
            targetLoad: 95,
            restSec: 150,
            supersetKey: null,
            notes: "Brace before descending and keep each repetition controlled.",
            warmupNotes: "Build gradually before the first work set.",
            warmupSets: PRODUCTION_WORKOUT_START_WARMUP,
            setNotes: ["Leave two clean repetitions in reserve.", null, "Stop if knee discomfort changes your movement."],
          },
          {
            name: "Dumbbell Bench Press",
            sets: 3,
            repMin: 8,
            repMax: 10,
            targetLoad: 30,
            restSec: 90,
            supersetKey: null,
            notes: "Keep shoulders supported and use a steady tempo.",
            setNotes: [null, "Match the first set's setup.", null],
          },
          {
            name: "Dumbbell Lateral Raise",
            sets: 2,
            repMin: 12,
            repMax: 15,
            targetLoad: 10,
            restSec: 60,
            supersetKey: "day-a-pair",
            supersetRestAfterRoundSec: 75,
            notes: "Raise without shrugging.",
            setNotes: [null, null],
          },
          {
            name: "Pallof Press",
            sets: 2,
            repMin: 12,
            repMax: 15,
            targetLoad: null,
            restSec: 60,
            supersetKey: "day-a-pair",
            supersetRestAfterRoundSec: 75,
            notes: "Resist rotation and pause fully extended.",
            setNotes: [null, "Use the same band tension."],
          },
        ],
      },
      {
        name: "Day B — Hinge and recovery",
        notes: "Recovery, pain, substitution, and skipped-work acceptance day.",
        warmupNotes: "Warm the hinge and shoulders before working sets.",
        exercises: [
          { name: "Romanian Deadlift", sets: 3, repMin: 8, repMax: 10, targetLoad: 115, restSec: 150, supersetKey: null, notes: "Keep the bar close and stop before position changes.", setNotes: [null, null, "Use this set for the difficult-exposure checkpoint."] },
          { name: "Barbell Overhead Press", sets: 3, repMin: 6, repMax: 8, targetLoad: 65, restSec: 120, supersetKey: null, notes: "Use the shoulder caution and stop for significant pain.", setNotes: [null, null, null] },
          { name: "Band Lat Pulldown", sets: 3, repMin: 10, repMax: 12, targetLoad: null, restSec: 75, supersetKey: null, notes: "Record band work without a misleading zero-pound load.", setNotes: ["Medium band", "Medium band", "Medium band"] },
          { name: "EZ-Bar Curl", sets: 2, repMin: 10, repMax: 12, targetLoad: 18, restSec: 60, supersetKey: null, notes: "Begin from the unloaded 18 lb bar baseline.", setNotes: [null, null] },
        ],
      },
      {
        name: "Day C — Bench and bodyweight",
        notes: "Bench progression, bodyweight presentation, and interruption recovery.",
        warmupNotes: "Prepare the shoulders, then ramp the bench press.",
        exercises: [
          { name: "Barbell Bench Press", sets: 3, repMin: 6, repMax: 8, targetLoad: 115, restSec: 150, supersetKey: null, notes: "Pause briefly and keep the same setup.", setNotes: [null, null, null] },
          { name: "Dumbbell Row", sets: 3, repMin: 8, repMax: 10, targetLoad: 35, restSec: 90, supersetKey: null, notes: "Support the torso on the bench.", setNotes: [null, null, null] },
          { name: "Plank", sets: 3, repMin: 1, repMax: 1, targetLoad: null, restSec: 60, supersetKey: null, notes: "Each repetition represents one timed hold; do not show 0 lb.", setNotes: ["30-second hold", "30-second hold", "30-second hold"] },
        ],
      },
    ],
  },
  startingState: {
    completedWorkoutCount: 0,
    activeWorkoutCount: 0,
    coachMessageCount: 0,
    recommendationCount: 0,
    expectedTodayDay: "Day A — Technique and superset",
  },
  knownLimitations: [
    "The current schema stores one account-level plate pool and cannot assign different compatible plates to each bar.",
    "Until a guarded server clock exists, UI-recorded campaign workouts use the run date.",
  ],
} as const;

export type BaWorkoutFixture = typeof BA_WORKOUT_FIXTURE;
