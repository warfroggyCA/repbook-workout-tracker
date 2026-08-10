import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  equipmentItems,
  exercises,
  plateInventory,
  plateLoadedMachineProfiles,
  sessionExercises,
  users,
  workoutTemplates,
} from "@/db/schema";
import { startWorkoutSession } from "@/services/session-lifecycle";
import { mutateSessionEquipmentSelection } from "@/services/session-equipment-selection";

const OWNER_EMAIL = "owner@example.com";

async function main() {
  if (
    process.env.PLATE_MACHINE_GUIDANCE_FIXTURE !== "1" ||
    process.env.E2E_DEV_LOGIN !== "1" ||
    !process.env.PGLITE_DIR ||
    process.env.DATABASE_URL
  ) {
    throw new Error(
      "Plate-machine guidance fixtures require the disposable local E2E runtime.",
    );
  }

  const db = await getDb();
  const owner = await db.query.users.findFirst({
    where: eq(users.email, OWNER_EMAIL),
  });
  if (!owner) throw new Error("The plate-machine fixture owner is missing.");

  const template = await db.query.workoutTemplates.findFirst({
    where: eq(workoutTemplates.name, "Day A — Squat"),
  });
  const exercise = await db.query.exercises.findFirst({
    where: eq(exercises.name, "Plate-Loaded Lat Pulldown"),
  });
  if (!template || !exercise) {
    throw new Error("The plate-machine fixture catalog is incomplete.");
  }

  const ownedPlates = await db
    .select({ id: plateInventory.id })
    .from(plateInventory)
    .where(eq(plateInventory.userId, owner.id));
  if (ownedPlates.length === 0) {
    throw new Error("The fixture requires an owned plate pool.");
  }

  const [machine] = await db
    .insert(equipmentItems)
    .values({
      userId: owner.id,
      type: "machine",
      label: "Owner two-sided Lat Pulldown",
      attrs: {},
      available: true,
    })
    .returning({ id: equipmentItems.id });
  if (!machine) throw new Error("The fixture machine was not created.");

  const [profile] = await db
    .insert(plateLoadedMachineProfiles)
    .values({
      userId: owner.id,
      equipmentItemId: machine.id,
      geometryCertainty: "known",
      startingResistance: 0,
      startingResistanceUnit: "lb",
      loadingPointCount: 2,
      balancingRule: "identical_each_point",
      targetEntryMeaning: "total_system",
    })
    .returning({ id: plateLoadedMachineProfiles.id });
  if (!profile) throw new Error("The fixture machine profile was not created.");

  const { sessionId } = await startWorkoutSession(
    db,
    owner.id,
    template.id,
    45,
  );
  const firstExercise = await db.query.sessionExercises.findFirst({
    where: and(
      eq(sessionExercises.sessionId, sessionId),
      eq(sessionExercises.orderIdx, 0),
    ),
  });
  if (!firstExercise) throw new Error("The fixture session has no first exercise.");

  await db
    .update(sessionExercises)
    .set({
      exerciseId: exercise.id,
      modificationType: "substituted",
      substitutedForExerciseId: firstExercise.exerciseId,
      substitutionReason: "other",
      substitutedAt: new Date(),
      targetSets: 3,
      targetRepsMin: 8,
      targetRepsMax: 10,
      targetLoad: 100,
      targetLoadUnit: "lb",
      restSec: 90,
    })
    .where(eq(sessionExercises.id, firstExercise.id));

  const selected = await mutateSessionEquipmentSelection(db, owner.id, {
    operation: "select",
    sessionExerciseId: firstExercise.id,
    equipmentItemId: machine.id,
    attachmentItemId: null,
    expectedCurrentSnapshotId: null,
    clientKey: crypto.randomUUID(),
    provenance: "user_selected",
  });
  if (
    selected.outcome !== "applied" &&
    selected.outcome !== "no_change" &&
    selected.outcome !== "replayed"
  ) {
    throw new Error(
      `The plate-machine snapshot was not created (${selected.outcome}).`,
    );
  }

  const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
  await client?.close?.();
  console.log(JSON.stringify({ sessionId, machineId: machine.id }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
