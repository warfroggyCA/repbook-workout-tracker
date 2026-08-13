import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
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
  await extraLarge.click();
  await expect.poll(() => page.evaluate(
    () => document.documentElement.dataset.fontSize,
  )).toBe("extra-large");

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

async function expectTouchTarget(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
}

async function dismissRest(page: Page) {
  const status = page.getByRole("complementary", { name: "Workout status" });
  const skip = status.getByRole("button", { name: "Skip rest", exact: true });
  await expect(skip).toBeVisible();
  await skip.click();
  const dismiss = status.getByRole("button", {
    name: "Dismiss rest timer",
    exact: true,
  });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
}

test("keeps ordinary completion minimal and makes exception evidence reversible, retry-safe, and reviewable", async ({
  browserName,
  page,
  context,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName, [
    /Failed to fetch|Load failed|ERR_(?:FAILED|INTERNET_DISCONNECTED)|NetworkError when attempting to fetch resource/i,
  ]);
  await signInAndStartDayA(page);
  const currentCard = page.getByTestId("current-exercise-card");

  let currentEntry = currentCard.getByTestId("current-set-entry");
  const ordinaryDetails = currentEntry.locator("details", {
    hasText: "Optional effort and set note",
  });
  await expect(ordinaryDetails).not.toHaveAttribute("open", "");
  await expect(currentEntry.getByText("Technique issue", { exact: true }))
    .not.toBeVisible();
  await currentEntry.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(currentCard.getByTestId("active-set-save-receipt"))
    .toContainText("Acknowledged by Repbook");
  await dismissRest(page);

  currentEntry = currentCard.getByTestId("current-set-entry");
  const optional = currentEntry.locator("details", {
    hasText: "Optional effort and set note",
  });
  await optional.locator("summary").click();
  await expect(optional).toHaveAttribute("open", "");
  await expect(optional).toContainText(
    "leaving it blank keeps effort unknown",
  );
  const effort = optional.getByRole("group", { name: "Effort shortcuts" });
  const hard = effort.getByRole("button", { name: /^Hard — RPE 8/ });
  await expect(hard).toHaveAttribute("aria-pressed", "false");
  await hard.focus();
  await expect(hard).toBeFocused();
  await hard.press("Space");
  await expect(hard).toHaveAttribute("aria-pressed", "true");
  await hard.evaluate(
    () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }),
  );
  await waitForHydratedReactHandler(hard);
  await hard.focus();
  await expect(hard).toBeFocused();
  await hard.press("Space");
  await expect(hard).toHaveAttribute("aria-pressed", "false");
  await expectTouchTarget(optional.locator("summary"));

  await optional.getByLabel("RIR (0–10)").fill("2");
  await optional.getByRole("button", { name: "Bracing", exact: true }).click();
  await optional.getByRole("button", {
    name: "Strength or fatigue",
    exact: true,
  }).click();

  const recordPain = optional.getByRole("button", {
    name: "Record pain",
    exact: true,
  });
  await expectTouchTarget(recordPain);
  await recordPain.click();
  await optional.getByRole("button", { name: "back", exact: true }).click();
  let severityFour = optional.getByRole("button", { name: "Pain severity 4" });
  await expectTouchTarget(severityFour);
  await severityFour.click();
  await optional.getByLabel("Pain note (optional)").fill(
    "Sharp only at the bottom",
  );
  await optional.getByRole("button", {
    name: "Clear pain flag",
    exact: true,
  }).click();
  await expect(optional.getByRole("group", { name: "Pain severity" }))
    .toHaveCount(0);

  await optional.getByRole("button", { name: "Record pain", exact: true }).click();
  await optional.getByRole("button", { name: "back", exact: true }).click();
  severityFour = optional.getByRole("button", { name: "Pain severity 4" });
  await expectTouchTarget(severityFour);
  await severityFour.click();
  await optional.getByLabel("Pain note (optional)").fill(
    "Sharp only at the bottom",
  );
  await optional.getByLabel("Set note (optional)").fill(
    "Stopped before technique degraded further",
  );

  expect(await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);

  await context.setOffline(true);
  await currentEntry.getByRole("button", { name: "Log set", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    const parsed = raw == null ? null : JSON.parse(raw);
    const entry = parsed?.entries?.[0];
    return entry == null ? null : {
      rir: entry.rir,
      techniqueIssue: entry.techniqueIssue,
      limitationCause: entry.limitationCause,
      pain: entry.pain,
    };
  })).toEqual({
    rir: 2,
    techniqueIssue: "bracing",
    limitationCause: "strength_fatigue",
    pain: {
      bodyPart: "back",
      severity: 4,
      note: "Sharp only at the bottom",
    },
  });

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const receipt = currentCard.getByTestId("active-set-save-receipt");
  await expect(receipt).toContainText("Acknowledged by Repbook");
  await expect(receipt).toContainText("RIR 2");
  await expect(receipt).toContainText("Technique: Bracing");
  await expect(receipt).toContainText("Limited by: Strength or fatigue");
  await expect(receipt).toContainText("Pain: back 4/10");

  const status = page.getByRole("complementary", { name: "Workout status" });
  await status.getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ }).click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish.getByRole("button", { name: "Save workout", exact: true }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(page.getByText("RIR 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Technique issue: Bracing", { exact: true }))
    .toBeVisible();
  await expect(page.getByText("Limited by: Strength or fatigue", { exact: true }))
    .toBeVisible();
  await expect(page.getByText(/Pain: back 4\/10/).first()).toBeVisible();

  await page.goto("/coach");
  const review = page.getByRole("region", {
    name: "Recent effort and issue context",
  });
  await expect(review).toContainText("RIR 2");
  await expect(review).toContainText("Technique: Bracing");
  await expect(review).toContainText("Limited by: Strength or fatigue");
  await expect(review).toContainText("Pain: back 4/10");
  await expect(review).toContainText(
    "They do not change your Program, approve a proposal, or create an adaptation.",
  );
  await pageErrors.expectNoUnexpected();
});
