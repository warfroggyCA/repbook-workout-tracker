import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "pii01b-equipment-fit.spec.ts",
  outputDir: "./output/playwright/pii01b-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  projects: [
    {
      name: "narrow-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        baseURL: "http://127.0.0.1:3180",
      },
    },
    {
      name: "narrow-webkit",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 390, height: 844 },
        baseURL: "http://127.0.0.1:3181",
      },
    },
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [3180, 3181].map((port) => ({
    command:
      `env E2E_PORT=${port} AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret node scripts/run-e2e-server.mjs --production --pii01b-equipment-fit`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  })),
});
