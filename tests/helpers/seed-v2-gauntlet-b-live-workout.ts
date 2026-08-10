import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { exercises, users } from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  BA_WORKOUT_EMAIL,
  BA_WORKOUT_FIXTURE,
} from "../fixtures/ba-workout-contract";
import { assertBaFixtureEnvironment } from "./ba-fixture-guard";

async function main() {
  assertBaFixtureEnvironment();
  const db = await getDb();
  const owner = await db.query.users.findFirst({
    where: eq(users.email, BA_WORKOUT_EMAIL),
    columns: { id: true },
  });
  if (!owner) throw new Error("The Gauntlet B owner fixture is missing.");

  const fixtureNames = BA_WORKOUT_FIXTURE.program.days.flatMap((day) =>
    day.exercises.map((exercise) => exercise.name),
  );
  const exerciseNames = [...new Set([...fixtureNames, "Suspension Push-Up"])];
  const library = await db
    .select({ id: exercises.id, name: exercises.name })
    .from(exercises)
    .where(inArray(exercises.name, exerciseNames));
  const exerciseIdByName = new Map(library.map((row) => [row.name, row.id]));
  for (const name of exerciseNames) {
    if (!exerciseIdByName.has(name)) {
      throw new Error(`The Gauntlet B exercise library is missing: ${name}`);
    }
  }

  const activation = await activateProgramAtomically(db, {
    userId: owner.id,
    loadUnit: BA_WORKOUT_FIXTURE.profile.unit,
    programName: BA_WORKOUT_FIXTURE.program.name,
    changeSummary: "Add one explicitly unavailable-equipment recovery fixture",
    auditAction: "program.activate",
    auditSummary: "Activated the isolated Gauntlet B live-workout fixture",
    days: BA_WORKOUT_FIXTURE.program.days.map((day) => ({
      name: day.name,
      notes: day.notes,
      warmupNotes: day.warmupNotes,
      exercises: day.exercises.map((exercise) => {
        const unavailable = exercise.name === "Dumbbell Bench Press";
        const name = unavailable ? "Suspension Push-Up" : exercise.name;
        return {
          exerciseId: exerciseIdByName.get(name)!,
          sets: exercise.sets,
          repMin: exercise.repMin,
          repMax: exercise.repMax,
          targetLoad: unavailable ? null : exercise.targetLoad,
          restSec: exercise.restSec,
          supersetKey: exercise.supersetKey,
          supersetRestAfterRoundSec:
            "supersetRestAfterRoundSec" in exercise
              ? exercise.supersetRestAfterRoundSec
              : undefined,
          notes: unavailable
            ? "Suspension equipment is intentionally unavailable in this disposable fixture."
            : exercise.notes,
          warmupNotes:
            "warmupNotes" in exercise ? exercise.warmupNotes : null,
          warmupSets:
            "warmupSets" in exercise
              ? exercise.warmupSets.map((set) => ({ ...set }))
              : [],
          setNotes: [...exercise.setNotes],
        };
      }),
    })),
  });
  if (!activation.ok) throw new Error(activation.reason);

  const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
  await client?.close?.();
  console.log(JSON.stringify({
    ownerId: owner.id,
    programVersionId: activation.programVersionId,
    unavailableExercise: "Suspension Push-Up",
  }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
