import { z } from "zod";
import {
  analysisPackageSourceBindingSchema,
  analysisQuestionSchema,
} from "@/lib/analysis-package";
import {
  EXTERNAL_ANALYSIS_INSTRUCTION_VERSION,
  EXTERNAL_ANALYSIS_RESPONSE_SCHEMA_VERSION,
} from "@/lib/external-analysis-versions";
import { externalAnalysisResponseSchema } from "@/lib/external-analysis-response";

export const EXTERNAL_ANALYSIS_IMPORT_SCHEMA_VERSION =
  "external-analysis-import/1" as const;
export const EXTERNAL_ANALYSIS_RESPONSE_DIGEST_VERSION = "sha256" as const;
export const EXTERNAL_ANALYSIS_IMPORT_MAX_BYTES = 288 * 1024;

const selectedItemIds = z.array(z.string().min(1).max(64)).max(25);

export const externalAnalysisImportRequestSchema = z
  .object({
    response: externalAnalysisResponseSchema,
    selections: z
      .object({
        observationIds: selectedItemIds,
        proposalIds: selectedItemIds,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.selections.observationIds.length === 0 &&
      value.selections.proposalIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["selections"],
        message: "Select at least one observation or proposal to import.",
      });
    }
    if (
      new Set(value.selections.observationIds).size !==
        value.selections.observationIds.length ||
      new Set(value.selections.proposalIds).size !==
        value.selections.proposalIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["selections"],
        message: "Selected item IDs must be unique.",
      });
    }
  });

const importedObservationSchema = externalAnalysisResponseSchema.shape.observations.element;

export const externalAnalysisImportDigestSchema = z
  .object({
    schemaVersion: z.literal(EXTERNAL_ANALYSIS_IMPORT_SCHEMA_VERSION),
    package: z
      .object({
        id: z.string().uuid(),
        namespace: z.string().regex(/^repbook-owner\/[0-9a-f]{24}$/),
        schemaVersion: z.literal("analysis-package/1"),
        semanticVersion: z.literal("repbook-v2/1"),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        evidenceCutoff: z.string().datetime(),
        expiresAt: z.string().datetime(),
      })
      .strict(),
    response: z
      .object({
        id: z.string().uuid(),
        schemaVersion: z.literal(EXTERNAL_ANALYSIS_RESPONSE_SCHEMA_VERSION),
        instructionVersion: z.literal(EXTERNAL_ANALYSIS_INSTRUCTION_VERSION),
        digestAlgorithm: z.literal(EXTERNAL_ANALYSIS_RESPONSE_DIGEST_VERSION),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    question: z
      .object({
        id: analysisQuestionSchema,
        text: z.string().min(1).max(1_000),
      })
      .strict(),
    sourceBindings: z.array(analysisPackageSourceBindingSchema).max(100),
    selectedObservationIds: selectedItemIds,
    selectedProposalIds: selectedItemIds,
    observations: z.array(importedObservationSchema).max(25),
    recommendationMap: z
      .array(
        z
          .object({
            proposalId: z.string().min(1).max(64),
            recommendationId: z.string().uuid(),
          })
          .strict(),
      )
      .max(25),
    importedAt: z.string().datetime(),
    rawResponseRetained: z.literal(false),
  })
  .strict();

export const externalAnalysisRecommendationEvidenceSchema = z
  .object({
    schemaVersion: z.literal("external-analysis-evidence-v1"),
    importId: z.string().uuid(),
    packageId: z.string().uuid(),
    responseId: z.string().uuid(),
    responseDigest: z.string().regex(/^[0-9a-f]{64}$/),
    proposalId: z.string().min(1).max(64),
    citedEvidenceIds: z.array(z.string().min(1).max(200)).min(1).max(40),
  })
  .strict();

export type ExternalAnalysisImportRequest = z.infer<
  typeof externalAnalysisImportRequestSchema
>;
export type ExternalAnalysisImportDigest = z.infer<
  typeof externalAnalysisImportDigestSchema
>;

export function sameExternalAnalysisSelections(
  digest: ExternalAnalysisImportDigest,
  selections: ExternalAnalysisImportRequest["selections"],
) {
  return (
    JSON.stringify([...digest.selectedObservationIds].sort()) ===
      JSON.stringify([...selections.observationIds].sort()) &&
    JSON.stringify([...digest.selectedProposalIds].sort()) ===
      JSON.stringify([...selections.proposalIds].sort())
  );
}
