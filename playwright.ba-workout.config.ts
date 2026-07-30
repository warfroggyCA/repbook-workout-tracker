import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const runId = process.env.BA_RUN_ID ?? `ba-local-${Date.now()}`;
const browser = process.env.BA_BROWSER ?? "chromium";
const port = Number.parseInt(process.env.BA_PORT ?? "3110", 10);
const evidenceRoot = resolve("output/playwright/ba-user-testing");
const outputRoot = resolve(evidenceRoot, runId);
const iphoneUserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("BA_PORT must be an integer from 1024 through 65535.");
}
if (!/^[a-z0-9][a-z0-9-]*$/i.test(runId)) {
  throw new Error("BA_RUN_ID may contain only letters, digits, and hyphens.");
}
if (relative(evidenceRoot, outputRoot).startsWith("..")) {
  throw new Error("BA_RUN_ID must stay inside the BA evidence directory.");
}
if (process.env.TEST_WORKER_INDEX === undefined && existsSync(outputRoot)) {
  throw new Error(`BA evidence already exists for run ${runId}.`);
}
if (browser !== "chromium" && browser !== "webkit") {
  throw new Error("BA_BROWSER must be chromium or webkit.");
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
  testDir: "./tests/ba",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
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
    ...calibratedProfile,
  },
  projects: [
    browser === "webkit"
      ? {
          name: "iphone-17-pro-max-webkit-behavior",
          use: { ...devices["iPhone 15 Pro Max"], ...calibratedProfile },
        }
      : {
          name: "iphone-17-pro-max-chrome-reference",
          use: { ...devices["Desktop Chrome"], ...calibratedProfile },
        },
  ],
  webServer: {
    command: `env E2E_PORT=${port} node scripts/run-e2e-server.mjs --production --ba-fixture`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
