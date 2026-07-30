import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["program-editor-core.spec.ts", "program-page-repair.spec.ts"],
  outputDir: "./output/playwright/program-editor-cross-browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
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
