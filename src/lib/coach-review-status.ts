import { TRAINING_CADENCE_ALGORITHM_VERSION } from "@/lib/training-cadence";
import { PRESCRIPTION_OUTCOME_ALGORITHM_VERSION } from "@/lib/set-metric-semantics";

export function coachReviewStatus(
  digest: unknown,
  revision: string,
  today: string,
) {
  const value =
    digest && typeof digest === "object"
      ? (digest as Record<string, unknown>)
      : {};
  if (
    value.cadenceAlgorithmVersion !== TRAINING_CADENCE_ALGORITHM_VERSION ||
    value.prescriptionOutcomeAlgorithmVersion !==
      PRESCRIPTION_OUTCOME_ALGORITHM_VERSION
  ) {
    return {
      current: false,
      message:
        "This older review may use calculations that have since changed.",
    };
  }
  if (typeof value.sourceEvidenceRevision !== "string") {
    return {
      current: false,
      message:
        "This saved review has not been checked against your current training records.",
    };
  }
  if (value.sourceEvidenceRevision !== revision) {
    return {
      current: false,
      message: "Your training records have changed since this review.",
    };
  }
  if (value.untilLocalDate !== today) {
    return {
      current: false,
      message:
        "This review covers an earlier period. Update it for your current training window.",
    };
  }
  return { current: true, message: null };
}
