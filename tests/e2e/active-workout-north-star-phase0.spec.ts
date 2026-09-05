import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  expect,
  test,
  type Locator,
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
const PHASE2_QA_DIRECTORY = resolve(
  "docs/assets/active-workout-phase2-qa",
);
const PHASE3_QA_DIRECTORY = resolve(
  "docs/assets/active-workout-phase3-qa",
);
const PHASE4_QA_DIRECTORY = resolve(
  "docs/assets/active-workout-phase4-qa",
);
const PHASE5_QA_DIRECTORY = resolve(
  "docs/assets/active-workout-phase5-qa",
);
const PHASE6_QA_DIRECTORY = resolve(
  "docs/assets/active-workout-phase6-qa",
);
const PHASE6_CONFIGURATION_INCOMPLETE_SCREENSHOT =
  "16-configuration-incomplete-390x844-115";

test.describe.configure({ mode: "serial" });

async function signInAndStartDayA(
  page: Page,
  settings: { includeWarmups?: boolean; expectLogSet?: boolean } = {},
) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  const includeWarmups = settings.includeWarmups ?? true;
  if (includeWarmups) {
    const options = page.locator("summary").filter({ hasText: "Workout options" });
    await options.click();
    await page
      .getByRole("checkbox", { name: /Include programmed warm-ups/ })
      .check();
  }
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);

  if (includeWarmups) {
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
  }
  if (settings.expectLogSet ?? true) {
    await expect(page.getByTestId("active-log-set")).toBeVisible();
  }
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
  if (process.env.UPDATE_ACTIVE_WORKOUT_PHASE2_QA === "1") {
    await mkdir(PHASE2_QA_DIRECTORY, { recursive: true });
    await writeFile(resolve(PHASE2_QA_DIRECTORY, `${name}.jpg`), image);
  }
  if (process.env.UPDATE_ACTIVE_WORKOUT_PHASE3_QA === "1") {
    await mkdir(PHASE3_QA_DIRECTORY, { recursive: true });
    await writeFile(resolve(PHASE3_QA_DIRECTORY, `${name}.jpg`), image);
  }
  if (process.env.UPDATE_ACTIVE_WORKOUT_PHASE4_QA === "1") {
    await mkdir(PHASE4_QA_DIRECTORY, { recursive: true });
    await writeFile(resolve(PHASE4_QA_DIRECTORY, `${name}.jpg`), image);
  }
  if (process.env.UPDATE_ACTIVE_WORKOUT_PHASE5_QA === "1") {
    await mkdir(PHASE5_QA_DIRECTORY, { recursive: true });
    await writeFile(resolve(PHASE5_QA_DIRECTORY, `${name}.jpg`), image);
  }
  if (process.env.UPDATE_ACTIVE_WORKOUT_PHASE6_QA === "1") {
    await mkdir(PHASE6_QA_DIRECTORY, { recursive: true });
    await writeFile(resolve(PHASE6_QA_DIRECTORY, `${name}.jpg`), image);
  }
}

async function waitForRest(page: Page) {
  const rest = page
    .getByRole("complementary", { name: "Workout status" })
    .getByTestId("rest-cockpit");
  await expect(rest).toBeVisible();
  return rest;
}

async function expectRestControlsClear(page: Page) {
  const rest = await waitForRest(page);
  const geometry = await rest.evaluate((element) => {
    const controls = Array.from(element.querySelectorAll("button"));
    return {
      horizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
      controls: controls.map((control) => {
        const bounds = control.getBoundingClientRect();
        return {
          name: control.textContent?.trim() ?? "",
          width: bounds.width,
          height: bounds.height,
        };
      }),
    };
  });
  expect(geometry.horizontalOverflow).toBe(false);
  expect(geometry.controls).toHaveLength(3);
  expect(
    geometry.controls.every(
      (control) => control.width >= 44 && control.height >= 44,
    ),
  ).toBe(true);
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
  const rest = await waitForRest(page);
  await expect(rest.getByRole("status")).toContainText("Rest complete");
}

async function endRest(page: Page) {
  const rest = await waitForRest(page);
  const end = rest.getByRole("button", {
    name: "End rest",
    exact: true,
  });
  if (await end.isVisible()) await end.click();
  await expect(rest).toContainText("Rest ended");
  await expect(rest).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId("active-log-set")).toBeVisible();
}

async function discardWorkout(page: Page) {
  await page
    .getByLabel("Workout status", { exact: true })
    .getByRole("button", {
      name: /^(?:Review and finish workout|Finish workout)$/i,
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
    progressText: cardText.match(/\b\d+ of \d+ sets\b/)?.[0] ?? null,
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

async function expectEssentialCurrentSetControlsClear(page: Page) {
  await settleFocusHandoff(page);
  const geometry = await page.evaluate(() => {
    const status = document.querySelector<HTMLElement>(
      '[aria-label="Workout status"]',
    );
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="current-set-entry"] .active-set-stepper',
      ),
    ];
    const visualTop = window.visualViewport?.offsetTop ?? 0;
    const visualBottom =
      visualTop + (window.visualViewport?.height ?? window.innerHeight);
    const statusTop = status?.getBoundingClientRect().top ?? visualBottom;
    return {
      count: controls.length,
      horizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
      clear: controls.every((control) => {
        const bounds = control.getBoundingClientRect();
        return (
          bounds.width >= 44 &&
          bounds.height >= 44 &&
          bounds.top >= visualTop - 1 &&
          bounds.bottom <= statusTop + 1
        );
      }),
    };
  });
  expect(geometry).toEqual({
    count: 4,
    horizontalOverflow: false,
    clear: true,
  });

  const status = page.getByRole("complementary", {
    name: "Workout status",
  });
  await expect(
    status.getByRole("button", { name: "Log set 2", exact: true }),
  ).toBeVisible();
  await expect(
    status.getByRole("button", { name: "Add training note", exact: true }),
  ).toBeVisible();
  await expect(
    status.getByRole("button", {
      name: "Review and finish workout",
      exact: true,
    }),
  ).toBeVisible();
}

async function expectWorkoutLandmarkClear(landmark: Locator) {
  await expect(landmark).toBeVisible();
  const geometry = await landmark.evaluate((element) => {
    const viewportTop = window.visualViewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop +
      (window.visualViewport?.height ?? window.innerHeight);
    const stickySummary = document.querySelector<HTMLElement>(
      '[data-testid="active-workout-sticky-summary"]',
    );
    const statusBar = document.querySelector<HTMLElement>(
      '[aria-label="Workout status"]',
    );
    const bounds = element.getBoundingClientRect();
    const card = element.closest<HTMLElement>(
      '[data-testid="current-exercise-card"]',
    );
    if (card == null) throw new Error("Current exercise landmark lost its card.");
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      visibleTop: Math.max(
        viewportTop,
        stickySummary?.getBoundingClientRect().bottom ?? viewportTop,
      ),
      visibleBottom: Math.min(
        viewportBottom,
        statusBar?.getBoundingClientRect().top ?? viewportBottom,
      ),
    };
  });
  expect(geometry.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
    geometry.visibleTop - 1,
  );
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.visibleBottom + 1);
}

async function expectCurrentExerciseLandmarkClear(page: Page) {
  await expectWorkoutLandmarkClear(
    page
      .getByTestId("current-exercise-card")
      .getByRole("heading", { level: 2 }),
  );
}

async function expectSavedLedgerEvidenceClear(page: Page) {
  await expectWorkoutLandmarkClear(
    page
      .getByTestId("current-exercise-card")
      .locator('[data-set-row-state="saved"]')
      .first(),
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
  await expectCurrentExerciseLandmarkClear(page);

  await page.getByTestId("active-log-set").click();
  await waitForRest(page);
  await expectRestControlsClear(page);
  await expect(page.getByTestId("active-set-ledger")).toBeVisible();
  await expect(page.getByTestId("current-set-entry")).toBeVisible();
  await expect(
    page.getByTestId("current-set-entry").locator("input").first(),
  ).toBeEnabled();
  await expect(page.getByTestId("active-log-set")).toHaveAccessibleName(
    "Log set 2",
  );
  await expect(
    page
      .getByTestId("active-set-ledger")
      .locator('[data-set-row-state="saved"]'),
  ).toHaveCount(1);
  await expectCurrentExerciseLandmarkClear(page);
  await expectSavedLedgerEvidenceClear(page);
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.restRunning390x844At115,
  );

  await setFontSize(page, "extra-large");
  await expectRestControlsClear(page);
  await expectCurrentExerciseLandmarkClear(page);
  await expectSavedLedgerEvidenceClear(page);
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.restRunning390x844At145,
  );

  await setFontSize(page, "default");
  await completeRestByClock(page);
  await expectCurrentExerciseLandmarkClear(page);
  await expectSavedLedgerEvidenceClear(page);
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.restComplete390x844At115,
  );
  await page.waitForTimeout(3_000);
  await expect(page.getByTestId("rest-cockpit")).toBeVisible();
  await expect(page.getByTestId("rest-cockpit")).toHaveCount(0, {
    timeout: 1_500,
  });
  await expect(page.getByTestId("active-log-set")).toBeVisible();
  await expectCurrentExerciseLandmarkClear(page);
  await expectSavedLedgerEvidenceClear(page);

  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.setEntry390x844At115,
  );

  await setFontSize(page, "extra-large");
  await expectEssentialCurrentSetControlsClear(page);
  await expectCurrentExerciseLandmarkClear(page);
  await expectSavedLedgerEvidenceClear(page);
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.setEntry390x844At145,
  );

  await page.setViewportSize({ width: 320, height: 700 });
  await expectEssentialCurrentSetControlsClear(page);
  await expectCurrentExerciseLandmarkClear(page);
  await expectSavedLedgerEvidenceClear(page);
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
  await signInAndStartDayA(page, {
    includeWarmups: false,
    expectLogSet: false,
  });
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

test("records the Phase 4 equipment-unavailable decision", async ({
  page,
  browserName,
}, testInfo) => {
  expect(process.env.ACTIVE_WORKOUT_PHASE4_EQUIPMENT_CONFLICT_FIXTURE).toBe(
    "1",
  );
  const pageErrors = observeGauntletPageErrors(page, browserName);
  await signInAndStartDayA(page, {
    includeWarmups: false,
    expectLogSet: false,
  });
  const currentExerciseCard = page.getByTestId("current-exercise-card");
  const affectedExerciseCardId = await currentExerciseCard.getAttribute("id");
  expect(affectedExerciseCardId).not.toBeNull();
  const affectedExerciseCard = page.locator(
    `[id="${affectedExerciseCardId!}"]`,
  );
  const equipmentDecision = affectedExerciseCard.getByRole("region", {
    name: "Equipment unavailable for Barbell Back Squat",
  });
  await expect(equipmentDecision).toBeVisible();
  await expect(equipmentDecision).toContainText(
    "Equipment unavailable for Barbell Back Squat",
  );
  await expect(
    equipmentDecision.getByRole("button", {
      name: "Replace for today",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    equipmentDecision.getByRole("button", {
      name: "Skip exercise",
      exact: true,
    }),
  ).toBeVisible();
  await expect(equipmentDecision).not.toContainText("Log it anyway");
  await expect(page.getByTestId("active-log-set")).toHaveCount(0);
  await expect(page.getByTestId("inline-log-set")).toHaveCount(0);
  await expect(page.getByText(
    "Resolve the equipment setup before logging this set.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByTestId("active-workout-dock-primary")).toContainText(
    "Replace for today",
  );
  await expectCurrentExerciseLandmarkClear(page);
  await expectWorkoutLandmarkClear(
    equipmentDecision.getByRole("heading", { level: 3 }),
  );
  await captureCurrentBaseline(
    page,
    testInfo,
    ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.equipmentDecision390x844At115,
  );

  const replace = page.getByTestId("active-workout-dock-primary");
  await waitForHydratedReactHandler(replace);
  await replace.click();
  await expect(
    page.getByRole("heading", { name: "Replace for today", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(
    "Reason: Equipment unavailable or incompatible",
    { exact: true },
  )).toBeVisible();
  await page
    .getByRole("button", { name: "Search exercise catalog", exact: true })
    .click();
  const replacementPicker = page.getByRole("dialog", {
    name: "Replace exercise",
  });
  await expect(
    replacementPicker.getByRole("button", {
      name: "View details for Plate-Loaded Lat Pulldown",
    }),
  ).toHaveCount(0);
  await replacementPicker
    .getByRole("button", { name: "All exercises", exact: true })
    .click();
  await replacementPicker
    .getByRole("textbox", { name: "Search exercise library" })
    .fill("Lat Pulldown");
  const resultList = replacementPicker.getByRole("list", {
    name: "Exercise results",
  });
  const familyToggle = resultList.locator(
    ':scope > [role="listitem"] > button[aria-controls]',
  ).filter({ hasText: "Lat Pulldown" });
  await expect(familyToggle).toBeVisible();
  const nestedVariants = replacementPicker.getByRole("list", {
    name: "Lat Pulldown variants",
  });
  await expect(nestedVariants).toBeVisible();
  const familyBox = await familyToggle.boundingBox();
  const nestedBox = await nestedVariants.boundingBox();
  expect(familyBox).not.toBeNull();
  expect(nestedBox).not.toBeNull();
  expect(nestedBox!.x).toBeGreaterThan(familyBox!.x);
  const plateLoadedTarget = replacementPicker.getByRole("button", {
    name: "View details for Plate-Loaded Lat Pulldown",
  });
  await expect(plateLoadedTarget).toContainText(
    "Needs a compatible plate-loaded machine with confirmed geometry.",
  );
  await plateLoadedTarget.click();
  await expect(
    replacementPicker.getByRole("button", {
      name: "Replace in this workout",
      exact: true,
    }),
  ).toBeDisabled();
  await replacementPicker
    .getByRole("button", { name: "Back to results", exact: true })
    .click();
  await replacementPicker
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.keyboard.press("Escape");

  const futureProgramLink = equipmentDecision.getByRole("link", {
    name: "Change future Program…",
    exact: true,
  });
  await expect(futureProgramLink).toBeVisible();
  const futureProgramHref = await futureProgramLink.getAttribute("href");
  expect(futureProgramHref).toMatch(/^\/program\/edit\?intent=replace&/);
  const futureProgramPage = await page.context().newPage();
  await futureProgramPage.goto(futureProgramHref!);
  await expect(futureProgramPage.getByText(
    "Choose the future replacement",
    { exact: true },
  )).toBeVisible();
  const futureReplacementPicker = futureProgramPage.getByRole("dialog", {
    name: "Replace Barbell Back Squat in future workouts",
  });
  await expect(futureReplacementPicker).toBeVisible();
  await futureReplacementPicker
    .getByRole("textbox", { name: "Search exercise library" })
    .fill("Bodyweight Squat");
  await futureReplacementPicker
    .getByRole("button", { name: "View details for Bodyweight Squat" })
    .click();
  await futureReplacementPicker
    .getByRole("button", { name: "Stage future replacement", exact: true })
    .click();
  await expect(futureProgramPage).not.toHaveURL(/intent=replace/);
  await expect(futureProgramPage.getByRole("status")).toContainText(
    "All changes saved",
  );
  await futureProgramPage.close();

  const skip = equipmentDecision.getByRole("button", {
    name: "Skip exercise",
    exact: true,
  });
  await waitForHydratedReactHandler(skip);
  await skip.click();
  await expect(
    page.getByRole("heading", { name: "Skip Barbell Back Squat?", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(
    "Repbook already knows the reason: equipment unavailable or incompatible. This skips the exercise for today; your saved Program remains unchanged.",
    { exact: true },
  )).toBeVisible();
  await page.getByRole("button", { name: "Confirm skip", exact: true }).click();
  await expect(affectedExerciseCard).toContainText(
    "Skipped (equipment unavailable or incompatible)",
  );
  await expect(
    affectedExerciseCard.getByRole("region", {
      name: "Equipment unavailable for Barbell Back Squat",
    }),
  ).toHaveCount(0);
  await affectedExerciseCard
    .getByRole("button", { name: "Keep skipped and continue", exact: true })
    .click();
  await expect(affectedExerciseCard).toContainText(
    "Skipped (equipment unavailable or incompatible)",
  );
  await expect(affectedExerciseCard).not.toContainText(
    "Equipment unavailable for Barbell Back Squat",
  );
  await pageErrors.expectNoUnexpected();
  await discardWorkout(page);
});

test("records the Phase 6 configuration-incomplete decision", async ({
  page,
  browserName,
}, testInfo) => {
  expect(process.env.ACTIVE_WORKOUT_PHASE6_CONFIGURATION_INCOMPLETE_FIXTURE).toBe(
    "1",
  );
  const pageErrors = observeGauntletPageErrors(page, browserName);
  await signInAndStartDayA(page, {
    includeWarmups: false,
    expectLogSet: false,
  });

  const currentExerciseCard = page.getByTestId("current-exercise-card");
  await expect(
    currentExerciseCard.getByRole("heading", {
      level: 2,
      name: "Plate-Loaded Lat Pulldown",
      exact: true,
    }),
  ).toBeVisible();
  const equipmentDecision = currentExerciseCard.getByRole("region", {
    name: "Equipment setup incomplete for Plate-Loaded Lat Pulldown",
  });
  await expect(equipmentDecision).toBeVisible();
  await expect(equipmentDecision).toContainText(
    "Plate-loaded lat pulldown: loading points, balancing rule, load-entry meaning",
  );
  const completeSetup = equipmentDecision.getByRole("link", {
    name: "Complete equipment setup",
    exact: true,
  });
  const sessionPath = new URL(page.url()).pathname;
  const equipmentUrl = new URL((await completeSetup.getAttribute("href"))!, page.url());
  expect(equipmentUrl.pathname).toBe("/settings/equipment");
  expect(equipmentUrl.searchParams.getAll("item")).toHaveLength(1);
  expect(equipmentUrl.searchParams.get("item")).toMatch(/^[0-9a-f-]{36}$/);
  expect(equipmentUrl.searchParams.get("returnTo")).toBe(sessionPath);
  await expect(
    equipmentDecision.getByRole("button", {
      name: "Replace for today",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    equipmentDecision.getByRole("button", {
      name: "Skip exercise",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByTestId("active-log-set")).toHaveCount(0);
  await expect(page.getByTestId("inline-log-set")).toHaveCount(0);
  const dockPrimary = page.getByTestId("active-workout-dock-primary");
  await expect(dockPrimary).toContainText("Complete equipment setup");
  await expectCurrentExerciseLandmarkClear(page);
  await expectWorkoutLandmarkClear(
    equipmentDecision.getByRole("heading", { level: 3 }),
  );
  await captureCurrentBaseline(
    page,
    testInfo,
    PHASE6_CONFIGURATION_INCOMPLETE_SCREENSHOT,
  );

  await page.getByRole("button", {
    name: "Review and finish workout", exact: true,
  }).click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  const reason = finish.getByLabel("Why are you finishing this workout early?");
  await expect(reason.locator('option[value="equipment_unavailable_incompatible"]'))
    .toHaveCount(0);
  await reason.selectOption("time_limit_reached");
  await expect(finish.getByRole("button", { name: "Save workout", exact: true }))
    .toBeEnabled();
  await finish.getByRole("button", { name: "Back to workout", exact: true }).click();

  await waitForHydratedReactHandler(dockPrimary);
  await dockPrimary.click();
  await expect(completeSetup).toBeFocused();
  await completeSetup.click();
  await expect(page).toHaveURL(equipmentUrl.href);
  const equipmentDrawer = page.getByRole("dialog", {
    name: "Plate-loaded lat pulldown", exact: true,
  });
  await expect(equipmentDrawer).toBeVisible();
  await equipmentDrawer.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Continue without changes", exact: true }).click();
  await expect(page).toHaveURL(new URL(sessionPath, equipmentUrl).href);
  await expect(completeSetup).toBeVisible();
  await pageErrors.expectNoUnexpected();
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

  await endRest(page);
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
    progressText: "1 of 3 sets",
  });

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

  await discardWorkout(page);
});
