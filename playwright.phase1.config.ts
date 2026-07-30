import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const runId = process.env.PHASE1_RUN_ID ?? `phase1-local-${Date.now()}`;
const port = Number.parseInt(process.env.PHASE1_PORT ?? "3118", 10);
const browser = process.env.PHASE1_BROWSER ?? "chromium";
const evidenceRoot = resolve("output/playwright/phase1-workout-experience");
const outputRoot = resolve(evidenceRoot, runId);

if (!/^[a-z0-9][a-z0-9-]*$/i.test(runId)) {
  throw new Error("PHASE1_RUN_ID may contain only letters, digits, and hyphens.");
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PHASE1_PORT must be an integer from 1024 through 65535.");
}
if (browser !== "chromium" && browser !== "webkit") {
  throw new Error("PHASE1_BROWSER must be chromium or webkit.");
}
if (relative(evidenceRoot, outputRoot).startsWith("..")) {
  throw new Error("PHASE1_RUN_ID must stay inside the Phase 1 evidence directory.");
}
if (process.env.TEST_WORKER_INDEX === undefined && existsSync(outputRoot)) {
  throw new Error(`Phase 1 evidence already exists for run ${runId}.`);
}

export default defineConfig({
  testDir: "./tests/phase1-foundation",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  outputDir: `${outputRoot}/test-results`,
  reporter: [
    ["list"],
    ["json", { outputFile: `${outputRoot}/report.json` }],
    ["html", { outputFolder: `${outputRoot}/html`, open: "never" }],
  ],
  use: {
    ...(browser === "webkit" ? devices["iPhone 13"] : devices["Desktop Chrome"]),
    browserName: browser,
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-CA",
    timezoneId: "America/Toronto",
    colorScheme: "light",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-e2e-server.mjs --production --stage7-ux --phase1-foundation`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
