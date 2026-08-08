import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  BA_WORKOUT_EMAIL,
  BA_WORKOUT_FIXTURE,
} from "../fixtures/ba-workout-contract";
import { PRODUCTION_WORKOUT_START_WARMUP } from "../fixtures/production-workout-start-contract";
import {
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

async function signInAndStart(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForHydratedReactHandler(extraLarge);
  if (!(await extraLarge.isChecked())) await extraLarge.click();
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe("extra-large");

  await page.goto("/today");
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
}

function exerciseCard(page: Page, name: string) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { level: 2, name, exact: true }),
  }).first();
}

async function expectReachableTarget(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      height: rect.height,
      width: rect.width,
      hit: hit === element || (hit != null && element.contains(hit)),
    };
  });
  expect(result).toMatchObject({ hit: true });
  expect(result.height).toBeGreaterThanOrEqual(44);
  expect(result.width).toBeGreaterThanOrEqual(44);
}

async function expectActiveViewportBudget(page: Page) {
  const budget = await page.evaluate(() => {
    const guidance = document.querySelector<HTMLElement>(
      'section[aria-label="Workout progress and upcoming work"]',
    );
    const dock = document.querySelector<HTMLElement>("#workout-rest-status");
    if (!guidance || !dock) throw new Error("Active workout boundaries are missing.");
    const guidanceRect = guidance.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const navigation = document.querySelector<HTMLElement>(
      'nav[aria-label="Primary navigation"]',
    );
    const navigationRect = navigation?.getBoundingClientRect() ?? null;
    const intrusions = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) =>
        element !== dock &&
        element !== navigation &&
        !element.contains(guidance) &&
        !dock.contains(element) &&
        !(navigation?.contains(element) ?? false)
      )
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.position !== "fixed" && style.position !== "sticky") return false;
        const rect = element.getBoundingClientRect();
        return rect.width >= window.innerWidth * 0.7 &&
          rect.bottom > guidanceRect.bottom + 1 &&
          rect.top < dockRect.top - 1;
      })
      .map((element) => element.id || element.getAttribute("aria-label") || element.tagName);
    return {
      usableHeight: Math.max(0, dockRect.top - guidanceRect.bottom),
      dockClearsNavigation:
        navigationRect == null || navigationRect.height === 0 ||
        dockRect.bottom <= navigationRect.top + 1,
      intrusions,
      horizontalOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  });
  expect(budget.usableHeight).toBeGreaterThanOrEqual(280);
  expect(budget.dockClearsNavigation).toBe(true);
  expect(budget.intrusions).toEqual([]);
  expect(budget.horizontalOverflow).toBeLessThanOrEqual(1);
}

async function dismissRest(page: Page) {
  const status = page.getByRole("complementary", { name: "Workout status" });
  const skip = status.getByRole("button", { name: "Skip rest", exact: true });
  await expect(skip).toBeVisible();
  await expectActiveViewportBudget(page);
  await skip.click();
  const dismiss = status.getByRole("button", {
    name: "Dismiss rest timer",
    exact: true,
  });
  await expect(dismiss).toBeVisible();
  await expectActiveViewportBudget(page);
  await dismiss.click();
  await expect(dismiss).toHaveCount(0);
}

async function skipForEquipment(card: Locator, page: Page) {
  await card.getByRole("button", { name: "Skip exercise", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Skip exercise — why?" });
  await dialog.getByRole("button", { name: "equipment", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("Exercise skipped");
}

test("keeps the full live workout usable through warm-up, skip, replace, continue, and finish", async ({
  browserName,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName);
  await signInAndStart(page);

  const warmup = page.locator("#workout-warmup");
  await expect(warmup).toContainText("Check off only the distinct actions below.");
  await expect(page.getByText(
    BA_WORKOUT_FIXTURE.program.days[0].warmupNotes,
    { exact: true },
  )).not.toBeVisible();
  expect(await warmup.evaluate((element) => getComputedStyle(element).position))
    .not.toMatch(/fixed|sticky/);
  await expectActiveViewportBudget(page);

  for (const [index, action] of PRODUCTION_WORKOUT_START_WARMUP.entries()) {
    const checkbox = warmup.getByRole("checkbox", {
      name: `Mark ${action.label} complete`,
      exact: true,
    });
    await expectReachableTarget(checkbox);
    await checkbox.click();
    const completedLastAction =
      index === PRODUCTION_WORKOUT_START_WARMUP.length - 1;
    if (completedLastAction) {
      await expect(warmup).not.toHaveAttribute("open", "");
      await warmup.locator(":scope > summary").click();
    }
    await expect(
      warmup.getByRole("checkbox", {
        name: `${action.label} complete`,
        exact: true,
      }),
    ).toHaveAttribute("aria-checked", "true");
    if (completedLastAction) await warmup.locator(":scope > summary").click();
  }
  await expect(warmup).not.toHaveAttribute("open", "");

  for (let setNo = 1; setNo <= 3; setNo += 1) {
    const current = page.getByTestId("current-exercise-card");
    const currentSet = current.getByTestId("current-set-entry");
    await expect(currentSet).toContainText(`Set ${setNo} of 3`);
    const log = currentSet.getByRole("button", { name: "Log set", exact: true });
    await expectReachableTarget(log);
    await log.click();
    await expect(current.getByTestId("active-set-save-receipt"))
      .toContainText(`Saved · Set ${setNo}`);
    await dismissRest(page);
    await expectActiveViewportBudget(page);
  }

  expect(
    BA_WORKOUT_FIXTURE.equipment.items
      .map((item) => String(item.type))
      .includes("suspension"),
  ).toBe(false);
  let incompatible = exerciseCard(page, "Suspension Push-Up");
  if (
    (await incompatible.locator(":scope > button").getAttribute("aria-expanded")) !==
    "true"
  ) {
    await incompatible.locator(":scope > button").click();
  }
  await skipForEquipment(incompatible, page);
  const replace = incompatible.getByRole("button", {
    name: "Replace exercise",
    exact: true,
  });
  const continueWithout = incompatible.getByRole("button", {
    name: "Continue without replacement",
    exact: true,
  });
  await expectReachableTarget(replace);
  await expectReachableTarget(continueWithout);
  await expectActiveViewportBudget(page);

  await continueWithout.click();
  await expect(
    exerciseCard(page, "Dumbbell Lateral Raise").locator(":scope > button"),
  ).toHaveAttribute("aria-expanded", "true");
  await expectActiveViewportBudget(page);

  incompatible = exerciseCard(page, "Suspension Push-Up");
  await incompatible.locator(":scope > button").click();
  await incompatible.getByRole("button", { name: "Un-skip", exact: true }).click();
  await expect(
    incompatible.getByRole("button", { name: "Skip exercise", exact: true }),
  ).toBeVisible();
  await skipForEquipment(incompatible, page);
  await incompatible
    .getByRole("button", { name: "Replace exercise", exact: true })
    .click();
  const replacementDrawer = page.getByRole("dialog", {
    name: "Replace exercise for this workout",
  });
  await replacementDrawer
    .getByRole("button", { name: "Equipment busy", exact: true })
    .click();
  await replacementDrawer
    .getByRole("button", { name: "Search exercise catalog", exact: true })
    .click();
  const picker = page.getByRole("dialog", { name: "Replace exercise", exact: true });
  await picker.getByLabel("Search exercise library").fill("Push-Up");
  await picker
    .getByRole("button", { name: "View details for Push-Up", exact: true })
    .click();
  await picker
    .getByRole("button", { name: "Replace in this workout", exact: true })
    .click();

  const replacement = exerciseCard(page, "Push-Up");
  await expect(replacement).toContainText("instead of Suspension Push-Up");
  await expect(replacement).not.toContainText("Exercise skipped");
  await expectActiveViewportBudget(page);

  const replacementSet = replacement.getByTestId("current-set-entry");
  await expect(replacementSet).toContainText("Push-Up · Set 1 of 3");
  const logReplacement = replacementSet.getByRole("button", {
    name: "Log set",
    exact: true,
  });
  await expectReachableTarget(logReplacement);
  await logReplacement.click();
  await expect(replacement.getByTestId("active-set-save-receipt"))
    .toContainText("Saved · Set 1");
  await expect(
    page.getByRole("complementary", { name: "Workout status" })
      .getByRole("button", { name: "Skip rest", exact: true }),
  ).toBeVisible();
  await expectActiveViewportBudget(page);

  const finish = page.getByRole("button", { name: "Finish", exact: true });
  await expectReachableTarget(finish);
  await finish.click();
  const finishDialog = page.getByRole("dialog", { name: "Finish workout" });
  const save = finishDialog.getByRole("button", {
    name: "Save workout",
    exact: true,
  });
  await expectReachableTarget(save);
  await save.click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await pageErrors.expectNoUnexpected();
});
