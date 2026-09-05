import { afterEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { exercises, exerciseEquipmentRequirements } from "@/db/schema";
import { seedExerciseLibrary } from "@/db/seed/library";
import { exerciseLibrary } from "@/db/seed/exercise-library";
import { createTestDatabaseAtMigration, type TestDatabase } from "../helpers/database";

let database: TestDatabase | undefined;
afterEach(async () => database?.close());

it("adds one separate kettlebell carry identity and preserves the existing dumbbell variant on replay and seed", async () => {
  database = await createTestDatabaseAtMigration("0086_added_plate_weight");
  const db = database.db;
  await seedExerciseLibrary(db, { offset: exerciseLibrary.findIndex((entry) => entry.name === "Suitcase Carry"), limit: 1 });
  const old = await db.query.exercises.findFirst({ where: eq(exercises.name, "Suitcase Carry") });
  expect(old).toMatchObject({ loadType: "dumbbell", loadSemantics: "per_implement" });
  const migration = await readFile("src/db/migrations/0087_timed_per_side_prescriptions.sql", "utf8");
  for (let replay = 0; replay < 2; replay += 1) {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.client.exec(statement);
    }
  }
  const variants = await db.query.exercises.findMany({ where: eq(exercises.name, "Kettlebell Suitcase Carry") });
  expect(variants).toHaveLength(1);
  expect(variants[0]).toMatchObject({ familyId: old!.familyId, isUnilateral: true, loadType: "kettlebell", loadSemantics: "per_implement", catalogReviewed: true });
  expect(variants[0].id).not.toBe(old!.id);
  expect(await db.query.exerciseEquipmentRequirements.findMany({ where: eq(exerciseEquipmentRequirements.exerciseId, variants[0].id) })).toEqual([expect.objectContaining({ equipmentType: "kettlebell" })]);
  await seedExerciseLibrary(db, { offset: exerciseLibrary.findIndex((entry) => entry.name === "Kettlebell Suitcase Carry"), limit: 1 });
  expect(await db.query.exercises.findFirst({ where: eq(exercises.name, "Kettlebell Suitcase Carry") })).toMatchObject({ id: variants[0].id, loadType: "kettlebell" });
  expect(await db.query.exercises.findFirst({ where: eq(exercises.id, old!.id) })).toEqual(old);
});
