import { z } from "zod";

export const coachingReviewSchema = z.object({
  summary: z.string().min(1).max(1200),
  overallTone: z.enum(["positive", "neutral", "watch"]),
  highlights: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        detail: z.string().min(1).max(700),
        tone: z.enum(["positive", "neutral", "watch"]),
        evidence: z.array(z.string().min(1).max(240)).max(5),
      })
    )
    .min(1)
    .max(6),
  nextFocus: z.array(z.string().min(1).max(300)).min(1).max(4),
  dataGaps: z.array(z.string().min(1).max(300)).max(6),
});

export type CoachingReview = z.infer<typeof coachingReviewSchema>;
