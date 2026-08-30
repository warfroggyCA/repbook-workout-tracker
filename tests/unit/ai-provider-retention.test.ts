import { afterEach, describe, expect, it, vi } from "vitest";
import { coachingAnswerSchema } from "@/ai/tasks/coaching-qa/schema";
import {
  DEFAULT_OPENAI_MODEL,
  getAIProvider,
  OPENAI_NO_STORAGE_OPTIONS,
  structuredOutputTokenLimit,
} from "@/ai/provider";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenAI provider retention", () => {
  it("uses the stronger current small model by default", () => {
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-5.4-mini");
  });

  it("explicitly disables provider response storage", () => {
    expect(OPENAI_NO_STORAGE_OPTIONS).toEqual({
      openai: {
        store: false,
        reasoningEffort: "low",
        reasoningSummary: null,
      },
    });
  });

  it("leaves enough output room for OpenAI Coach answers after reasoning", () => {
    expect(structuredOutputTokenLimit("coaching_qa")).toBe(4_000);
    expect(structuredOutputTokenLimit("weekly_review")).toBe(4_000);
    expect(structuredOutputTokenLimit("equipment_parse")).toBe(2_000);
    expect(structuredOutputTokenLimit("routine_build")).toBe(6_000);
  });

  it("keeps a bounded adaptive allowance for routine parsing", () => {
    expect(structuredOutputTokenLimit("routine_parse", "Day 1")).toBe(2_003);
    expect(
      structuredOutputTokenLimit("routine_parse", "x".repeat(20_000)),
    ).toBe(8_000);
  });

  it("keeps fake Coach data gaps within the answer contract", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_FAKE", "1");
    const dataGaps = Array.from(
      { length: 6 },
      (_, index) => `Missing signal ${index + 1}`,
    );

    const result = await getAIProvider().parseStructured({
      task: "coaching_qa",
      system: "Return a grounded Coach answer.",
      input: JSON.stringify({
        question: "What should I focus on next?",
        context: {
          trainingDigest: {
            cadence: { completedSessions: 11 },
            dataGaps,
          },
        },
      }),
      schema: coachingAnswerSchema,
    });

    expect(result.value.dataGaps).toEqual(dataGaps.slice(0, 5));
  });
});
