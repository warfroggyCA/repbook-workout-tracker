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
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  const activeSessionUrl = page.url();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "extra-large";
  });
  await expectNoHorizontalOverflow(page);
  const exerciseCards = page.locator('section[id^="exercise-"]');
  expect(await exerciseCards.count()).toBeGreaterThan(1);
  const futureRemovalCard = exerciseCards.nth(1);
  const futureRemovalExercise = (
    await futureRemovalCard.getByRole("heading", { level: 2 }).textContent()
  )?.trim();
  expect(futureRemovalExercise).toBeTruthy();
  await futureRemovalCard.getByTestId("exercise-swipe-surface").click();
  await futureRemovalCard
    .getByText("More for this exercise", { exact: true })
    .click();
  await futureRemovalCard
    .getByRole("button", { name: "Remove from today", exact: true })
    .click();
  const futureRemovalLink = page.getByRole("link", {
    name: /Remove from future .+ workouts/,
  });
  await expect(futureRemovalLink).toBeVisible();
  const futureRemovalHref = await futureRemovalLink.getAttribute("href");
  const futureRemovalDay = futureRemovalHref
    ? new URL(futureRemovalHref, page.url()).searchParams.get("day")
    : null;
  expect(futureRemovalDay).toBeTruthy();

  const staleRemovalUrl = new URL(futureRemovalHref!, page.url());
  staleRemovalUrl.searchParams.set(
    "exercise",
    "00000000-0000-4000-8000-000000000099",
  );
  const staleRemovalPage = await page.context().newPage();
  await staleRemovalPage.goto(
    `${staleRemovalUrl.pathname}${staleRemovalUrl.search}`,
  );
  await expect(
    staleRemovalPage.getByText("Future removal needs review", { exact: true }),
  ).toBeVisible();
  await expect(staleRemovalPage.getByText(/now contains a different exercise/i))
    .toBeVisible();
  await staleRemovalPage.close();

  await page.route("**/api/program/draft", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        reason: "Synthetic draft save interruption. Retry safely.",
      }),
    });
  });
  await futureRemovalLink.click();
  const futureRemovalDialog = page.getByRole("dialog", {
    name: `Remove ${futureRemovalExercise} from future workouts?`,
  });
  await expect(futureRemovalDialog).toContainText(
    "Your active workout, completed History, and current published Program stay unchanged",
  );
  await futureRemovalDialog
    .getByRole("button", { name: "Stage future removal", exact: true })
    .click();
  await expect(futureRemovalDialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/intent=remove/);
  await expect(page.getByRole("status")).toContainText(
    "Synthetic draft save interruption",
  );
  await page.unroute("**/api/program/draft");
  await page
    .getByRole("button", { name: "Retry save", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("All changes saved");

  const retainedActiveWorkout = await page.context().newPage();
  await retainedActiveWorkout.goto(activeSessionUrl);
  await expect(
    retainedActiveWorkout.getByRole("heading", {
      level: 2,
      name: futureRemovalExercise!,
    }),
  ).toBeVisible();
  await retainedActiveWorkout.close();

  const retainedCurrentProgram = await page.context().newPage();
  await retainedCurrentProgram.goto(
    `/program?day=${encodeURIComponent(futureRemovalDay!)}`,
  );
  await expect(
    retainedCurrentProgram.getByText(futureRemovalExercise!, { exact: true }),
  ).toBeVisible();
  await retainedCurrentProgram.close();

  await page.goto(`/program?day=${encodeURIComponent(futureRemovalDay!)}`);
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
  const continueEditing = page.getByRole("button", {
    name: "Continue editing",
    exact: true,
  });
  await expect(continueEditing).toBeVisible();
  await continueEditing.click();
  await expect(page.getByRole("tab", { name: "Edit", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("Program name")).toHaveValue(futureName);
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ready to publish", exact: true })).toBeVisible();

  const changeCard = page
    .getByRole("heading", { name: "What will change for future workouts", exact: true })
    .locator("../../..");
  await expect(changeCard).toContainText("exact change list for saved draft revision");
  await expect(changeCard).toContainText(`Remove ${futureRemovalExercise}`);
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

  await page.goto(`/program?day=${encodeURIComponent(futureRemovalDay!)}`);
  await expect(page.getByRole("heading", { level: 1, name: futureName })).toBeVisible();
  await expect(page.getByText(futureRemovalExercise!, { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
