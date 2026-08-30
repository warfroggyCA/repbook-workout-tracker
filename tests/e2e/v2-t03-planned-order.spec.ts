import { expect, test, type Page } from "@playwright/test";
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

async function skipCurrentSet(page: Page) {
  const current = page.getByTestId("current-exercise-card");
  const currentEntry = current.getByTestId("current-set-entry");
  await expect(currentEntry).toHaveCount(1);
  const priorOccurrenceId = await currentEntry.getAttribute("id");
  expect(priorOccurrenceId).toMatch(/^set-entry-/);
  await openNativeDetails(current.getByTestId("active-exercise-details"));
  const skip = current.getByRole("button", {
    name: "Skip set",
    exact: true,
  });
  await expect(skip).toBeEnabled();
  await waitForHydratedReactHandler(skip);
  await skip.click();
  const dialog = page.getByRole("dialog", { name: /^Skip set .+\?$/ });
  await dialog.getByLabel("Reason").selectOption("time_limit_reached");
  await dialog.getByRole("button", { name: "Skip item", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => {
    const nextEntry = page
      .getByTestId("current-exercise-card")
      .getByTestId("current-set-entry");
    if ((await nextEntry.count()) !== 1) return false;
    const nextOccurrenceId = await nextEntry.getAttribute("id");
    return nextOccurrenceId != null && nextOccurrenceId !== priorOccurrenceId;
  }).toBe(true);
}

test("keeps planned work authoritative around extra-before-plan and grouped work", async ({
  browserName,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName);
  await signInAndStartDayA(page);
  const first = page.getByRole("region", {
    name: "Barbell Back Squat",
    exact: true,
  });
  await expect(first).toContainText("Barbell Back Squat");
  await expect(first.getByTestId("current-set-entry")).toContainText("Set 1");

  await first.locator("details", {
    hasText: "Extra sets",
  }).locator(":scope > summary").click();
  const addExtra = first.getByRole("button", {
    name: "Add extra set",
    exact: true,
  });
  await expect(addExtra).toBeEnabled();
  await waitForHydratedReactHandler(addExtra);
  await addExtra.click();
  const extra = first.getByTestId("added-set-entry");
  await expect(extra).toContainText("Extra set 1 · Added to this workout");
  await expect(first.getByTestId("current-set-entry")).toContainText("Set 1");
  await extra.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(first).toContainText("Acknowledged by Repbook");
  await expect(
    page.getByRole("region", { name: "Workout progress and upcoming work" }),
  ).toContainText("0/13 planned · 1 extra");
  await page.reload({ waitUntil: "networkidle" });
  await expect(first).toContainText("Extra set 1");
  const status = page.getByRole("complementary", { name: "Workout status" });
  const skipRest = status.getByRole("button", { name: "Skip rest", exact: true });
  if (await skipRest.isVisible()) await skipRest.click();
  const dismissRest = status.getByRole("button", {
    name: "Dismiss rest timer",
    exact: true,
  });
  await expect(dismissRest).toBeVisible();
  await dismissRest.click();
  await expect(first.getByTestId("current-set-entry")).toContainText("Set 1");

  for (let index = 0; index < 9; index += 1) {
    await skipCurrentSet(page);
  }
  await expect(
    page.getByTestId("current-exercise-card").getByRole("heading", {
      name: "Dumbbell Lateral Raise",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByTestId("current-exercise-card").getByTestId("current-set-entry"),
  ).toContainText("Set 1");
  const group = page.getByTestId("active-workout-group");
  await expect(group).toContainText("Dumbbell Lateral Raise");
  await expect(group).toContainText("Up next in group: 2 of 2 · Pallof Press");
  const laterMember = page.getByRole("region", { name: "Pallof Press" });
  await expect(laterMember.getByTestId("current-set-entry")).toHaveCount(0);

  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await expect(finish).toContainText("0 of 13 planned sets done");
  await expect(finish).toContainText("1 extra set performed");
  await finish.getByText("Optional note and fatigue", { exact: true }).click();
  const fatigue = finish.getByRole("group", { name: "Overall fatigue" });
  const fatigueThree = fatigue.getByRole("button", {
    name: "3",
    exact: true,
  });
  await expect(fatigueThree).toHaveAttribute("aria-pressed", "false");
  await fatigueThree.focus();
  await fatigueThree.press("Space");
  await expect(fatigueThree).toHaveAttribute("aria-pressed", "true");
  await finish
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("user_choice");
  await finish.getByRole("button", { name: /^(?:Finish early|Save workout)$/ }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(page.getByText(/extra set 1/i).first()).toBeVisible();
  const technicalRecord = page.locator("details#technical-record");
  await expect(technicalRecord).not.toHaveAttribute("open", "");
  await technicalRecord.locator(":scope > summary").click();
  const extraLedgerItem = technicalRecord
    .locator("li")
    .filter({ hasText: /extra set 1/i })
    .first();
  await expect(extraLedgerItem).toContainText("added during workout");
  await expect(extraLedgerItem.getByText("completed", { exact: true })).toBeVisible();
  await pageErrors.expectNoUnexpected();
});
