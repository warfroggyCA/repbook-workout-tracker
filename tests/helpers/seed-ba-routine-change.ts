import { and, count, eq, inArray } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { getDb, type Db } from "@/db";
import {
  barbellConfigs,
  completedSets,
  equipmentItems,
  exercisePrescriptions,
  exercises,
  plateInventory,
  programs,
  programVersions,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  completeWorkoutSession,
  logWorkoutSet,
  startWorkoutSession,
} from "@/services/session-lifecycle";
import {
  BA_ROUTINE_CHANGE_BASELINE,
  BA_ROUTINE_CHANGE_SEMANTIC_DIGEST,
} from "../fixtures/ba-routine-change-contract";
import {
  assertBaFixtureEnvironment,
  type BaFixtureEnvironment,
} from "./ba-fixture-guard";

const OLD_WORKOUT_STARTED_AT = new Date("2026-07-01T14:00:00.000Z");
const OLD_WORKOUT_FINISHED_AT = new Date("2026-07-01T15:00:00.000Z");

export type BaRoutineChangeSeedResult = {
  dayCount: number;
  slotCount: number;
  completedWorkoutCount: number;
  completedOccurrenceCount: number;
  completedSetCount: number;
};

export async function seedBaRoutineChange(
  db: Db,
  environment: BaFixtureEnvironment = process.env as BaFixtureEnvironment,
): Promise<BaRoutineChangeSeedResult> {
  assertBaFixtureEnvironment(environment);
  const localDb = db as Db & {
    transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  };

  if (typeof localDb.transaction !== "function") {
    throw new Error("The BA routine-change fixture requires a transactional local database.");
  }

  return localDb.transaction(async (tx) => {
      const [existingUsers] = await tx.select({ value: count() }).from(users);
      if (Number(existingUsers?.value ?? 0) !== 0) {
        throw new Error("The BA routine-change fixture refuses a database containing any user.");
      }

      const requiredExerciseNames = [
        ...new Set(
          BA_ROUTINE_CHANGE_BASELINE.program.days.flatMap((day) =>
            day.exercises.map((exercise) => exercise.name),
          ),
        ),
        "Incline Dumbbell Curl",
        "Cable Face Pull",
        "Zottman Curl",
        "Overhead Cable Triceps Extension",
      ];
      const exerciseRows = await tx
        .select({ id: exercises.id, name: exercises.name })
        .from(exercises)
        .where(inArray(exercises.name, requiredExerciseNames));
      const exerciseIdByName = new Map(exerciseRows.map((exercise) => [exercise.name, exercise.id]));
      const missingExercises = requiredExerciseNames.filter((name) => !exerciseIdByName.has(name));
      if (missingExercises.length > 0) {
        throw new Error(`The BA routine-change exercise library is incomplete: ${missingExercises.join(", ")}.`);
      }

      const [user] = await tx
        .insert(users)
        .values({
          email: BA_ROUTINE_CHANGE_BASELINE.identity.email,
          name: BA_ROUTINE_CHANGE_BASELINE.identity.name,
        })
        .returning({ id: users.id });
      await tx.insert(userProfiles).values({
        userId: user.id,
        ageRange: "50-59",
        experience: "intermediate",
        goals: ["strength", "consistency"],
        sessionLengthMin: 60,
        weeklyFrequency: 3,
        unit: BA_ROUTINE_CHANGE_BASELINE.identity.unit,
        timezone: BA_ROUTINE_CHANGE_BASELINE.identity.timezone,
        setupCompletedAt: OLD_WORKOUT_STARTED_AT,
      });

      await tx.insert(equipmentItems).values([
        { userId: user.id, type: "barbell", label: "Olympic barbell", attrs: {}, available: true },
        { userId: user.id, type: "ez_bar", label: "EZ curl bar", attrs: {}, available: true },
        { userId: user.id, type: "plates", label: "Olympic and EZ-bar plates", attrs: {}, available: true },
        { userId: user.id, type: "rack", label: "Power rack", attrs: {}, available: true },
        { userId: user.id, type: "bench", label: "Adjustable bench", attrs: { adjustableBench: true }, available: true },
        { userId: user.id, type: "dumbbell", label: "Adjustable dumbbells", attrs: { minWeight: 5, maxWeight: 50, unit: "lb", adjustable: true, pair: true }, available: true },
        { userId: user.id, type: "cable", label: "Adjustable cable station with rope", attrs: { notes: "High and low pulley positions with rope attachment." }, available: true },
      ]);
      await tx.insert(barbellConfigs).values([
        { userId: user.id, barType: "olympic", barWeight: 45, collarWeight: 0, label: "Olympic bar" },
        { userId: user.id, barType: "ez", barWeight: 18, collarWeight: 0, label: "EZ curl bar" },
      ]);
      await tx.insert(plateInventory).values(
        [45, 25, 10, 5, 2.5, 1.25].map((denomination) => ({
          userId: user.id,
          denomination,
          quantity: 4,
        })),
      );

      const activation = await activateProgramAtomically(tx, {
        userId: user.id,
        loadUnit: BA_ROUTINE_CHANGE_BASELINE.identity.unit,
        programName: BA_ROUTINE_CHANGE_BASELINE.program.name,
        changeSummary: "Created the exact disposable BA routine-change baseline",
        auditAction: "program.activate",
        auditSummary: "Seeded the exact disposable BA routine-change baseline",
        structuredIntentReviewed: true,
        days: BA_ROUTINE_CHANGE_BASELINE.program.days.map((day) => ({
          name: day.name,
          warmupNotes: day.warmupNotes,
          exercises: day.exercises.map((exercise) => ({
            exerciseId: exerciseIdByName.get(exercise.name)!,
            sets: exercise.sets,
            repMin: exercise.repMin,
            repMax: exercise.repMax,
            targetLoad: exercise.targetLoad,
            restSec: exercise.restSec,
            supersetKey: null,
            notes: null,
          })),
        })),
      });
      if (!activation.ok) {
        throw new Error(`The BA routine-change Program could not be activated: ${activation.reason}`);
      }

      const oldWorkoutTemplate = await tx.query.workoutTemplates.findFirst({
        where: and(
          eq(workoutTemplates.programVersionId, activation.programVersionId),
          eq(workoutTemplates.name, BA_ROUTINE_CHANGE_BASELINE.history.completedDay),
        ),
        columns: { id: true, name: true },
      });
      if (!oldWorkoutTemplate) {
        throw new Error("The BA routine-change old-version workout template is missing.");
      }

      const started = await startWorkoutSession(
        tx,
        user.id,
        oldWorkoutTemplate.id,
        60,
        {
          now: () => OLD_WORKOUT_STARTED_AT,
          timezone: BA_ROUTINE_CHANGE_BASELINE.identity.timezone,
        },
      );
      if (started.existing) {
        throw new Error("The BA routine-change old-version workout unexpectedly reused an active workout.");
      }
      const occurrences = await tx.query.sessionExercises.findMany({
        where: eq(sessionExercises.sessionId, started.sessionId),
        orderBy: (occurrence, { asc }) => [asc(occurrence.orderIdx)],
      });
      let completedSetCount = 0;
      for (const occurrence of occurrences) {
        if (
          occurrence.targetSets == null ||
          occurrence.targetRepsMax == null ||
          occurrence.targetLoad == null ||
          occurrence.targetLoadUnit == null
        ) {
          throw new Error("The BA routine-change old-version workout target is incomplete.");
        }
        for (let setNo = 1; setNo <= occurrence.targetSets; setNo += 1) {
          const saved = await logWorkoutSet(tx, user.id, {
            sessionExerciseId: occurrence.id,
            setNo,
            // This pre-Stage-4 historical checkpoint intentionally carries no
            // performed equipment evidence. The immutable Program target above
            // still retains its prescribed load; simulation-specific exact
            // profiles are added only after this old workout is sealed.
            weight: null,
            weightUnit: null,
            reps: occurrence.targetRepsMax,
            rpe: 7,
            clientKey: `ba-routine-change-old-${occurrence.orderIdx}-${setNo}`,
          });
          if (saved.outcome !== "saved") {
            throw new Error(`The BA routine-change old-version set was not saved (${saved.outcome}).`);
          }
          completedSetCount += 1;
        }
      }
      const completed = await completeWorkoutSession(
        tx,
        {
          id: user.id,
          coachingPrefs: {
            aggressiveness: "conservative",
            deloadSuggestions: true,
            substitutionSuggestions: true,
            weeklyReview: true,
          },
        },
        {
          sessionId: started.sessionId,
          note: "Old-version BA routine-change history checkpoint.",
          fatigue: 2,
        },
        { now: () => OLD_WORKOUT_FINISHED_AT },
      );
      if (completed.alreadyFinished) {
        throw new Error("The BA routine-change old-version workout was already finished.");
      }

      const factRows = await Promise.all([
        tx.select({ value: count() }).from(users),
        tx.select({ value: count() }).from(programs),
        tx.select({ value: count() }).from(programVersions),
        tx.select({ value: count() }).from(workoutTemplates),
        tx.select({ value: count() }).from(workoutTemplateExercises),
        tx.select({ value: count() }).from(exercisePrescriptions),
        tx.select({ value: count() }).from(workoutSessions),
        tx.select({ value: count() }).from(sessionExercises),
        tx.select({ value: count() }).from(completedSets),
      ]);
      const durableCounts = factRows.map((rows) => Number(rows[0]?.value ?? 0));
      const stableFacts = {
        dayCount: BA_ROUTINE_CHANGE_BASELINE.program.days.length,
        slotCount: BA_ROUTINE_CHANGE_BASELINE.program.days.reduce(
          (total, day) => total + day.exercises.length,
          0,
        ),
        completedWorkoutCount: 1,
        completedOccurrenceCount: occurrences.length,
        completedSetCount,
      };
      if (
        stableFacts.dayCount !== 3 ||
        stableFacts.slotCount !== 13 ||
        stableFacts.completedWorkoutCount !== BA_ROUTINE_CHANGE_BASELINE.history.completedWorkouts ||
        stableFacts.completedOccurrenceCount !== 6 ||
        stableFacts.completedSetCount !== 15
      ) {
        throw new Error(`The BA routine-change semantic ledger is incomplete: ${JSON.stringify(stableFacts)}.`);
      }
      if (durableCounts.join(",") !== "1,1,1,3,13,13,1,6,15") {
        throw new Error(
          `The BA routine-change durable ledger is not exact: ${durableCounts.join(",")}.`,
        );
      }

      return stableFacts;
    });
}

async function main() {
  const db = await getDb();
  try {
    const result = await seedBaRoutineChange(db);
    process.stdout.write(`${JSON.stringify({
      email: BA_ROUTINE_CHANGE_BASELINE.identity.email,
      semanticDigest: BA_ROUTINE_CHANGE_SEMANTIC_DIGEST,
      programVersion: BA_ROUTINE_CHANGE_BASELINE.program.version,
      completedDay: BA_ROUTINE_CHANGE_BASELINE.history.completedDay,
      ...result,
    })}\n`);
  } finally {
    const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
    await client?.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
