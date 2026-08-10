import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.POST_V2_P1_TIMING_PORT ?? "3173", 10);
const startAt = "2026-08-04T16:00:00.000Z";
const finishAt = "2026-08-10T16:00:00.000Z";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["post-v2-p1-timing-recovery.spec.ts"],
  outputDir: "./output/playwright/post-v2-p1-timing/test-results",
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 25_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-CA",
    timezoneId: "America/Toronto",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
    ...devices["iPhone 13"],
    browserName: "chromium",
    viewport: { width: 390, height: 844 },
  },
  projects: [{ name: "stale-recovery-390-chromium" }],
  webServer: {
    command: `env E2E_PORT=${port} BA_ACCEPTANCE_START_AT=${startAt} BA_ACCEPTANCE_FINISH_AT=${finishAt} node scripts/run-e2e-server.mjs --production --ba-calendar`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
