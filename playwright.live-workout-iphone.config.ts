import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testMatch: "workout-smoke.spec.ts",
  grep: /keeps every active-workout route reachable with one scroll surface/,
  outputDir: "./output/playwright/live-workout-iphone",
  use: {
    ...devices["iPhone 13"],
    baseURL: "http://127.0.0.1:3100",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
});
