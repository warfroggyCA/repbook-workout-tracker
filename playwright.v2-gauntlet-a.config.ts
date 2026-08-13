import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.V2_GAUNTLET_A_PORT ?? "3139", 10);

export default defineConfig({
  testDir: "./tests/e2e",
  // v2-u01 owns a separate BA-identity fixture and runs immediately before
  // this suite in the protected v2-execution group.
  testMatch: [
    "replacement-mobile-keyboard.spec.ts",
    "v2-gauntlet-a-recovery.spec.ts",
    "v2-t03-planned-order.spec.ts",
    "v2-t05-execution-semantics.spec.ts",
    "v2-u02-exception-context.spec.ts",
  ],
  outputDir: "./output/playwright/v2-gauntlet-a/test-results",
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
    command: `env E2E_PORT=${port} AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret node scripts/run-e2e-server.mjs --production`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
