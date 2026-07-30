import { defineConfig, devices } from "@playwright/test";

const variant = process.env.STUDY_VARIANT;
if (variant !== "before" && variant !== "after") {
  throw new Error("STUDY_VARIANT must be before or after.");
}

export default defineConfig({
  testDir: "./tests/studies",
  testMatch: "active-workout-friction.spec.ts",
  outputDir: `./output/playwright/friction-study/${variant}-test-results`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
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
    command: "node scripts/run-friction-study-server.mjs",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: "http://127.0.0.1:3100/sign-in",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
