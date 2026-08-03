import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

async function signInAndStartDayA(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForHydratedReactHandler(extraLarge);
  await extraLarge.click();
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe("extra-large");

  await page.goto("/today");
  const alternateDays = page.getByTestId("alternate-program-days");
  await alternateDays.locator("summary").click();
  await alternateDays.getByRole("button", { name: /Day A — Squat/ }).click();
  const start = page.getByRole("button", { name: "Start workout", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
}

async function expectReachableTarget(locator: Locator) {
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
  });
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit === element || (hit != null && element.contains(hit));
  })).toBe(true);
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, width: rect.width };
  });
  expect(result.height).toBeGreaterThanOrEqual(44);
  expect(result.width).toBeGreaterThanOrEqual(44);
}

async function discardWorkout(page: Page) {
  if (!/\/session\/[0-9a-f-]+(?:#.*)?$/.test(page.url())) return;
  const finish = page.getByRole("button", { name: "Finish", exact: true });
  await waitForHydratedReactHandler(finish);
  await finish.click();
  const finishDialog = page.getByRole("dialog", { name: "Finish workout" });
  const discard = finishDialog.getByRole("button", {
    name: "Discard workout",
    exact: true,
  });
  await waitForHydratedReactHandler(discard);
  await discard.click();
  const confirm = page
    .getByRole("dialog", { name: /^Discard .+\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true });
  await waitForHydratedReactHandler(confirm);
  await confirm.click();
  await expect(page).toHaveURL(/\/today$/);
}

test("keeps the ordinary active set current-first, unobstructed, and acknowledgement-truthful", async ({
  page,
}) => {
  try {
    await signInAndStartDayA(page);

    const currentCard = page.getByTestId("current-exercise-card");
    const currentEntry = currentCard.getByTestId("current-set-entry");
    await expect(currentEntry).toBeVisible();
    await expect(currentEntry).toContainText("Current action");
    await expect(currentEntry).toContainText(
      "Barbell Back Squat · Set 1 of 3",
    );
    await expect(currentEntry).toContainText("Performed measure");
    await expect(currentEntry).toContainText("Next action");
    await expect(currentEntry).toContainText("Barbell Back Squat, set 2");

    const optionalDetails = currentEntry.locator("details", {
      hasText: "Optional effort and set note",
    });
    const exceptionDetails = currentEntry.locator("details", {
      hasText: "Set exceptions",
    });
    await expect(optionalDetails).not.toHaveAttribute("open", "");
    await expect(exceptionDetails).not.toHaveAttribute("open", "");
    await expect(
      currentEntry.getByRole("button", { name: "Log set", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("region", { name: "Workout progress and upcoming work" }),
    ).not.toContainText("Next:");

    const orderedVisibleActions = [
      currentEntry.getByText("Current action", { exact: true }),
      currentEntry.getByText("Performed measure", { exact: true }),
      currentEntry.getByRole("button", { name: "Log set", exact: true }),
      currentEntry.getByText("Next action", { exact: true }),
      exceptionDetails.locator(":scope > summary"),
    ];
    for (const action of orderedVisibleActions) await expect(action).toBeVisible();
    const actionBounds = await Promise.all(
      orderedVisibleActions.map((action) => action.boundingBox()),
    );
    expect(actionBounds.every((bounds) => bounds !== null)).toBe(true);
    for (let index = 1; index < actionBounds.length; index += 1) {
      expect(actionBounds[index]!.y).toBeGreaterThan(actionBounds[index - 1]!.y);
    }

    const primaryTargets = [
      currentEntry.getByLabel("Total load", { exact: true }),
      currentEntry.getByRole("textbox", { name: "Reps", exact: true }),
      currentEntry.getByRole("button", { name: "Log set", exact: true }),
      optionalDetails.locator("summary"),
      exceptionDetails.locator("summary"),
    ];
    for (const target of primaryTargets) await expectReachableTarget(target);

    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    const logSet = currentEntry.getByRole("button", {
      name: "Log set",
      exact: true,
    });
    await logSet.click();
    await expect(currentCard.getByText("Saved", { exact: true })).toBeVisible();
    await expect(
      currentCard.getByText("Acknowledged by Repbook", { exact: true }),
    ).toBeVisible();
    const workoutStatus = page.getByRole("complementary", {
      name: "Workout status",
    });
    await workoutStatus
      .getByRole("button", { name: "Skip rest", exact: true })
      .click();
    await workoutStatus
      .getByRole("button", { name: "Dismiss rest timer", exact: true })
      .click();
    const receipt = currentCard.getByTestId("active-set-save-receipt");
    await expect(receipt).toContainText("Saved · Set 1");
    await expect(receipt).toContainText("Acknowledged by Repbook");
    await expect(receipt).toBeVisible();
    const receiptBounds = await receipt.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
    });
    expect(receiptBounds.top).toBeGreaterThanOrEqual(0);
    expect(receiptBounds.bottom).toBeLessThanOrEqual(receiptBounds.viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  } finally {
    await discardWorkout(page);
  }
});
