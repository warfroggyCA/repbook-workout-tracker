import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

const REVIEW_DECISIONS_EMAIL = "review-decisions.e2e@example.com";

async function waitForReactHandler(locator: Locator) {
  await expect.poll(async () => {
    if ((await locator.count()) !== 1) return false;
    return locator.evaluate((element) => {
      const propsKey = Object.getOwnPropertyNames(element).find((name) =>
        name.startsWith("__reactProps$"),
      );
      if (!propsKey) return false;
      const props = (element as unknown as Record<string, unknown>)[propsKey];
      return typeof props === "object" && props !== null &&
        typeof (props as { onClick?: unknown }).onClick === "function";
    });
  }, { timeout: 30_000 }).toBe(true);
}

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(REVIEW_DECISIONS_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

test("links every material Review claim to evidence and preserves deliberate owner control", async ({
  browserName,
  page,
}) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(page, browserName);
  const narrow = (page.viewportSize()?.width ?? 0) <= 320;
  await page.goto("/coach");
  if (narrow) {
    await page.evaluate(() => {
      document.documentElement.dataset.fontSize = "extra-large";
    });
  }

  const pending = page.getByRole("region", { name: "Decisions needing review" });
  await expect(pending.getByText("3 pending", { exact: true })).toBeVisible();
  const supported = pending.locator("section").filter({
    hasText: "Two completed squat workouts at 105 lb",
  }).first();
  const unsupported = pending.locator("section").filter({
    hasText: "Retained proposal with explicitly unsupported evidence.",
  }).first();

  await expect(supported.getByText("Supported", { exact: true })).toBeVisible();
  await expect(supported).toContainText("progression rules");
  await expect(supported).toContainText("progression-rules-v2");
  await expect(supported).toContainText("Not scored");
  await expect(supported).toContainText("Proposed future Program effect");
  await expect(supported).toContainText("completed workouts stay unchanged");
  await expect(unsupported.getByText("Unsupported", { exact: true })).toBeVisible();
  await expect(unsupported.getByRole("button", { name: "Approve", exact: true }))
    .toBeDisabled();
  await expect(unsupported.getByRole("button", { name: "Reject", exact: true }))
    .toBeEnabled();

  await supported.getByText("How calculated", { exact: true }).click();
  const exactSetLink = supported.getByRole("link", { name: /performed set 1/ }).first();
  const evidenceHref = await exactSetLink.getAttribute("href");
  expect(evidenceHref).toMatch(/\/history\/[0-9a-f-]+\?range=12w&returnTo=review&recommendationId=[0-9a-f-]+#performed-set-[0-9a-f-]+$/);
  await exactSetLink.click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?range=12w&returnTo=review&recommendationId=[0-9a-f-]+#performed-set-[0-9a-f-]+$/);
  const evidenceTargetId = new URL(page.url()).hash.slice(1);
  await expect(page.locator(`[id="${evidenceTargetId}"]`)).toBeVisible();
  const back = page.getByRole("button", { name: "Back to review", exact: true });
  await back.focus();
  await expect(back).toBeFocused();
  await back.press("Enter");
  await expect(page).toHaveURL(/\/coach#recommendation-[0-9a-f-]+$/);
  const reviewTargetId = new URL(page.url()).hash.slice(1);
  await expect(page.locator(`[id="${reviewTargetId}"]`)).toContainText(
    "Two completed squat workouts at 105 lb",
  );

  const normalHistoryHref = new URL(evidenceHref!, page.url()).pathname;
  await page.goto(normalHistoryHref);
  const workoutSummary = page.getByTestId("workout-summary");
  await expect(workoutSummary).toContainText("3 Program decisions need review");
  await expect(workoutSummary).not.toContainText("Nothing needs a decision");
  await page.goto("/coach");

  const refreshedSupported = page.getByRole("region", {
    name: "Decisions needing review",
  }).locator("section").filter({
    hasText: "Two completed squat workouts at 105 lb",
  }).first();
  await refreshedSupported.getByText("Decide later", { exact: true }).click();
  await refreshedSupported.getByLabel("Optional revisit date").fill("2026-08-21");
  await refreshedSupported.getByLabel("Optional note").fill(
    "Review after two more workouts.",
  );
  const defer = refreshedSupported.getByRole("button", {
    name: "Defer review",
    exact: true,
  });
  await waitForReactHandler(defer);
  await defer.click();
  await expect(refreshedSupported.getByText("Review deferred", { exact: true }))
    .toBeVisible();
  await page.reload();
  const deferred = page.getByRole("region", {
    name: "Decisions needing review",
  }).locator("section").filter({
    hasText: "Review after two more workouts.",
  }).first();
  await expect(deferred).toContainText("Revisit on 2026-08-21");
  const resume = deferred.getByRole("button", { name: "Resume review", exact: true });
  await waitForReactHandler(resume);
  await resume.click();
  const resumed = page.getByRole("region", {
    name: "Decisions needing review",
  }).locator("section").filter({
    hasText: "Two completed squat workouts at 105 lb",
  }).first();
  await expect(resumed.getByText("Review deferred", { exact: true }))
    .toHaveCount(0);
  await expect(resumed.getByRole("button", { name: "Approve", exact: true }))
    .toBeEnabled();

  if (narrow) {
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )).toBeLessThanOrEqual(1);
  }

  const approve = resumed.getByRole("button", { name: "Approve", exact: true });
  await waitForReactHandler(approve);
  await approve.click();
  await expect(page.getByRole("region", { name: "Decisions needing review" })
    .getByText("1 pending", { exact: true })).toBeVisible();
  await page.getByText("Decision history and supporting evidence", {
    exact: true,
  }).click();
  await expect(page.getByRole("region", { name: "Recent decisions" })
    .getByText("Accepted", { exact: true })).toHaveCount(3);

  await page.goto(evidenceHref!);
  await expect(page.locator(`[id="${evidenceTargetId}"]`)).toBeVisible();
  await expect(page.locator(`[id="${evidenceTargetId}"]`)).toContainText("105 lb");
  await pageErrors.expectNoUnexpected();
});
