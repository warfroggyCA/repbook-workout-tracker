import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each([undefined, "OPENAI_API_KEY", "ANTHROPIC_API_KEY"])(
  "reports the actual preview provider with %s configured", async (key) => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_FAKE", "1");
    vi.stubEnv("AI_FAKE_UNAVAILABLE", "0");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    if (key) vi.stubEnv(key, "synthetic-test-key");
    const { getAIProvider, isUsingExampleAIProvider } = await import("@/ai/provider");
    const selected = getAIProvider();
    expect(isUsingExampleAIProvider()).toBe(!key);
    expect(getAIProvider()).toBe(selected);
  },
);
