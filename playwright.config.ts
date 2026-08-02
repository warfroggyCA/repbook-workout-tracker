import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: [
    "production-recovery.spec.ts",
    "optimized-route-matrix.spec.ts",
    "history-workspace.spec.ts",
    "program-editor.spec.ts",
    "program-editor-core.spec.ts",
    "program-editor-review-recovery.spec.ts",
    "program-editor-disabled.spec.ts",
    "plate-machine-guidance.spec.ts",
    "stage3-durable-workout.spec.ts",
    "stage3-mobile-calibration.spec.ts",
    "stage5-workout-guidance.spec.ts",
    "stage6-workout-simulation.spec.ts",
    "stage7-residual-ux.spec.ts",
    "replacement-mobile-keyboard.spec.ts",
    "superset-equipment-preparation.spec.ts",
    "active-workout-add-exercise.spec.ts",
    "v2-t01-recording-truth.spec.ts",
  ],
  outputDir: "./output/playwright/test-results",
  fullyParallel: false,
  workers: 1,
  // Stateful journeys share one fresh disposable DB. After a CI failure, rerun
  // the suite to get another fresh DB instead of continuing from partial state.
  maxFailures: isCI ? 1 : 0,
  retries: 0,
  timeout: isCI ? 120_000 : 60_000,
  expect: { timeout: isCI ? 30_000 : 10_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    // Next recommends exercising Playwright against the production build. It
    // also keeps Fast Refresh from invalidating server actions mid-journey.
    command:
      "env AUTH_GITHUB_ID=local-e2e-client AUTH_GITHUB_SECRET=local-e2e-secret node scripts/run-e2e-server.mjs --production",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: "http://127.0.0.1:3100/sign-in",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
