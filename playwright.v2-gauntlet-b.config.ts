import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.V2_GAUNTLET_B_PORT ?? "3149", 10);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["v2-gauntlet-b-live-workout.spec.ts"],
  outputDir: "./output/playwright/v2-gauntlet-b/test-results",
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
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
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-reference-chromium",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 440, height: 956 },
      },
    },
    {
      name: "narrow-mobile-webkit",
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit",
        viewport: { width: 320, height: 700 },
      },
    },
  ],
  webServer: {
    command: `env E2E_PORT=${port} AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret node scripts/run-e2e-server.mjs --production --v2-gauntlet-b-live-workout`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
