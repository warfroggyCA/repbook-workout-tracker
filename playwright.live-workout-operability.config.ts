import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

const iphoneStandalone = {
  ...devices["iPhone 13"],
  baseURL: "http://127.0.0.1:3120",
  trace: "on" as const,
  screenshot: "on" as const,
  video: "retain-on-failure" as const,
};

export default defineConfig({
  ...baseConfig,
  testMatch: "workout-smoke.spec.ts",
  grep: /keeps every active-workout route reachable with one scroll surface/,
  outputDir: "./output/playwright/live-workout-operability",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  use: iphoneStandalone,
  projects: [
    { name: "iphone-standalone-chromium", use: { ...iphoneStandalone, browserName: "chromium" } },
    { name: "iphone-standalone-webkit", use: { ...iphoneStandalone, browserName: "webkit" } },
  ],
  webServer: {
    command:
      "env AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret E2E_PORT=3120 node scripts/run-e2e-server.mjs --production",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: "http://127.0.0.1:3120/sign-in",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
