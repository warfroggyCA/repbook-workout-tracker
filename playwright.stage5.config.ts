import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const runId =
  process.env.STAGE5_RUN_ID ?? "remediation-2026-07-22-stage5-r16";
const port = Number.parseInt(process.env.STAGE5_PORT ?? "3115", 10);
const evidenceRoot = resolve("output/playwright");
const outputRoot = resolve(evidenceRoot, runId);
const iphoneUserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("STAGE5_PORT must be an integer from 1024 through 65535.");
}
if (!/^remediation-\d{4}-\d{2}-\d{2}-stage5-r\d+$/.test(runId)) {
  throw new Error(
    "STAGE5_RUN_ID must use remediation-YYYY-MM-DD-stage5-rN.",
  );
}
if (relative(evidenceRoot, outputRoot).startsWith("..")) {
  throw new Error("STAGE5_RUN_ID must stay inside output/playwright.");
}
if (process.env.TEST_WORKER_INDEX === undefined && existsSync(outputRoot)) {
  throw new Error(
    `Stage 5 evidence already exists for ${runId}; choose the next unused revision.`,
  );
}

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
  testMatch: ["stage5-workout-guidance.spec.ts"],
  outputDir: `${outputRoot}/test-results`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: `${outputRoot}/report.json` }],
    ["html", { outputFolder: `${outputRoot}/html`, open: "never" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    ...calibratedProfile,
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "stage5-iphone-chrome-reference",
      use: { ...devices["Desktop Chrome"], ...calibratedProfile },
    },
  ],
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-e2e-server.mjs --production`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
