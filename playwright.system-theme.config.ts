import { defineConfig, devices } from "@playwright/test";
const port = Number.parseInt(process.env.SYSTEM_THEME_PORT ?? "3196", 10);
export default defineConfig({
  testDir: "./tests/e2e", testMatch: ["system-theme.spec.ts"],
  outputDir: `./output/playwright/system-theme/${port}/test-results`,
  workers: 1, retries: 0, fullyParallel: false, timeout: 240_000,
  expect: { timeout: 20_000 }, reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, locale: "en-CA", timezoneId: "America/Toronto", colorScheme: "light", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "narrow-mobile-webkit", use: { browserName: "webkit", viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-e2e-server.mjs --production --stage7-ux --coach-clarity --phase1-foundation`,
    url: `http://127.0.0.1:${port}/sign-in`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 }, reuseExistingServer: false, timeout: 180_000,
  },
});
