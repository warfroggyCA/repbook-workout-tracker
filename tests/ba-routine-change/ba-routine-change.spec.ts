import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  BA_ROUTINE_CHANGE_BASELINE,
  BA_ROUTINE_CHANGE_EMAIL,
  BA_ROUTINE_CHANGE_REQUEST,
} from "../fixtures/ba-routine-change-contract";
import { writeBaCheckpointAudit, type BaDeviceCalibration } from "../helpers/ba-audit";
import { waitForHydratedServerAction } from "../helpers/react-readiness";

type ExpectedExercise = {
  name: string;
  sets: number;
  repMin: number;
  repMax: number;
  group: "A" | null;
};

const EXPECTED_PUBLISHED_DAYS: ExpectedExercise[][] = [
  [
    { name: "Barbell Bench Press", sets: 4, repMin: 5, repMax: 8, group: null },
    { name: "Incline Dumbbell Curl", sets: 3, repMin: 8, repMax: 12, group: null },
    { name: "Bulgarian Split Squat", sets: 2, repMin: 8, repMax: 10, group: null },
    { name: "Cable Face Pull", sets: 2, repMin: 15, repMax: 20, group: null },
  ],
  [
    { name: "Barbell Back Squat", sets: 4, repMin: 5, repMax: 8, group: null },
    { name: "Romanian Deadlift", sets: 3, repMin: 8, repMax: 10, group: null },
    { name: "Cable Rear Delt Fly", sets: 2, repMin: 12, repMax: 15, group: "A" },
    { name: "Zottman Curl", sets: 2, repMin: 10, repMax: 12, group: "A" },
    { name: "Overhead Cable Triceps Extension", sets: 2, repMin: 10, repMax: 15, group: "A" },
  ],
  [
    { name: "Lat Pulldown", sets: 3, repMin: 10, repMax: 15, group: null },
    { name: "Incline Barbell Bench Press", sets: 3, repMin: 8, repMax: 12, group: null },
    { name: "Barbell Overhead Press", sets: 3, repMin: 6, repMax: 10, group: null },
    { name: "Overhead Cable Triceps Extension", sets: 3, repMin: 10, repMax: 15, group: "A" },
    { name: "EZ-Bar Curl", sets: 3, repMin: 10, repMax: 15, group: "A" },
    { name: "Dumbbell Lateral Raise", sets: 2, repMin: 15, repMax: 25, group: null },
  ],
];

const REMOVED_BY_DAY = [["EZ-Bar Curl"], ["Dumbbell Curl"], ["Triceps Pushdown"]];
const OPTIONAL_FACE_PULL_NOTE =
  "Optional accessory: one set is the minimum; a second set is ideal when time and recovery allow.";

async function expectOrderedText(
  rows: Locator,
  expected: ExpectedExercise[],
  summary: (exercise: ExpectedExercise) => RegExp,
) {
  await expect(rows).toHaveCount(expected.length);
  for (const [index, exercise] of expected.entries()) {
    const row = rows.nth(index);
    await expect(row).toContainText(exercise.name);
    await expect(row).toContainText(summary(exercise));
  }
}

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(BA_ROUTINE_CHANGE_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function expectSaved(page: Page) {
  await expect(page.getByRole("status")).toContainText("All changes saved");
}

function isExpectedEmptyDraftResponse(request: { method: string; url: string; status?: number }) {
  return request.method === "GET" && request.status === 404 && new URL(request.url).pathname === "/api/program/draft";
}

async function discardWorkout(page: Page) {
  await page
    .getByRole("complementary", { name: "Workout status", exact: true })
    .getByRole("button", { name: "Finish", exact: true })
    .click();
  await page.getByRole("button", { name: "Discard workout", exact: true }).click();
  await page
    .getByRole("dialog", { name: /Discard .*\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

test("traces the exact BA routine change through proposal, publication, Today, and execution", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ method: string; url: string; reason: string; status?: number }> = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
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

  await signIn(page);
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

  async function checkpoint(input: {
    id: string;
    action: string;
    expected: string;
    observed: string;
    status?: "pass" | "fail";
    severity?: "blocker" | "high" | "medium" | "low" | "none";
    screenshot?: string;
  }) {
    const screenshot = input.screenshot ?? testInfo.outputPath(`${input.id}.png`);
    if (!input.screenshot) await page.screenshot({ path: screenshot, fullPage: true });
    await writeBaCheckpointAudit({
      evidenceRoot: testInfo.outputDir,
      attach: (name, options) => testInfo.attach(name, options),
      audit: {
        checkpointId: input.id,
        preconditions: "Fresh disposable exact BA routine-change fixture; connected journey runs with one browser worker.",
        action: input.action,
        expected: input.expected,
        observed: input.observed,
        status: input.status ?? "pass",
        severity: input.severity ?? "none",
        url: page.url(),
        calibration,
        consoleErrors: [...consoleErrors],
        pageErrors: [...pageErrors],
        failedRequests: [...failedRequests],
        artifacts: [{ label: input.id, kind: "screenshot", path: screenshot }],
      },
    });
  }

  await page.goto("/program");
  await expect(page.getByText("v1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: BA_ROUTINE_CHANGE_BASELINE.program.name,
      exact: true,
    }),
  ).toBeVisible();
  await checkpoint({
    id: "QA-02-RC-BASELINE",
    action: "Open Program before requesting a routine change.",
    expected: "The exact baseline Program is current at version 1.",
    observed: `${BA_ROUTINE_CHANGE_BASELINE.program.name} was current at version 1.`,
  });

  await page.goto("/program/edit");
  await expectSaved(page);
  await page.getByLabel("Update current Program").check();
  const prompt = page.getByLabel("What should change?");
  await prompt.fill(BA_ROUTINE_CHANGE_REQUEST);
  await expect(prompt).toHaveValue(BA_ROUTINE_CHANGE_REQUEST);
  const requestScreenshot = testInfo.outputPath("01-exact-request.png");
  await page.screenshot({ path: requestScreenshot, fullPage: true });
  await checkpoint({
    id: "QA-02-RC-EXACT-REQUEST",
    action: "Select Update current Program and paste the complete three-day request verbatim.",
    expected: "The request field preserves every character of the controlling BA-RC request.",
    observed: "The request field exactly matched the immutable BA-RC request constant.",
    screenshot: requestScreenshot,
  });
  await page
    .getByRole("button", { name: "Compare and propose changes", exact: true })
    .click();

  const proposalReady = page.getByText("Proposal ready to review", { exact: true });
  const proposalFailed = page.getByText("Coach could not build the proposal", { exact: true });
  await proposalReady.or(proposalFailed).first().waitFor({ state: "visible" });
  const proposed = page.getByLabel("Proposed Program changes");
  const expectedProposalRows = [
    /Change Barbell Bench Press: 4 sets, 5–8 reps/,
    /Add Incline Dumbbell Curl to Day 1/,
    /Replace EZ-Bar Curl on Day 1/,
    /Bulgarian Split Squat is unchanged/,
    /Add Cable Face Pull to Day 1/,
    /Change Barbell Back Squat: 4 sets, 5–8 reps/,
    /Change Romanian Deadlift: 3 sets, 8–10 reps/,
    /Add Zottman Curl to Day 2/,
    /Replace Dumbbell Curl on Day 2/,
    /Add Overhead Cable Triceps Extension to Day 2/,
    /Group Cable Rear Delt Fly \+ Zottman Curl \+ Overhead Cable Triceps Extension as A/,
    /Change Lat Pulldown: 3 sets, 10–15 reps/,
    /Incline Barbell Bench Press is unchanged/,
    /Barbell Overhead Press is unchanged/,
    /Add Overhead Cable Triceps Extension to Day 3/,
    /Replace Triceps Pushdown on Day 3/,
    /EZ-Bar Curl is unchanged/,
    /Group Overhead Cable Triceps Extension \+ EZ-Bar Curl as A/,
    /Dumbbell Lateral Raise is unchanged/,
  ];
  const missingProposalRows: string[] = [];
  if (await proposalReady.isVisible()) {
    for (const row of expectedProposalRows) {
      if ((await proposed.getByText(row).count()) === 0) missingProposalRows.push(row.source);
    }
  }
  const proposalStatus =
    (await proposalReady.isVisible()) && !(await proposalFailed.isVisible()) && missingProposalRows.length === 0;
  const proposalScreenshot = testInfo.outputPath("02-proposal.png");
  await page.screenshot({ path: proposalScreenshot, fullPage: true });
  await checkpoint({
    id: "QA-02-RC-PROPOSAL",
    action: "Submit the exact request and inspect every expected proposal row.",
    expected: `A reviewable proposal contains all ${expectedProposalRows.length} requested additions, removals, dose changes, unchanged items, and groups with zero decisions.`,
    observed: proposalStatus
      ? `Proposal was reviewable with all ${expectedProposalRows.length} expected rows.`
      : `Proposal ready: ${await proposalReady.isVisible()}; generic failure: ${await proposalFailed.isVisible()}; missing or contradictory rows: ${missingProposalRows.join(" | ") || "none identified"}.`,
    status: proposalStatus ? "pass" : "fail",
    severity: proposalStatus ? "none" : "high",
    screenshot: proposalScreenshot,
  });
  await expect(proposalFailed).toHaveCount(0);
  await expect(proposalReady).toBeVisible();
  await expect(page.getByText(/5 added · 6 changed · 3 removed · 6 unchanged · 0 need a decision/)).toBeVisible();
  await expect(page.getByText(/0 need a decision/)).toBeVisible();
  for (const row of expectedProposalRows) {
    await expect(proposed.getByText(row)).toBeVisible();
  }

  await page.getByRole("button", { name: "Apply selected changes", exact: true }).click();
  await expect(page.getByText("Proposal applied to the draft", { exact: true })).toBeVisible();
  await expectSaved(page);

  for (const [dayIndex, expectedExercises] of EXPECTED_PUBLISHED_DAYS.entries()) {
    await page.getByRole("tab", { name: `Day ${dayIndex + 1}`, exact: true }).click();
    const editorRows = page
      .getByRole("region", { name: `Day ${dayIndex + 1} exercises`, exact: true })
      .locator('button[aria-controls^="editor-"]');
    await expectOrderedText(
      editorRows,
      expectedExercises,
      ({ sets, repMin, repMax }) => new RegExp(`${sets} sets · ${repMin}–${repMax} reps`),
    );
    for (const removed of REMOVED_BY_DAY[dayIndex] ?? []) {
      await expect(
        page
          .getByRole("region", { name: `Day ${dayIndex + 1} exercises`, exact: true })
          .getByText(removed, { exact: true }),
      ).toHaveCount(0);
    }
  }

  await page.getByRole("tab", { name: "Day 1", exact: true }).click();
  const facePullEditorRow = page
    .getByRole("region", { name: "Day 1 exercises", exact: true })
    .locator('button[aria-controls^="editor-"]')
    .filter({ hasText: "Cable Face Pull" });
  await facePullEditorRow.click();
  const facePullEditor = page
    .locator("article[aria-labelledby]")
    .filter({ hasText: "Cable Face Pull" });
  await facePullEditor
    .locator("details")
    .filter({ hasText: "Advanced session options" })
    .locator("summary")
    .click();
  await expect(page.getByLabel("Work sets", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Minimum reps", { exact: true })).toHaveValue("15");
  await expect(page.getByLabel("Maximum reps", { exact: true })).toHaveValue("20");
  await expect(page.getByLabel("Minimum useful sets", { exact: true })).toHaveValue("1");
  await expect(
    page.getByLabel("Preferred sets (saved context)", { exact: true }),
  ).toHaveValue("2");
  await expect(
    page.getByLabel("Omission preference (saved for later)", { exact: true }),
  ).toHaveValue("if_minimum_met");
  await expect(page.getByLabel("Exercise notes", { exact: true })).toHaveValue(
    OPTIONAL_FACE_PULL_NOTE,
  );

  await page.getByRole("tab", { name: "Day 2", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Day 2 exercises", exact: true })
      .locator("details > summary"),
  ).toContainText(
    "3-exercise group: Cable Rear Delt Fly + Zottman Curl + Overhead Cable Triceps Extension",
  );
  await page.getByRole("tab", { name: "Day 3", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Day 3 exercises", exact: true })
      .locator("details > summary"),
  ).toContainText(
    "Superset: Overhead Cable Triceps Extension + EZ-Bar Curl",
  );
  await checkpoint({
    id: "QA-02-RC-DRAFT-APPLIED",
    action: "Apply every selected proposal change to the saved draft.",
    expected: "The saved editor draft contains every exact exercise, dose, removal, order, group, and optional Face Pull minimum/ideal instruction.",
    observed: "All three editor days matched the exact ordered oracle; removed exercises were absent; the Day 2 three-member two-set group and Day 3 three-set superset were present; Face Pull retained 2 work sets, 15–20 reps, minimum 1, ideal 2, optional omission, and its explanatory note.",
  });

  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: /Compare with current Program|Review changes/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Changes you made", exact: true })).toBeVisible();
  const reviewScreenshot = testInfo.outputPath("03-publication-review.png");
  await page.screenshot({ path: reviewScreenshot, fullPage: true });
  await checkpoint({
    id: "QA-02-RC-PUBLICATION-REVIEW",
    action: "Compare the draft with the current Program before activation.",
    expected: "The publication review clearly presents what will change.",
    observed: "The Changes you made review was visible before activation.",
    screenshot: reviewScreenshot,
  });
  await page.getByRole("button", { name: "Publish future Program", exact: true }).click();
  await expect(page.getByText(/Version 2 is now current/)).toBeVisible();
  await checkpoint({
    id: "QA-02-RC-ACTIVATION",
    action: "Activate the reviewed draft.",
    expected: "Program version 2 becomes current.",
    observed: "The editor confirmed Version 2 is now current.",
  });

  await page.goto("/program");
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
  for (const [dayIndex, expectedExercises] of EXPECTED_PUBLISHED_DAYS.entries()) {
    await page.getByRole("tab", { name: `Day ${dayIndex + 1}`, exact: true }).click();
    const daySection = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", {
          level: 2,
          name: `Day ${dayIndex + 1}`,
          exact: true,
        }),
      })
      .last();
    await expectOrderedText(
      daySection.locator("article"),
      expectedExercises,
      ({ sets, repMin, repMax }) => new RegExp(`${sets} sets · ${repMin}–${repMax} reps`),
    );
    for (const removed of REMOVED_BY_DAY[dayIndex] ?? []) {
      await expect(daySection.getByText(removed, { exact: true })).toHaveCount(0);
    }
    const grouped = expectedExercises.filter((exercise) => exercise.group === "A");
    if (grouped.length > 0) {
      await expect(daySection).toContainText(
        `A: ${grouped.map((exercise) => exercise.name).join(" + ")}`,
      );
    }
  }
  await page.getByRole("tab", { name: "Day 1", exact: true }).click();
  await expect(page.getByText(OPTIONAL_FACE_PULL_NOTE, { exact: true })).toBeVisible();
  const programScreenshot = testInfo.outputPath("04-published-program.png");
  await page.screenshot({ path: programScreenshot, fullPage: true });
  await checkpoint({
    id: "QA-02-RC-PUBLISHED-PROGRAM",
    action: "Inspect all three tabs of the activated Program.",
    expected: "Version 2 contains every requested exercise in exact order and at the exact dose; replaced sources are absent; groups and optional Face Pull meaning remain visible.",
    observed: `Version 2 showed all ${EXPECTED_PUBLISHED_DAYS.flat().length} exact ordered exercise doses, both requested groups, no stale replaced sources, and the optional Face Pull note across three days.`,
    screenshot: programScreenshot,
  });

  await page.goto("/today");
  await expect(page.getByTestId("today-decision")).toContainText("Day 1");
  const todayPreview = page.getByTestId("planned-exercise-preview");
  await todayPreview.locator("summary").click();
  await expectOrderedText(
    todayPreview.locator("li"),
    EXPECTED_PUBLISHED_DAYS[0]!,
    ({ sets, repMin, repMax }) => new RegExp(`${sets} × ${repMin}–${repMax}`),
  );
  await expect(todayPreview.getByText("EZ-Bar Curl", { exact: true })).toHaveCount(0);
  await checkpoint({
    id: "QA-02-RC-TODAY",
    action: "Open Today after publication and expand the planned preview.",
    expected: "Today selects Day 1 from version 2 and shows its exact ordered doses without the replaced curl.",
    observed: `Today selected Day 1 and showed all ${EXPECTED_PUBLISHED_DAYS[0]!.length} exact ordered doses without the replaced EZ-Bar Curl.`,
  });

  for (const [dayIndex, expectedExercises] of EXPECTED_PUBLISHED_DAYS.entries()) {
    if (dayIndex === 0) {
      const start = page.getByRole("button", { name: "Train as planned", exact: true });
      await waitForHydratedServerAction(start);
      await start.click();
    } else {
      await page.getByTestId("alternate-program-days").locator("summary").click();
      const alternate = page.getByRole("button", { name: new RegExp(`^Day ${dayIndex + 1}`) });
      await alternate.click();
      const start = page.getByRole("button", { name: "Start workout", exact: true });
      await waitForHydratedServerAction(start);
      await start.click();
    }
    await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { level: 1, name: `Day ${dayIndex + 1}`, exact: true })).toBeVisible();
    const workoutCards = page.locator('[id^="exercise-"]');
    await expectOrderedText(
      workoutCards,
      expectedExercises,
      ({ sets, repMin, repMax }) =>
        new RegExp(`0/${sets} sets · ${sets}×${repMin}–${repMax}`),
    );
    for (const removed of REMOVED_BY_DAY[dayIndex] ?? []) {
      await expect(
        page.getByRole("heading", { level: 2, name: removed, exact: true }),
      ).toHaveCount(0);
    }
    for (const exercise of expectedExercises) {
      const card = workoutCards.filter({
        has: page.getByRole("heading", {
          level: 2,
          name: exercise.name,
          exact: true,
        }),
      });
      await expect(card.getByText("SS", { exact: true })).toHaveCount(
        exercise.group ? 1 : 0,
      );
    }
    const workoutScreenshot = testInfo.outputPath(`05-workout-day-${dayIndex + 1}.png`);
    await page.screenshot({ path: workoutScreenshot, fullPage: true });
    await checkpoint({
      id: `QA-02-RC-WORKOUT-DAY-${dayIndex + 1}`,
      action: `Start published Day ${dayIndex + 1} and inspect exact order, dose, removals, and group structure.`,
      expected: `Workout Day ${dayIndex + 1} contains the exact ordered exercise doses, no replaced source, and only the requested grouped members.`,
      observed: `Workout Day ${dayIndex + 1} showed all ${expectedExercises.length} exercises in order with exact set/rep targets, no stale source, and the expected group membership.`,
      screenshot: workoutScreenshot,
    });
    await discardWorkout(page);
  }

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests.filter((request) => !isExpectedEmptyDraftResponse(request))).toEqual([]);
});
