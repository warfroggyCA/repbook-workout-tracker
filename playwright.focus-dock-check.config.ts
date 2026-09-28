// Manual WebKit check for focus clear of the active-workout dock.
// Run: npx playwright install webkit && npm run test:e2e:focus-dock-check
import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.FOCUS_DOCK_CHECK_PORT ?? "3187", 10);

export default defineConfig({
  testDir: "./tests/focus-dock-check",
  testMatch: ["focus-dock-check.spec.ts"],
  outputDir: "./output/playwright/focus-dock-check",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, locale: "en-CA", timezoneId: "America/Toronto", contextOptions: { reducedMotion: "reduce" } },
  projects: [
    { name: "webkit-320x700", use: { ...devices["iPhone 13"], browserName: "webkit", viewport: { width: 320, height: 700 } } },
    { name: "webkit-390x844", use: { ...devices["iPhone 13"], browserName: "webkit", viewport: { width: 390, height: 844 } } },
    { name: "webkit-844x390", use: { ...devices["iPhone 13"], browserName: "webkit", viewport: { width: 844, height: 390 } } },
  ],
  webServer: {
    command: `env E2E_PORT=${port} AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret node scripts/run-e2e-server.mjs --production --v2-gauntlet-b-live-workout`,
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
