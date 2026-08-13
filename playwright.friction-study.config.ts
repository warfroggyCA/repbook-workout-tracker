import { defineConfig, devices } from "@playwright/test";

const variant = process.env.STUDY_VARIANT;
if (variant !== "before" && variant !== "after") {
  throw new Error("STUDY_VARIANT must be before or after.");
}
const port = Number.parseInt(process.env.STUDY_PORT ?? "3100", 10);

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
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-friction-study-server.mjs`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
