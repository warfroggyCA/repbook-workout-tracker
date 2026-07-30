import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import {
  barbellConfigs,
  coachingInsights,
  constraints,
  equipmentItems,
  exercises,
  plateInventory,
  programs,
  recommendations,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  BA_WORKOUT_EMAIL,
  BA_WORKOUT_FIXTURE as BASE_BA_WORKOUT_FIXTURE,
} from "../fixtures/ba-workout-contract";
import { PRODUCTION_WORKOUT_START_PROGRAM } from "../fixtures/production-workout-start-contract";
import { assertBaFixtureEnvironment } from "./ba-fixture-guard";

const BA_WORKOUT_FIXTURE = process.env.PHASE0_START_FIXTURE === "1"
  ? {
      ...BASE_BA_WORKOUT_FIXTURE,
      program: PRODUCTION_WORKOUT_START_PROGRAM,
      startingState: {
        ...BASE_BA_WORKOUT_FIXTURE.startingState,
        expectedTodayDay: PRODUCTION_WORKOUT_START_PROGRAM.days[0].name,
      },
    }
  : BASE_BA_WORKOUT_FIXTURE;

type TransactionalDb = Db & {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
};

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function seedBaWorkoutFixture(db: Db) {
  assertBaFixtureEnvironment();
  const [{ count: existingUserCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  if (existingUserCount !== 0) {
    throw new Error(
      "The BA workout fixture requires a fresh database with no existing users.",
    );
  }
  const existing = await db.query.users.findFirst({
    where: eq(users.email, BA_WORKOUT_EMAIL),
    columns: { id: true },
  });
  if (existing) {
    throw new Error("The BA workout fixture was already seeded; reset by recreating its disposable database.");
  }

  const exerciseNames = BA_WORKOUT_FIXTURE.program.days.flatMap((day) =>
    day.exercises.map((exercise) => exercise.name),
  );
  const library = await db
    .select({ id: exercises.id, name: exercises.name })
    .from(exercises)
    .where(inArray(exercises.name, [...new Set(exerciseNames)]));
  const exerciseIdByName = new Map(library.map((exercise) => [exercise.name, exercise.id]));
  for (const name of exerciseNames) {
    if (!exerciseIdByName.has(name)) {
      throw new Error(`The BA workout fixture exercise library is missing: ${name}`);
    }
  }

  const fixture = await (db as TransactionalDb).transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ ...BA_WORKOUT_FIXTURE.identity })
      .returning({ id: users.id });

    await tx.insert(userProfiles).values({
      userId: user.id,
      ageRange: BA_WORKOUT_FIXTURE.profile.ageRange,
      experience: BA_WORKOUT_FIXTURE.profile.experience,
      goals: [...BA_WORKOUT_FIXTURE.profile.goals],
      sessionLengthMin: BA_WORKOUT_FIXTURE.profile.sessionLengthMin,
      weeklyFrequency: BA_WORKOUT_FIXTURE.profile.weeklyFrequency,
      unit: BA_WORKOUT_FIXTURE.profile.unit,
      timezone: BA_WORKOUT_FIXTURE.profile.timezone,
      setupCompletedAt: new Date(),
    });
    await tx.insert(constraints).values(
      BA_WORKOUT_FIXTURE.constraints.map((constraint) => ({
        userId: user.id,
        ...constraint,
        affectedPatterns: [...constraint.affectedPatterns],
      })),
    );
    await tx.insert(equipmentItems).values(
      BA_WORKOUT_FIXTURE.equipment.items.map((item) => ({
        userId: user.id,
        type: item.type,
        label: item.label,
        attrs: { ...item.attrs },
      })),
    );
    await tx.insert(plateInventory).values(
      BA_WORKOUT_FIXTURE.equipment.plates.map((plate) => ({ userId: user.id, ...plate })),
    );
    await tx.insert(barbellConfigs).values(
      BA_WORKOUT_FIXTURE.equipment.bars.map((bar) => ({ userId: user.id, ...bar })),
    );

    const activation = await activateProgramAtomically(tx, {
      userId: user.id,
      loadUnit: BA_WORKOUT_FIXTURE.profile.unit,
      programName: BA_WORKOUT_FIXTURE.program.name,
      changeSummary: "Dedicated disposable BA workout acceptance baseline",
      auditAction: "program.activate",
      auditSummary: "Activated the isolated three-day BA workout acceptance fixture",
      days: BA_WORKOUT_FIXTURE.program.days.map((day) => ({
        name: day.name,
        notes: day.notes,
        warmupNotes: day.warmupNotes,
        exercises: day.exercises.map((exercise) => ({
          exerciseId: exerciseIdByName.get(exercise.name)!,
          sets: exercise.sets,
          repMin: exercise.repMin,
          repMax: exercise.repMax,
          targetLoad: exercise.targetLoad,
          restSec: exercise.restSec,
          supersetKey: exercise.supersetKey,
          supersetRestAfterRoundSec:
            "supersetRestAfterRoundSec" in exercise
              ? exercise.supersetRestAfterRoundSec
              : undefined,
          notes: exercise.notes,
          warmupNotes: "warmupNotes" in exercise ? exercise.warmupNotes : null,
          warmupSets:
            "warmupSets" in exercise
              ? exercise.warmupSets.map((set) => ({ ...set }))
              : [],
          setNotes: [...exercise.setNotes],
        })),
      })),
    });
    if (!activation.ok) {
      throw new Error(`The BA workout Program could not be activated: ${activation.reason}`);
    }
    return { userId: user.id, ...activation };
  });

  const [profile, savedConstraints, savedEquipment, savedPlates, savedBars, program] =
    await Promise.all([
      db.query.userProfiles.findFirst({ where: eq(userProfiles.userId, fixture.userId) }),
      db.query.constraints.findMany({ where: eq(constraints.userId, fixture.userId) }),
      db.query.equipmentItems.findMany({ where: eq(equipmentItems.userId, fixture.userId) }),
      db.query.plateInventory.findMany({ where: eq(plateInventory.userId, fixture.userId) }),
      db.query.barbellConfigs.findMany({ where: eq(barbellConfigs.userId, fixture.userId) }),
      db.query.programs.findFirst({
        where: and(
          eq(programs.userId, fixture.userId),
          eq(programs.status, "active"),
          isNull(programs.archivedAt),
        ),
        with: {
          currentVersion: {
            with: {
              templates: {
                with: {
                  supersetGroups: true,
                  exercises: {
                    with: { exercise: true, supersetGroup: true, prescriptions: true },
                  },
                },
              },
            },
          },
        },
      }),
    ]);
  if (!profile || !program?.currentVersion) {
    throw new Error("The BA workout fixture did not produce its complete profile and active Program.");
  }

  const [historyCount, coachCount, recommendationCount] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(workoutSessions).where(eq(workoutSessions.userId, fixture.userId)),
    db.select({ count: sql<number>`count(*)::int` }).from(coachingInsights).where(eq(coachingInsights.userId, fixture.userId)),
    db.select({ count: sql<number>`count(*)::int` }).from(recommendations).where(eq(recommendations.userId, fixture.userId)),
  ]);
  if (historyCount[0]?.count !== 0 || coachCount[0]?.count !== 0 || recommendationCount[0]?.count !== 0) {
    throw new Error("The BA workout fixture must begin without workout, Coach, or recommendation history.");
  }

  const semanticState = {
    identity: BA_WORKOUT_FIXTURE.identity,
    profile: {
      ageRange: profile.ageRange,
      experience: profile.experience,
      goals: [...profile.goals].sort(),
      sessionLengthMin: profile.sessionLengthMin,
      weeklyFrequency: profile.weeklyFrequency,
      unit: profile.unit,
      timezone: profile.timezone,
    },
    constraints: savedConstraints
      .map(({ bodyPart, affectedPatterns, cautious, painStopThreshold, note }) => ({
        bodyPart,
        affectedPatterns: [...affectedPatterns].sort(),
        cautious,
        painStopThreshold,
        note,
      }))
      .sort((a, b) => a.bodyPart.localeCompare(b.bodyPart)),
    equipment: {
      items: savedEquipment
        .map(({ type, label, attrs }) => ({ type, label, attrs }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      plates: savedPlates
        .map(({ denomination, quantity }) => ({ denomination, quantity }))
        .sort((a, b) => a.denomination - b.denomination),
      bars: savedBars
        .map(({ barType, barWeight, label }) => ({ barType, barWeight, label }))
        .sort((a, b) => a.barType.localeCompare(b.barType)),
    },
    program: {
      name: program.name,
      days: program.currentVersion.templates
        .sort((a, b) => a.orderIdx - b.orderIdx)
        .map((day) => ({
          name: day.name,
          notes: day.notes,
          warmupNotes: day.warmupNotes,
          groups: day.supersetGroups
            .sort((a, b) => a.orderIdx - b.orderIdx)
            .map(({ name, restAfterRoundSec }) => ({ name, restAfterRoundSec })),
          exercises: day.exercises
            .sort((a, b) => a.orderIdx - b.orderIdx)
            .map((slot) => {
              const prescription = slot.prescriptions.find((candidate) => !candidate.supersededById);
              if (!prescription) throw new Error(`The BA workout slot has no active prescription: ${slot.exercise.name}`);
              return {
                name: slot.exercise.name,
                orderIdx: slot.orderIdx,
                sets: prescription.sets,
                repMin: prescription.repRangeMin,
                repMax: prescription.repRangeMax,
                targetLoad: prescription.targetLoad,
                targetLoadUnit: prescription.targetLoadUnit,
                restSec: slot.restSec,
                superset: slot.supersetGroup?.name ?? null,
                notes: slot.notes,
                warmupNotes: slot.warmupNotes,
                warmupSets: slot.warmupSets,
                setNotes: slot.setNotes,
              };
            }),
        })),
    },
    startingState: BA_WORKOUT_FIXTURE.startingState,
  };

  return {
    email: BA_WORKOUT_EMAIL,
    userId: fixture.userId,
    programId: fixture.programId,
    programVersionId: fixture.programVersionId,
    semanticDigest: stableDigest(semanticState),
    semanticState,
  };
}

async function main() {
  assertBaFixtureEnvironment();
  const db = await getDb();
  const result = await seedBaWorkoutFixture(db);
  const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
  await client?.close?.();
  console.log(JSON.stringify(result));
}

if (process.argv[1]?.endsWith("seed-ba-workout.ts")) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
