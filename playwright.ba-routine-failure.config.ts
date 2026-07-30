import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { BA_ROUTINE_FAILURE_MODES } from "./src/ai/acceptance-routine-failure-fixture";

const failureMode = process.env.BA_RC_FAILURE_MODE ?? "timeout";
if (!(BA_ROUTINE_FAILURE_MODES as readonly string[]).includes(failureMode)) {
  throw new Error("Unknown BA routine failure mode.");
}
const runId = process.env.BA_RC_FAILURE_RUN_ID ?? `ba-rc-${failureMode}-${Date.now()}`;
const port = Number.parseInt(process.env.BA_RC_FAILURE_PORT ?? "3140", 10);
const evidenceRoot = resolve("output/playwright/ba-user-testing");
const outputRoot = resolve(evidenceRoot, runId);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("BA_RC_FAILURE_PORT must be an integer from 1024 through 65535.");
}
if (!/^[a-z0-9][a-z0-9-]*$/i.test(runId)) {
  throw new Error("BA_RC_FAILURE_RUN_ID may contain only letters, digits, and hyphens.");
}
if (relative(evidenceRoot, outputRoot).startsWith("..")) {
  throw new Error("BA_RC_FAILURE_RUN_ID must stay inside the BA evidence directory.");
}
if (process.env.TEST_WORKER_INDEX === undefined && existsSync(outputRoot)) {
  throw new Error(`BA routine-failure evidence already exists for run ${runId}.`);
}
process.env.BA_EFFECTIVE_ROUTINE_FAILURE_MODE = failureMode;

const calibratedProfile = {
  viewport: { width: 440, height: 956 },
  screen: { width: 440, height: 956 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  locale: "en-CA",
  timezoneId: "America/Toronto",
  colorScheme: "light" as const,
};

export default defineConfig({
  testDir: "./tests/ba-routine-failure",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  outputDir: `${outputRoot}/test-results`,
  reporter: [
    ["list"],
    ["json", { outputFile: `${outputRoot}/report.json` }],
    ["html", { outputFolder: `${outputRoot}/html`, open: "never" }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
    ...devices["Desktop Chrome"],
    ...calibratedProfile,
  },
  projects: [{ name: `iphone-routine-failure-${failureMode}` }],
  webServer: {
    command: `env E2E_PORT=${port} BA_ROUTINE_CHANGE_FAILURE_MODE=${failureMode} node scripts/run-e2e-server.mjs --production --ba-routine-change`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
