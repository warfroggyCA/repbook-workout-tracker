import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import {
  isCorrelatedWebKitRscPrefetchCancellation,
  observeNextRscPrefetches,
} from "../helpers/webkit-rsc-prefetch-errors";

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
}

async function startDayA(page: Page) {
  const alternateDays = page.getByTestId("alternate-program-days");
  await alternateDays.locator("summary").click();
  const preview = alternateDays.getByRole("button", {
    name: /Day A — Squat/,
  });
  await preview.click();
  const start = page.getByRole("button", { name: "Start workout", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
}

async function skipCurrentSet(page: Page) {
  const card = page.getByTestId("current-exercise-card");
  const workoutStatus = page.getByRole("complementary", {
    name: "Workout status",
  });
  const showCurrent = workoutStatus.getByRole("button").first();
  const currentLabel = await showCurrent.innerText();
  await card.getByRole("button", { name: "Skip set", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Skip set / });
  await dialog.getByLabel("Reason").selectOption("time");
  await dialog.getByRole("button", { name: "Skip item", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => showCurrent.innerText())
    .not.toBe(currentLabel);
  await showCurrent.click();
  await expect(
    page
      .getByTestId("current-exercise-card")
      .getByRole("button", { name: "Skip set", exact: true }),
  ).toBeEnabled();
}

async function discardWorkout(page: Page) {
  if (!/\/session\/[0-9a-f-]+(?:#.*)?$/.test(page.url())) return;
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish
    .getByRole("button", { name: "Discard workout", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", { name: /^Discard .+\?$/ });
  await confirmation
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

async function expectReachableGroupSurface(
  page: Page,
  group: Locator,
  width: number,
) {
  await page.setViewportSize({ width, height: 700 });
  await page
    .getByRole("link", { name: "View Superset group & prep", exact: true })
    .click();
  await expect(group).toBeInViewport();
  await expect(group).toBeFocused();
  await expectNoHorizontalOverflow(page);
  const geometry = await group.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const links = Array.from(element.querySelectorAll("a")).map((link) => {
      const linkBox = link.getBoundingClientRect();
      return {
        width: linkBox.width,
        height: linkBox.height,
        left: linkBox.left,
        right: linkBox.right,
      };
    });
    const navigation = document.querySelector("nav.fixed");
    const status = document.querySelector('[aria-label="Workout status"]');
    const stickySummary = document.querySelector(
      '[aria-label="Workout progress and upcoming work"]',
    )?.parentElement;
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      viewportWidth: window.innerWidth,
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
      links,
      stickySummaryBottom:
        stickySummary?.getBoundingClientRect().bottom ?? null,
      statusBottom: status?.getBoundingClientRect().bottom ?? null,
      navigationTop: navigation?.getBoundingClientRect().top ?? null,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.rootFontSize).toBeCloseTo(23.2, 1);
  if (geometry.stickySummaryBottom != null) {
    expect(geometry.top).toBeGreaterThanOrEqual(
      geometry.stickySummaryBottom - 1,
    );
  }
  expect(geometry.links).toHaveLength(2);
  expect(
    geometry.links.every(
      (link) =>
        link.width >= 44 &&
        link.height >= 44 &&
        link.left >= 0 &&
        link.right <= geometry.viewportWidth + 1,
    ),
  ).toBe(true);
  if (geometry.statusBottom != null && geometry.navigationTop != null) {
    expect(geometry.statusBottom).toBeLessThanOrEqual(
      geometry.navigationTop + 1,
    );
  }
}

test("presents immutable superset order, truthful progress, and next-member equipment preparation", async ({
  browserName,
  page,
}) => {
  const browserErrors: string[] = [];
  const httpErrors: string[] = [];
  const nextRscPrefetches = observeNextRscPrefetches(page, browserName);
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
  await page.goto("/settings");
  await page.getByRole("radio", { name: /Extra large/ }).click();
  await expect(
    page.getByText("Saved to your profile.", { exact: true }),
  ).toBeVisible();
  await page.goto("/today");
  await startDayA(page);

  for (let index = 0; index < 9; index += 1) {
    await skipCurrentSet(page);
  }

  const group = page.getByTestId("active-workout-group");
  await expect(group).toContainText("Current exercise group");
  await expect(group).toContainText("Superset");
  await expect(group).toContainText(
    "Current member: 1 of 2 · Dumbbell Lateral Raise",
  );
  await expect(group).toContainText(
    "Up next in group: 2 of 2 · Pallof Press",
  );
  await expect(group).toContainText("Round 1 of 2");
  await expect(group).toContainText("0 of 4 performed");
  await expect(group).toContainText(
    "No rest is planned after the current set.",
  );
  await expect(group).toContainText("Prepare for Pallof Press");
  await expect(group).toContainText("Preparation is guidance only");
  await expect(group.getByRole("link")).toHaveCount(2);
  await expect(
    group.getByRole("link", { name: /1\. Dumbbell Lateral Raise/ }),
  ).toHaveAttribute("aria-current", "step");

  for (const width of [320, 375, 390, 440]) {
    await expectReachableGroupSurface(page, group, width);
  }

  const firstMember = group.getByRole("link", {
    name: /1\. Dumbbell Lateral Raise/,
  });
  const secondMember = group.getByRole("link", {
    name: /2\. Pallof Press/,
  });
  const groupAccess = page.getByRole("link", {
    name: "View Superset group & prep",
    exact: true,
  });
  await groupAccess.focus();
  await expect(groupAccess).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(group).toBeFocused();
  await expect
    .poll(() => group.evaluate((element) => element.matches(":focus-visible")))
    .toBe(true);
  await page.keyboard.press("Tab");
  await expect(firstMember).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(secondMember).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#exercise-/);

  await page.reload({ waitUntil: "domcontentloaded" });
  const restoredGroup = page.getByTestId("active-workout-group");
  await expect(restoredGroup).toContainText(
    "Current member: 1 of 2 · Dumbbell Lateral Raise",
  );
  await expect(restoredGroup).toContainText(
    "Up next in group: 2 of 2 · Pallof Press",
  );
  await expect(
    page.getByRole("region", { name: "Workout progress and upcoming work" }),
  ).toContainText("9 skipped");
  await expect(restoredGroup).toContainText("Prepare for Pallof Press");
  await expectNoHorizontalOverflow(page);

  const currentCard = page.getByTestId("current-exercise-card");
  await expect(currentCard.getByRole("heading", { level: 2 })).toHaveText(
    "Dumbbell Lateral Raise",
  );
  await page
    .getByRole("complementary", { name: "Workout status" })
    .locator("button")
    .first()
    .click();
  await expect(page).toHaveURL(/#set-entry-/);
  const currentActionUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(currentActionUrl);
  await expect(
    currentCard.getByRole("button", { name: "Skip set", exact: true }),
  ).toBeVisible();
  let releaseGroupSkip!: () => void;
  const groupSkipMayFinish = new Promise<void>((resolve) => {
    releaseGroupSkip = resolve;
  });
  let groupSkipStarted = false;
  await page.route("**/session/**", async (route) => {
    const postData = route.request().postData() ?? "";
    if (
      !groupSkipStarted &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"] &&
      postData.includes('"operation":"skip"')
    ) {
      groupSkipStarted = true;
      await groupSkipMayFinish;
    }
    await route.continue();
  });
  await currentCard
    .getByRole("button", { name: "Skip set", exact: true })
    .click();
  const groupSkip = page.getByRole("dialog", { name: /^Skip set / });
  await groupSkip.getByLabel("Reason").selectOption("time");
  await groupSkip
    .getByRole("button", { name: "Skip item", exact: true })
    .click();
  await expect(groupSkip).toHaveCount(0);
  await expect.poll(() => groupSkipStarted).toBe(true);
  await expect(currentCard.getByRole("heading", { level: 2 })).toHaveText(
    "Dumbbell Lateral Raise",
  );
  await expect(restoredGroup).toContainText(
    "Current member: 1 of 2 · Dumbbell Lateral Raise",
  );
  releaseGroupSkip();
  await expect(currentCard.getByRole("heading", { level: 2 })).toHaveText(
    "Pallof Press",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.closest(
            '[data-testid="current-exercise-card"]',
          ) != null,
      ),
    )
    .toBe(true);
  await expect(restoredGroup).toContainText(
    "Current member: 2 of 2 · Pallof Press",
  );
  const advancedGuidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  await expect(advancedGuidance).toContainText(
    /Now: Superset, round 1, member 2 of 2: Pallof Press, set 1/,
  );
  await expect(advancedGuidance).toContainText(
    /Next: Superset, round 2, member 1 of 2: Dumbbell Lateral Raise, set 2/,
  );
  await page.unrouteAll({ behavior: "wait" });

  await discardWorkout(page);
  await nextRscPrefetches.settle();
  expect(
    browserErrors.filter(
      (message) =>
        message !== "NEXT_REDIRECT" &&
        !isCorrelatedWebKitRscPrefetchCancellation(
          message,
          browserName,
          nextRscPrefetches.observedUrls,
        ),
    ),
  ).toEqual([]);
  expect(
    httpErrors.filter(
      (failure) => !/^404 GET http:\/\/[^/]+\/api\/program\/draft$/.test(failure),
    ),
  ).toEqual([]);
});
