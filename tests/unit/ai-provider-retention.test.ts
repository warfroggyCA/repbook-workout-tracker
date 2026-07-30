import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_MODEL,
  OPENAI_NO_STORAGE_OPTIONS,
  structuredOutputTokenLimit,
} from "@/ai/provider";

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
});
