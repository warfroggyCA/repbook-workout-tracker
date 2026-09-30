import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.WORKOUT_FEEDBACK_PORT ?? 3192);
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "workout-feedback.spec.ts",
  outputDir: "./output/playwright/workout-feedback", workers: 1, retries: 0,
  timeout: 180_000, expect: { timeout: 20_000 }, reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-e2e-server.mjs --production --workout-feedback`,
    url: `http://127.0.0.1:${port}/sign-in`, reuseExistingServer: false, timeout: 180_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
