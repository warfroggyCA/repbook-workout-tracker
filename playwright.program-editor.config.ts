import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["program-editor.spec.ts", "program-page-repair.spec.ts"],
  outputDir: "./output/playwright/program-editor",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "node scripts/run-e2e-server.mjs --production",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: "http://127.0.0.1:3100/sign-in",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
