import { expect, test } from "@playwright/test";
import { waitForEquipmentSelectionsToSettle, waitForHydratedReactHandler, waitForHydratedServerAction } from "../helpers/react-readiness";

test("shared pulley, inline preparation, corrected sets and manual scrolling", async ({ page }, testInfo) => {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  const resume = page.getByRole("button", { name: "Resume workout", exact: true });
  await waitForHydratedReactHandler(resume);
  await resume.click();
  await expect(page).toHaveURL(/\/session\//);
  await waitForEquipmentSelectionsToSettle(page);
  // Every cable exercise must see the same physical machine through its retained requirement.
  for (const name of ["Wide-Grip Lat Pulldown", "Cable Leg Curl"]) {
    await expect(page.locator(`[aria-label="Equipment setup for ${name}"]`)).toContainText("Shared plate pulley");
  }
  for (const name of ["Wide-Grip Lat Pulldown"]) {
    const warmup = page.getByRole("region", { name: `Warm-up for ${name}`, exact: true });
    await expect(warmup).toBeVisible();
    expect(await warmup.evaluate((el) => el.closest('[id^="exercise-"]') != null)).toBe(true);
    await warmup.getByRole("checkbox", { name: "Mark Easy preparation complete", exact: true }).click();
    await waitForEquipmentSelectionsToSettle(page);
  }
  await expect(page.locator('#workout-warmup [id^="warmup-occurrence-"]')).toHaveCount(0);
  const card = page.getByTestId("current-exercise-card");
  await expect(card).toContainText("Wide-Grip Lat Pulldown");
  const weight = card.getByLabel("Total added plate weight", { exact: true });
  await weight.fill("50");
  await expect(card).toContainText("25 lb per side");
  await card.getByRole("button", { name: "Increase weight", exact: true }).click();
  await expect(weight).not.toHaveValue("50");
  await card.getByRole("button", { name: "Decrease weight", exact: true }).click();
  await expect(weight).toHaveValue("50");
  await page.getByTestId("active-log-set").click();
  const dock = page.getByRole("complementary", { name: "Workout status" });
  await expect(page.getByTestId("rest-cockpit")).toBeVisible();
  await expect(card.getByRole("button", { name: /^Fix / }).first()).toBeVisible();
  await card.getByRole("button", { name: /^Fix / }).first().click();
  const correction = page.getByRole("dialog");
  await expect(correction).toBeVisible();
  await correction.getByLabel("Reps", { exact: true }).fill("9");
  await correction.getByRole("button", { name: "Save", exact: true }).click();
  await expect(correction).toHaveCount(0);
  await expect(card).toContainText("9 reps");
  // Reproduce timer focus left behind after editing, then viewport resize while browsing.
  await dock.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
  await page.evaluate(() => {
    window.dispatchEvent(new Event("touchmove"));
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const position = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => {
    window.visualViewport?.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(position);
  await page.waitForTimeout(1200); // Observe several timer/render frames, not just the first frame.
  expect(await page.evaluate(() => window.scrollY)).toBe(position);
  const dockBounds = await dock.boundingBox();
  expect(dockBounds!.y + dockBounds!.height).toBeCloseTo(page.viewportSize()!.height, 0);
  await page.screenshot({ path: testInfo.outputPath("stable-timer.png") });
  await page.reload();
  await waitForEquipmentSelectionsToSettle(page);
  await expect(page.getByTestId("current-exercise-card").getByLabel("Total added plate weight", { exact: true })).toHaveValue("50");
  for (let set = 2; set <= 3; set++) {
    await page.getByRole("button", { name: "End rest", exact: true }).click();
    const log = page.getByTestId("active-log-set");
    await expect(log).toBeEnabled();
    await log.click();
    await expect(page.getByTestId("rest-cockpit")).toHaveAttribute("data-rest-phase", "running");
  }
  const legWarmup = page.getByRole("region", { name: "Warm-up for Cable Leg Curl", exact: true });
  await expect(legWarmup).toBeVisible();
  await expect(legWarmup).toContainText("The countdown is rest time");
  await expect(legWarmup.getByRole("checkbox", { name: "Mark Easy preparation complete", exact: true })).toBeDisabled();
  await legWarmup.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("rest-before-inline-warmup.png") });
  await legWarmup.getByRole("button", { name: "End rest to start warm-up", exact: true }).click();
  const complete = legWarmup.getByRole("checkbox", { name: "Mark Easy preparation complete", exact: true });
  await expect(complete).toBeEnabled();
  await complete.click();
  const leg = page.getByTestId("current-exercise-card");
  await expect(leg).toContainText("Cable Leg Curl");
  await expect(leg.getByLabel("Total added plate weight", { exact: true })).toHaveValue("50");
  await expect(leg).toContainText("25 lb per side");
  await leg.getByRole("button", { name: "Increase weight", exact: true }).click();
  await expect(leg.getByLabel("Total added plate weight", { exact: true })).not.toHaveValue("50");
  await leg.getByRole("button", { name: "Decrease weight", exact: true }).click();
  await expect(leg.getByLabel("Total added plate weight", { exact: true })).toHaveValue("50");
  await page.screenshot({ path: testInfo.outputPath("inline-leg-warmup-and-plates.png") });
});
