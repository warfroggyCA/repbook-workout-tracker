import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const runId = process.env.PHASE0_RUN_ID ?? `phase0-local-${Date.now()}`;
const port = Number.parseInt(process.env.PHASE0_PORT ?? "3116", 10);
const browser = process.env.PHASE0_BROWSER ?? "chromium";
const evidenceRoot = resolve("output/playwright/phase0-workout-start");
const outputRoot = resolve(evidenceRoot, runId);

if (!/^[a-z0-9][a-z0-9-]*$/i.test(runId)) {
  throw new Error("PHASE0_RUN_ID may contain only letters, digits, and hyphens.");
}
if (relative(evidenceRoot, outputRoot).startsWith("..")) {
  throw new Error("PHASE0_RUN_ID must stay inside the Phase 0 evidence directory.");
}
if (process.env.TEST_WORKER_INDEX === undefined && existsSync(outputRoot)) {
  throw new Error(`Phase 0 evidence already exists for run ${runId}.`);
}
if (browser !== "chromium" && browser !== "webkit") {
  throw new Error("PHASE0_BROWSER must be chromium or webkit.");
}

export default defineConfig({
  testDir: "./tests/phase0-start",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  outputDir: `${outputRoot}/test-results`,
  reporter: [
    ["list"],
    ["json", { outputFile: `${outputRoot}/report.json` }],
    ["html", { outputFolder: `${outputRoot}/html`, open: "never" }],
  ],
  use: {
    ...devices["iPhone 13"],
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-CA",
    timezoneId: "America/Toronto",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: `iphone-standalone-${browser}`,
      use: { browserName: browser },
    },
  ],
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-e2e-server.mjs --production --ba-fixture --phase0-start`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
