import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testMatch: "workout-smoke.spec.ts",
  grep: /opens failed-set recovery from Settings at 145 percent on iPhone WebKit/,
  outputDir: "./output/playwright/failed-set-recovery",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    ...devices["iPhone 17 Pro Max"],
    browserName: "webkit",
    baseURL: "http://127.0.0.1:3121",
    locale: "en-CA",
    timezoneId: "America/Toronto",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "env AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret E2E_PORT=3121 node scripts/run-e2e-server.mjs --production",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: "http://127.0.0.1:3121/sign-in",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
