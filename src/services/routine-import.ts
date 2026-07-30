import { and, desc, eq, or, isNull, asc } from "drizzle-orm";
import type { Db } from "@/db";
import {
  constraints,
  exercises,
  equipmentItems,
  plateInventory,
  importEvents,
} from "@/db/schema";
import type { ExerciseVariantAttributes } from "@/db/schema/exercise";
import {
  missingRequirements,
  missingRequirementsSummary,
  buildEquipmentAvailability,
} from "@/engine/equipment-filter";
import { patternFlags } from "@/engine/constraint-filter";
import { routineParseSchema } from "@/ai/tasks/routine-parse/schema";
import type { ExerciseMediaPreview } from "@/lib/exercise-discovery";
import type { z } from "zod";

/**
 * One library exercise with its equipment verdict against the user's
 * inventory. The import review table uses `missing` for the red
 * "needs X — not in your inventory" badge, and confirmImport re-checks the
 * same computation server-side before anything persists.
 */
export type LibraryExerciseOption = {
  id: string;
  /** Internal catalog relationship used for strictly matched family media. */
  familyId: string | null;
  name: string;
  activityClass: string;
  movementPattern: string;
  family: string | null;
  loadType: string;
  metricType: string;
  loadSemantics: string;
  variantAttributes: ExerciseVariantAttributes;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  equipment: string[];
  available: boolean;
  /** Equipment types that fail the filter, e.g. ["cable"]. */
  missing: string[];
  /** Hard owner safety boundary; unlike missing equipment, this cannot be overridden. */
  constraintBlocked: boolean;
  unavailableReason: string | null;
  cautionBodyParts: string[];
  /** Training-only reviewed media; internal rights evidence is never included. */
  media?: ExerciseMediaPreview | null;
};

/** Every exercise the user may map to, with equipment availability. */
export async function getLibraryWithAvailability(
  db: Db,
  userId: string
): Promise<LibraryExerciseOption[]> {
  const [rows, equipmentRows, plateRows, constraintRows] = await Promise.all([
    db.query.exercises.findMany({
      where: or(isNull(exercises.userId), eq(exercises.userId, userId)),
      with: { equipmentRequirements: true, family: true },
      orderBy: asc(exercises.name),
    }),
    db.query.equipmentItems.findMany({
      where: eq(equipmentItems.userId, userId),
    }),
    db.query.plateInventory.findMany({
      where: eq(plateInventory.userId, userId),
      columns: { denomination: true },
    }),
    db.query.constraints.findMany({
      where: eq(constraints.userId, userId),
    }),
  ]);
  const inventory = buildEquipmentAvailability(equipmentRows, plateRows);

  const flags = patternFlags(constraintRows);

  return rows.map((ex) => {
    const missing = missingRequirements(ex.equipmentRequirements, inventory);
    const constraint = flags.get(ex.movementPattern);
    const unavailableReason = missing.length > 0
      ? missingRequirementsSummary(missing)
      : constraint?.avoid
        ? "blocked by current constraints"
        : null;
    return {
      id: ex.id,
      familyId: ex.familyId,
      name: ex.name,
      activityClass: ex.activityClass,
      movementPattern: ex.movementPattern,
      family: ex.family?.name ?? null,
      loadType: ex.loadType,
      metricType: ex.metricType,
      loadSemantics: ex.loadSemantics,
      variantAttributes: ex.variantAttributes,
      primaryMuscles: ex.primaryMuscles,
      secondaryMuscles: ex.secondaryMuscles,
      equipment: ex.equipmentRequirements.map((requirement) => requirement.equipmentType),
      available: unavailableReason == null,
      missing: missing.map((r) => r.equipmentType),
      constraintBlocked: constraint?.avoid ?? false,
      unavailableReason,
      cautionBodyParts: constraint?.cautious ? constraint.bodyParts : [],
    };
  });
}

/** Review-table mapping for one rawName (deterministic tier + AI tier merged). */
export type ImportMapping = {
  rawName: string;
  exerciseId: string | null;
  exerciseName: string | null;
  /** ✓ exact/alias · ~ fuzzy (AI-chosen) · ? none — plan §5 badges. */
  matchType: "exact" | "alias" | "fuzzy" | "none";
  candidates: Array<{ id: string; name: string; why?: string }>;
};

export type StagedImport = {
  importEventId: string;
  envelope: z.infer<typeof routineParseSchema>;
  mappings: ImportMapping[];
};

/**
 * The newest ImportEvent still sitting at `parsed` — the review screen
 * resumes it instead of losing the staged parse when the user navigates
 * away. Payloads that no longer validate are ignored, not repaired.
 */
export async function getLatestStagedImport(
  db: Db,
  userId: string
): Promise<StagedImport | null> {
  const event = await db.query.importEvents.findFirst({
    where: and(
      eq(importEvents.userId, userId),
      eq(importEvents.source, "paste"),
      eq(importEvents.status, "parsed")
    ),
    orderBy: desc(importEvents.createdAt),
  });
  if (!event?.parsedPayload) return null;
  const payload = event.parsedPayload as { envelope?: unknown; mappings?: unknown };
  const envelope = routineParseSchema.safeParse(payload.envelope);
  if (!envelope.success || !Array.isArray(payload.mappings)) return null;
  return {
    importEventId: event.id,
    envelope: envelope.data,
    mappings: payload.mappings as ImportMapping[],
  };
}
