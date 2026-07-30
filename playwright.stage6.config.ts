import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const runId = process.env.STAGE6_RUN_ID ?? "remediation-2026-07-22-stage6-r20";
const port = Number.parseInt(process.env.STAGE6_PORT ?? "3116", 10);
const evidenceRoot = resolve("output/playwright");
const outputRoot = resolve(evidenceRoot, runId);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("STAGE6_PORT must be an integer from 1024 through 65535.");
}
if (!/^remediation-\d{4}-\d{2}-\d{2}-stage6-r\d+$/.test(runId)) {
  throw new Error("STAGE6_RUN_ID must use remediation-YYYY-MM-DD-stage6-rN.");
}
if (relative(evidenceRoot, outputRoot).startsWith("..")) {
  throw new Error("STAGE6_RUN_ID must stay inside output/playwright.");
}
if (process.env.TEST_WORKER_INDEX === undefined && existsSync(outputRoot)) {
  throw new Error(`Stage 6 evidence already exists for ${runId}; choose the next unused revision.`);
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["stage6-workout-simulation.spec.ts"],
  outputDir: `${outputRoot}/test-results`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: `${outputRoot}/report.json` }],
    ["html", { outputFolder: `${outputRoot}/html`, open: "never" }],
  ],
  use: {
    ...devices["iPhone 17 Pro Max"],
    browserName: "chromium",
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-CA",
    timezoneId: "America/Toronto",
    colorScheme: "light",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-e2e-server.mjs --production --ba-routine-change --stage6-simulation`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
