import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["stage3-durable-workout.spec.ts"],
  outputDir: "./output/playwright/stage3-production-test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3116",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "env E2E_PORT=3116 node scripts/run-e2e-server.mjs --production",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: "http://127.0.0.1:3116/sign-in",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
