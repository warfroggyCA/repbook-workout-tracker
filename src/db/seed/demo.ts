import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import {
  users,
  userProfiles,
  constraints,
  equipmentItems,
  plateInventory,
  barbellConfigs,
  exercises,
  programs,
  programVersions,
  workoutTemplates,
  supersetGroups,
  workoutTemplateExercises,
  exercisePrescriptions,
  workoutSessions,
  sessionExercises,
  sessionOccurrences,
  completedSets,
  painLogs,
  sessionNotes,
  auditLogs,
} from "@/db/schema";
import {
  addLocalDays,
  workoutLocalDate,
} from "@/lib/workout-calendar";
import { resolveRetrospectiveWallTime } from "@/lib/retrospective-workout";

const DEMO_EMAIL = "owner@example.com";
const DEMO_TIMEZONE = "America/Toronto";

type SlotSpec = {
  exercise: string;
  sets: number;
  repMin: number;
  repMax: number;
  load: number | null;
  restSec: number;
  superset?: string; // slots sharing a key are paired
};

const templateSpecs: { name: string; slots: SlotSpec[] }[] = [
  {
    name: "Day A — Squat",
    slots: [
      { exercise: "Barbell Back Squat", sets: 3, repMin: 6, repMax: 8, load: 95, restSec: 150 },
      { exercise: "Dumbbell Bench Press", sets: 3, repMin: 8, repMax: 10, load: 30, restSec: 90 },
      { exercise: "Dumbbell Row", sets: 3, repMin: 8, repMax: 10, load: 35, restSec: 90 },
      { exercise: "Dumbbell Lateral Raise", sets: 2, repMin: 12, repMax: 15, load: 10, restSec: 60, superset: "s1" },
      { exercise: "Pallof Press", sets: 2, repMin: 12, repMax: 15, load: null, restSec: 60, superset: "s1" },
    ],
  },
  {
    name: "Day B — Hinge",
    slots: [
      { exercise: "Romanian Deadlift", sets: 3, repMin: 8, repMax: 10, load: 115, restSec: 150 },
      { exercise: "Barbell Overhead Press", sets: 3, repMin: 6, repMax: 8, load: 65, restSec: 120 },
      { exercise: "Band Lat Pulldown", sets: 3, repMin: 10, repMax: 12, load: null, restSec: 75 },
      { exercise: "Kettlebell Goblet Squat", sets: 3, repMin: 10, repMax: 12, load: 35, restSec: 90 },
      { exercise: "EZ-Bar Curl", sets: 2, repMin: 10, repMax: 12, load: 40, restSec: 60 },
    ],
  },
  {
    name: "Day C — Bench",
    slots: [
      { exercise: "Barbell Bench Press", sets: 3, repMin: 6, repMax: 8, load: 115, restSec: 150 },
      { exercise: "Barbell Row", sets: 3, repMin: 8, repMax: 10, load: 95, restSec: 120 },
      { exercise: "Dumbbell Reverse Lunge", sets: 3, repMin: 8, repMax: 10, load: 20, restSec: 90 },
      { exercise: "Dumbbell Overhead Triceps Extension", sets: 2, repMin: 10, repMax: 12, load: 25, restSec: 60 },
      { exercise: "Band Face Pull", sets: 2, repMin: 15, repMax: 20, load: null, restSec: 60 },
    ],
  },
];

/** One performed exercise in the demo history. */
type PerfSpec = {
  slot: number; // index into template slots
  sets: Array<{ w: number | null; r: number; rpe?: number }>;
  skipped?: "time" | "pain" | "fatigue" | "equipment";
  substitute?: string; // exercise name performed instead
  pain?: { bodyPart: string; severity: number; note?: string };
  note?: string;
};

type SessionSpec = {
  daysAgo: number;
  template: number; // index into templateSpecs
  note?: string;
  perfs: PerfSpec[];
};

// 5 weeks: W2 misses Day C, W3 is a full gap (vacation), W4-5 carry a
// shoulder-pain event on OHP, an OHP→DB press substitution, and a bench stall.
const historySpecs: SessionSpec[] = [
  // Week 1 — all three sessions, targets mostly hit
  { daysAgo: 35, template: 0, perfs: [
    { slot: 0, sets: [{ w: 95, r: 8 }, { w: 95, r: 8 }, { w: 95, r: 7, rpe: 8 }] },
    { slot: 1, sets: [{ w: 30, r: 10 }, { w: 30, r: 9 }, { w: 30, r: 8, rpe: 8 }] },
    { slot: 2, sets: [{ w: 35, r: 10 }, { w: 35, r: 10 }, { w: 35, r: 9 }] },
    { slot: 3, sets: [{ w: 10, r: 15 }, { w: 10, r: 13 }] },
    { slot: 4, sets: [{ w: null, r: 12 }, { w: null, r: 12 }] },
  ]},
  { daysAgo: 33, template: 1, perfs: [
    { slot: 0, sets: [{ w: 115, r: 10 }, { w: 115, r: 9 }, { w: 115, r: 8 }] },
    { slot: 1, sets: [{ w: 65, r: 8 }, { w: 65, r: 7 }, { w: 65, r: 6, rpe: 8 }] },
    { slot: 2, sets: [{ w: null, r: 12 }, { w: null, r: 11 }, { w: null, r: 10 }] },
    { slot: 3, sets: [{ w: 35, r: 12 }, { w: 35, r: 12 }, { w: 35, r: 10 }] },
    { slot: 4, sets: [{ w: 40, r: 12 }, { w: 40, r: 10 }] },
  ]},
  { daysAgo: 31, template: 2, note: "Good session, bench moving well.", perfs: [
    { slot: 0, sets: [{ w: 115, r: 8 }, { w: 115, r: 7 }, { w: 115, r: 7, rpe: 8 }] },
    { slot: 1, sets: [{ w: 95, r: 10 }, { w: 95, r: 9 }, { w: 95, r: 8 }] },
    { slot: 2, sets: [{ w: 20, r: 10 }, { w: 20, r: 10 }, { w: 20, r: 8 }] },
    { slot: 3, sets: [{ w: 25, r: 12 }, { w: 25, r: 10 }] },
    { slot: 4, sets: [{ w: null, r: 20 }, { w: null, r: 16 }] },
  ]},
  // Week 2 — Day C missed entirely
  { daysAgo: 28, template: 0, perfs: [
    { slot: 0, sets: [{ w: 95, r: 8 }, { w: 95, r: 8 }, { w: 95, r: 8, rpe: 7 }] },
    { slot: 1, sets: [{ w: 30, r: 10 }, { w: 30, r: 10 }, { w: 30, r: 9 }] },
    { slot: 2, sets: [{ w: 35, r: 10 }, { w: 35, r: 10 }, { w: 35, r: 10 }] },
    { slot: 3, sets: [{ w: 10, r: 15 }, { w: 10, r: 14 }] },
    { slot: 4, sets: [{ w: null, r: 12 }, { w: null, r: 12 }] },
  ]},
  { daysAgo: 26, template: 1, note: "Ran short on time, dropped curls.", perfs: [
    { slot: 0, sets: [{ w: 115, r: 10 }, { w: 115, r: 10 }, { w: 115, r: 9 }] },
    { slot: 1, sets: [{ w: 65, r: 8 }, { w: 65, r: 8 }, { w: 65, r: 7, rpe: 8 }] },
    { slot: 2, sets: [{ w: null, r: 12 }, { w: null, r: 12 }, { w: null, r: 11 }] },
    { slot: 3, sets: [{ w: 35, r: 12 }, { w: 35, r: 12 }, { w: 35, r: 12 }] },
    { slot: 4, sets: [], skipped: "time" },
  ]},
  // Week 3 — vacation, no sessions (14-day gap before next)
  // Week 4 — back; loads eased on Day A; shoulder pain on OHP; bench stalls
  { daysAgo: 14, template: 0, note: "First one back after vacation.", perfs: [
    { slot: 0, sets: [{ w: 85, r: 8 }, { w: 85, r: 8 }, { w: 85, r: 8, rpe: 7 }] },
    { slot: 1, sets: [{ w: 30, r: 9 }, { w: 30, r: 8 }, { w: 30, r: 8 }] },
    { slot: 2, sets: [{ w: 35, r: 10 }, { w: 35, r: 9 }, { w: 35, r: 9 }] },
    { slot: 3, sets: [{ w: 10, r: 14 }, { w: 10, r: 12 }] },
    { slot: 4, sets: [{ w: null, r: 12 }, { w: null, r: 10 }] },
  ]},
  { daysAgo: 12, template: 1, perfs: [
    { slot: 0, sets: [{ w: 115, r: 10 }, { w: 115, r: 9 }, { w: 115, r: 9 }] },
    { slot: 1, sets: [{ w: 65, r: 7 }, { w: 65, r: 6, rpe: 9 }, { w: 65, r: 4, rpe: 9.5 }],
      pain: { bodyPart: "shoulder", severity: 4, note: "Pinch at the top on the last two sets." },
      note: "Cut OHP short, shoulder pinching." },
    { slot: 2, sets: [{ w: null, r: 12 }, { w: null, r: 11 }, { w: null, r: 11 }] },
    { slot: 3, sets: [{ w: 35, r: 12 }, { w: 35, r: 12 }, { w: 35, r: 11 }] },
    { slot: 4, sets: [{ w: 40, r: 12 }, { w: 40, r: 11 }] },
  ]},
  { daysAgo: 10, template: 2, perfs: [
    { slot: 0, sets: [{ w: 115, r: 7 }, { w: 115, r: 6, rpe: 9 }, { w: 115, r: 5, rpe: 9.5 }],
      note: "Bench felt heavy today." },
    { slot: 1, sets: [{ w: 95, r: 10 }, { w: 95, r: 10 }, { w: 95, r: 9 }] },
    { slot: 2, sets: [{ w: 20, r: 10 }, { w: 20, r: 9 }, { w: 20, r: 8 }] },
    { slot: 3, sets: [{ w: 25, r: 12 }, { w: 25, r: 11 }] },
    { slot: 4, sets: [{ w: null, r: 20 }, { w: null, r: 18 }] },
  ]},
  // Week 5 — OHP substituted for DB press; bench stalls again
  { daysAgo: 7, template: 0, perfs: [
    { slot: 0, sets: [{ w: 95, r: 8 }, { w: 95, r: 8 }, { w: 95, r: 8, rpe: 7 }] },
    { slot: 1, sets: [{ w: 30, r: 10 }, { w: 30, r: 10 }, { w: 30, r: 10, rpe: 7 }] },
    { slot: 2, sets: [{ w: 35, r: 10 }, { w: 35, r: 10 }, { w: 35, r: 10 }] },
    { slot: 3, sets: [{ w: 10, r: 15 }, { w: 10, r: 15 }] },
    { slot: 4, sets: [{ w: null, r: 14 }, { w: null, r: 12 }] },
  ]},
  { daysAgo: 5, template: 1, note: "Swapped OHP for seated DB press, shoulder felt fine.", perfs: [
    { slot: 0, sets: [{ w: 115, r: 10 }, { w: 115, r: 10 }, { w: 115, r: 10, rpe: 8 }] },
    { slot: 1, substitute: "Seated Dumbbell Shoulder Press",
      sets: [{ w: 25, r: 10 }, { w: 25, r: 9 }, { w: 25, r: 8 }] },
    { slot: 2, sets: [{ w: null, r: 12 }, { w: null, r: 12 }, { w: null, r: 12 }] },
    { slot: 3, sets: [{ w: 35, r: 12 }, { w: 35, r: 12 }, { w: 35, r: 12 }] },
    { slot: 4, sets: [{ w: 40, r: 12 }, { w: 40, r: 12 }] },
  ]},
  { daysAgo: 3, template: 2, note: "Bench stuck again at 115.", perfs: [
    { slot: 0, sets: [{ w: 115, r: 7 }, { w: 115, r: 6, rpe: 9 }, { w: 115, r: 6, rpe: 9 }] },
    { slot: 1, sets: [{ w: 95, r: 10 }, { w: 95, r: 10 }, { w: 95, r: 10 }] },
    { slot: 2, sets: [{ w: 20, r: 10 }, { w: 20, r: 10 }, { w: 20, r: 9 }] },
    { slot: 3, sets: [{ w: 25, r: 12 }, { w: 25, r: 12 }] },
    { slot: 4, sets: [{ w: null, r: 20 }, { w: null, r: 20 }] },
  ]},
];

function demoInstantDaysAgo(n: number, hour: number, now: Date): Date {
  const localDate = addLocalDays(
    workoutLocalDate(now, DEMO_TIMEZONE),
    -n,
  );
  const resolution = resolveRetrospectiveWallTime({
    localDate,
    localTime: `${String(hour).padStart(2, "0")}:15:00`,
    timezone: DEMO_TIMEZONE,
  });
  if (resolution.outcome !== "unique") {
    throw new Error("Demo workout time must resolve to one exact instant.");
  }
  return resolution.instant;
}

/** Seeds the demo user, equipment, program, and ~5 weeks of history. */
export async function seedDemo(db: Db): Promise<string> {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, DEMO_EMAIL),
  });
  if (existing) return `demo user already exists (${existing.id}), skipped`;
  const seedReferenceTime = new Date();
  const daysAgo = (days: number, hour = 17) =>
    demoInstantDaysAgo(days, hour, seedReferenceTime);

  const [user] = await db
    .insert(users)
    .values({ email: DEMO_EMAIL, name: "Demo Owner" })
    .returning();

  await db.insert(userProfiles).values({
    userId: user.id,
    ageRange: "50-59",
    experience: "intermediate",
    goals: ["strength", "muscle tone", "consistency"],
    sessionLengthMin: 45,
    weeklyFrequency: 3,
    unit: "lb",
    setupCompletedAt: daysAgo(36),
  });

  await db.insert(constraints).values([
    {
      userId: user.id,
      bodyPart: "shoulder",
      affectedPatterns: ["vertical_push", "horizontal_push"],
      cautious: true,
      painStopThreshold: 3,
      note: "Pressing, dips, and overhead work can aggravate it.",
    },
    {
      userId: user.id,
      bodyPart: "knee",
      affectedPatterns: ["lunge", "squat"],
      cautious: true,
      painStopThreshold: 3,
      note: "Deep lunges and aggressive lower-body volume irritate knees.",
    },
  ]);

  const seededEquipment = await db.insert(equipmentItems).values([
    { userId: user.id, type: "rack", label: "Squat rack" },
    { userId: user.id, type: "bench", label: "Adjustable bench", attrs: { adjustableBench: true } },
    { userId: user.id, type: "barbell", label: "Olympic barbell (45 lb)", attrs: { maxWeight: 45 } },
    { userId: user.id, type: "ez_bar", label: "EZ curl bar (18 lb)", attrs: { maxWeight: 18 } },
    { userId: user.id, type: "dumbbell", label: "Adjustable dumbbells (5–35 lb pair)",
      attrs: { minWeight: 5, maxWeight: 35, adjustable: true, pair: true, increments: [5, 10, 15, 20, 25, 30, 35] } },
    { userId: user.id, type: "kettlebell", label: "Adjustable kettlebell (18–35 lb)",
      attrs: { minWeight: 18, maxWeight: 35, adjustable: true } },
    { userId: user.id, type: "bands", label: "Bodylastics resistance bands", attrs: { brand: "Bodylastics" } },
    { userId: user.id, type: "jump_rope", label: "Skipping rope" },
    { userId: user.id, type: "elliptical", label: "Elliptical" },
    { userId: user.id, type: "plates", label: "Olympic plates" },
    { userId: user.id, type: "bodyweight", label: "Bodyweight" },
  ]).returning({
    id: equipmentItems.id,
    label: equipmentItems.label,
  });
  const equipmentId = new Map(
    seededEquipment.map((item) => [item.label, item.id]),
  );
  const requiredEquipmentId = (label: string) => {
    const id = equipmentId.get(label);
    if (!id) throw new Error(`Seed equipment item missing: ${label}`);
    return id;
  };

  await db.insert(plateInventory).values([
    { userId: user.id, denomination: 45, quantity: 2 },
    { userId: user.id, denomination: 25, quantity: 2 },
    { userId: user.id, denomination: 10, quantity: 2 },
    { userId: user.id, denomination: 5, quantity: 4 },
    { userId: user.id, denomination: 2.5, quantity: 2 },
  ]);

  await db.insert(barbellConfigs).values([
    {
      userId: user.id,
      barType: "olympic",
      equipmentItemId: requiredEquipmentId("Olympic barbell (45 lb)"),
      unit: "lb",
      loadingKind: "olympic",
      sharedPlatePoolCompatible: true,
      barWeight: 45,
      label: "Olympic barbell (45 lb)",
    },
    {
      userId: user.id,
      barType: "ez",
      equipmentItemId: requiredEquipmentId("EZ curl bar (18 lb)"),
      unit: "lb",
      loadingKind: "ez",
      sharedPlatePoolCompatible: true,
      barWeight: 18,
      label: "EZ curl bar (18 lb)",
    },
  ]);

  // Resolve library exercises by name
  const names = new Set<string>();
  for (const t of templateSpecs) for (const s of t.slots) names.add(s.exercise);
  for (const h of historySpecs)
    for (const p of h.perfs) if (p.substitute) names.add(p.substitute);
  const exRows = await db
    .select({
      id: exercises.id,
      name: exercises.name,
      loadType: exercises.loadType,
      loadSemantics: exercises.loadSemantics,
      metricType: exercises.metricType,
    })
    .from(exercises)
    .where(inArray(exercises.name, [...names]));
  const exByName = new Map(exRows.map((r) => [r.name, r.id]));
  const exSemanticsById = new Map(exRows.map((r) => [r.id, r]));
  for (const n of names)
    if (!exByName.has(n)) throw new Error(`Seed exercise missing from library: ${n}`);

  // Demo seeding builds the same immutable tree in several readable steps.
  // Authorize only this disposable seed connection and keep the Program
  // archived until its complete v1 tree is present.
  await db.execute(sql`SELECT set_config('workout_tracker.program_publish', 'authorized', false)`);
  const [program] = await db
    .insert(programs)
    .values({
      userId: user.id,
      name: "3-Day Full Body",
      status: "archived",
      archivedAt: new Date(),
    })
    .returning();
  const [version] = await db
    .insert(programVersions)
    .values({
      programId: program.id,
      versionNo: 1,
      name: "3-Day Full Body",
      activatedAt: daysAgo(36),
      changeSummary: "Initial program from guided setup",
    })
    .returning();

  // Templates, slots, prescriptions
  const slotIds: string[][] = [];
  const slotLineageById = new Map<string, string>();
  for (let t = 0; t < templateSpecs.length; t++) {
    const spec = templateSpecs[t];
    const [template] = await db
      .insert(workoutTemplates)
      .values({ programVersionId: version.id, name: spec.name, orderIdx: t })
      .returning();

    const supersetIds = new Map<string, string>();
    for (const slot of spec.slots) {
      if (slot.superset && !supersetIds.has(slot.superset)) {
        const [group] = await db
          .insert(supersetGroups)
          .values({
            workoutTemplateId: template.id,
            orderIdx: supersetIds.size,
            restAfterRoundSec: slot.restSec,
          })
          .returning();
        supersetIds.set(slot.superset, group.id);
      }
    }

    const ids: string[] = [];
    for (let i = 0; i < spec.slots.length; i++) {
      const slot = spec.slots[i];
      const [wte] = await db
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: template.id,
          exerciseId: exByName.get(slot.exercise)!,
          orderIdx: i,
          supersetGroupId: slot.superset ? supersetIds.get(slot.superset) : null,
          restSec: slot.restSec,
        })
        .returning();
      ids.push(wte.id);
      slotLineageById.set(wte.id, wte.lineageId);
      await db.insert(exercisePrescriptions).values({
        templateExerciseId: wte.id,
        sets: slot.sets,
        repRangeMin: slot.repMin,
        repRangeMax: slot.repMax,
        targetLoad: slot.load,
        targetLoadUnit: slot.load == null ? null : "lb",
        effectiveFrom: daysAgo(36),
      });
    }
    slotIds.push(ids);
  }

  await db.update(programs).set({
    status: "active",
    currentVersionId: version.id,
    archivedAt: null,
  }).where(eq(programs.id, program.id));

  // History
  const templateRows = await db.query.workoutTemplates.findMany({
    where: eq(workoutTemplates.programVersionId, version.id),
  });
  const templateByIdx = new Map(templateRows.map((r) => [r.orderIdx, r]));

  for (const spec of historySpecs) {
    const template = templateByIdx.get(spec.template)!;
    const tSpec = templateSpecs[spec.template];
    const startedAt = daysAgo(spec.daysAgo);
    const finishedAt = new Date(startedAt.getTime() + 42 * 60 * 1000);
    const [session] = await db
      .insert(workoutSessions)
      .values({
        userId: user.id,
        templateId: template.id,
        templateName: template.name,
        sourceProgramId: program.id,
        sourceProgramVersionId: version.id,
        sourceDayLineageId: template.lineageId,
        status: "completed",
        startedAt,
        finishedAt,
        timezone: DEMO_TIMEZONE,
        localDate: workoutLocalDate(startedAt, DEMO_TIMEZONE),
      })
      .returning();

    if (spec.note) {
      await db
        .insert(sessionNotes)
        .values({ sessionId: session.id, text: spec.note, createdAt: finishedAt });
    }

    let occurrenceSequence = 0;
    for (const perf of spec.perfs) {
      const slot = tSpec.slots[perf.slot];
      const plannedExerciseId = exByName.get(slot.exercise)!;
      const performedExerciseId = perf.substitute
        ? exByName.get(perf.substitute)!
        : plannedExerciseId;

      const [se] = await db
        .insert(sessionExercises)
        .values({
          sessionId: session.id,
          exerciseId: performedExerciseId,
          plannedFromTemplateExerciseId: slotIds[spec.template][perf.slot],
          sourceSlotLineageId: slotLineageById.get(
            slotIds[spec.template][perf.slot],
          ),
          modificationType: perf.skipped
            ? "skipped"
            : perf.substitute
              ? "substituted"
              : "as_planned",
          skipReason: perf.skipped ?? null,
          substitutedForExerciseId: perf.substitute ? plannedExerciseId : null,
          orderIdx: perf.slot,
          restSec: slot.restSec,
          targetSets: slot.sets,
          targetRepsMin: slot.repMin,
          targetRepsMax: slot.repMax,
          targetLoad: slot.load,
          targetLoadUnit: slot.load == null ? null : "lb",
          notes: perf.note ?? null,
        })
        .returning();

      if (perf.sets.length) {
        const performedSemantics = exSemanticsById.get(performedExerciseId);
        if (!performedSemantics) {
          throw new Error("Seed performed exercise semantics are unavailable.");
        }
        const insertedSets = await db.insert(completedSets).values(
          perf.sets.map((s, i) => ({
            sessionExerciseId: se.id,
            setNo: i + 1,
            metricType: performedSemantics.metricType,
            performedSemanticsVersion: 1,
            performedLoadType: performedSemantics.loadType,
            performedLoadSemantics: performedSemantics.loadSemantics,
            weight: s.w,
            weightUnit: s.w == null ? null : ("lb" as const),
            reps: s.r,
            rpe: s.rpe ?? null,
            targetMet:
              s.r >= slot.repMin &&
              (slot.load == null || (s.w ?? 0) >= slot.load),
            restTakenSec: slot.restSec,
            loggedAt: new Date(startedAt.getTime() + (perf.slot * 8 + i * 2.5) * 60 * 1000),
          }))
        ).returning({
          id: completedSets.id,
          setNo: completedSets.setNo,
          loggedAt: completedSets.loggedAt,
        });
        await db.insert(sessionOccurrences).values(
          insertedSets.map((set) => ({
            sessionId: session.id,
            sessionExerciseId: se.id,
            kind: "working_set",
            origin: "planned",
            sequenceIdx: occurrenceSequence++,
            kindOrdinal: set.setNo - 1,
            plannedExerciseId,
            plannedRepsMin: slot.repMin,
            plannedRepsMax: slot.repMax,
            plannedLoad: slot.load,
            plannedLoadUnit: slot.load == null ? null : ("lb" as const),
            plannedRestSec: slot.restSec,
            plannedNote: perf.note ?? null,
            outcome: "completed",
            revision: 1,
            resolvedAt: set.loggedAt,
            completedSetId: set.id,
          })),
        );
      }

      if (perf.pain) {
        await db.insert(painLogs).values({
          userId: user.id,
          sessionId: session.id,
          exerciseId: performedExerciseId,
          bodyPart: perf.pain.bodyPart,
          severity: perf.pain.severity,
          source: "set_flag",
          note: perf.pain.note,
          createdAt: new Date(startedAt.getTime() + perf.slot * 8 * 60 * 1000),
        });
      }
    }
  }

  await db.insert(auditLogs).values({
    userId: user.id,
    actorType: "system",
    action: "seed.demo",
    entityType: "user",
    entityId: user.id,
    summary: "Demo data seeded: profile, equipment, 3-day program, 5 weeks of history.",
  });

  return `demo user created (${user.id}) with ${historySpecs.length} sessions`;
}
