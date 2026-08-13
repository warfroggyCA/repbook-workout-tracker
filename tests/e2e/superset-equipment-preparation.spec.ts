import { expect, test, type Locator, type Page } from "@playwright/test";
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

async function openCurrentExerciseCard(page: Page) {
  const card = page.getByTestId("current-exercise-card");
  const toggle = card.locator(":scope > button");
  await waitForHydratedReactHandler(toggle);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return card;
}

async function skipCurrentSet(page: Page) {
  let card = await openCurrentExerciseCard(page);
  const workoutStatus = page.getByRole("complementary", {
    name: "Workout status",
  });
  const showCurrent = workoutStatus.getByRole("button").first();
  const currentLabel = await showCurrent.innerText();
  await openNativeDetails(card.locator("details", {
    hasText: "Set exceptions",
  }));
  await card.getByRole("button", { name: "Skip set", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Skip set / });
  await dialog.getByLabel("Reason").selectOption("time");
  await dialog.getByRole("button", { name: "Skip item", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => showCurrent.innerText())
    .not.toBe(currentLabel);
  card = await openCurrentExerciseCard(page);
  await openNativeDetails(
    card.locator("details", {
      hasText: "Set exceptions",
    }),
  );
  await expect(
    card.getByRole("button", { name: "Skip set", exact: true }),
  ).toBeEnabled();
}

async function discardWorkout(page: Page) {
  if (!/\/session\/[0-9a-f-]+(?:#.*)?$/.test(page.url())) return;
  await page.getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ }).click();
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

async function chooseFontSize(
  page: Page,
  name: RegExp,
  key: string,
  returnUrl = "/today",
) {
  await page.goto("/settings");
  const choice = page.getByRole("radio", { name });
  await waitForHydratedReactHandler(choice);
  await choice.click();
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByText("Saved to your profile.", { exact: true }),
  ).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe(key);
  await page.goto(returnUrl);
}

test("keeps truthful saved-equipment preparation compact beside the current action", async ({
  page,
}, testInfo) => {
  await signIn(page);
  await chooseFontSize(page, /^Default/, "default");
  await startDayA(page);

  const preparation = page.getByTestId("session-preparation-panel");
  const warmup = page.locator("#workout-warmup");
  const currentCard = page.getByTestId("current-exercise-card");
  await expect(preparation).toBeVisible();
  await expect(preparation).toContainText("Equipment ready");
  await expect(preparation).toContainText("Saved equipment covers this workout.");
  await expect(
    preparation.getByRole("link", {
      name: "Go to first exercise",
      exact: true,
    }),
  ).toBeVisible();
  const equipmentList = preparation.locator("details").filter({
    hasText: "Review equipment list",
  });
  await expect(warmup).toHaveCount(0);
  await expect(equipmentList).not.toHaveAttribute("open", "");
  await expect(
    preparation.getByText("Review equipment list", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.locator(
      '[data-testid="current-exercise-card"], [data-testid="session-preparation-panel"]',
    ).evaluateAll((elements) => elements.map((element) =>
      element.getAttribute("data-testid")
    )))
    .toEqual(["current-exercise-card", "session-preparation-panel"]);

  await page.setViewportSize({ width: 390, height: 844 });
  await preparation.scrollIntoViewIfNeeded();
  const defaultGeometry = await preparation.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const continueLink = element.querySelector("a");
    const continueBox = continueLink?.getBoundingClientRect() ?? null;
    return {
      height: box.height,
      left: box.left,
      right: box.right,
      viewportWidth: window.innerWidth,
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
      continueWidth: continueBox?.width ?? 0,
      continueHeight: continueBox?.height ?? 0,
    };
  });
  expect(defaultGeometry.height).toBeLessThanOrEqual(460);
  expect(defaultGeometry.left).toBeGreaterThanOrEqual(0);
  expect(defaultGeometry.right).toBeLessThanOrEqual(
    defaultGeometry.viewportWidth + 1,
  );
  expect(defaultGeometry.rootFontSize).toBeCloseTo(18.4, 1);
  expect(defaultGeometry.continueWidth).toBeGreaterThanOrEqual(44);
  expect(defaultGeometry.continueHeight).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalOverflow(page);
  await equipmentList.locator(":scope > summary").click();
  await expect(equipmentList).toHaveAttribute("open", "");
  await expect(equipmentList).toContainText("Prepare");
  await expect(equipmentList).toContainText("In saved equipment");
  await expect(equipmentList.locator("li")).not.toHaveCount(0);
  await expect(equipmentList).not.toContainText(
    /\b\d+(?:\.\d+)?\s*(?:lb|kg)\b/i,
  );
  await expect(equipmentList.getByRole("checkbox")).toHaveCount(0);
  await equipmentList.locator(":scope > summary").click();
  await expect(equipmentList).not.toHaveAttribute("open", "");
  await page.screenshot({
    path: resolve(
      "output/playwright/superset-prep",
      `${testInfo.project.name}-preparation-390-default.png`,
    ),
    fullPage: true,
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("session-preparation-panel")).toBeVisible();
  await expect(page.getByTestId("session-preparation-panel")).toContainText(
    "Equipment ready",
  );
  await expect(
    page
      .getByTestId("session-preparation-panel")
      .getByText("Review equipment list", { exact: true }),
  ).toBeVisible();

  const activeWorkoutUrl = page.url();
  await chooseFontSize(
    page,
    /^Extra large/,
    "extra-large",
    activeWorkoutUrl,
  );
  await expect(page.getByTestId("session-preparation-panel")).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 });
  await expect
    .poll(() => page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    ))
    .toBeCloseTo(23.2, 1);
  await expectNoHorizontalOverflow(page);
  await expect(warmup).toHaveCount(0);
  const continueLink = page
    .getByTestId("session-preparation-panel")
    .getByRole("link", { name: "Go to first exercise", exact: true });
  const continueTarget = (await continueLink.getAttribute("href"))?.slice(1);
  expect(continueTarget).toMatch(/^set-entry-/);
  const continueBox = await continueLink.boundingBox();
  expect(continueBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(continueBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: resolve(
      "output/playwright/superset-prep",
      `${testInfo.project.name}-preparation-320-xl.png`,
    ),
    fullPage: true,
  });

  await continueLink.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate((targetId) => {
      return document.activeElement?.closest(
        `#${CSS.escape(targetId)}`,
      ) != null;
    }, continueTarget!))
    .toBe(true);
  await expect(page).toHaveURL(/#set-entry-/);

  await currentCard
    .getByRole("button", { name: "Log set", exact: true })
    .click();
  const receipt = page.getByTestId("active-set-save-receipt");
  await expect(receipt).toHaveCount(1);
  await expect(receipt).toContainText("Acknowledged by Repbook");
  await expect(page.getByTestId("active-workout-sticky-summary")).toContainText(
    "1/13 planned",
  );
  await page.reload({ waitUntil: "networkidle" });
  const collapsedPreparation = page.locator(
    'details[data-testid="session-preparation-panel"]',
  );
  await expect(collapsedPreparation).toBeVisible();
  await expect(collapsedPreparation).not.toHaveAttribute("open", "");
  await expect(collapsedPreparation).toContainText("Workout equipment");

  const showCurrent = page.getByRole("complementary", {
    name: "Workout status",
  }).getByRole("button").first();
  await expect(showCurrent).toBeVisible();
  await expect(showCurrent).toContainText(/Set 2 of 3|Resting/);

  await discardWorkout(page);
});

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
    const navigationRect = navigation?.getBoundingClientRect() ?? null;
    const navigationVisible =
      navigation != null &&
      getComputedStyle(navigation).display !== "none" &&
      (navigationRect?.height ?? 0) > 0;
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
      navigationTop: navigationVisible
        ? navigationRect?.top ?? window.innerHeight
        : window.innerHeight,
      navigationVisible,
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
  expect(geometry.navigationVisible).toBe(false);
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

  const laterMemberCard = page.locator('section[id^="exercise-"]').filter({
    has: page.getByRole("heading", {
      level: 2,
      name: "Pallof Press",
      exact: true,
    }),
  }).first();
  const laterMemberToggle = laterMemberCard.locator(":scope > button");
  await laterMemberToggle.click();
  await expect(laterMemberToggle).toHaveAttribute("aria-expanded", "true");
  await expect(laterMemberCard).toContainText(
    "Reach this set in the workout flow",
  );
  await expect(
    laterMemberCard.getByRole("button", { name: "Log set", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button")
    .first()
    .click();
  await expect(
    page.getByTestId("current-exercise-card").getByRole("button", {
      name: "Log set",
      exact: true,
    }),
  ).toBeVisible();

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
  await expect(
    page.getByRole("button", { name: "Open unsaved workout changes" }),
  ).toHaveCount(0);
  await expect(restoredGroup).toContainText("Prepare for Pallof Press");
  await expectNoHorizontalOverflow(page);

  const currentCard = page.getByTestId("current-exercise-card");
  await expect(currentCard.getByRole("heading", { level: 2 })).toHaveText(
    "Dumbbell Lateral Raise",
  );
  const currentToggle = currentCard.locator(":scope > button");
  await expect(currentToggle).toHaveAttribute("aria-expanded", "true");
  await currentToggle.click();
  await expect(currentToggle).toHaveAttribute("aria-expanded", "false");
  const showCurrent = page
    .getByRole("complementary", { name: "Workout status" })
    .locator("button")
    .first();
  await expect(showCurrent).toHaveAccessibleName(
    "Show Dumbbell Lateral Raise, Set 1",
  );
  await showCurrent.click();
  await expect(currentToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/#set-entry-/);
  const currentActionUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(currentActionUrl);
  await expect(currentCard.getByRole("heading", { level: 2 })).toHaveText(
    "Dumbbell Lateral Raise",
  );
  await openNativeDetails(currentCard.locator("details", {
    hasText: "Set exceptions",
  }));
  await expect(
    currentCard.getByRole("button", { name: "Skip set", exact: true }),
  ).toBeVisible();
  const currentEntryId = await currentCard
    .getByTestId("current-set-entry")
    .getAttribute("id");
  const currentOccurrenceId = currentEntryId?.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )?.[0];
  expect(currentOccurrenceId).toBeTruthy();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await currentCard
    .getByRole("button", { name: "Skip set", exact: true })
    .click();
  const groupSkip = page.getByRole("dialog", { name: /^Skip set / });
  await groupSkip.getByLabel("Reason").selectOption("time");
  await groupSkip
    .getByRole("button", { name: "Skip item", exact: true })
    .click();
  await expect(groupSkip).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open unsaved workout changes" }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem(
      "workout-tracker:occurrence-mutation-outbox:v1",
    );
    const entries = raw == null ? [] : JSON.parse(raw).entries ?? [];
    return entries.map((entry: {
      occurrenceId?: unknown;
      operation?: unknown;
      reason?: unknown;
      label?: unknown;
      status?: unknown;
    }) => ({
      occurrenceId: entry.occurrenceId,
      operation: entry.operation,
      reason: entry.reason,
      label: entry.label,
      status: entry.status,
    }));
  })).toEqual([{
    occurrenceId: currentOccurrenceId,
    operation: "skip",
    reason: "time",
    label: "Working set",
    status: "queued",
  }]);
  await expect(currentCard.getByRole("heading", { level: 2 })).toHaveText(
    "Dumbbell Lateral Raise",
  );
  await expect(currentCard).toContainText("Skip · Unsaved");
  await expect(currentCard).toContainText(
    "will not advance until Repbook acknowledges this change",
  );
  await expect(restoredGroup).toContainText(
    "Current member: 1 of 2 · Dumbbell Lateral Raise",
  );
  const pendingGuidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  await expect(pendingGuidance).toContainText("9 skipped");
  await expect(pendingGuidance).toContainText(
    /Now: Superset, round 1, member 1 of 2: Dumbbell Lateral Raise, set 1/,
  );
  await page.context().setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(currentCard.getByRole("heading", { level: 2 })).toHaveText(
    "Pallof Press",
  );
  await expect(currentCard.locator(":scope > button")).toHaveAttribute(
    "aria-expanded",
    "true",
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
  await expect(advancedGuidance).not.toContainText("Next:");
  await expect(currentCard).toContainText("Next action");
  await expect(currentCard).toContainText(
    "Superset, round 2, member 1 of 2: Dumbbell Lateral Raise, set 2",
  );
  await expect(
    page.getByRole("button", { name: "Open unsaved workout changes" }),
  ).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(currentCard.getByRole("heading", { level: 2 })).toHaveText(
    "Pallof Press",
  );
  await expect(restoredGroup).toContainText(
    "Current member: 2 of 2 · Pallof Press",
  );

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
