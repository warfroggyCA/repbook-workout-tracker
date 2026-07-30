import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import {
  equipmentDefinitions,
  exerciseAliases,
  exerciseExecutionRequirements,
  exerciseEquipmentRequirements,
  exerciseFamilies,
  exercises,
  exerciseSources,
} from "@/db/schema";
import {
  exerciseActivityClass,
  exerciseFamilyName,
  exerciseLoadSemantics,
  exerciseMetricType,
  exerciseVariantKey,
  catalogKey,
} from "@/services/exercise-catalog";
import { exerciseLibrary, type EquipmentType } from "./exercise-library";

const equipmentDefinitionLibrary: Array<{
  key: string;
  label: string;
  category: EquipmentType;
}> = [
  { key: "olympic_barbell", label: "Olympic barbell", category: "barbell" },
  { key: "straight_barbell", label: "Straight barbell", category: "barbell" },
  { key: "ez_curl_bar", label: "EZ curl bar", category: "ez_bar" },
  { key: "trap_bar", label: "Trap / hex bar", category: "trap_bar" },
  { key: "smith_machine", label: "Smith machine", category: "smith_machine" },
  { key: "power_rack", label: "Power rack", category: "rack" },
  { key: "adjustable_bench", label: "Adjustable bench", category: "bench" },
  { key: "flat_bench", label: "Flat bench", category: "bench" },
  { key: "dumbbell_pair", label: "Dumbbell pair", category: "dumbbell" },
  { key: "kettlebell", label: "Kettlebell", category: "kettlebell" },
  { key: "cable_stack", label: "Cable stack", category: "cable" },
  { key: "lat_pulldown", label: "Lat-pulldown station", category: "cable" },
  { key: "cable_rope", label: "Cable rope attachment", category: "cable" },
  { key: "cable_straight_bar", label: "Cable straight-bar attachment", category: "cable" },
  { key: "cable_v_grip", label: "Cable neutral/V-grip attachment", category: "cable" },
  { key: "suspension_trainer", label: "Suspension trainer / rings", category: "suspension" },
  { key: "dip_station", label: "Dip station", category: "dip_station" },
  { key: "landmine_base", label: "Landmine attachment", category: "landmine" },
  { key: "plyometric_box", label: "Plyometric box", category: "box" },
  { key: "medicine_ball", label: "Medicine ball", category: "medicine_ball" },
  { key: "stability_ball", label: "Stability ball", category: "stability_ball" },
  { key: "foam_roller", label: "Foam roller", category: "foam_roller" },
  { key: "weight_sled", label: "Weight sled", category: "sled" },
  { key: "battle_rope", label: "Battle rope", category: "battle_rope" },
  { key: "rowing_ergometer", label: "Rowing ergometer", category: "rowing_machine" },
  { key: "stationary_bike", label: "Stationary / air bike", category: "stationary_bike" },
  { key: "treadmill", label: "Treadmill", category: "treadmill" },
  { key: "stair_machine", label: "Stair machine", category: "stair_machine" },
];

async function seedEquipmentDefinitions(db: Db) {
  for (const definition of equipmentDefinitionLibrary) {
    await db
      .insert(equipmentDefinitions)
      .values(definition)
      .onConflictDoUpdate({
        target: equipmentDefinitions.key,
        set: { label: definition.label, category: definition.category },
      });
  }
}

export type SeedLibraryProgress = {
  inserted: number;
  processed: number;
  total: number;
  done: boolean;
};

/**
 * Idempotent catalog reconciliation. Existing exercise IDs are retained while
 * metadata, safe aliases, requirements, families, and provenance are updated.
 *
 * `range` seeds a slice of the library so serverless callers can work in
 * chunks that fit a function time limit; omitting it seeds everything.
 */
export async function seedExerciseLibrary(
  db: Db,
  range?: { offset: number; limit: number }
): Promise<SeedLibraryProgress> {
  const total = exerciseLibrary.length;
  const offset = Math.max(0, range?.offset ?? 0);
  const slice = exerciseLibrary.slice(offset, offset + (range?.limit ?? total));
  if (offset === 0) await seedEquipmentDefinitions(db);
  let inserted = 0;

  // Seed each analytical family once from its first (canonical) variant.
  // Later specialty variants such as jumping lunges must not overwrite the
  // family's base movement pattern. Canonical variants are derived from the
  // FULL library so a chunked call assigns the same family ownership.
  const canonicalFamilies = new Map<string, (typeof exerciseLibrary)[number]>();
  for (const entry of exerciseLibrary) {
    const familyName = exerciseFamilyName(entry);
    if (!canonicalFamilies.has(familyName)) canonicalFamilies.set(familyName, entry);
  }
  const neededFamilies = new Set(slice.map((entry) => exerciseFamilyName(entry)));
  const familyIds = new Map<string, string>();
  for (const [familyName, entry] of canonicalFamilies) {
    if (!neededFamilies.has(familyName)) continue;
    const familyKey = catalogKey(familyName);
    const [family] = await db
      .insert(exerciseFamilies)
      .values({
        key: familyKey,
        name: familyName,
        movementPattern: entry.pattern,
        primaryMuscles: entry.muscles,
        secondaryMuscles: entry.secondaryMuscles ?? [],
      })
      .onConflictDoUpdate({
        target: exerciseFamilies.key,
        set: {
          name: familyName,
          movementPattern: entry.pattern,
          primaryMuscles: entry.muscles,
          secondaryMuscles: entry.secondaryMuscles ?? [],
        },
      })
      .returning({ id: exerciseFamilies.id });
    familyIds.set(familyName, family.id);
  }

  for (const entry of slice) {
    const familyName = exerciseFamilyName(entry);
    const familyId = familyIds.get(familyName)!;

    const existing = await db.query.exercises.findFirst({
      where: eq(exercises.name, entry.name),
    });
    if (existing?.userId) continue;

    let exerciseId = existing?.id;
    const metadata = {
      familyId,
      movementPattern: entry.pattern,
      primaryMuscles: entry.muscles,
      secondaryMuscles: entry.secondaryMuscles ?? [],
      isUnilateral: entry.unilateral ?? false,
      loadType: entry.loadType,
      activityClass: exerciseActivityClass(entry),
      metricType: exerciseMetricType(entry),
      loadSemantics: exerciseLoadSemantics(entry),
      variantKey: exerciseVariantKey(entry),
      variantAttributes: {
        ...(entry.unilateral ? { laterality: "unilateral" as const } : {}),
        ...entry.variantAttributes,
      },
      catalogReviewed: true,
    };

    if (exerciseId) {
      await db.update(exercises).set(metadata).where(eq(exercises.id, exerciseId));
    } else {
      const [created] = await db
        .insert(exercises)
        .values({ name: entry.name, ...metadata })
        .returning({ id: exercises.id });
      exerciseId = created.id;
      inserted += 1;
    }

    await Promise.all([
      db.delete(exerciseAliases).where(eq(exerciseAliases.exerciseId, exerciseId)),
      db
        .delete(exerciseEquipmentRequirements)
        .where(eq(exerciseEquipmentRequirements.exerciseId, exerciseId)),
      db
        .delete(exerciseExecutionRequirements)
        .where(eq(exerciseExecutionRequirements.exerciseId, exerciseId)),
      db.delete(exerciseSources).where(eq(exerciseSources.exerciseId, exerciseId)),
    ]);

    const aliases = [...new Set((entry.aliases ?? []).map((alias) => alias.toLowerCase()))];
    if (aliases.length) {
      await db.insert(exerciseAliases).values(
        aliases.map((alias) => ({ exerciseId, alias }))
      );
    }
    await db.insert(exerciseEquipmentRequirements).values(
      entry.equipment.map((requirement) => {
        const [equipmentType, minWeight] = Array.isArray(requirement)
          ? requirement
          : [requirement, null];
        return { exerciseId, equipmentType, minWeight };
      })
    );

    if (entry.exactExecutionRequirement) {
      await db.insert(exerciseExecutionRequirements).values({
        exerciseId,
        requiredProfileKind:
          entry.exactExecutionRequirement.requiredProfileKind,
        requiredAttachmentKind:
          entry.exactExecutionRequirement.requiredAttachmentKind ?? null,
        requiresKnownGeometry:
          entry.exactExecutionRequirement.requiresKnownGeometry,
        reviewNotes: entry.exactExecutionRequirement.reviewNotes,
        reviewedAt: new Date("2026-07-21T00:00:00.000Z"),
      });
    }

    const itemSource = entry.source ?? {
      name: "Workout Tracker curated catalog",
      id: exerciseVariantKey(entry),
      license: "Project-authored metadata",
    };
    await db.insert(exerciseSources).values({
      exerciseId,
      sourceName: itemSource.name,
      sourceId: itemSource.id ?? exerciseVariantKey(entry),
      sourceUrl: itemSource.url ?? null,
      license: itemSource.license ?? null,
      reviewedAt: new Date(),
    });
  }

  return {
    inserted,
    processed: slice.length,
    total,
    done: offset + slice.length >= total,
  };
}
