import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  installNextDevelopmentRefreshControl,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const expectedUserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const evidenceDirectory = resolve(
  "output/playwright/remediation-2026-07-21-stage3-mobile-r4",
);
const captureEvidence = process.env.STAGE3_MOBILE_CAPTURE_EVIDENCE === "1";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (captureEvidence) await mkdir(evidenceDirectory);
});

async function screenshot(page: Page, name: string) {
  if (!captureEvidence) return;
  await page.screenshot({ path: resolve(evidenceDirectory, name), fullPage: false });
}

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page
    .getByPlaceholder("allowlisted email")
    .fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function expectSaved(page: Page) {
  await expect(page.getByRole("status")).toContainText("All changes saved");
}

async function touchMetric(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} must have a visible box`).not.toBeNull();
  expect(box?.width ?? 0, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0, `${label} height`).toBeGreaterThanOrEqual(44);
  return {
    label,
    width: Math.round((box?.width ?? 0) * 10) / 10,
    height: Math.round((box?.height ?? 0) * 10) / 10,
  };
}

function boxBottom(box: { y: number; height: number } | null) {
  return box ? box.y + box.height : Number.POSITIVE_INFINITY;
}

function isExpectedFrameworkCancellation(failure: string) {
  if (!failure.endsWith(" — net::ERR_ABORTED")) return false;
  return (
    /^POST http:\/\/[^/]+\/(?:sign-in|settings|today|session\/[0-9a-f-]+)(?:\?[^ ]*)? — /.test(
      failure,
    ) ||
    /^GET http:\/\/[^/]+\/api\/program\/draft — /.test(failure) ||
    (/^GET http:\/\/[^/]+\//.test(failure) && failure.includes("_rsc="))
  );
}

function isExpectedFreshEditorResponse(failure: string) {
  return /^404 GET http:\/\/[^/]+\/api\/program\/draft$/.test(failure);
}

test("keeps new Stage 3 controls usable at the saved iPhone calibration", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  const requestFailures: string[] = [];
  const httpErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      browserErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    requestFailures.push(
      `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  await signIn(page);
  const calibration = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    screen: { width: screen.width, height: screen.height },
    deviceScaleFactor: devicePixelRatio,
    mobile: /iPhone/.test(navigator.userAgent),
    touch: navigator.maxTouchPoints > 0,
    maxTouchPoints: navigator.maxTouchPoints,
    userAgent: navigator.userAgent,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  expect(calibration).toEqual({
    viewport: { width: 440, height: 956 },
    screen: { width: 440, height: 956 },
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    maxTouchPoints: 1,
    userAgent: expectedUserAgent,
    locale: "en-CA",
    timezone: "America/Toronto",
  });

  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await extraLarge.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  const typography = await page.evaluate(() => ({
    key: document.documentElement.dataset.fontSize,
    rootPixels: Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    ),
  }));
  expect(typography.key).toBe("extra-large");
  expect(typography.rootPixels).toBeCloseTo(23.2, 1);

  await page.goto("/program/edit");
  await expectSaved(page);
  await page.getByRole("tab", { name: /Day B.*Hinge/ }).click();
  await page
    .locator("summary")
    .filter({ hasText: "Optional check-off steps" })
    .click();
  await page.getByRole("button", { name: "Add warm-up step", exact: true }).click();
  const editorStep = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Step 1", exact: true }),
  });
  await editorStep.getByLabel("Step", { exact: true }).fill("Mobile activation ramp");
  await editorStep.getByLabel("Repetitions (optional)").fill("6");
  await editorStep.getByLabel("Loading method").selectOption("percent");
  await editorStep.getByLabel("Percent", { exact: true }).fill("40");
  await editorStep
    .getByLabel("Notes (optional)")
    .fill("Controlled tempo at the calibrated mobile size.");
  await expectSaved(page);
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Check Program", exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Ready to publish" })).toBeVisible();
  await page
    .getByRole("button", { name: "Publish future Program", exact: true })
    .click();
  await expect(page.getByText("Future Program published", { exact: true })).toBeVisible();

  const todayLink = page.getByRole("link", { name: "Today", exact: true }).last();
  await todayLink.focus();
  await expect(todayLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/today$/);
  const start = page.getByRole("button", { name: "Train as planned", exact: true });
  await page.getByRole("checkbox", { name: /Include programmed warm-ups/ }).check();
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
  const sessionUrl = page.url();

  const statusBar = page.getByRole("complementary", { name: "Workout status" });
  const workoutGuidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  await page.locator("#workout-warmup").scrollIntoViewIfNeeded();
  const warmupRow = page
    .locator("#workout-warmup li")
    .filter({ hasText: "Mobile activation ramp" });
  await warmupRow.scrollIntoViewIfNeeded();
  await expect(warmupRow).toContainText("6 reps · 40% of working load");
  await expect(warmupRow).toContainText(
    "Plan: Controlled tempo at the calibrated mobile size.",
  );
  await expect(page.locator("#workout-warmup")).not.toContainText(
    "checkable warm-up sequence is not available yet",
  );
  await expect(workoutGuidance).toContainText("Now: Mobile activation ramp");
  await expect(statusBar).toContainText("Mobile activation ramp");
  await expect(statusBar).toContainText("Complete warm-up");
  await expect(statusBar.getByTestId("active-workout-dock-primary"))
    .toHaveAttribute("aria-label", "Complete Mobile activation ramp");

  const addNote = warmupRow.getByRole("button", { name: "Add note", exact: true });
  const skip = warmupRow.getByRole("button", {
    name: "Skip due to time",
    exact: true,
  });
  const complete = warmupRow.getByRole("checkbox", { name: "Mark Mobile activation ramp complete", exact: true });
  const initialTouchTargets = await Promise.all([
    touchMetric(addNote, "Add note"),
    touchMetric(skip, "Skip warm-up"),
    touchMetric(complete, "Complete warm-up"),
  ]);

  const bottomTabs = page.locator("nav.fixed");
  const initialLayout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(initialLayout.scrollWidth).toBeLessThanOrEqual(
    initialLayout.viewportWidth + 1,
  );
  const dockBox = await statusBar.boundingBox();
  const tabsBox = await bottomTabs.boundingBox();
  expect(dockBox).not.toBeNull();
  expect(tabsBox).toBeNull();
  expect(boxBottom(dockBox)).toBeLessThanOrEqual(
    calibration.viewport.height + 1,
  );
  await screenshot(page, "01-extra-large-warmup-controls.png");

  await addNote.focus();
  await expect(addNote).toBeFocused();
  await page.keyboard.press("Enter");
  const noteDialog = page.getByRole("dialog", {
    name: "Note for Mobile activation ramp",
  });
  const note = noteDialog.getByLabel("Workout-item note");
  await expect(note).toBeFocused();
  await note.fill("Mobile offline note from the calibrated profile.");
  const noteMetric = await touchMetric(note, "Workout-item note");
  await note.press("Tab");
  const cancel = noteDialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeFocused();
  await cancel.press("Tab");
  const saveNote = noteDialog.getByRole("button", { name: "Save note", exact: true });
  await expect(saveNote).toBeFocused();
  const saveMetric = await touchMetric(saveNote, "Save note");
  const keyboardLayout = await Promise.all([
    note.boundingBox(),
    saveNote.boundingBox(),
  ]);
  for (const box of keyboardLayout) {
    expect(box).not.toBeNull();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect(boxBottom(box)).toBeLessThanOrEqual(956);
  }
  await screenshot(page, "02-keyboard-reachable-note-dialog.png");

  await context.setOffline(true);
  await saveNote.press("Enter");
  const queueButton = page.getByRole("button", {
    name: "Open unsaved workout changes",
  });
  await expect(queueButton).toBeVisible();
  const queueMetric = await touchMetric(queueButton, "Unsaved workout changes");
  const queueBox = await queueButton.boundingBox();
  const offlineTabsBox = await bottomTabs.boundingBox();
  expect(queueBox).not.toBeNull();
  expect(offlineTabsBox).toBeNull();
  expect(boxBottom(queueBox)).toBeLessThanOrEqual(
    calibration.viewport.height + 1,
  );
  await screenshot(page, "03-offline-queue-in-focused-workout.png");

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(queueButton).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page
      .locator("#workout-warmup li")
      .filter({ hasText: "Mobile activation ramp" }),
  ).toContainText("Note: Mobile offline note from the calibrated profile.");
  await page.waitForLoadState("networkidle");

  const returnToToday = page.getByRole("link", {
    name: "Back to Today",
    exact: true,
  });
  await returnToToday.click();
  await expect(page).toHaveURL(/\/today$/);
  const resume = page.getByRole("button", { name: "Resume workout", exact: true });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(page).toHaveURL(sessionUrl);
  await page.locator("#workout-warmup").scrollIntoViewIfNeeded();
  await expect(
    page
      .locator("#workout-warmup li")
      .filter({ hasText: "Mobile activation ramp" }),
  ).toContainText("Mobile offline note from the calibrated profile.");
  const resumedWarmupRow = page
    .locator("#workout-warmup li")
    .filter({ hasText: "Mobile activation ramp" });
  await resumedWarmupRow.scrollIntoViewIfNeeded();
  await resumedWarmupRow
    .getByRole("checkbox", { name: "Mark Mobile activation ramp complete", exact: true })
    .click();
  const collapsedWarmup = page.locator("details#workout-warmup");
  await expect(collapsedWarmup).not.toHaveAttribute("open", "");
  await expect(collapsedWarmup).toContainText("Warm-up complete");
  await collapsedWarmup.locator("summary").click();
  await collapsedWarmup
    .getByRole("button", { name: "Review full plan", exact: true })
    .click();
  await expect(resumedWarmupRow).toBeVisible();
  await expect(resumedWarmupRow).toContainText("completed");
  const resolvedEditNote = resumedWarmupRow.getByRole("button", {
    name: "Edit note",
    exact: true,
  });
  const resolvedEditMetric = await touchMetric(
    resolvedEditNote,
    "Edit completed warm-up note",
  );
  await resolvedEditNote.click();
  const resolvedNoteDialog = page.getByRole("dialog", {
    name: "Note for Mobile activation ramp",
  });
  await resolvedNoteDialog.getByLabel("Workout-item note").fill("");
  await resolvedNoteDialog
    .getByRole("button", { name: "Save note", exact: true })
    .click();
  await expect(resumedWarmupRow).toContainText("completed");
  await expect(resumedWarmupRow).not.toContainText(
    "Note: Mobile offline note from the calibrated profile.",
  );
  await expect(
    resumedWarmupRow.getByRole("button", { name: "Add note", exact: true }),
  ).toBeVisible();
  await screenshot(page, "04-back-navigation-resumes-durable-workout.png");

  await page.setViewportSize({ width: 320, height: 700 });
  const currentExercise = page.getByTestId("current-exercise-card");
  const currentExerciseName = await currentExercise
    .getByRole("heading", { level: 2 })
    .textContent();
  const logSet = currentExercise.getByRole("button", {
    name: "Log set",
    exact: true,
  });
  await logSet.scrollIntoViewIfNeeded();
  await logSet.click();
  await expect(statusBar).toContainText("Resting");
  await expect(statusBar).toContainText(currentExerciseName ?? "");
  await expect(
    statusBar.getByRole("region", { name: "Rest timer" }),
  ).toBeVisible();
  await expect(
    statusBar.getByRole("button", { name: "Decrease rest by 15 seconds" }),
  ).toBeVisible();
  await expect(
    statusBar.getByRole("button", { name: "Increase rest by 15 seconds" }),
  ).toBeVisible();
  await expect(
    statusBar.getByRole("button", { name: "Skip rest" }),
  ).toBeVisible();

  const enlargedLayout = await page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>(
      '[aria-label="Workout status"]',
    );
    const tabs = document.querySelector<HTMLElement>(
      'nav[aria-label="Primary navigation"]',
    );
    const tabsRect = tabs?.getBoundingClientRect() ?? null;
    const tabsVisible =
      tabs != null &&
      getComputedStyle(tabs).display !== "none" &&
      (tabsRect?.height ?? 0) > 0;
    const currentHeading = document.querySelector<HTMLElement>(
      '[data-testid="current-exercise-card"] h2',
    );
    const nextIdentity = document.querySelector<HTMLElement>(
      '[aria-label="Workout progress and upcoming work"] p',
    );
    return {
      dock: dock?.getBoundingClientRect().toJSON() ?? null,
      tabs: tabsRect?.toJSON() ?? null,
      tabsVisible,
      viewportBottom: window.innerHeight,
      currentHeadingFits:
        currentHeading != null &&
        currentHeading.scrollWidth <= currentHeading.clientWidth + 1,
      nextIdentityFits:
        nextIdentity != null &&
        nextIdentity.scrollWidth <= nextIdentity.clientWidth + 1,
    };
  });
  expect(enlargedLayout.dock).not.toBeNull();
  expect(enlargedLayout.tabs).not.toBeNull();
  expect(enlargedLayout.tabsVisible).toBe(false);
  expect(enlargedLayout.dock?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    210,
  );
  expect(
    (enlargedLayout.dock?.y ?? 0) + (enlargedLayout.dock?.height ?? 0),
  ).toBeLessThanOrEqual(enlargedLayout.viewportBottom + 1);
  expect(enlargedLayout.currentHeadingFits).toBe(true);
  expect(enlargedLayout.nextIdentityFits).toBe(true);
  await screenshot(page, "05-extra-large-rest-dock.png");

  const metrics = {
    calibration,
    typography,
    touchTargets: [
      ...initialTouchTargets,
      noteMetric,
      saveMetric,
      queueMetric,
      resolvedEditMetric,
    ],
    layout: {
      dockBottom: Math.round(boxBottom(dockBox) * 10) / 10,
      navigationVisible: tabsBox !== null,
      queueBottom: Math.round(boxBottom(queueBox) * 10) / 10,
      offlineNavigationVisible: offlineTabsBox !== null,
      horizontalOverflowPixels:
        initialLayout.scrollWidth - initialLayout.viewportWidth,
      enlargedRestDockHeight:
        Math.round((enlargedLayout.dock?.height ?? 0) * 10) / 10,
      enlargedRestDockBottom:
        Math.round(
          ((enlargedLayout.dock?.y ?? 0) +
            (enlargedLayout.dock?.height ?? 0)) *
            10,
        ) / 10,
      enlargedNavigationVisible: enlargedLayout.tabsVisible,
      enlargedViewportBottom:
        Math.round(enlargedLayout.viewportBottom * 10) / 10,
    },
    expectedFrameworkRequestCancellations: requestFailures.filter(
      isExpectedFrameworkCancellation,
    ),
    expectedFreshEditorResponses: httpErrors.filter(
      isExpectedFreshEditorResponse,
    ),
  };
  if (captureEvidence) {
    await writeFile(
      resolve(evidenceDirectory, "calibration-and-layout-metrics.json"),
      `${JSON.stringify(metrics, null, 2)}\n`,
      { flag: "wx" },
    );
  }

  expect(browserErrors.filter((message) => message !== "NEXT_REDIRECT")).toEqual([]);
  expect(
    requestFailures.filter((failure) => !isExpectedFrameworkCancellation(failure)),
  ).toEqual([]);
  expect(
    httpErrors.filter((failure) => !isExpectedFreshEditorResponse(failure)),
  ).toEqual([]);
});
