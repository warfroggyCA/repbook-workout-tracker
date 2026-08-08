import { z } from "zod";
import type {
  RecommendationEvidence,
  RecommendationPayload,
  RecommendationReviewEvidence,
} from "@/db/schema";

export const REVIEW_EVIDENCE_SCHEMA_VERSION = "review-evidence-v1" as const;
export const PROGRESSION_REVIEW_SOURCE_VERSION = "progression-rules-v1" as const;

export const recommendationReviewEvidenceSchema = z.object({
  schemaVersion: z.literal(REVIEW_EVIDENCE_SCHEMA_VERSION),
  producer: z.enum(["progression_rules", "pain_consistency", "external_analysis"]),
  sourceVersion: z.string().trim().min(1).max(100),
  generatedAt: z.iso.datetime(),
  quality: z.enum([
    "supported",
    "contradictory",
    "unsupported",
    "unverified_external",
  ]),
  confidence: z.literal("not_scored"),
  limitations: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  proposedEffect: z.object({
    kind: z.enum(["future_program_change", "future_review_intent", "none"]),
    summary: z.string().trim().min(1).max(500),
  }),
});

function proposedEffect(payload: RecommendationPayload) {
  switch (payload.kind) {
    case "load_change":
      return `${payload.fromLoad ?? "No current target"} → ${payload.toLoad} ${payload.loadUnit} in a new future Program version; completed workouts stay unchanged.`;
    case "substitution":
      return "Replace this exercise only in a new future Program version; completed workouts and their performed identities stay unchanged.";
    case "rep_target_change":
      return `${payload.fromRepMax} → ${payload.toRepMax} maximum target reps in a new future Program version.`;
    case "set_count_change":
      return `${payload.fromSets} → ${payload.toSets} planned sets in a new future Program version.`;
    case "deload":
      return "Publish the proposed temporary deload only as a new future Program version.";
    case "remove_exercise":
      return "Remove this exercise only from a new future Program version; completed workouts stay unchanged.";
    case "hold":
      return "No Program change. This informational status only prevents an unsupported automatic progression while its evidence remains current.";
    case "external_review":
      return `${payload.requestedOutcome} Accepting records this as an owner-approved future Review direction; it does not edit or publish the Program.`;
  }
}

export function buildRecommendationReviewEvidence(input: {
  payload: RecommendationPayload;
  producer: RecommendationReviewEvidence["producer"];
  sourceVersion: string;
  generatedAt?: Date;
  quality?: RecommendationReviewEvidence["quality"];
  limitations?: string[];
}): RecommendationReviewEvidence {
  const isHold = input.payload.kind === "hold";
  const isExternal = input.payload.kind === "external_review";
  return recommendationReviewEvidenceSchema.parse({
    schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION,
    producer: input.producer,
    sourceVersion: input.sourceVersion,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    quality: input.quality ?? "supported",
    confidence: "not_scored",
    limitations: input.limitations ?? [
      "Only cited retained evidence was evaluated. Missing observations remain unknown.",
      "This deterministic proposal has no confidence score and does not account for unrecorded context.",
    ],
    proposedEffect: {
      kind: isHold
        ? "none"
        : isExternal
          ? "future_review_intent"
          : "future_program_change",
      summary: proposedEffect(input.payload),
    },
  });
}

export function withRecommendationReviewEvidence(
  evidence: RecommendationEvidence,
  input: Parameters<typeof buildRecommendationReviewEvidence>[0],
): RecommendationEvidence {
  return { ...evidence, review: buildRecommendationReviewEvidence(input) };
}

export function parseRecommendationReviewEvidence(evidence: RecommendationEvidence) {
  return recommendationReviewEvidenceSchema.safeParse(evidence.review);
}
