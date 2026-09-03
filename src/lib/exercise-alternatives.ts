import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";

export const ALTERNATIVE_REASONS = [
  "variety",
  "equipment_busy",
  "discomfort",
  "other",
] as const;

export const SUBSTITUTION_REASONS = [
  ...ALTERNATIVE_REASONS,
  "equipment_unavailable_incompatible",
] as const;

export type ExerciseAlternativeReason = (typeof SUBSTITUTION_REASONS)[number];
export type UserSelectedAlternativeReason = (typeof ALTERNATIVE_REASONS)[number];
export type ExerciseAlternativeTier = "same_family" | "same_movement" | "same_muscle";

export type ExerciseAlternativeAnnotation = {
  tier: ExerciseAlternativeTier;
  label: string;
  description: string;
};

export type RankedExerciseAlternative = {
  item: ExerciseDiscoveryItem;
  tier: ExerciseAlternativeTier;
  primaryMuscleOverlap: number;
  annotation: ExerciseAlternativeAnnotation;
};

function normalizedSet(values: string[]) {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function primaryMuscleOverlap(
  planned: ExerciseDiscoveryItem,
  candidate: ExerciseDiscoveryItem
) {
  const plannedMuscles = normalizedSet(planned.primaryMuscles);
  return candidate.primaryMuscles.reduce(
    (count, muscle) => count + Number(plannedMuscles.has(muscle.trim().toLowerCase())),
    0
  );
}

function equipmentDifference(
  planned: ExerciseDiscoveryItem,
  candidate: ExerciseDiscoveryItem
) {
  const plannedEquipment = normalizedSet(planned.equipment);
  const candidateEquipment = normalizedSet(candidate.equipment);
  const changed =
    plannedEquipment.size !== candidateEquipment.size ||
    [...plannedEquipment].some((equipment) => !candidateEquipment.has(equipment));
  return changed ? " Equipment and loading setup differ." : "";
}

export function classifyExerciseAlternative(
  planned: ExerciseDiscoveryItem,
  candidate: ExerciseDiscoveryItem
): RankedExerciseAlternative | null {
  const overlap = primaryMuscleOverlap(planned, candidate);
  let tier: ExerciseAlternativeTier | null = null;

  if (planned.family && candidate.family === planned.family) {
    tier = "same_family";
  } else if (
    candidate.movementPattern === planned.movementPattern &&
    overlap > 0
  ) {
    tier = "same_movement";
  } else if (overlap > 0) {
    tier = "same_muscle";
  }

  if (!tier) return null;

  const annotation: ExerciseAlternativeAnnotation =
    tier === "same_family"
      ? {
          tier,
          label: "Closest family variant",
          description: `The closest match to ${planned.name}.${equipmentDifference(planned, candidate)}`,
        }
      : tier === "same_movement"
        ? {
            tier,
            label: "Same movement",
            description: `Keeps the ${planned.movementPattern.replaceAll("_", " ")} pattern and primary-muscle emphasis, but uses a different exercise family.${equipmentDifference(planned, candidate)}`,
          }
        : {
            tier,
            label: "Same primary muscle",
            description: `Trains the same primary muscle area with a different ${candidate.movementPattern.replaceAll("_", " ")} movement. Sets and loads are not directly comparable.${equipmentDifference(planned, candidate)}`,
          };

  return { item: candidate, tier, primaryMuscleOverlap: overlap, annotation };
}

const TIER_ORDER: Record<ExerciseAlternativeTier, number> = {
  same_family: 0,
  same_movement: 1,
  same_muscle: 2,
};

export function rankExerciseAlternatives(
  planned: ExerciseDiscoveryItem,
  candidates: ExerciseDiscoveryItem[]
) {
  return candidates
    .map((candidate) => classifyExerciseAlternative(planned, candidate))
    .filter((candidate): candidate is RankedExerciseAlternative => candidate != null)
    .sort(
      (a, b) =>
        TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
        b.primaryMuscleOverlap - a.primaryMuscleOverlap ||
        Number(b.item.inCurrentProgram) - Number(a.item.inCurrentProgram) ||
        (a.item.recentRank ?? Number.MAX_SAFE_INTEGER) -
          (b.item.recentRank ?? Number.MAX_SAFE_INTEGER) ||
        (b.item.useCount ?? 0) - (a.item.useCount ?? 0) ||
        a.item.name.localeCompare(b.item.name)
    );
}
