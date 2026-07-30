import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.REPLACEMENT_MOBILE_PORT ?? "3126", 10);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["replacement-mobile-keyboard.spec.ts"],
  outputDir: "./output/playwright/replacement-mobile/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
    locale: "en-CA",
    timezoneId: "America/Toronto",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
  projects: [
    {
      name: "replacement-mobile-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "replacement-mobile-webkit",
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
