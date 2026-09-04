import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  expect,
  test,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS } from "../../src/lib/active-workout-presentation-state";
import { BA_WORKOUT_EMAIL } from "../fixtures/ba-workout-contract";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const SET_OUTBOX_KEY = "workout-tracker:workout-set-outbox:v1";
const PHASE5_QA_DIRECTORY = resolve(
  "docs/assets/active-workout-phase5-qa",
);

test.describe.configure({ mode: "serial" });

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function capturePhase5Evidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
) {
  await page.evaluate(() =>
    new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => resolveFrame())
      ),
    ),
  );
  const image = await page.screenshot({
    type: "jpeg",
    quality: 84,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach(`phase5-${name}`, {
    body: image,
    contentType: "image/jpeg",
  });
  if (process.env.UPDATE_ACTIVE_WORKOUT_PHASE5_QA === "1") {
    await mkdir(PHASE5_QA_DIRECTORY, { recursive: true });
    await writeFile(resolve(PHASE5_QA_DIRECTORY, `${name}.jpg`), image);
  }
}

async function signInAndStartDayA(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
  await expect(page.getByTestId("active-log-set")).toHaveAccessibleName(
    "Log set 1",
  );
}

async function dismissRest(page: Page) {
  const rest = page
    .getByRole("complementary", { name: "Workout status" })
    .getByTestId("rest-cockpit");
  if (!(await rest.isVisible())) return;
  const end = rest.getByRole("button", { name: "End rest", exact: true });
  await end.click();
  await expect(rest).toHaveCount(0, { timeout: 5_000 });
}

async function discardWorkout(page: Page) {
  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", {
      name: /^(?:Review and finish workout|Finish workout)$/,
    })
    .click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish
    .getByRole("button", { name: "Discard workout", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /^Discard .+\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

async function currentExerciseName(page: Page) {
  return page
    .getByTestId("current-exercise-card")
    .getByRole("heading", { level: 2 })
    .innerText();
}

async function openCurrentExerciseTools(page: Page) {
  const name = await currentExerciseName(page);
  const card = page.getByRole("region", { name, exact: true });
  const toggle = card.getByTestId("exercise-swipe-surface");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await openNativeDetails(card.getByTestId("active-exercise-details"));
  return card;
}

async function skipCurrentExercise(page: Page) {
  const before = await currentExerciseName(page);
  const card = await openCurrentExerciseTools(page);
  const skip = card.getByRole("button", {
    name: "Skip exercise",
    exact: true,
  });
  await waitForHydratedReactHandler(skip);
  await skip.click();
  await page
    .getByRole("dialog", { name: "Skip exercise — why?" })
    .getByRole("button", { name: "User choice", exact: true })
    .click();
  await expect(card.getByRole("status")).toContainText("Exercise skipped");
  await card
    .getByRole("button", { name: "Keep skipped and continue", exact: true })
    .click();
  await expect.poll(() => currentExerciseName(page)).not.toBe(before);
}

async function expectOutboxCount(page: Page, count: number) {
  await expect.poll(() => page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return 0;
    return (JSON.parse(raw) as { entries?: unknown[] }).entries?.length ?? 0;
  }, SET_OUTBOX_KEY)).toBe(count);
}

test("keeps a retained set coherent through saving, reload failure, and explicit discard", async ({
  context,
  page,
}, testInfo) => {
  await signInAndStartDayA(page);

  const releaseSave = deferred();
  const saveHeld = deferred();
  let holdNextSet = true;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      holdNextSet &&
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      (request.postData() ?? "").includes('"setNo"')
    ) {
      holdNextSet = false;
      saveHeld.resolve();
      await releaseSave.promise;
    }
    await route.continue();
  });

  const firstLog = page.getByTestId("active-log-set");
  const firstLogClick = firstLog.click();
  await saveHeld.promise;
  const savingRow = page.locator('[data-set-row-state="saving"]');
  await expect(savingRow).toContainText("Saving");
  await expect(page.getByTestId("active-log-set")).toHaveAccessibleName(
    "Log set 2",
  );
  await capturePhase5Evidence(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.saving390x844At115,
  );
  releaseSave.resolve();
  await firstLogClick;
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator('[data-set-row-state="saved"]')).toHaveCount(1);
  await expectOutboxCount(page, 0);
  await dismissRest(page);

  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.getByTestId("active-log-set").click();
  await expectOutboxCount(page, 1);
  await expect(page.getByTestId("active-log-set")).toHaveAccessibleName(
    "Log set 3",
  );
  await dismissRest(page);
  await page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) throw new Error("The retained set was not written.");
    const stored = JSON.parse(raw) as {
      entries?: Array<{
        status: string;
        attemptCount: number;
        nextAttemptAtISO: string | null;
        lastAttemptAtISO: string | null;
        lastError: string | null;
      }>;
    };
    const entry = stored.entries?.[0];
    if (entry == null) throw new Error("The retained set entry is missing.");
    entry.status = "needs_attention";
    entry.attemptCount = 6;
    entry.nextAttemptAtISO = null;
    entry.lastAttemptAtISO = new Date().toISOString();
    entry.lastError = "Repbook could not confirm this saved set.";
    localStorage.setItem(storageKey, JSON.stringify(stored));
  }, SET_OUTBOX_KEY);
  await context.setOffline(false);
  await page.reload({ waitUntil: "domcontentloaded" });

  const failedRow = page.locator('[data-set-row-state="failed"]');
  await expect(failedRow).toContainText("Save failed");
  await expect(failedRow).toContainText("95 lb × 8");
  await expect(failedRow.getByTestId("failed-set-recovery")).toHaveCount(1);
  await expect(failedRow.locator(".ui-state")).toHaveCount(0);
  await expect(failedRow.getByRole("button", { name: "Retry save" })).toBeVisible();
  await expect(
    failedRow.getByRole("button", { name: "Discard device copy" }),
  ).toBeVisible();
  await failedRow.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" })
  );
  await capturePhase5Evidence(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.failed390x844At115,
  );

  await failedRow
    .getByRole("button", { name: "Discard device copy", exact: true })
    .click();
  await expectOutboxCount(page, 0);
  await expect(failedRow).toHaveCount(0);
  await expect(page.getByTestId("active-log-set")).toHaveAccessibleName(
    "Log set 2",
  );
  await discardWorkout(page);
});

test("keeps dark landscape, correction, restore, and exact superset context coherent", async ({
  page,
}, testInfo) => {
  await signInAndStartDayA(page);
  const sessionUrl = page.url();
  await page.locator("html").evaluate((element) => element.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )).toBe(true);

  await page.getByTestId("active-log-set").click();
  await expect(page.locator('[data-set-row-state="saved"]')).toHaveCount(1);
  await dismissRest(page);
  let squat = await openCurrentExerciseTools(page);
  await squat
    .getByTestId("completed-sets")
    .getByRole("button", { name: "Correct set", exact: true })
    .first()
    .click();
  const correction = page.getByRole("dialog", {
    name: "Correct acknowledged set 1",
  });
  await correction.getByLabel("Load", { exact: true }).fill("100");
  await correction
    .getByLabel("Why are you correcting this?")
    .selectOption("measurement_entry");
  await correction
    .getByRole("button", { name: "Review correction", exact: true })
    .click();
  await expect(correction).toContainText("Original");
  await expect(correction).toContainText("Corrected");
  await capturePhase5Evidence(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.correction390x844At115,
  );
  await correction.getByRole("checkbox").check();
  await correction
    .getByRole("button", { name: "Save reviewed correction", exact: true })
    .click();
  await expect(page.getByText("Set correction acknowledged")).toBeVisible();

  await page.goto("/recovery/versions?type=completed_set");
  const restore = page
    .getByRole("button", { name: "Restore earlier values", exact: true })
    .first();
  await waitForHydratedReactHandler(restore);
  await restore.click();
  const restoreDialog = page.getByRole("dialog", {
    name: /Restore the earlier values for/,
  });
  await restoreDialog
    .getByRole("button", { name: "Create snapshot and restore", exact: true })
    .click();
  await expect(page.getByText("Earlier values restored", { exact: true }))
    .toBeVisible();

  await page.goto(sessionUrl);
  await page.locator("html").evaluate((element) => element.classList.add("dark"));
  squat = page.getByRole("region", {
    name: "Barbell Back Squat",
    exact: true,
  });
  const squatToggle = squat.getByTestId("exercise-swipe-surface");
  if ((await squatToggle.getAttribute("aria-expanded")) !== "true") {
    await squatToggle.click();
  }
  await openNativeDetails(squat.getByTestId("active-exercise-details"));
  const restoredRow = squat.locator('[data-set-row-state="saved"]').first();
  await expect(restoredRow).toContainText("95 lb × 8");
  await expect(restoredRow).toContainText("Latest: Version restored");

  await skipCurrentExercise(page);
  await skipCurrentExercise(page);
  await expect.poll(() => currentExerciseName(page)).toBe(
    "Dumbbell Lateral Raise",
  );
  const group = page.getByTestId("active-workout-group");
  await expect(group).toContainText(
    "Current member: 1 of 2 · Dumbbell Lateral Raise",
  );
  await expect(group).toContainText("Up next in group: 2 of 2 · Pallof Press");

  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  )).toBeLessThanOrEqual(1);
  await capturePhase5Evidence(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.landscape844x390At115,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await capturePhase5Evidence(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.superset390x844At115,
  );
  await discardWorkout(page);
});

test("keeps skip and replacement choices explicit through pending completion and History", async ({
  page,
}, testInfo) => {
  await signInAndStartDayA(page);
  const card = await openCurrentExerciseTools(page);
  const skip = card.getByRole("button", {
    name: "Skip exercise",
    exact: true,
  });
  await waitForHydratedReactHandler(skip);
  await skip.click();
  await page
    .getByRole("dialog", { name: "Skip exercise — why?" })
    .getByRole("button", { name: "User choice", exact: true })
    .click();
  await expect(card.getByRole("status")).toContainText("Exercise skipped");
  await expect(
    card.getByRole("button", { name: "Replace exercise", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", {
      name: "Keep skipped and continue",
      exact: true,
    }),
  ).toBeVisible();
  await card.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" })
  );
  await capturePhase5Evidence(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.skipReplace390x844At115,
  );

  await card
    .getByRole("button", { name: "Replace exercise", exact: true })
    .click();
  const replacement = page.getByRole("dialog", {
    name: "Replace exercise for this workout",
  });
  await expect(replacement).toContainText("Why are you replacing it?");
  await page.keyboard.press("Escape");
  await expect(replacement).toHaveCount(0);
  await card
    .getByRole("button", {
      name: "Keep skipped and continue",
      exact: true,
    })
    .click();

  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: "Review and finish workout", exact: true })
    .click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await expect(finish).toContainText("still pending");
  await expect(
    finish.getByLabel("Why are you finishing this workout early?"),
  ).toBeVisible();
  await capturePhase5Evidence(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.finishReview390x844At115,
  );
  await finish
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("user_choice");

  const releaseFinish = deferred();
  const finishHeld = deferred();
  let holdFinish = true;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const postData = request.postData() ?? "";
    if (
      holdFinish &&
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      postData.includes('"completionReason"') &&
      postData.includes('"durationDecision"')
    ) {
      holdFinish = false;
      finishHeld.resolve();
      await releaseFinish.promise;
    }
    await route.continue();
  });
  const save = finish.getByRole("button", { name: "Save workout", exact: true });
  const saveClick = save.click();
  await finishHeld.promise;
  await expect(
    finish.getByRole("button", { name: "Saving workout…", exact: true }),
  ).toBeDisabled();
  releaseFinish.resolve();
  await saveClick;
  await page.unrouteAll({ behavior: "wait" });
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(page.getByText("Completed with planned work remaining", {
    exact: true,
  })).toBeVisible();
});
