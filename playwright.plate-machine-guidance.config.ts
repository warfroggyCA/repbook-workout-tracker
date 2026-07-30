import { defineConfig, devices } from "@playwright/test";

const iphoneUserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const calibratedIphone = {
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
  testMatch: ["plate-machine-guidance.spec.ts"],
  outputDir: "./output/playwright/plate-machine-guidance-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3123",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "iphone-17-pro-max-webkit-browser",
      use: {
        ...devices["Desktop Safari"],
        ...calibratedIphone,
      },
    },
    {
      name: "iphone-17-pro-max-webkit-installed-like",
      use: {
        ...devices["Desktop Safari"],
        ...calibratedIphone,
      },
    },
    {
      name: "normal-desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        locale: "en-CA",
        timezoneId: "America/Toronto",
      },
    },
  ],
  webServer: {
    command:
      "env E2E_PORT=3123 node scripts/run-e2e-server.mjs --production --plate-machine-guidance",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: "http://127.0.0.1:3123/sign-in",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
