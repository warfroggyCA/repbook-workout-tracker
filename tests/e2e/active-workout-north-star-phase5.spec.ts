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
const PHASE6_QA_DIRECTORY = resolve(
  "docs/assets/active-workout-phase6-qa",
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
  if (process.env.UPDATE_ACTIVE_WORKOUT_PHASE6_QA === "1") {
    await mkdir(PHASE6_QA_DIRECTORY, { recursive: true });
    await writeFile(resolve(PHASE6_QA_DIRECTORY, `${name}.jpg`), image);
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
  const skipDialog = page.getByRole("dialog", {
    name: "Skip exercise — why?",
  });
  await expect(
    skipDialog.getByRole("button", {
      name: "Equipment unavailable or incompatible",
      exact: true,
    }),
  ).toHaveCount(0);
  await skipDialog
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
    name: "Edit set 1",
  });
  await correction.getByLabel("Load", { exact: true }).fill("100");
  await capturePhase5Evidence(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.correction390x844At115,
  );
  await correction
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByText("Set saved")).toBeVisible();

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
  await expect(replacement).toContainText("Choose a reason, then browse replacements.");
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

test("workout feedback: direct RPE, immediate extra-set rest, and interrupted audio recovery", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const state = { contexts: [] as Array<{ state: string }>, loudTones: 0 };
    Object.assign(window, { feedbackAudio: state });
    class Audio {
      private clockState = "running";
      private elapsed = 0;
      private resumedAt = performance.now();
      get state() { return this.clockState; }
      set state(value: string) {
        this.elapsed = this.currentTime;
        this.clockState = value;
        this.resumedAt = performance.now();
      }
      get currentTime() {
        return this.elapsed + (this.state === "running" ? (performance.now() - this.resumedAt) / 1_000 : 0);
      }
      destination = {};
      constructor() { state.contexts.push(this); }
      async resume() {
        await new Promise((resolve) => setTimeout(resolve, 150));
        this.state = "running";
      }
      async suspend() { this.state = "suspended"; }
      async close() { this.state = "closed"; }
      createGain() {
        return { gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime(value: number) { if (value > 0.4) state.loudTones += 1; },
        }, connect() {}, disconnect() {} };
      }
      createOscillator() {
        return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {} };
      }
    }
    Object.assign(window, { AudioContext: Audio });
  });
  await signInAndStartDayA(page);
  const name = await currentExerciseName(page);
  const current = page.getByTestId("current-set-entry");
  await expect(current.getByRole("radio", { name: /^Not recorded;/ })).toBeChecked();
  await expect(page.getByTestId("active-exercise-details").first()).not.toHaveAttribute("open");
  await current.getByRole("radio", { name: /^Hard — RPE 8;/ }).check();
  await expect(current.getByRole("radio", { name: /^Hard — RPE 8;/ })).toBeChecked();
  await capturePhase5Evidence(page, testInfo, "feedback-direct-rpe");
  const submitted = page.waitForRequest((request) => request.method() === "POST" &&
    Boolean(request.headers()["next-action"]) && (request.postData() ?? "").includes('"setNo":1'));
  await page.getByTestId("active-log-set").click();
  expect((await submitted).postData()).toContain('"rpe":8');
  await expect(page.locator('[data-set-row-state="saved"]')).toHaveCount(1);
  await dismissRest(page);
  await expect(page.getByTestId("current-set-entry").getByRole("radio", { name: /^Not recorded;/ })).toBeChecked();
  for (let setNo = 2; setNo <= 3; setNo += 1) {
    await page.getByTestId("active-log-set").click();
    if (setNo < 3) await expect(page.locator('[data-set-row-state="saved"]')).toHaveCount(setNo);
    else await expect.poll(() => currentExerciseName(page)).not.toBe(name);
    await expectOutboxCount(page, 0);
    await dismissRest(page);
  }
  const squat = page.getByRole("region", { name, exact: true });
  const toggle = squat.getByTestId("exercise-swipe-surface");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await openNativeDetails(squat.getByTestId("active-exercise-details"));
  await expect(squat.getByTestId("completed-sets")).toContainText("Hard");
  const releaseAppend = deferred();
  const appendHeld = deferred();
  let intercepted = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!intercepted && request.method() === "POST" && request.headers()["next-action"] &&
      (request.postData() ?? "").includes('"expectedSetNo"')) {
      intercepted = true;
      appendHeld.resolve();
      await Promise.race([releaseAppend.promise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    await route.continue();
  });
  const appendClick = squat.getByRole("button", { name: "Add extra set", exact: true }).first().click();
  await expect.poll(() => intercepted, { timeout: 10_000 }).toBe(true);
  await appendHeld.promise;
  const timerKey = "workout-tracker:rest-timer:v1";
  const retained = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), timerKey);
  expect(retained.phase).toBe("running");
  expect(retained.sourceCompletedSetId).toBeNull();
  expect(retained.endsAt - retained.startedAt).toBe(150_000);
  await expect(page.getByTestId("rest-cockpit")).toBeVisible();
  releaseAppend.resolve();
  await appendClick;
  await expect(squat.locator('[data-set-membership="extra"]')).toHaveCount(1);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).endsAt, timerKey)).toBe(retained.endsAt);
  await page.evaluate((key) => {
    const audio = (window as unknown as { feedbackAudio: { contexts: Array<{ state: string }>; loudTones: number } }).feedbackAudio;
    for (const context of audio.contexts) context.state = "interrupted";
    audio.loudTones = 0;
    const timer = JSON.parse(localStorage.getItem(key)!);
    timer.startedAt = Date.now(); timer.totalSec = 1; timer.endsAt = timer.startedAt + 1_000; timer.revision += 1;
    localStorage.setItem(key, JSON.stringify(timer));
    window.dispatchEvent(new Event("workout-rest-timer-change"));
    window.dispatchEvent(new Event("focus"));
  }, timerKey);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { feedbackAudio: { loudTones: number } }).feedbackAudio.loudTones,
  )).toBe(8);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect(page.getByTestId("rest-cockpit")).toContainText("Rest complete");
  expect(await page.evaluate(() => (window as unknown as { feedbackAudio: { loudTones: number } }).feedbackAudio.loudTones)).toBe(8);
  await page.reload();
  await waitForEquipmentSelectionsToSettle(page);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).generationId, timerKey)).toBe(retained.generationId);
  await discardWorkout(page);
});

test("fixes a just-logged set from its ledger row and resumes from Today with exact device state", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await signInAndStartDayA(page);
  const sessionUrl = page.url();
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "extra-large";
    localStorage.setItem("workout-font-size", "extra-large");
    window.dispatchEvent(new Event("workout-font-size-change"));
  });
  const attach = async (name: string) =>
    testInfo.attach(`fix-resume-${name}`, {
      body: await page.screenshot({ type: "jpeg", quality: 84, animations: "disabled", caret: "hide" }),
      contentType: "image/jpeg",
    });

  // Log a mistaken result: 7 repetitions instead of 8. The starting load
  // can come from earlier synthetic workouts, so read it rather than assume it.
  const exerciseName = await currentExerciseName(page);
  const ledger = page.getByTestId("active-set-ledger").first();
  const currentEntry = ledger.getByTestId("current-set-entry");
  const repsInput = currentEntry.getByLabel("Reps", { exact: true });
  await waitForHydratedReactHandler(
    currentEntry.getByRole("button", { name: "Decrease reps" }),
  );
  await repsInput.fill("7");
  await expect(repsInput).toHaveValue("7");
  const load = (await currentEntry
    .getByRole("textbox")
    .first()
    .inputValue()).trim();
  expect(load).toMatch(/^\d+(?:\.\d+)?$/);
  const mistaken = `${load} lb × 7`;
  const corrected = `${load} lb × 8`;
  await page.getByTestId("active-log-set").click();
  const savedRow = ledger.locator('[data-set-row-state="saved"]').first();
  await expect(savedRow).toContainText(mistaken);

  // Rest keeps running while the saved row offers the existing correction.
  const rest = page
    .getByRole("complementary", { name: "Workout status" })
    .getByTestId("rest-cockpit");
  await expect(rest).toBeVisible();
  const fix = savedRow.getByRole("button", { name: `Fix Set 1, ${mistaken}` });
  await expect(fix).toBeVisible();
  const fixHitArea = await fix.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const before = window.getComputedStyle(element, "::before");
    return {
      width:
        bounds.width -
        Number.parseFloat(before.left) -
        Number.parseFloat(before.right),
      height:
        bounds.height -
        Number.parseFloat(before.top) -
        Number.parseFloat(before.bottom),
    };
  });
  expect(fixHitArea.height).toBeGreaterThanOrEqual(44);
  expect(fixHitArea.width).toBeGreaterThanOrEqual(44);
  await fix.scrollIntoViewIfNeeded();
  await attach("saved-row-fix");
  await waitForHydratedReactHandler(fix);
  await fix.click();

  const correction = page.getByRole("dialog", {
    name: "Edit set 1",
  });
  await expect(correction.getByRole("checkbox")).toHaveCount(0);
  await expect(correction.getByLabel("Why are you correcting this?")).toHaveCount(0);
  const save = correction.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await correction.getByLabel("Reps", { exact: true }).fill("9");
  await correction.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(correction).toBeHidden();
  await expect(savedRow).toContainText(mistaken);
  await fix.click();
  await expect(correction.getByLabel("Reps", { exact: true })).toHaveValue("7");
  await correction.getByLabel("Reps", { exact: true }).fill("10");
  await page.keyboard.press("Escape");
  await expect(correction).toBeHidden();
  await fix.click();
  await expect(correction.getByLabel("Reps", { exact: true })).toHaveValue("7");
  await page.context().setOffline(true);
  try {
    await correction.getByLabel("Reps", { exact: true }).fill("8");
    await expect(correction).toContainText("You’re offline. Reconnect to save changes.");
    await expect(save).toBeDisabled();
    await expect(page.getByTestId("rest-cockpit")).toBeAttached();
  } finally {
    await page.context().setOffline(false);
  }
  await expect(save).toBeEnabled();
  await expect(correction.getByLabel("Reps", { exact: true })).toHaveValue("8");
  // A failed request keeps the draft, and an explicit retry saves once.
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await save.click();
  await expect(correction.getByRole("alert")).toContainText("Couldn’t confirm the save");
  await expect(correction.getByLabel("Reps", { exact: true })).toHaveValue("8");
  await expect(savedRow).toContainText(mistaken);
  await page.unroute("**/*");
  await correction
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByText("Set saved")).toBeVisible();
  await expect(savedRow).toContainText(corrected);
  await expect(savedRow).toContainText("Latest: Corrected");
  await expect(rest).toBeVisible();
  await expect(page.getByTestId("active-log-set")).toHaveAccessibleName(
    "Log set 2",
  );
  await expect(page.getByTestId("active-log-set")).toBeEnabled();
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )).toBeLessThanOrEqual(1);
  await attach("corrected-row");

  // Today names the next saved step when nothing is waiting on this device.
  await page.goto("/today");
  const deviceWork = page.getByTestId("resume-device-work");
  await expect(deviceWork).toHaveText(
    "No sets or workout changes from this workout are waiting on this device",
  );
  await expect(page.getByTestId("resume-up-next")).toContainText(
    `${exerciseName} · set 2`,
  );
  await expect(page.getByTestId("resume-up-next")).toContainText(/reps/);
  await attach("today-up-next");

  // A set held on this device replaces Up next with the device status.
  await page.goto(sessionUrl);
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      (request.postData() ?? "").includes('"setNo"')
    ) {
      await route.abort("internetdisconnected");
      return;
    }
    await route.continue();
  });
  await dismissRest(page);
  await page.getByTestId("active-log-set").click();
  await expectOutboxCount(page, 1);
  const pendingRow = ledger.locator(
    '[data-set-row-state="retained_locally"], [data-set-row-state="saving"], [data-set-row-state="retrying"]',
  );
  const pendingFix = pendingRow.getByTestId("set-fix-pending");
  await expect(pendingFix).toHaveAccessibleName("Fix after it saves");
  await expect(pendingFix).toBeDisabled();
  await expect(
    pendingRow.getByRole("button", { name: /^Fix Set/ }),
  ).toHaveCount(0);

  await page.goto("/today");
  await expect(deviceWork).toHaveText(
    /1 set still saving from this device/,
  );
  await expect(deviceWork).toContainText(
    "Open the workout to finish saving and see where you are.",
  );
  await expect(page.getByTestId("resume-up-next")).toHaveCount(0);
  await attach("today-saving");

  await page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) throw new Error("The retained set was not written.");
    const stored = JSON.parse(raw) as {
      entries?: Array<{ status: string; nextAttemptAtISO: string | null }>;
    };
    const entry = stored.entries?.[0];
    if (entry == null) throw new Error("The retained set entry is missing.");
    entry.status = "needs_attention";
    entry.nextAttemptAtISO = null;
    localStorage.setItem(storageKey, JSON.stringify(stored));
  }, SET_OUTBOX_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(deviceWork).toHaveAttribute("data-device-work", "attention");
  await expect(deviceWork).toContainText(
    "1 set needs attention on this device",
  );
  await expect(page.getByTestId("resume-up-next")).toHaveCount(0);
  await attach("today-attention");

  await page.unrouteAll({ behavior: "wait" });
  await page.getByText("Resume workout", { exact: true }).click();
  await expect(page).toHaveURL(sessionUrl);
  const failedRow = page.locator('[data-set-row-state="failed"]');
  await failedRow
    .getByRole("button", { name: "Discard device copy", exact: true })
    .click();
  await expectOutboxCount(page, 0);
  await page.goto("/today");
  await expect(deviceWork).toHaveText(
    "No sets or workout changes from this workout are waiting on this device",
  );
  await expect(page.getByTestId("resume-up-next")).toContainText(
    `${exerciseName} · set 2`,
  );

  // Unreadable or quarantined device evidence is never reported as clear.
  for (const [label, stored] of [
    ["unreadable set queue", "{"],
    [
      "quarantined set copy",
      JSON.stringify({ version: 4, entries: [{ synthetic: "unreadable copy" }] }),
    ],
  ] as const) {
    await page.evaluate(
      ({ storageKey, value }) => localStorage.setItem(storageKey, value),
      { storageKey: SET_OUTBOX_KEY, value: stored },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(deviceWork, label).toHaveAttribute("data-device-work", "unknown");
    await expect(deviceWork, label).toContainText(
      "Repbook can't confirm what's waiting on this device",
    );
    await expect(page.getByTestId("resume-up-next"), label).toHaveCount(0);
    await attach(`today-unknown-${label.replaceAll(" ", "-")}`);
  }
  await page.evaluate(
    (storageKey) => localStorage.removeItem(storageKey),
    SET_OUTBOX_KEY,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(deviceWork).toHaveAttribute("data-device-work", "clear");

  await page.getByText("Resume workout", { exact: true }).click();
  await expect(page).toHaveURL(sessionUrl);
  await discardWorkout(page);
});
