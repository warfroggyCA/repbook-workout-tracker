import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(
  process.env.ACTIVE_WORKOUT_ADD_EXERCISE_PORT ?? "3129",
  10,
);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["active-workout-add-exercise.spec.ts"],
  outputDir: "./output/playwright/active-workout-add-exercise/test-results",
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-CA",
    timezoneId: "America/Toronto",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-webkit",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: `env E2E_PORT=${port} AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret node scripts/run-e2e-server.mjs --production`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
