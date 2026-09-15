import { afterEach, expect, it, vi } from "vitest";
import { getAIProvider } from "@/ai/provider";
import { routineParseDraftSchema } from "@/ai/tasks/routine-parse/schema";
import { programUpdateSchema } from "@/ai/tasks/program-update/schema";

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
