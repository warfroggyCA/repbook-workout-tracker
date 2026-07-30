import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "history-calendar.spec.ts",
  outputDir: "./output/playwright/history-calendar",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "history-calendar-chromium",
      use: {
        ...devices["Desktop Chrome"],
        timezoneId: "Pacific/Kiritimati",
      },
    },
    {
      name: "history-calendar-webkit",
      use: {
        ...devices["iPhone 13"],
        timezoneId: "Pacific/Kiritimati",
      },
    },
  ],
  webServer: {
    command:
      "env AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret node scripts/run-e2e-server.mjs --production",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: "http://127.0.0.1:3100/sign-in",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
