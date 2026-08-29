import { expect, test, type Locator, type Page } from "@playwright/test";
import { BA_WORKOUT_EMAIL } from "../fixtures/ba-workout-contract";
import { waitForHydratedServerAction } from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

async function expectTouchTarget(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const size = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, width: rect.width };
  });
  expect(size.height).toBeGreaterThanOrEqual(44);
  expect(size.width).toBeGreaterThanOrEqual(44);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
}

async function signInAndStart(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  const start = page.getByRole("button", { name: "Train as planned", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
}

test("recovers a six-day interruption without rewriting source timestamps", async ({
  browserName,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName);
  await signInAndStart(page);
  const sessionId = page.url().match(/\/session\/([0-9a-f-]+)/)?.[1];
  expect(sessionId).toBeTruthy();

  const timingWarning = page.getByTestId("active-workout-timing-warning");
  await expect(timingWarning).toContainText("Timing needs review · wall clock 6 days");
  await expect(timingWarning).toContainText("Active time is unavailable");

  await page.goto("/today");
  const recovery = page.getByTestId("today-decision");
  await expect(recovery).toContainText("Workout needs attention");
  await expect(recovery).toContainText("Timing needs review · wall clock 6 days");
  await expect(recovery).toContainText("The recorded start is retained");
  const resume = recovery.getByRole("button", { name: "Resume workout", exact: true });
  const review = recovery.getByRole("button", {
    name: "Review timing & finish",
    exact: true,
  });
  const discard = recovery.getByRole("button", {
    name: "Discard this workout",
    exact: true,
  });
  await expectTouchTarget(resume);
  await expectTouchTarget(review);
  await expectTouchTarget(discard);

  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "extra-large";
  });
  await expectNoHorizontalOverflow(page);
  await expectTouchTarget(resume);
  await expectTouchTarget(review);
  await expectTouchTarget(discard);

  await page.setViewportSize({ width: 440, height: 956 });
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "default";
  });
  await expectNoHorizontalOverflow(page);
  await expectTouchTarget(resume);
  await expectTouchTarget(review);
  await expectTouchTarget(discard);

  await page.setViewportSize({ width: 390, height: 844 });

  await review.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}\\?reviewTiming=1$`));
  const finishDialog = page.getByRole("dialog", { name: "Finish workout" });
  await expect(finishDialog).toBeVisible();
  await expect(finishDialog).toContainText("Wall clock: 6 days");
  await expect(finishDialog).toContainText("Active time unavailable");
  const save = finishDialog.getByRole("button", {
    name: /^(?:Finish early|Save workout)$/,
  });
  await expect(save).toBeDisabled();

  const enterActive = finishDialog.getByRole("radio", {
    name: /Enter active time/,
  });
  await enterActive.focus();
  await page.keyboard.press("Space");
  const activeMinutes = finishDialog.getByTestId("owner-reported-active-minutes");
  await activeMinutes.fill("60");
  await expect(finishDialog).toContainText("Active time: 60 min · owner reported");
  await finishDialog
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("interruption");
  await expectTouchTarget(save);
  await save.click();
  await expect(page).toHaveURL(new RegExp(`/history/${sessionId}\\?finished=1$`));
  await expect(page.getByText(/Active 1 hr · wall clock 6 days · owner reported/)).toBeVisible();

  const technicalRecord = page.locator("#technical-record");
  await technicalRecord.locator(":scope > summary").click();
  const correct = page.getByRole("button", {
    name: "Correct active duration",
    exact: true,
  });
  await expectTouchTarget(correct);
  await correct.click();
  const correctionDialog = page.getByRole("dialog", {
    name: "Correct active workout duration",
  });
  await expect(correctionDialog).toContainText(
    "It never changes the original start or finish timestamps",
  );
  const unknown = correctionDialog.getByRole("radio", {
    name: /Active time is unknown/,
  });
  await unknown.focus();
  await page.keyboard.press("Space");
  const reviewed = correctionDialog.getByRole("checkbox", {
    name: /source timestamps will remain unchanged/,
  });
  await reviewed.focus();
  await page.keyboard.press("Space");
  const saveCorrection = correctionDialog.getByRole("button", {
    name: "Save active-duration correction",
    exact: true,
  });
  await expectTouchTarget(saveCorrection);
  await saveCorrection.click();
  await expect(page.getByText(/Active time unavailable · wall clock 6 days/)).toBeVisible();
  await technicalRecord.locator(":scope > summary").click();
  await expect(
    technicalRecord.getByText(/source timestamps retained/),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await pageErrors.expectNoUnexpected();
});
