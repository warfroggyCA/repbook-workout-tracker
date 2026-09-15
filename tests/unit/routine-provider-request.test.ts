import { afterEach, expect, it, vi } from "vitest";
import { getAIProvider } from "@/ai/provider";
import { routineParseDraftSchema } from "@/ai/tasks/routine-parse/schema";
import { programUpdateSchema } from "@/ai/tasks/program-update/schema";
import { sanitizeAIProviderError } from "@/lib/ai-provider-error";
import { programAIFailureMessage } from "@/lib/program-ai-failure";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.each([routineParseDraftSchema, programUpdateSchema])(
  "sends a strict compatible union through the installed OpenAI SDK",
  async (schema) => {
    vi.stubEnv("AI_FAKE", "0");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
    vi.stubEnv("AI_PARSE_MODEL", "gpt-5.4-mini");
    let sent: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            error: {
              message: "Synthetic rejection",
              type: "invalid_request_error",
              code: "test_error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await expect(
      getAIProvider().parseStructured<unknown>({
        task: "routine_parse",
        system: "Synthetic test",
        input: "Synthetic routine",
        schema,
      }),
    ).rejects.toThrow();
    expect(sent).not.toBeNull();
    expect(JSON.stringify(sent)).toContain('"anyOf"');
    expect(JSON.stringify(sent)).not.toContain('"oneOf"');
    expect(sent).toMatchObject({
      store: false,
      text: { format: { type: "json_schema", strict: true } },
    });
  },
);

it("preserves the provider status after the installed SDK exhausts retries", async () => {
  vi.stubEnv("AI_FAKE", "0");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
  const fetch = vi.fn(async () => new Response(
    JSON.stringify({
      error: {
        message: "PRIVATE_SYNTHETIC_PROVIDER_DETAIL",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetch);
  let failure: unknown;
  try {
    await getAIProvider().parseStructured({
      task: "routine_build",
      system: "Synthetic test",
      input: "Synthetic request",
      schema: programUpdateSchema,
    });
  } catch (error) {
    failure = error;
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  const safe = sanitizeAIProviderError(failure);
  expect(safe).toEqual({
    errorKind: "provider_retry",
    providerStatusCode: 429,
    providerRetryable: true,
    causeKind: "provider_api",
  });
  expect(programAIFailureMessage(safe)).toContain("usage limit");
  expect(JSON.stringify(safe)).not.toContain("PRIVATE_SYNTHETIC_PROVIDER_DETAIL");
});
