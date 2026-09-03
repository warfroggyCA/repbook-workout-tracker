import type { ExerciseAlternativeReason } from "@/lib/exercise-alternatives";

type SubstitutedSessionExercise = {
  id: string;
  exerciseId: string;
  modificationType: string;
  skipReason: string | null;
  substitutedForExerciseId: string | null;
  substitutionReason: ExerciseAlternativeReason | null;
};

type SessionExerciseVersion = {
  entityId: string;
  beforeData: Record<string, unknown>;
  afterData: Record<string, unknown>;
};

/**
 * Read only the evidence retained with this exact current substitution. A
 * present row value wins; version evidence is accepted only when the complete
 * post-substitution identity still matches. Current inventory is never used to
 * reconstruct a historical cause.
 */
export function retainedSkipReasonForSubstitution(
  exercise: SubstitutedSessionExercise,
  versions: readonly SessionExerciseVersion[],
): string | null {
  if (exercise.modificationType !== "substituted") return null;
  if (exercise.skipReason) return exercise.skipReason;
  const matchingVersion = versions.find(
    (version) =>
      version.entityId === exercise.id &&
      version.afterData.exercise_id === exercise.exerciseId &&
      version.afterData.substituted_for_exercise_id ===
        exercise.substitutedForExerciseId &&
      version.afterData.substitution_reason === exercise.substitutionReason,
  );
  const retainedReason = matchingVersion?.beforeData.skip_reason;
  return typeof retainedReason === "string" && retainedReason.length > 0
    ? retainedReason
    : null;
}

export function substitutionReasonLabel(
  reason: ExerciseAlternativeReason | null,
) {
  if (reason === "equipment_busy") return "equipment busy";
  if (reason === "equipment_unavailable_incompatible") {
    return "equipment unavailable or incompatible";
  }
  if (reason === "discomfort") return "discomfort";
  if (reason === "variety") return "variety";
  return "another reason";
}

export function skipReasonLabel(reason: string) {
  if (reason === "equipment_unavailable_incompatible") {
    return "equipment unavailable or incompatible";
  }
  if (reason === "technical_app_issue") return "technical or app issue";
  if (reason === "pain_discomfort") return "pain or discomfort";
  if (reason === "time_limit_reached") return "time limit reached";
  return reason.replaceAll("_", " ");
}
