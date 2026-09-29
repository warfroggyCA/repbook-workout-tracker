import { describe, expect, it } from "vitest";
import { coachReviewStatus, hasReviewableTraining } from "@/lib/coach-review-status";
import { TRAINING_CADENCE_ALGORITHM_VERSION } from "@/lib/training-cadence";
import { PRESCRIPTION_OUTCOME_ALGORITHM_VERSION } from "@/lib/set-metric-semantics";
const digest = {
  cadenceAlgorithmVersion: TRAINING_CADENCE_ALGORITHM_VERSION,
  prescriptionOutcomeAlgorithmVersion: PRESCRIPTION_OUTCOME_ALGORITHM_VERSION,
  sourceEvidenceRevision: "10",
  untilLocalDate: "2026-09-29",
};
describe("saved Coach review freshness", () => {
  it("requires current algorithms, evidence revision and calendar window", () => {
    expect(coachReviewStatus(digest, "10", "2026-09-29").current).toBe(true);
    expect(coachReviewStatus(digest, "11", "2026-09-29").current).toBe(false);
    expect(coachReviewStatus(digest, "10", "2026-09-30").current).toBe(false);
  });
  it("never treats legacy, malformed, or unversioned prose as current advice", () => {
    for (const value of [
      null,
      [],
      "text",
      {},
      { ...digest, cadenceAlgorithmVersion: "old" },
      { ...digest, sourceEvidenceRevision: undefined },
    ]) {
      expect(coachReviewStatus(value, "10", "2026-09-29").current).toBe(false);
    }
  });
});

it("allows reviews of interrupted-only training without treating empty history as training", () => {
  expect(hasReviewableTraining({ completedSessions: 0, abandonedSessions: 1 }, 0)).toBe(true);
  expect(hasReviewableTraining({ completedSessions: 0, abandonedSessions: 0 }, 0)).toBe(false);
  expect(hasReviewableTraining({ completedSessions: 1, abandonedSessions: 0 }, 0)).toBe(true);
  expect(hasReviewableTraining({ completedSessions: 0, abandonedSessions: 0 }, 1)).toBe(true);
});
