import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

async function signInAndStartDayA(
  page: Page,
  options: { extraLarge?: boolean } = {},
) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  await page.goto("/settings");
  const fontSize = options.extraLarge === false
    ? page.getByRole("radio", { name: /^Default/ })
    : page.getByRole("radio", { name: /Extra large/ });
  await waitForHydratedReactHandler(fontSize);
  await fontSize.click();
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe(options.extraLarge === false ? "default" : "extra-large");

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

async function expectFullyInViewport(locator: Locator) {
  await expect.poll(() => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })).toBe(true);
}

async function revealCurrentFromStatusBar(page: Page) {
  const workoutStatus = page.getByRole("complementary", {
    name: "Workout status",
  });
  const reveal = workoutStatus.locator("button").first();
  await waitForHydratedReactHandler(reveal);
  await expectReachableTarget(reveal);
  await reveal.click();
  await expect.poll(() => page.evaluate(() => {
    const log = document.querySelector<HTMLElement>(
      '[data-testid="active-log-set"]',
    );
    const dock = document.querySelector<HTMLElement>(
      '[aria-label="Workout status"]',
    );
    if (!log || !dock) return false;
    return log.getBoundingClientRect().bottom <=
      dock.getBoundingClientRect().top - 8;
  })).toBe(true);
}

async function compactGeometry(page: Page) {
  return page.evaluate(() => {
    const primaryElement = document.querySelector<HTMLElement>(
      '[data-testid="active-workout-primary"]',
    );
    const previousElement = document.querySelector<HTMLElement>(
      '[data-testid="previous-comparable-set"]',
    );
    const logElement = document.querySelector<HTMLElement>(
      '[data-testid="active-log-set"]',
    );
    const dockElement = document.querySelector<HTMLElement>(
      '[aria-label="Workout status"]',
    );
    const cardElement = document.querySelector<HTMLElement>(
      '[data-testid="current-exercise-card"]',
    );
    if (!primaryElement || !previousElement || !logElement || !dockElement || !cardElement) {
      throw new Error("The compact active-workout geometry is incomplete.");
    }
    const primaryRect = primaryElement.getBoundingClientRect();
    const previousRect = previousElement.getBoundingClientRect();
    const firstInput = primaryElement.querySelector<HTMLElement>("input");
    const inputWidths = [...primaryElement.querySelectorAll<HTMLElement>("input")]
      .map((input) => input.getBoundingClientRect().width);
    const logRect = logElement.getBoundingClientRect();
    return {
      primaryHeight: primaryRect.height,
      cardHeight: cardElement.getBoundingClientRect().height,
      previousBeforeInput:
        firstInput != null && previousRect.bottom <= firstInput.getBoundingClientRect().top,
      inputBeforeLog:
        firstInput != null && firstInput.getBoundingClientRect().bottom <= logRect.top,
      logClearsDock: logRect.bottom <= dockElement.getBoundingClientRect().top - 8,
      logBottom: logRect.bottom,
      dockTop: dockElement.getBoundingClientRect().top,
      primaryTop: primaryRect.top,
      primaryBottom: primaryRect.bottom,
      minimumInputWidth:
        inputWidths.length > 0 ? Math.min(...inputWidths) : 0,
      horizontalOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      cardChildren: [...cardElement.children].map((child) => ({
        tag: child.tagName,
        height: child.getBoundingClientRect().height,
      })),
      disclosures: [...cardElement.querySelectorAll("details")].map(
        (details) => ({
          summary: details.querySelector("summary")?.textContent?.trim() ?? "",
          open: details.open,
          height: details.getBoundingClientRect().height,
        }),
      ),
    };
  });
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
  browserName,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName);
  try {
    await signInAndStartDayA(page);

    const currentCard = page.getByTestId("current-exercise-card");
    const currentEntry = currentCard.getByTestId("current-set-entry");
    await expect(currentEntry).toBeVisible();
    await expect(currentEntry).toContainText("Current action");
    await expect(currentEntry).toContainText("Set 1 of 3");
    await expect(currentEntry).toContainText("Performed measure");
    await expect(currentEntry).toContainText("Next action");
    await expect(currentEntry).toContainText("Barbell Back Squat, set 2");

    const setOptions = currentEntry.locator("details", {
      hasText: "Set options",
    });
    await expect(setOptions).not.toHaveAttribute("open", "");
    await expect(
      currentEntry.getByRole("button", { name: "Log set", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("region", { name: "Workout progress and upcoming work" }),
    ).not.toContainText("Next:");

    const orderedVisibleActions = [
      currentEntry.getByText("Current action", { exact: true }),
      currentEntry.getByTestId("previous-comparable-set"),
      currentEntry.getByText("Performed measure", { exact: true }),
      currentEntry.getByRole("button", { name: "Log set", exact: true }),
      currentEntry.getByText("Next action", { exact: true }),
      setOptions.locator(":scope > summary"),
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
      setOptions.locator("summary"),
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
    const receipt = currentCard.getByTestId("active-set-save-receipt");
    await expect(receipt).toContainText("Saved · Set 1");
    await expect(receipt).toContainText("Acknowledged by Repbook");
    await expect(
      receipt.getByRole("button", { name: "Correct set", exact: true }),
    ).toBeVisible();
    await expect(receipt).toBeVisible();
    await expectFullyInViewport(receipt);
    const workoutStatus = page.getByRole("complementary", {
      name: "Workout status",
    });
    await workoutStatus
      .getByRole("button", { name: "Skip rest", exact: true })
      .click();
    await workoutStatus
      .getByRole("button", { name: "Dismiss rest timer", exact: true })
      .click();
    await expectFullyInViewport(receipt);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  } finally {
    await discardWorkout(page);
  }
  await pageErrors.expectNoUnexpected();
});

test("fits the complete primary logging action at 390x844 with keyboard disclosures", async ({
  browserName,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pageErrors = observeGauntletPageErrors(page, browserName);
  try {
    await signInAndStartDayA(page, { extraLarge: false });
    const currentCard = page.getByTestId("current-exercise-card");
    const currentEntry = currentCard.getByTestId("current-set-entry");
    const primary = currentEntry.getByTestId("active-workout-primary");
    const previous = primary.getByTestId("previous-comparable-set");
    const log = primary.getByRole("button", { name: "Log set", exact: true });

    await expect(previous).toBeVisible();
    let terminalComparison:
      | { state: "available"; href: string }
      | { state: "unavailable" }
      | null = null;
    await expect(async () => {
      const snapshot = await previous.evaluate((element) => {
        const sourceLinks = element.querySelectorAll<HTMLAnchorElement>(
          'a[aria-label="View source workout"]',
        );
        return {
          state: element.getAttribute("data-comparison-state"),
          text: element.textContent?.trim() ?? "",
          sourceCount: sourceLinks.length,
          href: sourceLinks[0]?.getAttribute("href") ?? null,
        };
      });
      if (snapshot.state === "available") {
        expect(snapshot.sourceCount).toBe(1);
        expect(snapshot.href).toMatch(/^\/history\/[0-9a-f-]+$/);
        terminalComparison = {
          state: "available",
          href: snapshot.href!,
        };
        return;
      }
      if (snapshot.state === "unavailable") {
        expect(snapshot.sourceCount).toBe(0);
        expect(snapshot.text).toBe("Previous comparable set unavailable");
        terminalComparison = { state: "unavailable" };
        return;
      }
      throw new Error("Previous comparable evidence is still loading.");
    }).toPass({ timeout: 25_000 });
    expect(terminalComparison).not.toBeNull();
    await expect(log).toBeVisible();
    await revealCurrentFromStatusBar(page);

    const geometry = await compactGeometry(page);
    expect(geometry, JSON.stringify(geometry)).toMatchObject({
      previousBeforeInput: true,
      inputBeforeLog: true,
      logClearsDock: true,
    });
    expect(geometry.primaryHeight).toBeLessThanOrEqual(420);
    expect(geometry.cardHeight, JSON.stringify(geometry)).toBeLessThanOrEqual(680);
    expect(geometry.minimumInputWidth).toBeGreaterThanOrEqual(44);
    expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Log set", exact: true })).toHaveCount(1);

    const setOptions = currentEntry.locator("details", {
      hasText: "Set options",
    });
    const setOptionsSummary = setOptions.locator(":scope > summary");
    await setOptionsSummary.focus();
    await page.keyboard.press("Enter");
    await expect(setOptions).toHaveAttribute("open", "");
    await expect(setOptions.getByLabel("RIR (0–10)")).toBeVisible();
    await expect(
      setOptions.getByRole("button", { name: "Skip set", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Space");
    await expect(setOptions).not.toHaveAttribute("open", "");

    const progress = currentCard.locator("details", {
      hasText: "Exercise progress & extras",
    });
    const progressSummary = progress.locator(":scope > summary");
    await progressSummary.focus();
    await page.keyboard.press("Enter");
    await expect(progress).toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(progress).not.toHaveAttribute("open", "");

    const more = currentCard.locator("details", {
      hasText: "More for this exercise",
    });
    const moreSummary = more.locator(":scope > summary");
    await moreSummary.focus();
    await page.keyboard.press("Enter");
    await expect(more).toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(more).not.toHaveAttribute("open", "");

    await discardWorkout(page);
    await signInAndStartDayA(page, { extraLarge: true });
    await revealCurrentFromStatusBar(page);
    const extraLargeGeometry = await compactGeometry(page);
    expect(
      extraLargeGeometry,
      JSON.stringify(extraLargeGeometry),
    ).toMatchObject({
      previousBeforeInput: true,
      inputBeforeLog: true,
      logClearsDock: true,
    });
    expect(extraLargeGeometry.cardHeight).toBeLessThanOrEqual(900);
    expect(extraLargeGeometry.minimumInputWidth).toBeGreaterThanOrEqual(44);
    expect(extraLargeGeometry.horizontalOverflow).toBeLessThanOrEqual(1);
  } finally {
    await discardWorkout(page);
  }
  await pageErrors.expectNoUnexpected();
});
