import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
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
  const dayA = alternateDays.getByRole("button", { name: /Day A — Squat/ });
  const start = (await dayA.count()) > 0
    ? page.getByRole("button", { name: "Start workout", exact: true })
    : page.getByRole("button", { name: "Train as planned", exact: true });
  if ((await dayA.count()) > 0) await dayA.click();
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
  const status = page.getByRole("complementary", { name: "Workout status" });
  return (await status.getByRole("button").first().innerText())
    .split("\n")[0]
    .trim();
}

async function discardWorkout(page: Page) {
  await page
    .getByRole("button", { name: /^(?:Finish early|Finish workout)$/i })
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
  const initialCurrentActionLabel = await startWorkout(page);
  const preparation = page.getByTestId("session-preparation-panel");
  await expect(preparation).toHaveCount(0);
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

  const addedCard = page.getByRole("region", { name: "Push-Up", exact: true });
  await expect(addedCard).toBeVisible();
  await expect(addedCard).toContainText("Workout only");
  await expect(preparation).toHaveCount(0);
  const currentCard = page.getByTestId("current-exercise-card");
  if ((await currentCard.count()) > 0) {
    await expect(
      page.getByRole("region", { name: "Workout progress and upcoming work" }),
    ).not.toContainText("Next:");
    await expect(currentCard).toContainText("Next action");
  }
  await expect(
    page.getByRole("complementary", { name: "Workout status" }),
  ).toContainText(initialCurrentActionLabel);
  await addedCard.getByRole("button", { name: /Push-Up/ }).click();
  await expect(addedCard).toContainText(
    "Added during this workout. It has no Program slot or progression target, and your Program remains unchanged.",
  );
  await expect(addedCard).toContainText("Set 1");
  await context.setOffline(true);
  await addedCard.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(preparation).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    if (!raw) return 0;
    return (JSON.parse(raw) as { entries?: unknown[] }).entries?.length ?? 0;
  })).toBe(1);
  await context.setOffline(false);
  await expect(addedCard).toContainText("1/2 done · Workout only");
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
  const restoredAddedCard = page.getByRole("region", {
    name: "Push-Up",
    exact: true,
  });
  await expect(page.getByTestId("session-preparation-panel")).toHaveCount(0);
  await expect(restoredAddedCard).toContainText("Workout only");
  await expect(restoredAddedCard).toContainText("1/2 done · Workout only");
  const swipeSurface = restoredAddedCard.getByTestId(
    "exercise-swipe-surface",
  );
  await swipeSurface.evaluate((element) => {
    const dispatchTouch = (
      type: "touchstart" | "touchmove" | "touchend",
      clientX: number,
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touch = { clientX, clientY: 40 };
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : [touch],
      });
      Object.defineProperty(event, "changedTouches", { value: [touch] });
      element.dispatchEvent(event);
    };
    dispatchTouch("touchstart", 300);
    dispatchTouch("touchmove", 205);
    dispatchTouch("touchend", 205);
  });
  const swipeRemove = restoredAddedCard.getByRole("button", {
    name: "Remove Push-Up from today",
    exact: true,
  });
  await expect(swipeRemove).toHaveAttribute("aria-hidden", "false");
  await swipeRemove.click();
  const removeDialog = page.getByRole("dialog", {
    name: "Remove Push-Up from today?",
  });
  await expect(removeDialog).toContainText(
    "1 completed set will remain in this workout's history.",
  );
  await removeDialog
    .getByRole("button", { name: "Remove from today", exact: true })
    .click();
  await expect(removeDialog).toHaveCount(0);
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(restoredAddedCard).toContainText("1/2 done · Workout only");
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
  await expect(
    page.getByText(
      "Enter the numeric assistance and unit for this set, or keep the observation in a note instead.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(assisted.getByText("Save failed", { exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
        if (!raw) return 0;
        const parsed = JSON.parse(raw) as { entries?: unknown[] };
        return parsed.entries?.length ?? 0;
      }),
    )
    .toBe(0);

  await assisted.getByLabel("Assistance").fill("40");
  await assisted
    .getByRole("button", { name: "Log set", exact: true })
    .click();
  await expect(assisted).toContainText("1/1 done · Workout only");

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
  await expect(restTimer).toContainText("Rest complete");
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
    const navigation = document.querySelector("nav.fixed");
    const navigationRect = navigation?.getBoundingClientRect() ?? null;
    const navigationVisible =
      navigation != null &&
      getComputedStyle(navigation).display !== "none" &&
      (navigationRect?.height ?? 0) > 0;
    const navigationTop = navigationVisible
      ? navigationRect?.top ?? window.innerHeight
      : window.innerHeight;
    return {
      dockBottom: element.getBoundingClientRect().bottom,
      navigationTop,
      navigationVisible,
      buttons: Array.from(element.querySelectorAll("button"))
        .filter((button) =>
          button.textContent?.trim() === "Dismiss rest timer" ||
          button.getAttribute("aria-label") === "Review workout finish",
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
  expect(readyLayout.navigationVisible).toBe(false);
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
    exact: true,
  });
  await restoredAssisted
    .getByRole("button", { name: /Assisted Push-Up/ })
    .click();
  await openNativeDetails(
    restoredAssisted.getByTestId("active-exercise-details"),
  );
  await expect(
    restoredAssisted
      .getByText("Assistance: 40 lb · 8 reps", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^(?:Finish early|Finish workout)$/i })
    .click();
  await page
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("user_choice");
  await page.getByRole("button", { name: /^(?:Finish early|Save workout)$/ }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(
    page.getByText(
      "Assistance: 40 lb · 8 reps (repetition counting basis unknown)",
      { exact: true },
    ),
  ).toBeVisible();

  await page.goto("/history?view=exercises&range=all");
  const assistedProgress = page
    .getByRole("heading", {
      level: 3,
      name: "Assisted Push-Up",
      exact: true,
    })
    .locator("../..");
  await expect(assistedProgress).toContainText("Not comparable");
  await expect(assistedProgress).toContainText("Assistance: 40 lb · 8 reps");
  await expect(
    assistedProgress.getByRole("link", { name: /Assisted Push-Up/ }),
  ).toHaveCount(0);
});
