import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.HISTORY_WORKSPACE_PORT ?? "3126", 10);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["history-workspace.spec.ts"],
  outputDir: "./output/playwright/history-workspace/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-CA",
    timezoneId: "America/Toronto",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-e2e-server.mjs --production --stage7-ux`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
