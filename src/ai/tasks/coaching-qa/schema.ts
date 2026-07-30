import { z } from "zod";

export const coachingAnswerSchema = z.object({
  answer: z.string().min(1).max(2200),
  evidence: z.array(z.string().min(1).max(260)).max(6),
  dataGaps: z.array(z.string().min(1).max(300)).max(5),
  safetyNote: z.string().min(1).max(500).nullable(),
});

export type CoachingAnswer = z.infer<typeof coachingAnswerSchema>;
