import { defineConfig, devices } from "@playwright/test";

const iphoneUserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const calibratedProfile = {
  viewport: { width: 440, height: 956 },
  screen: { width: 440, height: 956 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: iphoneUserAgent,
  locale: "en-CA",
  timezoneId: "America/Toronto",
  colorScheme: "light" as const,
};

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["stage3-mobile-calibration.spec.ts"],
  outputDir: "./output/playwright/stage3-mobile-test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    ...calibratedProfile,
    baseURL: "http://127.0.0.1:3114",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "iphone-17-pro-max-chrome-reference",
      use: { ...devices["Desktop Chrome"], ...calibratedProfile },
    },
  ],
  webServer: {
    command: "env E2E_PORT=3114 node scripts/run-e2e-server.mjs --production",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: "http://127.0.0.1:3114/sign-in",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
