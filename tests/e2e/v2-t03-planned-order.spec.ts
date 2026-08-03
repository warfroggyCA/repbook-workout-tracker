import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
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
  await openNativeDetails(current.locator("details", {
    hasText: "Set exceptions",
  }));
  await current.getByRole("button", { name: "Skip set", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Skip set .+\?$/ });
  await dialog.getByLabel("Reason").selectOption("time");
  await dialog.getByRole("button", { name: "Skip item", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("keeps planned work authoritative around extra-before-plan and grouped work", async ({
  page,
}) => {
  await signInAndStartDayA(page);
  const first = page.getByTestId("current-exercise-card");
  await expect(first).toContainText("Barbell Back Squat");
  await expect(first.getByTestId("current-set-entry")).toContainText("Set 1");

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
  await expect(first.getByTestId("current-set-entry")).toContainText("Set 1");
  const status = page.getByRole("complementary", { name: "Workout status" });
  const skipRest = status.getByRole("button", { name: "Skip rest", exact: true });
  if ((await skipRest.count()) > 0) await skipRest.click();
  await status
    .getByRole("button", { name: "Dismiss rest timer", exact: true })
    .click();

  for (let index = 0; index < 9; index += 1) {
    await skipCurrentSet(page);
  }
  const group = page.getByTestId("active-workout-group");
  await expect(group).toContainText("Dumbbell Lateral Raise");
  await expect(group).toContainText("Up next in group: 2 of 2 · Pallof Press");
  const laterMember = page.getByRole("region", { name: "Pallof Press" });
  await expect(laterMember.getByTestId("current-set-entry")).toHaveCount(0);

  await page.getByRole("button", { name: "Finish", exact: true }).click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await expect(finish).toContainText("0 of 13 planned sets done");
  await expect(finish).toContainText("1 extra set performed");
  await finish.getByRole("button", { name: "Save workout", exact: true }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(page.getByText(/extra set 1/i).first()).toBeVisible();
  await expect(page.getByText("added during workout", { exact: true }).first()).toBeVisible();
});
