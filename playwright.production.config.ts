import { defineConfig, devices } from "@playwright/test";

const remoteBaseURL = process.env.PLAYWRIGHT_PRODUCTION_BASE_URL?.replace(
  /\/$/,
  ""
);
const baseURL = remoteBaseURL ?? "http://127.0.0.1:3100";
const testMatch = [
  "security-headers.spec.ts",
  "production-recovery.spec.ts",
  ...(!remoteBaseURL ? ["optimized-route-matrix.spec.ts"] : []),
];

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch,
  outputDir: "./output/playwright/production-test-results",
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    ...(remoteBaseURL ? {} : devices["Desktop Chrome"]),
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: remoteBaseURL
    ? [
        { name: "desktop-chrome", use: devices["Desktop Chrome"] },
        { name: "mobile-chrome", use: devices["Pixel 7"] },
      ]
    : undefined,
  webServer: remoteBaseURL
    ? undefined
    : {
        command:
          "env AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret node scripts/run-e2e-server.mjs --production --optimized-route-fixtures",
        gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
        url: "http://127.0.0.1:3100/sign-in",
        reuseExistingServer: false,
        timeout: 180_000,
      },
});
