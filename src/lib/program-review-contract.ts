import { z } from "zod";
import {
  programDurationRangeSchema,
  programPreflightResultSchema,
} from "@/lib/program-preflight";

const reviewChangeSchema = z.object({
  kind: z.string().min(1),
  path: z.string().min(1),
  label: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
});

const reviewFieldsSchema = z.object({
  reviewedRevision: z.number().int().min(0),
  changes: z.array(reviewChangeSchema),
  programUpdates: z.array(reviewChangeSchema).default([]),
  cautions: z.array(z.string()),
  preflight: programPreflightResultSchema.nullable(),
  recommendationRevision: z.number().int().min(0),
  recommendationConsequences: z.array(
    z.object({
      recommendationId: z.string().uuid(),
      outcome: z.enum(["carry", "satisfied", "superseded"]),
      explanation: z.string().min(1),
    }),
  ),
  summary: z.object({
    weeklySetsBefore: z.number().finite().min(0),
    weeklySetsAfter: z.number().finite().min(0),
    durationBefore: z.array(programDurationRangeSchema),
    durationAfter: z.array(programDurationRangeSchema),
    muscleSetsBefore: z.record(z.string(), z.number().finite().min(0)),
    muscleSetsAfter: z.record(z.string(), z.number().finite().min(0)),
  }),
});

export const publishableProgramReviewSchema = reviewFieldsSchema.extend({
  status: z.literal("publishable"),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  blockingErrors: z.tuple([]),
});

export const blockedProgramReviewSchema = reviewFieldsSchema.extend({
  status: z.literal("blocked"),
  hash: z.null(),
  blockingErrors: z.array(z.string().min(1)).min(1),
});

export const programReviewSchema = z.discriminatedUnion("status", [
  publishableProgramReviewSchema,
  blockedProgramReviewSchema,
]);

export type ProgramReviewChange = z.infer<typeof reviewChangeSchema>;
export type PublishableProgramReview = z.infer<
  typeof publishableProgramReviewSchema
>;
export type BlockedProgramReview = z.infer<typeof blockedProgramReviewSchema>;
export type ProgramReview = z.infer<typeof programReviewSchema>;
