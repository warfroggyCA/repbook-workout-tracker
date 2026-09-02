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
import { PRODUCTION_WORKOUT_START_WARMUP } from "../fixtures/production-workout-start-contract";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

const REST_TIMER_STORAGE_KEY = "workout-tracker:rest-timer:v1";
const REST_TIMER_CHANGE_EVENT = "workout-rest-timer-change";
const FONT_SIZE_STORAGE_KEY = "workout-font-size";
const FONT_SIZE_EVENT = "workout-font-size-change";
const BASELINE_DIRECTORY = resolve(
  "docs/assets/active-workout-phase0-baseline",
);

test.describe.configure({ mode: "serial" });

async function signInAndStartDayA(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  const options = page.locator("summary").filter({ hasText: "Workout options" });
  await options.click();
  await page
    .getByRole("checkbox", { name: /Include programmed warm-ups/ })
    .check();
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);

  for (
    let index = 0;
    index < PRODUCTION_WORKOUT_START_WARMUP.length;
    index += 1
  ) {
    const warmup = index === 0
      ? page.locator(
          '#workout-warmup [role="checkbox"][aria-checked="false"]:visible',
        ).first()
      : page.getByTestId("active-workout-dock-primary");
    await expect.poll(() => warmup.getAttribute("aria-label")).toContain(
      PRODUCTION_WORKOUT_START_WARMUP[index].label,
    );
    await waitForHydratedReactHandler(warmup);
    await warmup.click();
  }
  await expect(page.getByTestId("active-log-set")).toBeVisible();
}

async function setFontSize(page: Page, size: "default" | "extra-large") {
  await page.evaluate(
    ({ nextSize, storageKey, eventName }) => {
      document.documentElement.dataset.fontSize = nextSize;
      localStorage.setItem(storageKey, nextSize);
      window.dispatchEvent(new Event(eventName));
    },
    { nextSize: size, storageKey: FONT_SIZE_STORAGE_KEY, eventName: FONT_SIZE_EVENT },
  );
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe(size);
}

async function captureCurrentBaseline(
  page: Page,
  testInfo: TestInfo,
  name: string,
) {
  await page.evaluate(() =>
    new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
    ),
  );
  const image = await page.screenshot({
    type: "jpeg",
    quality: 84,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach(`baseline-current-${name}`, {
    body: image,
    contentType: "image/jpeg",
  });
  if (process.env.UPDATE_ACTIVE_WORKOUT_PHASE0_BASELINE === "1") {
    await mkdir(BASELINE_DIRECTORY, { recursive: true });
    await writeFile(resolve(BASELINE_DIRECTORY, `${name}.jpg`), image);
  }
}

async function waitForRest(page: Page) {
  const rest = page
    .getByRole("complementary", { name: "Workout status" })
    .getByTestId("rest-cockpit");
  await expect(rest).toBeVisible();
  return rest;
}

async function completeRestByClock(page: Page) {
  const adjusted = await page.evaluate(
    ({ storageKey, eventName }) => {
      const raw = localStorage.getItem(storageKey);
      if (raw == null) return false;
      const timer = JSON.parse(raw) as {
        revision: number;
        startedAt: number;
        endsAt: number;
        totalSec: number;
      };
      const endsAt = Date.now() - 1;
      timer.revision += 1;
      timer.endsAt = endsAt;
      timer.startedAt = endsAt - timer.totalSec * 1_000;
      localStorage.setItem(storageKey, JSON.stringify(timer));
      window.dispatchEvent(new Event(eventName));
      return true;
    },
    { storageKey: REST_TIMER_STORAGE_KEY, eventName: REST_TIMER_CHANGE_EVENT },
  );
  expect(adjusted).toBe(true);
  await expect(
    page.getByRole("button", { name: "Dismiss rest timer", exact: true }),
  ).toBeVisible();
}

async function dismissRest(page: Page) {
  const rest = await waitForRest(page);
  const skip = rest.getByRole("button", { name: "Skip rest", exact: true });
  if (await skip.isVisible()) await skip.click();
  const dismiss = rest.getByRole("button", {
    name: "Dismiss rest timer",
    exact: true,
  });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
  await expect(rest).toHaveCount(0);
  await expect(page.getByTestId("active-log-set")).toBeVisible();
}

async function discardWorkout(page: Page) {
  await page
    .getByRole("button", { name: /^(?:Finish early|Finish workout)$/i })
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

async function currentMeasureValues(page: Page) {
  return page.getByTestId("active-workout-primary").locator("input").evaluateAll(
    (inputs) =>
      Object.fromEntries(
        inputs.map((input) => [
          input.getAttribute("aria-label") ?? input.id,
          (input as HTMLInputElement).value,
        ]),
      ),
  );
}

async function currentActionSnapshot(page: Page) {
  const card = page.getByTestId("current-exercise-card");
  const cardCount = await card.count();
  if (cardCount !== 1) {
    return {
      cardCount,
      draftIdentity: null,
      primaryLabel: null,
      progressText: null,
    };
  }
  const cardText = await card.innerText();
  const primary = page.getByTestId("active-workout-primary");
  return {
    cardCount,
    draftIdentity: await card.getAttribute("data-draft-identity"),
    primaryLabel:
      (await primary.count()) === 1
        ? await primary.getAttribute("aria-label")
        : null,
    progressText: cardText.match(/\b\d+\/\d+ done\b/)?.[0] ?? null,
  };
}

async function activeElementName(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement
      ? active.getAttribute("aria-label") ?? active.textContent?.trim() ?? ""
      : "";
  });
}

async function settleFocusHandoff(page: Page) {
  await page.evaluate(() =>
    new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
    ),
  );
}

async function restDeadline(page: Page) {
  return page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return null;
    const timer = JSON.parse(raw) as { endsAt?: unknown };
    return typeof timer.endsAt === "number" ? timer.endsAt : null;
  }, REST_TIMER_STORAGE_KEY);
}

test("records the six common-path current baselines without treating them as targets", async ({
  page,
  browserName,
}, testInfo) => {
  const pageErrors = observeGauntletPageErrors(page, browserName);
  await signInAndStartDayA(page);
  await setFontSize(page, "default");

  await page.getByTestId("active-log-set").click();
  await waitForRest(page);
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.restRunning390x844At115,
  );

  await setFontSize(page, "extra-large");
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.restRunning390x844At145,
  );

  await setFontSize(page, "default");
  await completeRestByClock(page);
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.restComplete390x844At115,
  );
  await page
    .getByRole("button", { name: "Dismiss rest timer", exact: true })
    .click();
  await expect(page.getByTestId("active-log-set")).toBeVisible();

  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.setEntry390x844At115,
  );

  await setFontSize(page, "extra-large");
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.setEntry390x844At145,
  );

  await page.setViewportSize({ width: 320, height: 700 });
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.setEntry320x700At145,
  );

  await pageErrors.expectNoUnexpected();
  await discardWorkout(page);
});

test("records the isolated equipment-decision baseline", async ({
  page,
  browserName,
}, testInfo) => {
  const pageErrors = observeGauntletPageErrors(page, browserName);
  await signInAndStartDayA(page);
  const equipmentDecision = page.getByRole("region", {
    name: "Equipment setup for Barbell Back Squat",
  });
  await expect(equipmentDecision).toBeVisible();
  await expect(equipmentDecision).toContainText(
    "Choose the physical equipment before logging this exercise.",
  );
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.equipmentDecision390x844At115,
  );
  await pageErrors.expectNoUnexpected();
  await discardWorkout(page);
});

test("a stray Enter after Log set cannot change rest or the next set", async ({
  page,
}, testInfo) => {
  await signInAndStartDayA(page);

  const logSet = page.getByTestId("active-log-set");
  await logSet.focus();
  await page.keyboard.press("Enter");
  await waitForRest(page);
  await settleFocusHandoff(page);
  const postLogFocus = await activeElementName(page);
  const restBefore = await restDeadline(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const restAfter = await restDeadline(page);

  await dismissRest(page);
  await settleFocusHandoff(page);
  const postDismissFocus = await activeElementName(page);
  const measuresBefore = await currentMeasureValues(page);
  const currentActionBefore = await currentActionSnapshot(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const measuresAfter = await currentMeasureValues(page);
  const currentActionAfter = await currentActionSnapshot(page);
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.keyboard390x844At115,
  );

  const observations = {
    postLogFocus,
    postLogFocusSafe: !/^(?:Decrease|Increase) /.test(postLogFocus),
    restDeadlineDeltaMs:
      restBefore == null || restAfter == null ? null : restAfter - restBefore,
    postDismissFocus,
    postDismissFocusSafe: !/^(?:Decrease|Increase) /.test(postDismissFocus),
    measuresBefore,
    measuresAfter,
    measureValuesUnchanged:
      JSON.stringify(measuresAfter) === JSON.stringify(measuresBefore),
    currentActionBefore,
    currentActionAfter,
    currentActionUnchanged:
      JSON.stringify(currentActionAfter) ===
      JSON.stringify(currentActionBefore),
  };
  await testInfo.attach("known-phase0-keyboard-observation", {
    body: Buffer.from(JSON.stringify(observations, null, 2)),
    contentType: "application/json",
  });

  expect(postLogFocus).not.toBe("");
  expect(postDismissFocus).not.toBe("");
  expect(restBefore).not.toBeNull();
  expect(restAfter).not.toBeNull();
  expect(Object.keys(measuresBefore).length).toBeGreaterThan(0);
  expect(Object.keys(measuresAfter).sort()).toEqual(
    Object.keys(measuresBefore).sort(),
  );
  expect(currentActionBefore).toMatchObject({
    cardCount: 1,
    draftIdentity: expect.stringMatching(/\S/),
    primaryLabel: "Barbell Back Squat, Set 2",
    progressText: "1/3 done",
  });

  test.fail(true, "Known Phase 0 focus handoff lands on decrement controls");
  expect(observations).toEqual({
    postLogFocus: expect.any(String),
    postLogFocusSafe: true,
    restDeadlineDeltaMs: 0,
    postDismissFocus: expect.any(String),
    postDismissFocusSafe: true,
    measuresBefore: expect.any(Object),
    measuresAfter: measuresBefore,
    measureValuesUnchanged: true,
    currentActionBefore: expect.any(Object),
    currentActionAfter: currentActionBefore,
    currentActionUnchanged: true,
  });
});
