import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("keeps every disposable login guard while disabling real and fake AI", async () => {
  vi.resetModules();
  for (const [key, value] of Object.entries({
    NODE_ENV: "production",
    E2E_DEV_LOGIN: "1",
    AI_FAKE: "1",
    AI_FAKE_UNAVAILABLE: "1",
    PGLITE_DIR: "/tmp/test-pglite",
    SNAPSHOT_LOCAL_DIR: "/tmp/test-snapshots",
    SNAPSHOT_ENCRYPTION_KEY_V1: "synthetic-test-key",
    DATABASE_URL:
      "postgresql://workout_tracker_test:local-test-only@local.test/workout_tracker_test",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  }))
    vi.stubEnv(key, value);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { isDisposableAcceptanceRuntime } = await import(
    "@/lib/acceptance-runtime"
  );
  const { isAIAvailable, getAIProvider } = await import("@/ai/provider");
  expect(isDisposableAcceptanceRuntime()).toBe(true);
  expect(isAIAvailable()).toBe(false);
  await expect(
    getAIProvider().parseStructured({
      task: "routine_build",
      system: "Synthetic test",
      input: "No request may be sent",
      schema: z.object({}),
    }),
  ).rejects.toThrow("not configured");
  expect(fetch).not.toHaveBeenCalled();
});
