import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import {
  installNextDevelopmentRefreshControl,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import {
  isCorrelatedWebKitRscPrefetchCancellation,
  isExpectedWebKitRscLinkCancellation,
  observeNextRscPrefetches,
} from "../helpers/webkit-rsc-prefetch-errors";

const expectedNavigationPrefetches = new Set([
  "/coach",
  "/history",
  "/program",
  "/settings",
  "/today",
]);

test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
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
  if ((await extraLarge.getAttribute("aria-checked")) !== "true") {
    await waitForHydratedReactHandler(extraLarge);
    await extraLarge.click();
    await expect(
      page.getByText("Saved to your profile.", { exact: true }),
    ).toBeVisible();
  }
  await page.goto("/today");
}

async function startWorkout(page: Page) {
  const alternateDays = page.getByTestId("alternate-program-days");
  await alternateDays.locator("summary").click();
  const start = alternateDays.getByRole("button", { name: /Day A — Squat/ });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
}

async function discardWorkout(page: Page) {
  await page
    .getByRole("button", { name: "Finish Workout", exact: true })
    .click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish
    .getByRole("button", { name: "Discard workout", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /^Discard .+\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

test("adds a reviewed workout-only exercise without editing the Program", async ({
  browserName,
  context,
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  const httpErrors: string[] = [];
  const prefetches = observeNextRscPrefetches(page, browserName);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      browserErrors.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  await signIn(page);
  await startWorkout(page);
  const plannedHeadingsBefore = await page
    .locator('section[aria-labelledby^="session-exercise-heading-"]')
    .count();

  const addButton = page.getByRole("button", {
    name: "Add exercise to this workout",
    exact: true,
  });
  await addButton.focus();
  await expect(addButton).toBeFocused();
  await page.keyboard.press("Enter");

  const picker = page.getByRole("dialog", {
    name: "Choose an exercise for this workout",
  });
  await expect(picker).toBeVisible();
  await picker.getByRole("textbox", { name: "Search exercise library" }).fill(
    "Push-Up",
  );
  await picker
    .getByRole("button", { name: "View details for Push-Up", exact: true })
    .click();
  await expect(picker.getByRole("heading", { name: "Push-Up" })).toBeFocused();
  await picker
    .getByRole("button", { name: "Review exercise", exact: true })
    .click();

  let review = page.getByRole("dialog", {
    name: "Add exercise to this workout",
  });
  await expect(review).toContainText(
    "Nothing here edits the Program or creates a superset.",
  );
  await review.getByLabel("Initial sets").fill("2");
  await expect(review.getByLabel("Initial sets")).toHaveValue("2");

  await page.reload({ waitUntil: "domcontentloaded" });
  review = page.getByRole("dialog", { name: "Add exercise to this workout" });
  await expect(review).toContainText(
    "Your reviewed exercise was restored. It has not been added until the server confirms it.",
  );
  await expect(review.getByLabel("Initial sets")).toHaveValue("2");
  if (browserName === "chromium") {
    await context.setOffline(true);
    await review
      .getByRole("button", { name: "Add exercise", exact: true })
      .click();
    await expect(review.getByRole("alert")).toContainText(
      "The server did not confirm the addition.",
    );
    await context.setOffline(false);
  }
  await review.getByRole("button", { name: "Add exercise", exact: true }).click();

  const addedCard = page.getByRole("region", { name: "Push-Up" });
  await expect(addedCard).toBeVisible();
  await expect(addedCard).toContainText("Workout only");
  await expect(
    page.getByRole("region", { name: "Workout progress and upcoming work" }),
  ).toContainText("Next: Barbell Back Squat, set 2");
  await expect(
    page.getByRole("complementary", { name: "Workout status" }),
  ).toContainText("Barbell Back Squat");
  await expect(
    page.getByRole("complementary", { name: "Workout status" }),
  ).toContainText("Set 1 of 3");
  await addedCard.getByRole("button", { name: /Push-Up/ }).click();
  await expect(addedCard).toContainText(
    "Added during this workout. It has no Program slot or progression target, and your Program remains unchanged.",
  );
  await expect(addedCard).toContainText("Set 1");
  await expect(addedCard).toContainText("Set 2");
  await addedCard.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(addedCard).toContainText("1/2 performed");
  await expect(
    page.locator('section[aria-labelledby^="session-exercise-heading-"]'),
  ).toHaveCount(plannedHeadingsBefore + 1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);

  const touchTarget = await addButton.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height };
  });
  expect(touchTarget.width).toBeGreaterThanOrEqual(44);
  expect(touchTarget.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: resolve(
      "output/playwright/active-workout-add-exercise",
      `${testInfo.project.name}-added.png`,
    ),
    fullPage: true,
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  const restoredAddedCard = page.getByRole("region", { name: "Push-Up" });
  await expect(restoredAddedCard).toContainText("Workout only");
  await expect(restoredAddedCard).toContainText("1/2 performed");
  await discardWorkout(page);

  await prefetches.settle();
  expect(
    browserErrors.filter(
      (message) =>
        message !== "NEXT_REDIRECT" &&
        !isCorrelatedWebKitRscPrefetchCancellation(
          message,
          browserName,
          prefetches.observedUrls,
        ) &&
        !isExpectedWebKitRscLinkCancellation(
          message,
          browserName,
          expectedNavigationPrefetches,
        ),
    ),
  ).toEqual([]);
  expect(
    httpErrors.filter(
      (failure) => !/^404 GET http:\/\/[^/]+\/api\/program\/draft$/.test(failure),
    ),
  ).toEqual([]);
});

test("refuses incomplete assistance, then preserves assisted work without false progress claims", async ({
  page,
}) => {
  await signIn(page);
  await startWorkout(page);

  await page
    .getByRole("button", {
      name: "Add exercise to this workout",
      exact: true,
    })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Choose an exercise for this workout",
  });
  await picker
    .getByRole("textbox", { name: "Search exercise library" })
    .fill("Assisted Push-Up");
  await picker
    .getByRole("button", {
      name: "View details for Assisted Push-Up",
      exact: true,
    })
    .click();
  await picker
    .getByRole("button", { name: "Review exercise", exact: true })
    .click();

  const review = page.getByRole("dialog", {
    name: "Add exercise to this workout",
  });
  await review.getByLabel("Initial sets").fill("1");
  await review
    .getByRole("button", { name: "Add exercise", exact: true })
    .click();

  const assisted = page.getByRole("region", { name: "Assisted Push-Up" });
  await expect(assisted).toContainText("Workout only");
  await assisted
    .getByRole("button", { name: /Assisted Push-Up/ })
    .click();
  await assisted.getByLabel("Assistance").fill("");
  await assisted
    .getByRole("textbox", { name: "Reps", exact: true })
    .fill("8");
  await assisted
    .getByRole("button", { name: "Log set", exact: true })
    .click();
  await expect(assisted.getByText("Save failed", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Enter the amount of assistance, or add it as a note instead.",
      { exact: true },
    ),
  ).toBeVisible();
  await assisted.getByRole("button", { name: "Discard", exact: true }).click();

  await assisted.getByLabel("Assistance").fill("40");
  await assisted
    .getByRole("button", { name: "Log set", exact: true })
    .click();
  await expect(assisted).toContainText("1/1 performed");
  await expect(
    assisted.getByText("Assistance: 40 lb · 8 reps", { exact: true }),
  ).toBeVisible();

  const workoutStatus = page.getByRole("complementary", {
    name: "Workout status",
  });
  const restTimer = workoutStatus.getByLabel("Rest timer");
  await expect(restTimer).toBeVisible();
  const decreaseRest = restTimer.getByRole("button", {
    name: "Decrease rest by 15 seconds",
    exact: true,
  });
  for (let index = 0; index < 6; index += 1) await decreaseRest.click();
  await expect(workoutStatus).toContainText("Ready");
  await page.setViewportSize({ width: 320, height: 700 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  const dismissRest = workoutStatus.getByRole("button", {
    name: "Dismiss rest timer",
    exact: true,
  });
  await expect(dismissRest).toBeVisible();
  const readyLayout = await workoutStatus.evaluate((element) => {
    const navigationTop =
      document.querySelector("nav.fixed")?.getBoundingClientRect().top ??
      Number.POSITIVE_INFINITY;
    return {
      dockBottom: element.getBoundingClientRect().bottom,
      navigationTop,
      buttons: Array.from(element.querySelectorAll("button"))
        .filter((button) =>
          ["Dismiss rest timer", "Finish"].includes(
            button.textContent?.trim() ?? "",
          ),
        )
        .map((button) => {
          const box = button.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
            bottom: box.bottom,
          };
        }),
    };
  });
  expect(readyLayout.dockBottom).toBeLessThanOrEqual(
    readyLayout.navigationTop + 1,
  );
  expect(readyLayout.buttons).toHaveLength(2);
  expect(
    readyLayout.buttons.every(
      (button) =>
        button.width >= 44 &&
        button.height >= 44 &&
        button.bottom <= readyLayout.navigationTop + 1,
    ),
  ).toBe(true);
  await dismissRest.click();

  await page.reload({ waitUntil: "domcontentloaded" });
  const restoredAssisted = page.getByRole("region", {
    name: "Assisted Push-Up",
  });
  await restoredAssisted
    .getByRole("button", { name: /Assisted Push-Up/ })
    .click();
  await expect(
    restoredAssisted
      .getByText("Assistance: 40 lb · 8 reps", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Finish Workout", exact: true })
    .click();
  await page.getByRole("button", { name: "Save workout", exact: true }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(
    page.getByText("Assistance: 40 lb · 8 reps", { exact: true }),
  ).toBeVisible();

  await page.goto("/history?view=exercises&range=all");
  const assistedProgress = page
    .locator("article")
    .filter({ hasText: "Assisted Push-Up" });
  await expect(assistedProgress).toContainText("Not comparable");
  await expect(assistedProgress).toContainText("Assistance: 40 lb · 8 reps");
  await expect(
    page.getByRole("link", { name: /Assisted Push-Up/ }),
  ).toHaveCount(0);
});
