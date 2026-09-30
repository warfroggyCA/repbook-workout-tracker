import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { equipmentItems, exercises, plateLoadedMachineProfiles, users, workoutTemplates } from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { startWorkoutSession } from "@/services/session-lifecycle";

async function main() {
  if (process.env.E2E_DEV_LOGIN !== "1" || !process.env.PGLITE_DIR || process.env.DATABASE_URL) {
    throw new Error("Workout feedback fixtures require a disposable local database.");
  }
  const db = await getDb();
  const owner = await db.query.users.findFirst({ where: eq(users.email, "owner@example.com") });
  if (!owner) throw new Error("Missing synthetic fixture.");
  const [machine] = await db.insert(equipmentItems).values({
    userId: owner.id, type: "machine", label: "Shared plate pulley", attrs: { cablePulley: true }, available: true,
  }).returning();
  await db.insert(plateLoadedMachineProfiles).values({
    userId: owner.id, equipmentItemId: machine.id, geometryCertainty: "known",
    startingResistance: null, startingResistanceUnit: "lb", loadingPointCount: 2,
    balancingRule: "identical_each_point", targetEntryMeaning: "added_plates",
  });
  // Existing generic cable stations must not make automatic selection ambiguous.
  await db.execute(sql`UPDATE equipment_items SET available = false WHERE user_id = ${owner.id} AND type = 'cable'`);
  const targets = ["Wide-Grip Lat Pulldown", "Cable Leg Curl"];
  const movements = await Promise.all(targets.map((name) => db.query.exercises.findFirst({ where: eq(exercises.name, name) })));
  if (movements.some((item) => !item)) throw new Error("Missing cable exercise.");
  const activation = await activateProgramAtomically(db, {
    userId: owner.id, loadUnit: "lb", programName: "Shared pulley workout",
    changeSummary: "Synthetic workflow fixture", auditAction: "program.activate", auditSummary: "Synthetic workflow fixture",
    days: [{ name: "Pulley practice", exercises: movements.map((item) => ({
      exerciseId: item!.id, sets: 3, repMin: 8, repMax: 12, targetLoad: 50, targetLoadUnit: "lb",
      restSec: 90, supersetKey: null, notes: null,
      warmupSets: [{ label: "Easy preparation", reps: 8, load: 20, loadUnit: "lb", loadPercent: null, loadText: null, notes: null }],
    })) }],
  });
  if (!activation.ok) throw new Error(activation.reason);
  const template = await db.query.workoutTemplates.findFirst({ where: eq(workoutTemplates.programVersionId, activation.programVersionId) });
  if (!template) throw new Error("Missing activated template.");
  await startWorkoutSession(db, owner.id, template.id, 45, { includeWarmups: true });
  await (db as { $client?: { close?: () => Promise<void> } }).$client?.close?.();
}
main().catch((error) => { console.error(error); process.exit(1); });
