import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const calendarCase = process.env.BA_CALENDAR_CASE ?? "toronto-before-midnight";
const cases = {
  "toronto-before-midnight": {
    start: "2026-07-18T03:55:00.000Z",
    finish: "2026-07-18T03:59:00.000Z",
    timezone: "America/Toronto",
    localDate: "2026-07-17",
    weekday: "Fri",
  },
  "toronto-after-midnight": {
    start: "2026-07-18T04:05:00.000Z",
    finish: "2026-07-18T04:10:00.000Z",
    timezone: "America/Toronto",
    localDate: "2026-07-18",
    weekday: "Sat",
  },
  "toronto-cross-midnight": {
    start: "2026-07-18T03:55:00.000Z",
    finish: "2026-07-18T04:05:00.000Z",
    timezone: "America/Toronto",
    localDate: "2026-07-17",
    weekday: "Fri",
  },
  "utc-same-instant": {
    start: "2026-07-18T03:55:00.000Z",
    finish: "2026-07-18T04:00:00.000Z",
    timezone: "UTC",
    localDate: "2026-07-18",
    weekday: "Sat",
  },
} as const;

if (!(calendarCase in cases)) {
  throw new Error("Unknown BA calendar classification case.");
}
const scenario = cases[calendarCase as keyof typeof cases];
const runId = process.env.BA_CALENDAR_RUN_ID ?? `ba-calendar-${calendarCase}-${Date.now()}`;
const port = Number.parseInt(process.env.BA_CALENDAR_PORT ?? "3130", 10);
const evidenceRoot = resolve("output/playwright/ba-user-testing");
const outputRoot = resolve(evidenceRoot, runId);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("BA_CALENDAR_PORT must be an integer from 1024 through 65535.");
}
if (!/^[a-z0-9][a-z0-9-]*$/i.test(runId)) {
  throw new Error("BA_CALENDAR_RUN_ID may contain only letters, digits, and hyphens.");
}
if (relative(evidenceRoot, outputRoot).startsWith("..")) {
  throw new Error("BA_CALENDAR_RUN_ID must stay inside the BA evidence directory.");
}
if (process.env.TEST_WORKER_INDEX === undefined && existsSync(outputRoot)) {
  throw new Error(`BA calendar evidence already exists for run ${runId}.`);
}

process.env.BA_EXPECTED_LOCAL_DATE = scenario.localDate;
process.env.BA_EXPECTED_WEEKDAY = scenario.weekday;
process.env.BA_EXPECTED_TIMEZONE = scenario.timezone;
process.env.BA_EXPECTED_START_AT = scenario.start;
process.env.BA_EXPECTED_FINISH_AT = scenario.finish;
process.env.BA_EXPECTED_UTC_OFFSET_MINUTES = scenario.timezone === "UTC" ? "0" : "240";
process.env.BA_EXPECTED_ORIGIN = `http://127.0.0.1:${port}`;
process.env.BA_EFFECTIVE_CALENDAR_CASE = calendarCase;

const calibratedProfile = {
  viewport: { width: 440, height: 956 },
  screen: { width: 440, height: 956 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  locale: "en-CA",
  timezoneId: scenario.timezone,
  colorScheme: "light" as const,
};

export default defineConfig({
  testDir: "./tests/ba-calendar",
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
  projects: [{ name: `iphone-calendar-${calendarCase}` }],
  webServer: {
    command: `env E2E_PORT=${port} BA_ACCEPTANCE_START_AT=${scenario.start} BA_ACCEPTANCE_FINISH_AT=${scenario.finish} node scripts/run-e2e-server.mjs --production --ba-calendar`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
