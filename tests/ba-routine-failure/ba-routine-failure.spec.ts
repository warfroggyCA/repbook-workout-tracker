import { expect, test, type Page } from "@playwright/test";
import { BA_ROUTINE_CHANGE_BASELINE, BA_ROUTINE_CHANGE_EMAIL, BA_ROUTINE_CHANGE_REQUEST } from "../fixtures/ba-routine-change-contract";
import { writeBaCheckpointAudit, type BaDeviceCalibration } from "../helpers/ba-audit";
import { waitForHydratedServerAction } from "../helpers/react-readiness";
import type { AcceptanceRoutineDurableState } from "@/services/acceptance-routine-state";

async function captureRoutineState(page: Page) {
  const stableVisibleText = (value: string) =>
    value
      .replace(/Checked \d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M\./g, "Checked [timestamp].")
      .replace(/\s+/g, " ")
      .trim();
  await page.goto("/program");
  await expect(page.getByText("v1", { exact: true })).toBeVisible();
  const programDays: string[] = [];
  for (let index = 0; index < BA_ROUTINE_CHANGE_BASELINE.program.days.length; index += 1) {
    await page.getByRole("tab", { name: `Day ${index + 1}`, exact: true }).click();
    programDays.push(stableVisibleText(await page.locator("main").innerText()));
  }
  await page.goto("/history");
  const history = stableVisibleText(await page.locator("main").innerText());
  await page.goto("/today");
  const today = stableVisibleText(await page.locator("main").innerText());
  await expect(page.getByTestId("today-decision")).toContainText("Day 1");
  await expect(page.getByRole("button", { name: "Train as planned", exact: true })).toBeVisible();
  return { programDays, history, today };
}

function isExpectedEmptyDraftResponse(request: { method: string; url: string; status?: number }) {
  return request.method === "GET" && request.status === 404 && new URL(request.url).pathname === "/api/program/draft";
}

async function captureDurableRoutineState(
  page: Page,
): Promise<AcceptanceRoutineDurableState> {
  const response = await page.request.get("/api/acceptance/routine-state");
  if (response.status() !== 200) {
    throw new Error(
      `The guarded durable-state checkpoint returned ${response.status()}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    status: string;
    state: AcceptanceRoutineDurableState;
  };
  expect(body.status).toBe("ok");
  return body.state;
}

function changedDurableSections(
  before: AcceptanceRoutineDurableState,
  after: AcceptanceRoutineDurableState,
) {
  return (Object.keys(before) as Array<keyof AcceptanceRoutineDurableState>).filter(
    (section) => JSON.stringify(before[section]) !== JSON.stringify(after[section]),
  );
}

function durableStateSummary(state: AcceptanceRoutineDurableState) {
  const versions = state.programTree.currentVersionNumbers.join(", ") || "none";
  const draftStates = state.drafts.states.length
    ? state.drafts.states
        .map((draft) => `${draft.status} revision ${draft.revision}`)
        .join(", ")
    : "none";
  return `Program ${state.programTree.programs}, versions ${state.programTree.versions}, current version numbers ${versions}, days ${state.programTree.days}, groups ${state.programTree.groups}, slots ${state.programTree.slots}, prescriptions ${state.programTree.prescriptions}; drafts ${state.drafts.count} (${draftStates}); compiler proposals ${state.proposals.count}; recommendations ${state.recommendations.count}; workout sessions ${state.workouts.sessions}, occurrences ${state.workouts.occurrences}, completed sets ${state.workouts.sets}`;
}

test("keeps the Program unchanged after one controlled routine-provider failure", async ({ page }, testInfo) => {
  const mode = process.env.BA_EFFECTIVE_ROUTINE_FAILURE_MODE!;
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

  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(BA_ROUTINE_CHANGE_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  const calibration = await page.evaluate<BaDeviceCalibration>(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    screen: { width: screen.width, height: screen.height },
    deviceScaleFactor: devicePixelRatio,
    mobile: /iPhone/.test(navigator.userAgent),
    touch: navigator.maxTouchPoints > 0 || "ontouchstart" in window,
    touchPoints: navigator.maxTouchPoints,
    userAgent: navigator.userAgent,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));

  const before = await captureRoutineState(page);

  await page.goto("/program/edit");
  await expect(page.getByRole("status")).toContainText("All changes saved");
  await page.getByLabel("Update current Program").check();
  const durableBefore = await captureDurableRoutineState(page);
  await page.getByLabel("What should change?").fill(BA_ROUTINE_CHANGE_REQUEST);
  await page.getByRole("button", { name: "Compare and propose changes", exact: true }).click();
  const failure = page.getByText("Coach could not build the proposal", { exact: true });
  await expect(failure).toBeVisible();
  const alert = failure.locator(".." );
  const observed = (await alert.innerText()).trim() || "Failure alert had no text.";
  const expectedFailureDetail = mode === "timeout"
    ? "Coach timed out while building Day 1"
    : mode === "malformed"
      ? "Coach returned an unusable result for Day 1"
      : "AI parsing is not configured";
  const failureLabelMatches = observed.includes(expectedFailureDetail);
  const alertScreenshot = testInfo.outputPath(`${mode}-provider-alert.png`);
  await page.screenshot({ path: alertScreenshot, fullPage: true });
  await expect(page.getByText("Proposal ready to review", { exact: true })).toHaveCount(0);
  await writeBaCheckpointAudit({
    evidenceRoot: testInfo.outputDir,
    attach: (name, options) => testInfo.attach(name, options),
    audit: {
      checkpointId: `QA-03-ROUTINE-${mode.toUpperCase()}-ALERT`,
      preconditions: "Fresh disposable BA routine-change database at the exact Program version 1 baseline.",
      action: `Paste the exact three-day request and trigger the controlled ${mode} provider outcome.`,
      expected: `The editor stays on the request screen, shows the specific controlled ${mode} failure, and creates no proposal.`,
      observed,
      status: failureLabelMatches ? "pass" : "fail",
      severity: failureLabelMatches ? "none" : "medium",
      url: page.url(),
      calibration,
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      failedRequests: [...failedRequests],
      artifacts: [{ label: "Provider failure alert", kind: "screenshot", path: alertScreenshot }],
    },
  });

  const durableAfter = await captureDurableRoutineState(page);
  const durableChanges = changedDurableSections(durableBefore, durableAfter);

  const after = await captureRoutineState(page);
  const visibleStateMatches = JSON.stringify(after) === JSON.stringify(before);
  const durableStateMatches = durableChanges.length === 0;
  const stateMatches = visibleStateMatches && durableStateMatches;

  const screenshot = testInfo.outputPath(`${mode}-no-partial-mutation.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await writeBaCheckpointAudit({
    evidenceRoot: testInfo.outputDir,
    attach: (name, options) => testInfo.attach(name, options),
    audit: {
      checkpointId: `QA-03-ROUTINE-${mode.toUpperCase()}-NO-MUTATION`,
      preconditions: "Fresh disposable BA routine-change database at Program version 1.",
      action: `After the controlled ${mode} failure, compare the durable Program/version/tree, draft, compiler proposal, recommendation, workout/session, occurrence, and completed-set state, then revisit all three Program days, History, and Today.`,
      expected: "The complete durable Program tree, open-draft state, proposal and recommendation counts, workout/session occurrence and set records, all Program-day content, History, Today, version 1, and the planned-start action are unchanged.",
      observed: stateMatches
        ? `Durable state exactly matched before and after (${durableStateSummary(durableAfter)}). All three complete Program-day views, the complete History view, and the complete Today view also exactly matched; version 1 and Train as planned remained visible.`
        : `Visible-state match: ${visibleStateMatches}; durable-state match: ${durableStateMatches}; changed durable sections: ${durableChanges.join(", ") || "none"}.`,
      status: stateMatches ? "pass" : "fail",
      severity: stateMatches ? "none" : "high",
      url: page.url(),
      calibration,
      consoleErrors,
      pageErrors,
      failedRequests,
      followUp: "The alert checkpoint records the editor URL; this independent checkpoint records the final Today URL and full visible-state comparison.",
      artifacts: [
        { label: "No partial mutation", kind: "screenshot", path: screenshot },
      ],
    },
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests.filter((request) => !isExpectedEmptyDraftResponse(request))).toEqual([]);
  expect(durableChanges, "Controlled provider failure changed durable state sections.").toEqual([]);
  expect(after).toEqual(before);
  expect(failureLabelMatches, observed).toBe(true);
});
