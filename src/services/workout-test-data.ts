import { and, eq, inArray, isNull, like } from "drizzle-orm";
import type { Db } from "@/db";
import {
  completedSets,
  exercises,
  fatigueLogs,
  painLogs,
  sessionExercises,
  sessionOccurrences,
  sessionNotes,
  workoutSessions,
} from "@/db/schema";
import { workoutLocalDate } from "@/lib/workout-calendar";

export const TEST_DATA_PREFIX = "Sample data · ";

type Unit = "lb" | "kg";

type TestExercise = Pick<
  typeof exercises.$inferSelect,
  "id" | "name" | "loadType" | "loadSemantics" | "metricType"
>;

type Slot = {
  exercise: string;
  sets: number;
  repMin: number;
  repMax: number;
  baseLoadLb: number;
  restSec: number;
  substitute?: { exercise: string; baseLoadLb: number };
};

const templates: Array<{ name: string; slots: Slot[] }> = [
  {
    name: `${TEST_DATA_PREFIX}Day 1 — Chest & back`,
    slots: [
      { exercise: "Barbell Back Squat", sets: 4, repMin: 5, repMax: 8, baseLoadLb: 135, restSec: 120 },
      { exercise: "Barbell Bench Press", sets: 4, repMin: 5, repMax: 8, baseLoadLb: 115, restSec: 120 },
      { exercise: "Lat Pulldown", sets: 3, repMin: 8, repMax: 12, baseLoadLb: 70, restSec: 75 },
      { exercise: "Dumbbell Lateral Raise", sets: 3, repMin: 12, repMax: 20, baseLoadLb: 15, restSec: 60 },
    ],
  },
  {
    name: `${TEST_DATA_PREFIX}Day 2 — Hinge & shoulders`,
    slots: [
      { exercise: "Romanian Deadlift", sets: 3, repMin: 8, repMax: 10, baseLoadLb: 135, restSec: 105 },
      {
        exercise: "Barbell Overhead Press",
        sets: 3,
        repMin: 6,
        repMax: 10,
        baseLoadLb: 65,
        restSec: 90,
        substitute: { exercise: "Seated Dumbbell Shoulder Press", baseLoadLb: 25 },
      },
      { exercise: "Seated Cable Row", sets: 3, repMin: 10, repMax: 12, baseLoadLb: 80, restSec: 75 },
      { exercise: "Hammer Curl", sets: 2, repMin: 10, repMax: 12, baseLoadLb: 25, restSec: 60 },
    ],
  },
  {
    name: `${TEST_DATA_PREFIX}Day 3 — Upper & single-leg`,
    slots: [
      { exercise: "Incline Barbell Bench Press", sets: 3, repMin: 8, repMax: 12, baseLoadLb: 95, restSec: 90 },
      { exercise: "Bulgarian Split Squat", sets: 3, repMin: 8, repMax: 12, baseLoadLb: 25, restSec: 75 },
      { exercise: "Lat Pulldown", sets: 3, repMin: 10, repMax: 15, baseLoadLb: 75, restSec: 75 },
      { exercise: "Triceps Pushdown", sets: 3, repMin: 10, repMax: 15, baseLoadLb: 40, restSec: 60 },
    ],
  },
];

export const TEST_DATA_EXERCISE_NAMES = [
  ...new Set(
    templates.flatMap((template) =>
      template.slots.flatMap((slot) => [
        slot.exercise,
        ...(slot.substitute ? [slot.substitute.exercise] : []),
      ])
    )
  ),
];

type TestDataBundle = {
  sessions: Array<typeof workoutSessions.$inferInsert>;
  sessionExercises: Array<typeof sessionExercises.$inferInsert>;
  sets: Array<typeof completedSets.$inferInsert>;
  fatigue: Array<typeof fatigueLogs.$inferInsert>;
  pain: Array<typeof painLogs.$inferInsert>;
  notes: Array<typeof sessionNotes.$inferInsert>;
};

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfWeek(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}

function loadForUnit(loadLb: number, unit: Unit) {
  const value = unit === "kg" ? loadLb * 0.453592 : loadLb;
  return Math.round(value / 2.5) * 2.5;
}

export function buildWorkoutTestData({
  userId,
  unit,
  exerciseRows,
  timezone = "America/Toronto",
  now = new Date(),
}: {
  userId: string;
  unit: Unit;
  exerciseRows: TestExercise[];
  timezone?: string;
  now?: Date;
}): TestDataBundle {
  const exerciseByName = new Map(
    exerciseRows.map((exercise) => [exercise.name, exercise])
  );
  const missing = TEST_DATA_EXERCISE_NAMES.filter(
    (name) => !exerciseByName.has(name)
  );
  if (missing.length > 0) {
    throw new Error(`Exercise library is missing: ${missing.join(", ")}`);
  }

  const bundle: TestDataBundle = {
    sessions: [],
    sessionExercises: [],
    sets: [],
    fatigue: [],
    pain: [],
    notes: [],
  };
  const firstWeek = addDays(startOfWeek(now), -11 * 7);
  let sessionIndex = 0;

  for (let weekIndex = 0; weekIndex < 12; weekIndex += 1) {
    for (const [templateIndex, dayOffset] of [0, 2, 5].entries()) {
      const template = templates[templateIndex];
      const startedAt = addDays(firstWeek, weekIndex * 7 + dayOffset);
      startedAt.setHours(17 + templateIndex, 15, 0, 0);
      if (startedAt.getTime() > now.getTime()) continue;

      const sessionId = crypto.randomUUID();
      const abandoned = sessionIndex === 16;
      const durationMin = abandoned ? 19 : 38 + ((sessionIndex * 7) % 16);
      const finishedAt = new Date(startedAt.getTime() + durationMin * 60_000);
      bundle.sessions.push({
        id: sessionId,
        userId,
        templateName: template.name,
        status: abandoned ? "abandoned" : "completed",
        timeBudgetMin: 45,
        startedAt,
        finishedAt,
        timezone,
        localDate: workoutLocalDate(startedAt, timezone),
      });

      template.slots.forEach((slot, slotIndex) => {
        const substitute =
          weekIndex === 8 && templateIndex === 1 && slotIndex === 1
            ? slot.substitute
            : undefined;
        const plannedExercise = exerciseByName.get(slot.exercise)!;
        const performedExercise = exerciseByName.get(
          substitute?.exercise ?? slot.exercise
        )!;
        const skipped =
          (abandoned && slotIndex >= 2) ||
          (!abandoned && sessionIndex % 10 === 5 && slotIndex === 3);
        const baseLoadLb = substitute?.baseLoadLb ?? slot.baseLoadLb;
        const progressionLb =
          baseLoadLb <= 30
            ? Math.floor(weekIndex / 6) * 2.5
            : Math.floor(weekIndex / 3) * 5;
        const targetLoad = loadForUnit(
          baseLoadLb + progressionLb,
          unit
        );
        const sessionExerciseId = crypto.randomUUID();

        bundle.sessionExercises.push({
          id: sessionExerciseId,
          sessionId,
          exerciseId: performedExercise.id,
          modificationType: skipped
            ? "skipped"
            : substitute
              ? "substituted"
              : "as_planned",
          skipReason: skipped ? (abandoned ? "time" : "fatigue") : null,
          substitutedForExerciseId: substitute ? plannedExercise.id : null,
          orderIdx: slotIndex,
          restSec: slot.restSec,
          targetSets: slot.sets,
          targetRepsMin: slot.repMin,
          targetRepsMax: slot.repMax,
          targetLoad,
          targetLoadUnit: unit,
          notes: substitute
            ? "Sample substitution after a shoulder discomfort flag."
            : null,
        });

        if (skipped) return;
        for (let setIndex = 0; setIndex < slot.sets; setIndex += 1) {
          const miss = (sessionIndex + slotIndex * 3 + setIndex) % 13 === 0;
          const repSpan = slot.repMax - slot.repMin + 1;
          const reps = miss
            ? Math.max(1, slot.repMin - 1)
            : slot.repMin + ((sessionIndex + slotIndex + setIndex) % repSpan);
          const rpe = Math.min(
            9.5,
            7 + ((sessionIndex + slotIndex + setIndex) % 6) * 0.4
          );
          bundle.sets.push({
            id: crypto.randomUUID(),
            sessionExerciseId,
            setNo: setIndex + 1,
            metricType: performedExercise.metricType,
            performedSemanticsVersion: 1,
            performedLoadType: performedExercise.loadType,
            performedLoadSemantics: performedExercise.loadSemantics,
            weight: targetLoad,
            weightUnit: unit,
            reps,
            rpe: Math.round(rpe * 10) / 10,
            targetMet: !miss,
            restTakenSec: slot.restSec + ((setIndex % 3) - 1) * 5,
            note:
              setIndex === slot.sets - 1 && sessionIndex % 9 === 2
                ? "Strong final set."
                : null,
            loggedAt: new Date(
              startedAt.getTime() + (slotIndex * 9 + setIndex * 2 + 4) * 60_000
            ),
          });
        }
      });

      if (!abandoned) {
        bundle.fatigue.push({
          id: crypto.randomUUID(),
          userId,
          sessionId,
          severity: 2 + ((sessionIndex * 3) % 4),
          note: sessionIndex % 8 === 4 ? "Sleep was a little short." : null,
          createdAt: finishedAt,
        });
      }

      if (sessionIndex === 6 || sessionIndex === 22) {
        const shoulder = sessionIndex === 22;
        bundle.pain.push({
          id: crypto.randomUUID(),
          userId,
          sessionId,
          exerciseId: exerciseByName.get(
            shoulder ? "Barbell Overhead Press" : "Barbell Back Squat"
          )!.id,
          bodyPart: shoulder ? "shoulder" : "knee",
          severity: shoulder ? 4 : 2,
          source: "set_flag",
          note: shoulder
            ? "Sample flag: pinching near the top of the press."
            : "Sample flag: mild discomfort that settled after the warm-up.",
          createdAt: new Date(startedAt.getTime() + 14 * 60_000),
        });
      }

      if (sessionIndex % 6 === 1) {
        bundle.notes.push({
          id: crypto.randomUUID(),
          sessionId,
          text:
            sessionIndex % 12 === 1
              ? "Good energy today; the main lifts moved cleanly."
              : "Kept the pace steady and finished inside the time target.",
          createdAt: finishedAt,
        });
      }

      sessionIndex += 1;
    }
  }

  return bundle;
}

export async function getWorkoutTestDataCount(db: Db, userId: string) {
  const rows = await db
    .select({ id: workoutSessions.id })
    .from(workoutSessions)
    .where(
      and(
        eq(workoutSessions.userId, userId),
        like(workoutSessions.templateName, `${TEST_DATA_PREFIX}%`),
        isNull(workoutSessions.archivedAt)
      )
    );
  return rows.length;
}

export async function insertWorkoutTestData(
  db: Db,
  userId: string,
  unit: Unit,
  timezone: string,
  now = new Date()
) {
  const exerciseRows = await db.query.exercises.findMany({
    where: inArray(exercises.name, TEST_DATA_EXERCISE_NAMES),
    columns: {
      id: true,
      name: true,
      loadType: true,
      loadSemantics: true,
      metricType: true,
    },
  });
  const data = buildWorkoutTestData({
    userId,
    unit,
    timezone,
    exerciseRows,
    now,
  });

  await db.insert(workoutSessions).values(data.sessions);
  await db.insert(sessionExercises).values(data.sessionExercises);
  await db.insert(completedSets).values(data.sets);
  const exerciseById = new Map(
    data.sessionExercises.map((exercise) => [exercise.id, exercise]),
  );
  const nextSequenceBySession = new Map<string, number>();
  const occurrences = [...data.sets]
    .sort((left, right) => {
      const leftExercise = exerciseById.get(left.sessionExerciseId)!;
      const rightExercise = exerciseById.get(right.sessionExerciseId)!;
      if (leftExercise.sessionId !== rightExercise.sessionId) {
        return leftExercise.sessionId.localeCompare(rightExercise.sessionId);
      }
      return (
        (leftExercise.orderIdx ?? 0) - (rightExercise.orderIdx ?? 0) ||
        left.setNo - right.setNo
      );
    })
    .map((set) => {
      const exercise = exerciseById.get(set.sessionExerciseId)!;
      const sequenceIdx = nextSequenceBySession.get(exercise.sessionId) ?? 0;
      nextSequenceBySession.set(exercise.sessionId, sequenceIdx + 1);
      return {
        sessionId: exercise.sessionId,
        sessionExerciseId: exercise.id,
        kind: "working_set",
        origin: "legacy",
        sequenceIdx,
        kindOrdinal: set.setNo - 1,
        plannedExerciseId:
          exercise.substitutedForExerciseId ?? exercise.exerciseId,
        plannedRepsMin: exercise.targetRepsMin,
        plannedRepsMax: exercise.targetRepsMax,
        plannedLoad: exercise.targetLoad,
        plannedLoadUnit: exercise.targetLoadUnit,
        plannedRestSec: exercise.restSec,
        plannedNote: exercise.notes,
        outcome: "completed",
        revision: 1,
        resolvedAt: set.loggedAt,
        completedSetId: set.id,
      } as const;
    });
  if (occurrences.length) await db.insert(sessionOccurrences).values(occurrences);
  await db.insert(fatigueLogs).values(data.fatigue);
  await db.insert(painLogs).values(data.pain);
  await db.insert(sessionNotes).values(data.notes);

  return data.sessions.length;
}
