import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  equipmentItems,
  exerciseEquipmentRequirements,
  exercises,
  plateInventory,
  userProfiles,
  users,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { saveExerciseEquipmentFitAssertion } from "@/services/exercise-equipment-fit-management";

export const PROGRAM_PAGE_REPAIR_EMAIL = "program-page.e2e@example.com";

async function main() {
  if (!process.env.PGLITE_DIR || process.env.DATABASE_URL) {
    throw new Error(
      "Program page repair fixtures require the disposable local PGlite harness.",
    );
  }

  const db = await getDb();
  const exerciseNames = [
    "Barbell Bench Press",
    "Barbell Back Squat",
    "Dumbbell Row",
    "Romanian Deadlift",
    "Barbell Overhead Press",
    "Band Lat Pulldown",
    "Dumbbell Reverse Lunge",
    "EZ-Bar Curl",
  ];
  const exerciseRows = await db
    .select({ id: exercises.id, name: exercises.name })
    .from(exercises)
    .where(inArray(exercises.name, exerciseNames));
  const exerciseId = new Map(exerciseRows.map((row) => [row.name, row.id]));
  for (const name of exerciseNames) {
    if (!exerciseId.has(name)) {
      throw new Error(`Program page fixture exercise is missing: ${name}`);
    }
  }

  const [user] = await db
    .insert(users)
    .values({
      email: PROGRAM_PAGE_REPAIR_EMAIL,
      name: "Program compatibility fixture",
    })
    .returning({ id: users.id });
  await db.insert(userProfiles).values({
    userId: user.id,
    setupCompletedAt: new Date(),
    fontSize: "default",
  });

  const requirements = await db.select({
    exerciseId: exerciseEquipmentRequirements.exerciseId,
    equipmentType: exerciseEquipmentRequirements.equipmentType,
    equipmentDefinitionId: exerciseEquipmentRequirements.equipmentDefinitionId,
  }).from(exerciseEquipmentRequirements).where(inArray(
    exerciseEquipmentRequirements.exerciseId,
    exerciseRows.map((exercise) => exercise.id),
  ));
  if (requirements.some((requirement) => requirement.equipmentType === "plates")) {
    await db.insert(plateInventory).values({
      userId: user.id,
      denomination: 45,
      quantity: 8,
    });
  }
  const reviewedItems = new Map<string, string>();
  for (const requirement of requirements) {
    if (["bodyweight", "plates"].includes(requirement.equipmentType)) continue;
    const itemKey = `${requirement.equipmentType}:${requirement.equipmentDefinitionId ?? "broad"}`;
    if (!reviewedItems.has(itemKey)) {
      const [item] = await db.insert(equipmentItems).values({
        userId: user.id,
        type: requirement.equipmentType,
        definitionId: requirement.equipmentDefinitionId,
        label: `Reviewed ${requirement.equipmentType.replaceAll("_", " ")}`,
        attrs: { maxWeight: 500 },
        available: true,
      }).returning({ id: equipmentItems.id });
      reviewedItems.set(itemKey, item.id);
    }
    const equipmentItemId = reviewedItems.get(itemKey)!;
    const retained = await saveExerciseEquipmentFitAssertion(db, user.id, {
      mutationId: crypto.randomUUID(),
      assertionId: null,
      exerciseId: requirement.exerciseId,
      equipmentItemId,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: null,
      expectedRevision: null,
    });
    if (!retained.ok) {
      throw new Error(`Program page fit fixture failed: ${retained.reason}`);
    }
  }

  const result = await activateProgramAtomically(db, {
    userId: user.id,
    loadUnit: "lb",
    programName: "Three-Day Compatibility Strength Program With A Long Title",
    changeSummary: "Disposable saved Program compatibility fixture",
    auditAction: "program.activate",
    auditSummary: "Created disposable Program page repair fixture",
    days: [
      {
        name: "Day 1 — Full-body strength and technique",
        notes:
          "A representative long day note keeps the tablet content column under realistic pressure without using production-only text.",
        exercises: [
          {
            exerciseId: exerciseId.get("Barbell Bench Press")!,
            sets: 3,
            repMin: 6,
            repMax: 8,
            targetLoad: 115,
            restSec: 150,
            supersetKey: null,
            notes: "Pause briefly on the chest.",
            warmupNotes: "Five minutes easy, then shoulder circles.",
            warmupSets: [
              {
                label: "Empty bar",
                reps: 10,
                load: null,
                loadUnit: null,
                loadPercent: null,
                loadText: "Empty bar",
                notes: null,
              },
              {
                label: "First ramp",
                reps: 5,
                load: null,
                loadUnit: null,
                loadPercent: 55,
                loadText: null,
                notes: "Move smoothly",
              },
              {
                label: "Second ramp",
                reps: 3,
                load: 85,
                loadUnit: "lb",
                loadPercent: null,
                loadText: null,
                notes: null,
              },
            ],
          },
          {
            exerciseId: exerciseId.get("Barbell Back Squat")!,
            sets: 3,
            repMin: 6,
            repMax: 8,
            targetLoad: 135,
            restSec: 180,
            supersetKey: null,
            notes: null,
          },
          {
            exerciseId: exerciseId.get("Dumbbell Row")!,
            sets: 3,
            repMin: 8,
            repMax: 10,
            targetLoad: 35,
            restSec: 90,
            supersetKey: null,
            notes: null,
          },
        ],
      },
      {
        name: "Day 2: Hinge and upper-body pairing",
        notes: "Keep both paired movements controlled.",
        exercises: [
          {
            exerciseId: exerciseId.get("Romanian Deadlift")!,
            sets: 3,
            repMin: 8,
            repMax: 10,
            targetLoad: 115,
            restSec: 150,
            supersetKey: null,
            notes: null,
          },
          {
            exerciseId: exerciseId.get("Barbell Overhead Press")!,
            sets: 3,
            repMin: 6,
            repMax: 8,
            targetLoad: 65,
            restSec: 90,
            supersetKey: "upper-pair",
            supersetRestAfterRoundSec: 90,
            notes: null,
          },
          {
            exerciseId: exerciseId.get("Band Lat Pulldown")!,
            sets: 3,
            repMin: 10,
            repMax: 12,
            targetLoad: null,
            restSec: 90,
            supersetKey: "upper-pair",
            supersetRestAfterRoundSec: 90,
            notes: null,
          },
        ],
      },
      {
        name: "DAY 3. Accessories and steady practice",
        notes: null,
        exercises: [
          {
            exerciseId: exerciseId.get("Dumbbell Reverse Lunge")!,
            sets: 3,
            repMin: 8,
            repMax: 10,
            targetLoad: 20,
            restSec: 90,
            supersetKey: null,
            notes: null,
          },
          {
            exerciseId: exerciseId.get("EZ-Bar Curl")!,
            sets: 2,
            repMin: 10,
            repMax: 12,
            targetLoad: 40,
            restSec: 60,
            supersetKey: null,
            notes: null,
          },
        ],
      },
    ],
  });

  if (!result.ok) {
    throw new Error(`Program page fixture activation failed: ${result.reason}`);
  }

  const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
  await client?.close?.();
  console.log(
    JSON.stringify({
      email: PROGRAM_PAGE_REPAIR_EMAIL,
      programId: result.programId,
      versionId: result.programVersionId,
    }),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
