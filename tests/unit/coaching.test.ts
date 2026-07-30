import { describe, expect, it } from "vitest";
import { coachingReviewSchema } from "@/ai/tasks/coaching-review/schema";
import { coachingAnswerSchema } from "@/ai/tasks/coaching-qa/schema";
import {
  parseStoredCoachingAnswer,
  parseStoredCoachingReview,
  questionFromInsightDigest,
} from "@/services/coaching";

const review = {
  summary: "Training is consistent, with one recovery signal to watch.",
  overallTone: "positive" as const,
  highlights: [
    {
      title: "Bench press is progressing",
      detail: "The latest clean exposures reached the top of the rep range.",
      tone: "positive" as const,
      evidence: ["Bench Press: 95×8 on Jul 2 and Jul 9"],
    },
  ],
  nextFocus: ["Keep the next bench increase small."],
  dataGaps: ["Effort is missing from several sets."],
};

describe("stored coaching insight validation", () => {
  it("round-trips a structured review", () => {
    expect(coachingReviewSchema.parse(review)).toEqual(review);
    expect(parseStoredCoachingReview(JSON.stringify(review))).toEqual(review);
  });

  it("refuses malformed or legacy review content", () => {
    expect(parseStoredCoachingReview("not json")).toBeNull();
    expect(
      parseStoredCoachingReview(JSON.stringify({ summary: "Incomplete" }))
    ).toBeNull();
  });

  it("round-trips an answer with evidence and uncertainty", () => {
    const answer = {
      answer: "The logged sets support holding steady for one more exposure.",
      evidence: ["Two of three squat sets missed the rep target."],
      dataGaps: ["No fatigue check-in was logged."],
      safetyNote: null,
    };
    expect(coachingAnswerSchema.parse(answer)).toEqual(answer);
    expect(parseStoredCoachingAnswer(JSON.stringify(answer))).toEqual(answer);
  });
});

describe("question history", () => {
  it("reads only a real string question from the stored model input", () => {
    expect(questionFromInsightDigest({ question: "How is my squat?" })).toBe(
      "How is my squat?"
    );
    expect(questionFromInsightDigest({ question: 42 })).toBeNull();
    expect(questionFromInsightDigest(null)).toBeNull();
  });
});
