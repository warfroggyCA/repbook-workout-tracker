import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))).toMatchObject({
    scrollWidth: expect.any(Number),
    clientWidth: expect.any(Number),
  });
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )).toBe(true);
}

test("reviews and publishes an exact future-only Program change with a recoverable failure", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });

  await signIn(page);
  await page.goto("/program");
  const currentName = (await page.getByRole("heading", { level: 1 }).textContent())?.trim();
  expect(currentName).toBeTruthy();
  await page.getByRole("button", { name: "Edit this day", exact: true }).click();

  await expect(page.getByRole("heading", { name: "How Program changes work", exact: true })).toBeVisible();
  await expect(page.getByText("Your current Program stays active.", { exact: true })).toBeVisible();
  await expect(page.getByText("New workouts use the new version.", { exact: true })).toBeVisible();
  await expect(page.getByText("Active work and History stay unchanged.", { exact: true })).toBeVisible();

  const futureName = `Future-only ${Date.now()}`;
  await page.getByLabel("Program name").fill(futureName);
  await expect(page.getByRole("status")).toContainText("All changes saved");

  const unchangedProgram = await page.context().newPage();
  await unchangedProgram.goto("/program");
  await expect(unchangedProgram.getByRole("heading", { level: 1, name: currentName! })).toBeVisible();
  await expect(unchangedProgram.getByText(futureName, { exact: true })).toHaveCount(0);
  await unchangedProgram.close();

  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Check Program", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ready to publish", exact: true })).toBeVisible();

  const changeCard = page
    .getByRole("heading", { name: "What will change for future workouts", exact: true })
    .locator("../../..");
  await expect(changeCard).toContainText("exact change list for saved draft revision");
  const exactChange = changeCard.locator("details").filter({ hasText: "Program name" }).first();
  await exactChange.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(exactChange).toHaveAttribute("open", "");
  await expect(exactChange.getByText("Current Program", { exact: true })).toBeVisible();
  await expect(exactChange.getByText(currentName!, { exact: true })).toBeVisible();
  await expect(exactChange.getByText("Future Program after publication", { exact: true })).toBeVisible();
  await expect(exactChange.getByText(futureName, { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "extra-large";
  });
  await expectNoHorizontalOverflow(page);
  const publish = page.getByRole("button", { name: "Publish future Program", exact: true });
  await expect(publish).toBeEnabled();

  await page.route("**/api/program/draft/publish", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ reason: "Publication temporarily unavailable. Try again." }),
    });
  });
  await publish.click();
  await expect(page.getByRole("status")).toContainText("Publication temporarily unavailable");
  await expect(page.getByText("Future Program published", { exact: true })).toHaveCount(0);

  await page.unroute("**/api/program/draft/publish");
  await publish.click();
  await expect(page.getByText("Future Program published", { exact: true })).toBeVisible();
  await expect(page.getByText(/workouts started from this point forward/i)).toBeVisible();
  await expect(page.getByText(/workout already in progress, History, and earlier versions remain unchanged/i)).toBeVisible();

  await page.goto("/program");
  await expect(page.getByRole("heading", { level: 1, name: futureName })).toBeVisible();
  expect(errors).toEqual([]);
});
