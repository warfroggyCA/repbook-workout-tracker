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
      }),
    )
    .min(1)
    .max(6),
  nextFocus: z.array(z.string().min(1).max(300)).min(1).max(4),
  dataGaps: z.array(z.string().min(1).max(300)).max(6),
});

export type CoachingReview = z.infer<typeof coachingReviewSchema>;

// New output stays concise; the original schema remains the reader for saved reviews.
export const conciseCoachingReviewSchema = coachingReviewSchema.extend({
  summary: z.string().min(1).max(300),
  highlights: z
    .array(
      coachingReviewSchema.shape.highlights.element.extend({
        title: z.string().min(1).max(100),
        detail: z.string().min(1).max(280),
      }),
    )
    .min(1)
    .max(3),
  nextFocus: z.array(z.string().min(1).max(180)).min(1).max(2),
});
