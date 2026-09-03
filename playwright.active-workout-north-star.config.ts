import { defineConfig } from "@playwright/test";

const port = Number.parseInt(
  process.env.ACTIVE_WORKOUT_NORTH_STAR_PORT ?? "3175",
  10,
);
const fixtureMode =
  process.env.ACTIVE_WORKOUT_PHASE4_EQUIPMENT_CONFLICT_FIXTURE === "1"
    ? "equipment-conflict"
    : process.env.ACTIVE_WORKOUT_PHASE0_CONTRACT_FIXTURE === "1"
      ? "equipment"
      : "common";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["active-workout-north-star-phase0.spec.ts"],
  outputDir: `./output/playwright/active-workout-north-star/${fixtureMode}-test-results`,
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 25_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
    locale: "en-CA",
    timezoneId: "America/Toronto",
    colorScheme: "light",
    contextOptions: { reducedMotion: "reduce" },
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [{ name: "phase0-mobile-chromium" }],
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-e2e-server.mjs --production --ba-fixture`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
