import type { PerformedSemanticFacet } from "@/lib/history-workout-evidence";

export const EXERCISE_HISTORY_ALGORITHM_VERSION = "exercise-history-v1";

export const EXERCISE_EVIDENCE_TIERS = [
  "native",
  "manual",
  "imported",
  "corrected",
  "legacy",
  "unsupported",
] as const;

export type ExerciseEvidenceTier = (typeof EXERCISE_EVIDENCE_TIERS)[number];
export type ExerciseIdentityScope =
  "shared" | "owner_created" | "import_created";
export type ReviewedMappingStatus =
  | "not_applicable"
  | "confirmed"
  | "missing"
  | "inconsistent";

export type ReviewedExerciseMapping = {
  id: string;
  source: string;
  normalizedKey: string;
  sourceName: string;
  sourceEquipment: string | null;
  exerciseId: string;
  confirmedAtISO: string;
};

export const EXERCISE_EVIDENCE_TIER_LABELS: Record<
  ExerciseEvidenceTier,
  string
> = {
  native: "Recorded in Repbook",
  manual: "Entered after the workout",
  imported: "Imported evidence",
  corrected: "Corrected evidence",
  legacy: "Legacy evidence",
  unsupported: "Unsupported evidence",
};

/** Returns null for an exercise that does not belong to the current owner. */
export function classifyExerciseIdentityScope(input: {
  ownerId: string;
  exerciseOwnerId: string | null;
  createdFromImportEventId: string | null;
}): ExerciseIdentityScope | null {
  if (input.exerciseOwnerId == null) return "shared";
  if (input.exerciseOwnerId !== input.ownerId) return null;
  return input.createdFromImportEventId == null
    ? "owner_created"
    : "import_created";
}

export function hasOneExactCompletedWorkingOccurrence<
  T extends {
    kind: string;
    outcome: string;
    completedSetId: string | null;
  },
>(setId: string, occurrences: T[]) {
  return (
    occurrences.filter(
      (occurrence) =>
        occurrence.kind === "working_set" &&
        occurrence.outcome === "completed" &&
        occurrence.completedSetId === setId,
    ).length === 1
  );
}

export function classifyExerciseEvidenceTier(input: {
  source: string;
  importBatchId: string | null;
  occurrenceOrigin: string | null;
  performedSemanticFacet: PerformedSemanticFacet;
  calculationSupported?: boolean;
  exactOccurrenceLinked: boolean;
  corrected: boolean;
}): ExerciseEvidenceTier {
  if (
    input.performedSemanticFacet === "unsupported" ||
    input.calculationSupported === false
  ) {
    return "unsupported";
  }
  if (
    input.performedSemanticFacet === "legacy_partial" ||
    !input.exactOccurrenceLinked ||
    input.occurrenceOrigin === "legacy"
  ) {
    return "legacy";
  }
  if (input.corrected) return "corrected";
  if (
    input.importBatchId != null ||
    input.source === "hevy" ||
    input.occurrenceOrigin === "imported"
  ) {
    return "imported";
  }
  if (input.source === "history_manual") return "manual";
  return "native";
}

export function resolveReviewedExerciseMapping(input: {
  source: string;
  performedExerciseId: string;
  normalizedKey: string | null;
  mappings: ReviewedExerciseMapping[];
}): { status: ReviewedMappingStatus; mapping: ReviewedExerciseMapping | null } {
  if (input.source !== "hevy") {
    return { status: "not_applicable", mapping: null };
  }
  if (input.normalizedKey == null) return { status: "missing", mapping: null };
  const mapping = input.mappings.find(
    (candidate) =>
      candidate.source === input.source &&
      candidate.normalizedKey === input.normalizedKey,
  );
  if (!mapping) return { status: "missing", mapping: null };
  if (mapping.exerciseId !== input.performedExerciseId) {
    return { status: "inconsistent", mapping };
  }
  return { status: "confirmed", mapping };
}

export function tierWithReviewedMapping(
  tier: ExerciseEvidenceTier,
  mappingStatus: ReviewedMappingStatus,
): ExerciseEvidenceTier {
  if (mappingStatus === "inconsistent") return "unsupported";
  if (mappingStatus === "missing" && tier !== "unsupported") return "legacy";
  return tier;
}
