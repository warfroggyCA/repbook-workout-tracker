import { expect, test } from "@playwright/test";
import { BA_WORKOUT_EMAIL, BA_WORKOUT_FIXTURE } from "../fixtures/ba-workout-contract";
import { writeBaCheckpointAudit, type BaDeviceCalibration } from "../helpers/ba-audit";
import { waitForHydratedServerAction } from "../helpers/react-readiness";

test("starts from the exact clean BA workout baseline", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ method: string; url: string; reason: string; status?: number }> = [];
  const isCancelledWebKitPrefetch = (text: string) =>
    text.includes("_rsc=") && text.includes("due to access control checks.");
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !isCancelledWebKitPrefetch(text)) {
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (error) => {
    if (!isCancelledWebKitPrefetch(error.message)) pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "unknown failure";
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(reason)) return;
    failedRequests.push({ method: request.method(), url: request.url(), reason });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    failedRequests.push({
      method: response.request().method(),
      url: response.url(),
      reason: `HTTP ${response.status()} ${response.statusText()}`.trim(),
      status: response.status(),
    });
  });

  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const devLogin = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(devLogin);
  await devLogin.click();
  await expect(page).toHaveURL(/\/today$/);
  await page.waitForLoadState("networkidle");

  const calibration = await page.evaluate<BaDeviceCalibration>(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    screen: { width: window.screen.width, height: window.screen.height },
    deviceScaleFactor: devicePixelRatio,
    mobile: /iPhone/.test(navigator.userAgent),
    touch: navigator.maxTouchPoints > 0 || "ontouchstart" in window,
    touchPoints: navigator.maxTouchPoints,
    userAgent: navigator.userAgent,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  expect(calibration).toMatchObject({
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 2,
    timezone: "America/Toronto",
  });
  expect(calibration.touch).toBe(true);
  expect(calibration.userAgent).toContain("iPhone");

  async function checkpoint(input: {
    id: string;
    action: string;
    expected: string;
    observed: string;
  }) {
    const screenshot = testInfo.outputPath(`${input.id}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await writeBaCheckpointAudit({
      evidenceRoot: testInfo.outputDir,
      attach: (name, options) => testInfo.attach(name, options),
      audit: {
        checkpointId: input.id,
        preconditions: "Fresh disposable exact BA workout fixture; no connected journey has mutated it.",
        action: input.action,
        expected: input.expected,
        observed: input.observed,
        status: "pass",
        severity: "none",
        url: page.url(),
        calibration,
        consoleErrors: [...consoleErrors],
        pageErrors: [...pageErrors],
        failedRequests: [...failedRequests],
        artifacts: [{ label: input.id, kind: "screenshot", path: screenshot }],
      },
    });
  }

  const expectedDay = BA_WORKOUT_FIXTURE.startingState.expectedTodayDay;
  await expect(page.getByTestId("today-decision")).toContainText(expectedDay);
  await expect(
    page.getByRole("button", { name: "Train as planned", exact: true }),
  ).toBeVisible();
  await checkpoint({
    id: "QA-01-BASELINE-TODAY",
    action: "Sign in and open Today.",
    expected: `Today selects ${expectedDay} and offers Train as planned.`,
    observed: `Today selected ${expectedDay}; Train as planned was visible.`,
  });

  await page.goto("/history");
  await expect(page.getByText("No workouts in this period.", { exact: true })).toBeVisible();
  await checkpoint({
    id: "QA-01-BASELINE-HISTORY",
    action: "Open History before starting a workout.",
    expected: "No completed workout appears in the fixture period.",
    observed: "History displayed “No workouts in this period.”",
  });

  await page.goto("/coach");
  await expect(
    page.getByText("Nothing needs your decision right now", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No decision history yet.", { exact: false })).toBeVisible();
  await checkpoint({
    id: "QA-01-BASELINE-COACH",
    action: "Open Coach before any acceptance action.",
    expected: "No pending decision and no decision history are present.",
    observed: "Coach showed no pending decision and no decision history.",
  });

  await page.goto("/program");
  await expect(
    page.getByRole("heading", { name: BA_WORKOUT_FIXTURE.program.name, exact: true }),
  ).toBeVisible();
  for (const [index, day] of BA_WORKOUT_FIXTURE.program.days.entries()) {
    await page.getByRole("tab", { name: `Day ${index + 1}`, exact: true }).click();
    await expect(page.getByText(day.name, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(day.warmupNotes, { exact: true })).toBeVisible();
  }
  await checkpoint({
    id: "QA-01-BASELINE-PROGRAM",
    action: "Visit every Program day tab and inspect its identity and warm-up.",
    expected: `All ${BA_WORKOUT_FIXTURE.program.days.length} exact seeded days and warm-ups are visible.`,
    observed: `All ${BA_WORKOUT_FIXTURE.program.days.length} seeded day names and warm-up notes were visible.`,
  });

  await page.goto("/today");
  await expect(page.getByText(expectedDay, { exact: true }).first()).toBeVisible();
  await page.getByText(/Preview planned exercises/).click();
  for (const exercise of BA_WORKOUT_FIXTURE.program.days[0].exercises) {
    await expect(
      page.getByText(exercise.name, { exact: true }).first(),
    ).toBeVisible();
  }
  await checkpoint({
    id: "QA-01-BASELINE-PREVIEW",
    action: "Return to Today and expand the planned exercise preview.",
    expected: "Every planned Day A exercise appears before workout creation.",
    observed: `All ${BA_WORKOUT_FIXTURE.program.days[0].exercises.length} planned Day A exercises were visible.`,
  });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
