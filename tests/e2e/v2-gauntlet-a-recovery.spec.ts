import { expect, test, type Page } from "@playwright/test";
import { getWorkoutFinishButton } from "../helpers/active-workout-controls";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

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
  if (!(await extraLarge.isChecked())) await extraLarge.click();
  await expect(extraLarge).toBeChecked();

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

async function expectSetQueueLength(page: Page, expected: number) {
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    return parsed.entries?.length ?? 0;
  })).toBe(expected);
}

async function dismissRest(page: Page) {
  const status = page.getByRole("complementary", { name: "Workout status" });
  const skip = status.getByRole("button", { name: "Skip rest", exact: true });
  if ((await skip.count()) > 0) await skip.click();
  const dismiss = status.getByRole("button", {
    name: "Dismiss rest timer",
    exact: true,
  });
  if ((await dismiss.count()) > 0) await dismiss.click();
}

test("recovers offline and timeout-after-commit sets exactly, then reviews abandonment accessibly", async ({
  browserName,
  context,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName, [
    /Failed to fetch/i,
    /Load failed/i,
    /Failed to load resource: WebKit encountered an internal error/i,
    /ERR_(?:FAILED|INTERNET_DISCONNECTED)/i,
    /NetworkError when attempting to fetch resource/i,
  ]);
  await signInAndStartDayA(page);
  const sessionId = page.url().split("/").at(-1)!;

  let current = page.getByTestId("current-exercise-card");
  let entry = current.getByTestId("current-set-entry");
  await context.setOffline(true);
  await entry.getByRole("button", { name: "Log set", exact: true }).click();
  await expectSetQueueLength(page, 1);
  await expect(current.getByRole("status")).toContainText(
    /Saving|Retrying|waiting|Pending on this device/i,
  );

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(current.getByTestId("active-set-save-receipt"))
    .toContainText("Saved · Set 1");
  await expectSetQueueLength(page, 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  current = page.getByTestId("current-exercise-card");
  await current
    .locator("details", { hasText: "Exercise progress & extras" })
    .locator(":scope > summary")
    .click();
  await expect(
    current.locator('[id^="logged-set-"]').filter({ hasText: "Set 1" }),
  ).toBeVisible();
  await expect(current.getByTestId("current-set-entry")).toContainText("Set 2");
  await dismissRest(page);

  let afterCommitInterceptions = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      afterCommitInterceptions === 0 &&
      request.method() === "POST" &&
      request.headers()["next-action"]
    ) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      afterCommitInterceptions += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  current = page.getByTestId("current-exercise-card");
  entry = current.getByTestId("current-set-entry");
  await entry.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(current.getByTestId("active-set-save-receipt"))
    .toContainText("Saved · Set 2");
  await expectSetQueueLength(page, 0);
  expect(afterCommitInterceptions).toBe(1);
  await page.unrouteAll({ behavior: "wait" });

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await getWorkoutFinishButton(page).click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await openNativeDetails(finish.locator("details", {
    hasText: "Optional note and fatigue",
  }));
  const fatigue = finish.getByRole("group", { name: "Overall fatigue" });
  const fatigueThree = fatigue.getByRole("button", {
    name: "3",
    exact: true,
  });
  await expect(fatigueThree).toHaveAttribute("aria-pressed", "false");
  await fatigueThree.focus();
  await expect(fatigueThree).toBeFocused();
  await fatigueThree.press("Space");
  await expect(fatigueThree).toHaveAttribute("aria-pressed", "true");
  const fatigueBox = await fatigueThree.boundingBox();
  expect(fatigueBox).not.toBeNull();
  expect(fatigueBox!.height).toBeGreaterThanOrEqual(44);
  await fatigueThree.press("Space");
  await expect(fatigueThree).toHaveAttribute("aria-pressed", "false");

  await finish
    .getByRole("button", { name: "Discard workout", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /^Discard .+\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);

  await page.goto(`/history/${sessionId}`);
  await expect(page.getByText("Abandoned workout", { exact: true })).toBeVisible();
  await expect(page.getByText(/2 performed working sets/)).toBeVisible();
  await pageErrors.expectNoUnexpected();
});
