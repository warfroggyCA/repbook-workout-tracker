import { expect, test, type Locator } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedFormSubmit,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const isCI = Boolean(process.env.CI);
let workoutMayBeActive = false;

/**
 * Intentionally coupled to the pinned React 19.2.4 DOM internals: React assigns
 * __reactProps$ during host hydration. A React upgrade should fail here clearly.
 */
async function waitForReactHandler(locator: Locator) {
  await expect
    .poll(
      async () => {
        if ((await locator.count()) !== 1) return false;
        return locator.evaluate((element) => {
          const propsKey = Object.getOwnPropertyNames(element).find((name) =>
            name.startsWith("__reactProps$")
          );
          if (!propsKey) return false;
          const props = (element as unknown as Record<string, unknown>)[propsKey];
          return (
            typeof props === "object" &&
            props !== null &&
            typeof (props as { onClick?: unknown }).onClick === "function"
          );
        });
      },
      { timeout: isCI ? 30_000 : 10_000 }
    )
    .toBe(true);
}

async function expectMinimumWorkoutTouchTargets(scope: Locator) {
  const undersized = await scope
    .locator("button:visible, input:visible, textarea:visible")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label:
              element.getAttribute("aria-label") ??
              element.textContent?.trim() ??
              element.getAttribute("name") ??
              element.tagName,
            width: rect.width,
            height: rect.height,
          };
        })
        .filter((target) => target.width < 44 || target.height < 44)
    );
  expect(undersized).toEqual([]);
}

async function signIn(
  page: import("@playwright/test").Page,
  email = "owner@example.com",
  expectedLanding: RegExp = /\/today$/
) {
  const signInResponse = await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page
    .getByPlaceholder("allowlisted email")
    .fill(email);
  const devLogin = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(devLogin);
  await devLogin.click();
  await expect(page).toHaveURL(expectedLanding);
  await page.waitForLoadState("networkidle");
  return signInResponse;
}

async function confirmActiveWorkoutDiscard(
  page: import("@playwright/test").Page
) {
  const discard = page.getByRole("button", {
    name: "Discard workout",
    exact: true,
  });
  await waitForReactHandler(discard);
  await discard.click();
  const confirmation = page.getByRole("dialog", { name: /Discard .*\?$/ });
  await expect(confirmation).toContainText(
    "this active workout cannot be resumed afterward"
  );
  await confirmation
    .getByRole("button", {
      name: /^(?:Confirm discard|Discard current device copies & abandon)$/,
    })
    .click();
}

async function signInAndStartWorkout(page: import("@playwright/test").Page) {
  const signInResponse = await signIn(page);
  workoutMayBeActive = true;
  const resumeWorkout = page.getByRole("button", {
    name: "Resume workout",
    exact: true,
  });
  const startWorkout = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await expect
    .poll(
      async () => {
        if ((await resumeWorkout.count()) > 0) return "resume";
        if ((await startWorkout.count()) > 0) return "start";
        return "loading";
      },
      { timeout: 30_000 }
    )
    .toMatch(/^(resume|start)$/);
  // This suite shares one database and the afterEach cleanup only runs in CI,
  // so an earlier journey may still hold the single active workout. Only one
  // unarchived active workout may exist, and Today then offers Resume instead
  // of Train as planned; discard it so this journey starts from a known state.
  if ((await resumeWorkout.count()) > 0) {
    await waitForReactHandler(resumeWorkout);
    await resumeWorkout.click();
    await expect(page).toHaveURL(/\/session\/[0-9a-f-]+(?:#.*)?$/);
    await page
      .getByRole("complementary", { name: "Workout status" })
      .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
      .click();
    await confirmActiveWorkoutDiscard(page);
    await expect(page).toHaveURL(/\/today$/);
  }
  await waitForReactHandler(startWorkout);
  await startWorkout.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
  return signInResponse;
}

async function abandonActiveWorkout(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext
) {
  await context.setOffline(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.clearCookies();
  await signIn(page);

  await page.evaluate(() => {
    localStorage.removeItem("workout-tracker:workout-set-outbox:v1");
    window.dispatchEvent(new Event("workout-set-outbox-change"));
  });
  await page.reload();

  const resumeWorkout = page.getByRole("button", {
    name: "Resume workout",
    exact: true,
  });
  const startWorkout = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await expect
    .poll(
      async () => {
        if ((await resumeWorkout.count()) > 0) return "resume";
        if ((await startWorkout.count()) > 0) return "start";
        return "loading";
      },
      { timeout: 30_000 }
    )
    .toMatch(/^(resume|start)$/);
  if ((await resumeWorkout.count()) === 0) return;

  await waitForReactHandler(resumeWorkout);
  await resumeWorkout.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+(?:#.*)?$/);
  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  await confirmActiveWorkoutDiscard(page);
  await expect(page).toHaveURL(/\/today$/);
}

test.beforeEach(() => {
  workoutMayBeActive = false;
});

test.afterEach(async ({ page, context }) => {
  if (!isCI || !workoutMayBeActive) return;
  await abandonActiveWorkout(page, context);
});

async function verifyDecisiveToday({
  page,
}: {
  page: import("@playwright/test").Page;
}) {
  await installNextDevelopmentRefreshControl(page);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.setViewportSize({ width: 320, height: 700 });
  await signIn(page);
  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForReactHandler(extraLarge);
  await extraLarge.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();

  await page.goto("/today");
  const decision = page.getByTestId("today-decision");
  const trainAsPlanned = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  const decisionStatus = decision.locator(
    '[aria-label^="Program decision status"]'
  );
  const alternateDays = page.getByTestId("alternate-program-days");
  const alternateSummary = alternateDays.locator("summary");
  const dayC = page.getByRole("button", { name: /Day C — Bench/ });
  const responsiveViewports = [
    { width: 320, height: 700 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ] as const;

  await expect(
    page.getByRole("heading", { name: "Day B — Hinge", exact: true })
  ).toBeVisible();
  await expect(decision).toContainText(
    "Why this day: Next after Day A — Squat, completed today."
  );
  await expect(trainAsPlanned).toBeVisible();
  await expect(decisionStatus).toBeVisible();
  await expect(page.getByText("Adapt today", { exact: true })).toHaveCount(0);
  await expect(alternateDays).not.toHaveAttribute("open", "");
  await expect(alternateSummary).toBeVisible();
  await expect(dayC).toBeHidden();

  const firstViewport = await decision.evaluate((element) => {
    const primary = element.querySelector("form button");
    const status = element.querySelector(
      '[aria-label^="Program decision status"]'
    );
    const supporting = element.querySelector(
      '[data-testid="today-supporting-context"]'
    );
    const bottomNavigation = document.querySelector("nav.fixed");
    if (!primary || !status || !supporting || !bottomNavigation) return null;
    const primaryRect = primary.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    const navigationRect = bottomNavigation.getBoundingClientRect();
    return {
      primaryBottom: Math.round(primaryRect.bottom),
      statusBottom: Math.round(statusRect.bottom),
      navigationTop: Math.round(navigationRect.top),
      primaryClipped: primary.scrollWidth > primary.clientWidth + 1,
      statusClipped: status.scrollWidth > status.clientWidth + 1,
      pageOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
      decisionPrecedesSupporting:
        Boolean(
          primary.compareDocumentPosition(status) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ) &&
        Boolean(
          status.compareDocumentPosition(supporting) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ),
    };
  });
  expect(firstViewport).not.toBeNull();
  expect(firstViewport?.primaryBottom).toBeLessThanOrEqual(
    firstViewport?.navigationTop ?? 0
  );
  expect(firstViewport?.statusBottom).toBeLessThanOrEqual(
    firstViewport?.navigationTop ?? 0
  );
  expect(firstViewport?.primaryClipped).toBe(false);
  expect(firstViewport?.statusClipped).toBe(false);
  expect(firstViewport?.pageOverflow).toBe(false);
  expect(firstViewport?.decisionPrecedesSupporting).toBe(true);

  for (const viewport of responsiveViewports) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1
        )
      )
      .toBe(true);
    const responsiveDecision = await decision.evaluate((element) => {
      const primary = element.querySelector("form button");
      const status = element.querySelector(
        '[aria-label^="Program decision status"]'
      );
      if (!primary || !status) return null;
      const primaryRect = primary.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      return {
        primaryBottom: primaryRect.bottom,
        statusBottom: statusRect.bottom,
        primaryClipped: primary.scrollWidth > primary.clientWidth + 1,
        statusClipped: status.scrollWidth > status.clientWidth + 1,
      };
    });
    expect(responsiveDecision).not.toBeNull();
    expect(responsiveDecision?.primaryBottom).toBeLessThanOrEqual(
      viewport.height
    );
    expect(responsiveDecision?.statusBottom).toBeLessThanOrEqual(
      viewport.height
    );
    expect(responsiveDecision?.primaryClipped).toBe(false);
    expect(responsiveDecision?.statusClipped).toBe(false);
  }
  await page.setViewportSize({ width: 320, height: 700 });

  await trainAsPlanned.focus();
  await expect(trainAsPlanned).toBeFocused();
  await trainAsPlanned.press("Tab");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label") ??
        document.activeElement?.textContent?.trim() ??
        ""
      )
    )
    .toMatch(/^(Program decision status|Preview planned exercises)/);
  await alternateSummary.focus();
  await expect(alternateSummary).toBeFocused();
  await alternateSummary.press("Enter");
  await expect(alternateDays).toHaveAttribute("open", "");
  await expect(dayC).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Supporting actions", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record activity", exact: true })
  ).toBeVisible();
  await expect(page.getByPlaceholder(/e\.g\. "Bench 135/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent training", exact: true })
  ).toBeVisible();

  workoutMayBeActive = true;
  await trainAsPlanned.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: "Day B — Hinge", exact: true })
  ).toBeVisible();
  await waitForEquipmentSelectionsToSettle(page);

  await page.goto("/today");
  await expect(
    page.getByRole("heading", { name: "Day B — Hinge", exact: true })
  ).toBeVisible();
  const resume = page.getByRole("button", {
    name: "Resume workout",
    exact: true,
  });
  const activeDecision = page.getByTestId("today-decision");
  await expect(resume).toBeVisible();
  await expect(activeDecision).toContainText(
    "Saved sets and notes are retained.",
  );
  await expect(page.getByTestId("alternate-program-days")).toHaveCount(0);
  await expect(page.getByText("Adapt today", { exact: true })).toHaveCount(0);

  for (const viewport of responsiveViewports) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1
        )
      )
      .toBe(true);
    const responsiveActiveDecision = await activeDecision.evaluate((element) => {
      const primary = element.querySelector('[data-slot="button"]');
      const status = element.querySelector(
        '[aria-label^="Program decision status"]'
      );
      const bottomNavigation = document.querySelector("nav.fixed");
      if (!primary || !status) return null;
      const primaryRect = primary.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      return {
        primaryBottom: primaryRect.bottom,
        statusBottom: statusRect.bottom,
        navigationTop:
          bottomNavigation?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
        primaryClipped: primary.scrollWidth > primary.clientWidth + 1,
        statusClipped: status.scrollWidth > status.clientWidth + 1,
      };
    });
    expect(responsiveActiveDecision).not.toBeNull();
    expect(responsiveActiveDecision?.primaryBottom).toBeLessThanOrEqual(
      viewport.height
    );
    expect(responsiveActiveDecision?.statusBottom).toBeLessThanOrEqual(
      viewport.height
    );
    if (viewport.width <= 390) {
      expect(responsiveActiveDecision?.primaryBottom).toBeLessThanOrEqual(
        responsiveActiveDecision?.navigationTop ?? 0
      );
      expect(responsiveActiveDecision?.statusBottom).toBeLessThanOrEqual(
        responsiveActiveDecision?.navigationTop ?? 0
      );
    }
    expect(responsiveActiveDecision?.primaryClipped).toBe(false);
    expect(responsiveActiveDecision?.statusClipped).toBe(false);
  }
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => {
    localStorage.setItem(
      "workout-tracker:workout-set-outbox:v1",
      JSON.stringify({
        version: 1,
        entries: [{ privateValue: "must-stay-private" }],
      })
    );
    window.dispatchEvent(new Event("workout-set-outbox-change"));
  });
  await page.getByRole("button", { name: "Discard this workout", exact: true }).click();
  const discardDialog = page.getByRole("dialog", { name: /Discard Day B — Hinge/ });
  await expect(discardDialog).toContainText(
    "Saved history is retained",
  );
  // An unreadable copy cannot be attributed to this workout. Exiting remains
  // reachable, the dialog never renders its raw private value, and abandoning
  // this workout must leave the unscopable copy byte-for-byte intact.
  await expect(discardDialog).toContainText(
    "1 unreadable set copy may belong to this or another workout.",
  );
  await expect(
    discardDialog.getByRole("button", {
      name: "Confirm discard",
      exact: true,
    })
  ).toBeEnabled();
  await expect(discardDialog).not.toContainText("must-stay-private");
  const unreadableCopyBeforeDiscard = await page.evaluate(() =>
    localStorage.getItem("workout-tracker:workout-set-outbox:v1")
  );
  await discardDialog
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
  expect(await page.evaluate(() =>
    localStorage.getItem("workout-tracker:workout-set-outbox:v1")
  )).toBe(unreadableCopyBeforeDiscard);
  workoutMayBeActive = false;
  await page.evaluate(() => {
    localStorage.removeItem("workout-tracker:workout-set-outbox:v1");
    window.dispatchEvent(new Event("workout-set-outbox-change"));
  });

  const reopenedAlternates = page.getByTestId("alternate-program-days");
  await reopenedAlternates.locator("summary").click();
  const reopenedDayC = page.getByRole("button", { name: /Day C — Bench/ });
  await expect(reopenedDayC).toBeVisible();
  workoutMayBeActive = true;
  await reopenedDayC.click();
  const startReopenedDayC = page.getByRole("button", {
    name: "Start workout",
    exact: true,
  });
  await waitForHydratedServerAction(startReopenedDayC);
  await startReopenedDayC.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: "Day C — Bench", exact: true })
  ).toBeVisible();
  const finishReopenedWorkout = page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", {
      name: /^(?:Review workout finish|Finish workout)$/,
    });
  await waitForReactHandler(finishReopenedWorkout);
  await finishReopenedWorkout.click();
  await confirmActiveWorkoutDiscard(page);
  await expect(page).toHaveURL(/\/today$/);
  workoutMayBeActive = false;

  await page.goto("/settings");
  const defaultSize = page.getByRole("radio", { name: /Default 115%/ });
  await waitForReactHandler(defaultSize);
  await defaultSize.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("default");
  expect(browserErrors).toEqual([]);
}

async function verifyNoHistoryToday({
  page,
}: {
  page: import("@playwright/test").Page;
}) {
  await installNextDevelopmentRefreshControl(page);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "today-empty.e2e@example.com");

  const decision = page.getByTestId("today-decision");
  await expect(
    page.getByRole("heading", {
      name: "Day One — Foundation",
      exact: true,
    })
  ).toBeVisible();
  await expect(decision).toContainText(
    "Why this day: First in the Program because no Program day is complete yet."
  );
  await expect(
    page.getByRole("button", { name: "Train as planned", exact: true })
  ).toBeVisible();
  await expect(decision).toContainText("No Program changes pending");
  await expect(page.getByText("Adapt today", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("alternate-program-days")).toHaveCount(0);

  await expect(
    page.getByRole("heading", { name: "Supporting actions", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record activity", exact: true })
  ).toBeVisible();
  await expect(page.getByPlaceholder(/e\.g\. "Bench 135/)).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No completed workouts yet",
      exact: true,
    })
  ).toBeVisible();
  await expect(
    page.getByText(
      "Statistics and streaks will appear after your first completed workout.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    page.getByText(
      "Completed workouts will appear here after your first one.",
      { exact: true }
    )
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
      )
    )
    .toBe(true);
  expect(browserErrors).toEqual([]);
}

async function verifyReviewAndDecisions({
  page,
}: {
  page: import("@playwright/test").Page;
}) {
  await installNextDevelopmentRefreshControl(page);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.setViewportSize({ width: 320, height: 700 });
  await signIn(page, "review-decisions.e2e@example.com");
  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForReactHandler(extraLarge);
  await extraLarge.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        preference: document.documentElement.dataset.fontSize,
        rootSize: getComputedStyle(document.documentElement).fontSize,
      }))
    )
    .toEqual({ preference: "extra-large", rootSize: "23.2px" });

  await page.goto("/today");
  const decisionLink = page.locator(
    '[aria-label^="Program decision status: 2 changes need review"]'
  );
  await expect(decisionLink).toContainText("2 Program changes pending");
  await expect(decisionLink).toHaveAttribute("href", "/coach");
  await decisionLink.focus();
  await expect(decisionLink).toBeFocused();
  await decisionLink.press("Enter");
  await expect(page).toHaveURL(/\/coach$/);
  await expect(
    page.getByRole("heading", { name: "Review and decisions", exact: true })
  ).toBeVisible();
  const activeReviewLink = page
    .locator("nav.fixed")
    .getByRole("link", { name: "Review", exact: true });
  await expect(activeReviewLink).toBeVisible();
  await expect(activeReviewLink).toHaveAttribute("aria-current", "page");

  const expectedSectionOrder = [
    "Decisions needing review",
    "Recent decisions",
    "Outcomes ready to assess",
    "Live Coach stays with the workout",
    "Secondary coaching tools",
  ];
  const topLevelHeadings = await page
    .getByRole("heading", { level: 2 })
    .allTextContents();
  expect(
    topLevelHeadings.filter((heading) => expectedSectionOrder.includes(heading))
  ).toEqual(expectedSectionOrder);

  const pendingRegion = page.getByRole("region", {
    name: "Decisions needing review",
  });
  await expect(pendingRegion.getByText("2 pending", { exact: true })).toBeVisible();
  await expect(
    pendingRegion.getByText("Decision required", { exact: true })
  ).toHaveCount(1);
  await expect(
    pendingRegion.getByText("Automatic status", { exact: true })
  ).toHaveCount(1);
  await expect(
    pendingRegion.getByRole("heading", { name: "Observed basis", exact: true })
  ).toHaveCount(2);
  await expect(
    pendingRegion.locator("dt").filter({ hasText: "Confidence" })
  ).toHaveCount(2);
  await expect(pendingRegion.getByText("Not scored", { exact: true })).toHaveCount(2);
  await expect(pendingRegion.getByText("Linked completed workouts")).toHaveCount(2);
  const benchHold = pendingRegion
    .locator("section")
    .filter({ hasText: "Barbell Bench Press" })
    .first();
  await expect(benchHold.getByText("Load held", { exact: true })).toBeVisible();
  await expect(
    benchHold.getByText(
      "A workout with no pain entry doesn't shorten that time.",
      { exact: false }
    )
  ).toBeVisible();
  await expect(
    benchHold.getByRole("button", { name: "Dismiss notice", exact: true })
  ).toBeVisible();
  await expect(
    benchHold.getByRole("button", { name: "Approve", exact: true })
  ).toHaveCount(0);
  await expect(
    benchHold.getByRole("button", { name: "Reject", exact: true })
  ).toHaveCount(0);
  const squatDecisionEvidence = pendingRegion
    .locator("section")
    .filter({ hasText: "Barbell Back Squat" })
    .first();
  for (const [label, value] of [
    ["Linked completed workouts", "2"],
    ["Linked working sets", "6"],
    ["Clean completed workouts", "2"],
    ["Previous target", "105 lb"],
    ["Suggested target", "110 lb"],
  ] as const) {
    const evidenceTerm = squatDecisionEvidence
      .locator("dt")
      .filter({ hasText: label });
    await expect(evidenceTerm).toBeVisible();
    await expect(
      evidenceTerm.locator("xpath=following-sibling::dd[1]")
    ).toHaveText(value);
  }
  await expect(
    squatDecisionEvidence.getByRole("status", { name: "Adjusted load" })
  ).toHaveText("110");

  const recentRegion = page.getByRole("region", { name: "Recent decisions" });
  await expect(recentRegion.getByText("Accepted", { exact: true })).toHaveCount(2);
  await expect(recentRegion.getByText("Rejected", { exact: true })).toHaveCount(1);
  await expect(recentRegion.getByText("Expired", { exact: true })).toHaveCount(1);
  await expect(recentRegion.getByText("Undone", { exact: true })).toHaveCount(1);

  const outcomesRegion = page.getByRole("region", {
    name: "Outcomes ready to assess",
  });
  await expect(
    outcomesRegion.getByText("Ready to assess", { exact: true })
  ).toHaveCount(2);
  const squatOutcome = outcomesRegion.locator("li").filter({
    hasText: "Barbell Back Squat",
  });
  await expect(squatOutcome).toContainText("2 workouts · 6 sets");
  await expect(squatOutcome).toContainText("6/6 met");
  const benchOutcome = outcomesRegion.locator("li").filter({
    hasText: "Barbell Bench Press",
  });
  await expect(benchOutcome).toContainText("Not recorded");
  await expect(benchOutcome).toContainText(
    "Evidence is limited: target results or effort are missing for one or more recorded sets."
  );
  await expect(benchOutcome).toContainText("1 positive report · max 4/10");

  const liveCoachContext = page.getByRole("region", {
    name: "Live Coach stays with the workout",
  });
  await expect(liveCoachContext.getByRole("link", { name: "Go to Today" })).toBeVisible();
  const historyLink = liveCoachContext.getByRole("link", {
    name: "Review completed workouts",
  });
  await expect(historyLink).toHaveAttribute("href", "/history");
  await waitForReactHandler(historyLink);
  await historyLink.click();
  await expect(page).toHaveURL(/\/history$/);
  await page.goto("/coach");
  await expect(
    page.getByRole("heading", { name: "Review and decisions", exact: true })
  ).toBeVisible();

  const latestOutcomeLink = outcomesRegion.getByRole("link").first();
  await waitForReactHandler(latestOutcomeLink);
  await latestOutcomeLink.click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", {
      name: "Workout Coach conversation",
      exact: true,
    })
  ).toBeVisible();
  await expect(
    page.getByText("Shoulder felt tight after the final bench set.", {
      exact: true,
    })
  ).toBeVisible();
  await page.goto("/coach");
  await expect(
    page.getByRole("heading", { name: "Review and decisions", exact: true })
  ).toBeVisible();

  const secondaryRegion = page.getByRole("region", {
    name: "Secondary coaching tools",
  });
  await expect(
    secondaryRegion.getByRole("button", {
      name: "Create a fresh review",
      exact: true,
    })
  ).toBeVisible();
  await expect(
    secondaryRegion.getByRole("textbox", { name: "Question for Coach" })
  ).toBeVisible();
  const coreBeforeTools = await page.evaluate(() => {
    const outcomes = document.querySelector('[aria-labelledby="outcomes-heading"]');
    const secondary = document.querySelector(
      '[aria-labelledby="secondary-tools-heading"]'
    );
    if (!outcomes || !secondary) return false;
    return Boolean(outcomes.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(coreBeforeTools).toBe(true);

  const createReview = secondaryRegion.getByRole("button", {
    name: "Create a fresh review",
    exact: true,
  });
  await waitForReactHandler(createReview);
  await createReview.click();
  await expect(
    page.getByText("Your new training review is ready below.", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Latest training review", { exact: true })).toBeVisible();
  const question = "What evidence is still missing for my bench decision?";
  await secondaryRegion.getByRole("textbox", { name: "Question for Coach" }).fill(question);
  const askCoach = secondaryRegion.getByRole("button", {
    name: "Ask Coach",
    exact: true,
  });
  await waitForReactHandler(askCoach);
  await askCoach.click();
  await expect(page.getByText("Coach answered your question below.")).toBeVisible();
  await expect(page.getByText(question, { exact: true })).toBeVisible();
  await expect(pendingRegion.getByText("2 pending", { exact: true })).toBeVisible();

  const responsiveViewports = [
    { width: 320, height: 700 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ] as const;
  for (const viewport of responsiveViewports) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1
        )
      )
      .toBe(true);
    const actionButtons = pendingRegion.getByRole("button", {
      name: /^(Approve|Reject)$/,
    });
    for (let index = 0; index < (await actionButtons.count()); index += 1) {
      const button = actionButtons.nth(index);
      await button.evaluate((element) =>
        element.scrollIntoView({ block: "center", inline: "nearest" })
      );
      const geometry = await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const navigation = document.querySelector("nav.fixed");
        const navigationRect = navigation?.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          navigationTop: navigationRect?.top ?? Number.POSITIVE_INFINITY,
          navigationVisible: Boolean(
            navigation &&
              navigationRect &&
              navigationRect.width > 0 &&
              navigationRect.height > 0 &&
              getComputedStyle(navigation).visibility !== "hidden"
          ),
          clipped: element.scrollWidth > element.clientWidth + 1,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(geometry.clipped).toBe(false);
      if (geometry.navigationVisible) {
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.navigationTop + 1);
      }
    }
  }

  await page.setViewportSize({ width: 320, height: 700 });
  const squatDecision = pendingRegion
    .locator("section")
    .filter({ hasText: "Barbell Back Squat" })
    .first();
  const decrease = squatDecision.getByRole("button", {
    name: "Decrease load",
    exact: true,
  });
  await decrease.focus();
  await expect(decrease).toBeFocused();
  await decrease.press("Tab");
  await expect(
    squatDecision.getByRole("button", { name: "Increase load", exact: true })
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    squatDecision.getByText("Decide later", { exact: true })
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    squatDecision.getByRole("button", { name: "Approve", exact: true })
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    squatDecision.getByRole("button", { name: "Reject", exact: true })
  ).toBeFocused();

  const benchDecision = pendingRegion
    .locator("section")
    .filter({ hasText: "Barbell Bench Press" })
    .first();
  const dismissBenchHold = benchDecision.getByRole("button", {
    name: "Dismiss notice",
    exact: true,
  });
  await waitForReactHandler(dismissBenchHold);
  await dismissBenchHold.click();
  await expect(
    pendingRegion.getByRole("heading", {
      name: "Barbell Bench Press",
      exact: true,
    })
  ).toHaveCount(0);
  await expect(
    recentRegion.getByText("Dismissed", { exact: true })
  ).toHaveCount(1);

  const increaseSquat = squatDecision.getByRole("button", {
    name: "Increase load",
    exact: true,
  });
  await increaseSquat.click();
  const approveEdited = squatDecision.getByRole("button", {
    name: "Approve edited",
    exact: true,
  });
  await waitForReactHandler(approveEdited);
  await approveEdited.click();
  await expect(pendingRegion.getByText("0 pending", { exact: true })).toBeVisible();
  await expect(
    pendingRegion.getByText("Nothing needs your decision right now", {
      exact: true,
    })
  ).toBeVisible();
  await expect(recentRegion.getByText("Edited", { exact: true })).toBeVisible();
  await expect(recentRegion.getByText("Rejected", { exact: true })).toHaveCount(1);
  await expect(
    recentRegion.getByText("Dismissed", { exact: true })
  ).toHaveCount(1);

  await page.goto("/settings");
  const defaultSize = page.getByRole("radio", { name: /Default 115%/ });
  await waitForReactHandler(defaultSize);
  await defaultSize.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("default");
  expect(browserErrors).toEqual([]);
}

test("recovers one ready progression job through concurrent protected drainers", async ({
  page,
  request,
}) => {
  const unauthorized = await request.post("/api/maintenance/progression");
  expect(unauthorized.status()).toBe(401);

  const exerciseName = "Barbell Back Squat";

  const maintenanceHeaders = {
    authorization: "Bearer local-e2e-maintenance-secret",
  };
  const concurrentDrains = await Promise.all([
    request.post("/api/maintenance/progression", {
      headers: maintenanceHeaders,
    }),
    request.post("/api/maintenance/progression", {
      headers: maintenanceHeaders,
    }),
  ]);
  expect(concurrentDrains.map((response) => response.status())).toEqual([
    200,
    200,
  ]);
  const drainResults = await Promise.all(
    concurrentDrains.map((response) => response.json())
  );
  expect(
    drainResults.reduce(
      (total, result: { attempted: number }) => total + result.attempted,
      0
    )
  ).toBe(1);
  expect(
    drainResults.reduce(
      (total, result: { completed: number }) => total + result.completed,
      0
    )
  ).toBe(1);
  expect(
    drainResults.reduce(
      (
        total,
        result: {
          retryScheduled: number;
          permanentlyFailed: number;
          leaseLost: number;
        }
      ) =>
        total +
        result.retryScheduled +
        result.permanentlyFailed +
        result.leaseLost,
      0
    )
  ).toBe(0);
  await expect
    .poll(async () => {
      const response = await request.post("/api/maintenance/progression", {
        headers: maintenanceHeaders,
      });
      const result = (await response.json()) as {
        after: {
          ready: number;
          processing: number;
          expiredLeases: number;
          failed: number;
          exhausted: number;
        };
      };
      return {
        status: response.status(),
        ready: result.after.ready,
        processing: result.after.processing,
        expiredLeases: result.after.expiredLeases,
        failed: result.after.failed,
        exhausted: result.after.exhausted,
      };
    })
    .toEqual({
      status: 200,
      ready: 0,
      processing: 0,
      expiredLeases: 0,
      failed: 0,
      exhausted: 0,
    });

  await signIn(page);
  await expect
    .poll(
      async () => {
        await page.goto("/coach");
        return page
          .getByRole("region", { name: "Decisions needing review" })
          .getByText(exerciseName, { exact: true })
          .count();
      },
      { timeout: 20_000 }
    )
    .toBeGreaterThan(0);

  const suggestions = page.getByRole("region", {
    name: "Decisions needing review",
  });
  await expect(
    suggestions.getByText(exerciseName, { exact: true })
  ).toHaveCount(1);
  const exerciseSuggestion = suggestions
    .locator("section")
    .filter({ hasText: exerciseName });
  const approveSuggestion = exerciseSuggestion.getByRole("button", {
    name: "Approve",
    exact: true,
  });
  await waitForReactHandler(approveSuggestion);
  await approveSuggestion.click();
  await expect(suggestions.getByText(exerciseName, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Recent decisions", { exact: true })).toBeVisible();
  await expect(
    page.getByText(exerciseName, { exact: true }).last()
  ).toBeVisible();
});

test("shows the incomplete workout retry sentence on Today", async ({ page }) => {
  await signIn(page);
  await page.goto("/today?start=retry");
  await expect(
    page.getByRole("alert").filter({ hasText: "Workout not started" })
  ).toContainText(
    "The workout could not be created completely. Nothing was saved — try again."
  );
});

test(
  "makes Review and decisions truthful, decisive, contextual, and accessible",
  verifyReviewAndDecisions
);

test("shows honest empty Review and decisions states", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await signIn(page, "today-empty.e2e@example.com");
  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForReactHandler(extraLarge);
  await extraLarge.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        preference: document.documentElement.dataset.fontSize,
        rootSize: getComputedStyle(document.documentElement).fontSize,
      }))
    )
    .toEqual({ preference: "extra-large", rootSize: "23.2px" });
  await page.goto("/coach");
  await expect(
    page.getByRole("heading", { name: "Review and decisions", exact: true })
  ).toBeVisible();
  await expect(page.getByText("0 pending", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "No decisions have been proposed yet. Rule-based checks run from completed planned workouts and recorded pain evidence.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    page.getByText(
      "No decision history yet. This list begins after you accept, edit, or reject a proposal, dismiss an automatic notice, or when a proposal expires.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("No accepted decision has follow-up training to assess yet.", {
      exact: true,
    })
  ).toBeVisible();
  await expect(page.getByText("No generated review yet", { exact: true })).toBeVisible();
  await expect(page.getByText("No open-ended answers yet.")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
      )
    )
    .toBe(true);
  await page.goto("/settings");
  const defaultSize = page.getByRole("radio", { name: /Default 115%/ });
  await waitForReactHandler(defaultSize);
  await defaultSize.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("default");
});

test(
  "makes Today one decisive, accessible choice before supporting information",
  verifyDecisiveToday
);

test(
  "keeps the no-history Today state decisive and complete",
  verifyNoHistoryToday
);

test("answers all five History questions without mixing independent activity into strength evidence", async ({
  page,
  context,
  browserName,
}) => {
  await installNextDevelopmentRefreshControl(page);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const lensTitles = [
    "Progress",
    "Program fit",
    "Pain and constraints",
    "Work capacity",
    "Records",
  ] as const;
  const lensKeys = [
    "progress",
    "program-fit",
    "pain-constraints",
    "work-capacity",
    "records",
  ] as const;

  await signIn(page);
  await page.goto("/history?range=all");
  await expect(
    page.getByRole("heading", { name: "Calendar", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Training calendar", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Needs attention", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Five questions", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "Insights", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Five questions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Training calendar", exact: true }),
  ).toHaveCount(0);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "More History actions" }).click();
  await expect(
    page.locator('a[href="/api/export/csv?entity=sets&weeks=all"][download]'),
  ).toHaveAttribute("href", /\/api\/export\/csv\?entity=sets&weeks=all/);
  await expect(
    page.getByRole("link", { name: "All export options", exact: true }),
  ).toHaveAttribute("href", "/export");
  await expect(
    page.getByRole("link", { name: "Open Archive", exact: true }),
  ).toHaveAttribute("href", "/archive");
  await page.keyboard.press("Escape");

  for (const [index, title] of lensTitles.entries()) {
    await page.goto(
      `/history?range=all&view=insights&lens=${lensKeys[index]}`,
    );
    const lens = page.getByRole("article", { name: title, exact: true });
    await expect(lens).toBeVisible();
    await expect(
      lens.getByRole("region", { name: "Short answer", exact: true })
    ).toBeVisible();
    await expect(
      lens.getByRole("region", { name: "Supporting evidence", exact: true })
    ).toBeVisible();
    await expect(
      lens.getByRole("region", {
        name: "Confidence and data limitation",
        exact: true,
      })
    ).toBeVisible();
    await expect(
      lens.getByRole("region", { name: "Decision support", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(1);
  }

  await page.goto("/history?range=all&view=insights&lens=progress");
  const progressLens = page.getByRole("article", {
    name: "Progress",
    exact: true,
  });
  await expect(progressLens).toContainText(
    "Progress is uncertain; no exact exercise has two comparable best-set observations.",
  );
  await expect(progressLens).toContainText(
    "needs two comparable observations",
  );
  await expect(progressLens).toContainText("exact-exercise comparisons");

  await page.goto("/history?range=all&view=insights&lens=program-fit");
  const programLens = page.getByRole("article", {
    name: "Program fit",
    exact: true,
  });
  await expect(programLens).toContainText("Program workouts completed");
  await expect(programLens).toContainText("Deferred workouts are not recorded");
  await expect(programLens).toContainText(
    "not proof that every prescribed set was completed"
  );

  await page.goto("/history?range=all&view=insights&lens=pain-constraints");
  const painLens = page.getByRole("article", {
    name: "Pain and constraints",
    exact: true,
  });
  await expect(painLens).toContainText(
    "no repeated movement pattern is established"
  );
  await expect(painLens).toContainText("recorded associations, not causes");

  await page.goto("/history?range=all&view=insights&lens=work-capacity");
  const capacityLens = page.getByRole("article", {
    name: "Work capacity",
    exact: true,
  });
  await expect(capacityLens).toContainText(
    "Not enough comparable completed strength work is available to establish a workload trend.",
  );
  await expect(capacityLens).toContainText("2,280 lb vs 0 lb");
  await expect(capacityLens).toContainText("Completed working sets");
  await expect(capacityLens).toContainText("Average duration · latest half");
  await expect(
    capacityLens.getByRole("region", {
      name: "Independent activity context",
      exact: true,
    })
  ).toContainText("kept separate");
  await expect(
    page.getByRole("heading", { name: "Weekly workload", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Independent health activities",
      exact: true,
    }),
  ).toBeVisible();

  await page.goto("/history?range=all&view=insights&lens=records");
  const recordsLens = page.getByRole("article", {
    name: "Records",
    exact: true,
  });
  await expect(recordsLens).toContainText(
    "Showing best observed performances for 1 exact exercise variant.",
  );
  await expect(recordsLens).toContainText("Barbell Back Squat");
  await expect(recordsLens).toContainText("not durable all-time PR records");
  await expect(recordsLens).toContainText(
    "No Program decision is supported by records alone"
  );

  await page.goto("/history?range=all&view=insights&lens=program-fit");
  const reviewLink = programLens.getByRole("link", {
    name: "Open Review and decisions",
    exact: true,
  });
  await waitForReactHandler(reviewLink);
  await reviewLink.focus();
  await expect(reviewLink).toBeFocused();
  await reviewLink.press("Enter");
  await expect(page).toHaveURL(/\/coach$/);
  await expect(
    page.getByRole("heading", { name: "Review and decisions", exact: true })
  ).toBeVisible();
  await page.goto("/history?range=all&view=insights");
  await expect(
    page.getByRole("heading", { name: "Five questions", exact: true }),
  ).toBeVisible();

  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForReactHandler(extraLarge);
  await extraLarge.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("extra-large");

  for (const viewport of [
    { width: 320, height: 700 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/history?range=all&view=insights");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1
        )
      )
      .toBe(true);

    for (const title of lensTitles) {
      await expect(
        page.getByRole("link", { name: new RegExp(`^${title}\\b`) }),
      ).toBeVisible();
    }

    if (viewport.width === 320) {
      const viewNavigation = page.getByRole("navigation", {
        name: "History views",
      });
      const calendarView = viewNavigation.getByRole("link", {
        name: "Calendar",
        exact: true,
      });
      await calendarView.focus();
      await expect(calendarView).toBeFocused();
      if (browserName !== "webkit") {
        for (const title of ["Insights", "Exercises"]) {
          await page.keyboard.press("Tab");
          await expect(
            viewNavigation.getByRole("link", { name: title, exact: true })
          ).toBeFocused();
        }
      }
      await page.goto("/history?range=all&view=insights&lens=records");
      const records = page.getByRole("article", {
        name: "Records",
        exact: true,
      });
      expect(
        await records.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth + 1 &&
            element.scrollHeight <= element.clientHeight + 1,
        ),
      ).toBe(true);
      const finalDecision = records.getByRole("region", {
        name: "Decision support",
        exact: true,
      });
      await finalDecision.evaluate((element) =>
        element.scrollIntoView({ block: "center" })
      );
      const decisionBox = await finalDecision.boundingBox();
      const bottomNavigationBox = await page.locator("nav.fixed").boundingBox();
      expect(decisionBox).not.toBeNull();
      expect(bottomNavigationBox).not.toBeNull();
      expect(decisionBox!.y + decisionBox!.height).toBeLessThanOrEqual(
        bottomNavigationBox!.y
      );
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  const defaultSize = page.getByRole("radio", { name: /Default 115%/ });
  await waitForReactHandler(defaultSize);
  await defaultSize.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("default");

  await context.clearCookies();
  await signIn(page, "today-empty.e2e@example.com");
  const emptyAnswers = [
    "No strength-progress answer is available yet",
    "No Program-linked history is available",
    "No pain or discomfort-linked exercise changes",
    "Not enough comparable completed strength work",
    "No eligible supported performance observations",
  ];
  for (const [index, title] of lensTitles.entries()) {
    await page.goto(`/history?view=insights&lens=${lensKeys[index]}`);
    const lens = page.getByRole("article", { name: title, exact: true });
    await expect(lens).toContainText(emptyAnswers[index]);
    await expect(
      lens.getByRole("region", { name: "Decision support", exact: true })
    ).toContainText(/No (Program )?(decision|change)/);
  }

  await page.goto("/activity/new");
  await page.getByLabel("Title (optional)").fill("Release 1B.3 separation walk");
  await page.getByLabel("Minutes", { exact: true }).fill("90");
  await page.getByLabel("Distance (optional)").fill("7.5");
  const recordActivity = page.getByRole("button", {
    name: "Record activity",
    exact: true,
  });
  await waitForHydratedFormSubmit(recordActivity);
  await recordActivity.click();
  await expect(page).toHaveURL(/\/activity\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", {
      name: "Release 1B.3 separation walk",
      exact: true,
    })
  ).toBeVisible();
  await page.goto("/history?view=insights");
  const activitySummary = page
    .getByRole("heading", {
      name: "Independent activity summary",
      exact: true,
    })
    .locator("xpath=ancestor::*[@data-slot='card'][1]");
  await expect(activitySummary).toContainText("activities");
  await expect(activitySummary).toContainText("90");
  await expect(activitySummary).toContainText("7.5");
  await page.goto("/history?view=insights&lens=work-capacity");
  await expect(
    page
      .getByRole("article", { name: "Work capacity", exact: true })
      .getByRole("region", {
        name: "Independent activity context",
        exact: true,
      })
  ).toContainText("1 independent activity · 90 min");
  for (const [index, title] of lensTitles.entries()) {
    await page.goto(`/history?view=insights&lens=${lensKeys[index]}`);
    const strengthEvidence = page
      .getByRole("article", { name: title, exact: true })
      .getByRole("region", { name: "Supporting evidence", exact: true });
    await expect(strengthEvidence).not.toContainText(
      "Release 1B.3 separation walk"
    );
    await expect(strengthEvidence).not.toContainText(/7\.5(?:0)? km/);
  }
  await page.goto("/history?view=insights&lens=progress");
  await expect(
    page.getByRole("article", { name: "Progress", exact: true })
  ).toContainText("No strength-progress answer is available yet");
  await page.goto("/history?view=insights&lens=records");
  await expect(
    page.getByRole("article", { name: "Records", exact: true })
  ).toContainText("No eligible supported performance observations");
  const unexpectedBrowserErrors =
    browserName === "webkit" &&
    browserErrors.length === 2 &&
    browserErrors[0] === "Load failed" &&
    browserErrors[1] ===
      "/127.0.0.1:3100/__nextjs_original-stack-frames due to access control checks."
      ? []
      : browserErrors;
  expect(unexpectedBrowserErrors).toEqual([]);
});

test("signs in and completes a durable workout flow", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const signInResponse = await signInAndStartWorkout(page);
  expect(signInResponse?.headers()["content-security-policy"]).toContain(
    "default-src 'self'"
  );

  const firstExercise = page.locator('[id^="exercise-"]').first();
  const nextSet = page.getByTestId("current-exercise-card");
  const workoutStatus = page.getByRole("complementary", { name: "Workout status" });
  await expect(firstExercise).toBeVisible();
  await expect(nextSet.getByLabel("Total load")).toBeVisible();
  await expect(nextSet.getByText(/^Per side:/)).toBeVisible();
  const weight = nextSet.getByLabel("Total load");
  const reps = nextSet.getByRole("textbox", { name: "Reps", exact: true });
  await weight.fill("95");
  await reps.fill("8");
  await openNativeDetails(nextSet.locator("details", {
    hasText: "Optional effort and set note",
  }));
  await nextSet.getByRole("button", { name: /^Hard — RPE 8;/ }).click();
  await expect(nextSet.getByText("Selected: Hard — RPE 8", {
    exact: true,
  })).toBeVisible();
  await nextSet
    .getByRole("button", { name: "Enter exact RPE instead", exact: true })
    .click();
  await nextSet.getByRole("spinbutton", { name: "Exact RPE (1–10)" }).fill("8.5");
  let releaseSave!: () => void;
  const saveMayFinish = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saveStarted = false;
  await page.route("**/session/**", async (route) => {
    if (
      !saveStarted &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      saveStarted = true;
      await saveMayFinish;
    }
    await route.continue();
  });
  await nextSet
    .getByRole("button", { name: "Log set", exact: true })
    .click();
  await expect.poll(() => saveStarted).toBe(true);
  await expect(workoutStatus).toContainText("Resting");
  await expect(
    nextSet.getByRole("button", { name: "Log set", exact: true }),
  ).toBeEnabled();
  await expect(firstExercise).toContainText("saving");
  releaseSave();
  await expect(workoutStatus).toContainText("Resting");
  await expect(workoutStatus.getByText(/next set ready/i)).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  const loggedSet = firstExercise
    .locator('[id^="logged-set-"]')
    .filter({ hasText: "Set 1" })
    .first();
  await expect(loggedSet).toContainText("95 lb");
  await expect(loggedSet).toContainText("RPE 8.5");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem(
          "workout-tracker:active-workout-measurements:v1"
        );
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
          records?: Array<{ setId?: string | null }>;
        };
        return parsed.records?.[0]?.setId ?? null;
      })
    )
    .toMatch(/^[0-9a-f-]+$/);
  await expect(
    nextSet.getByRole("button", { name: "Log set", exact: true })
  ).toBeEnabled();
  await openNativeDetails(firstExercise.getByTestId("completed-sets"));
  await firstExercise
    .getByRole("button", { name: "Correct set", exact: true })
    .first()
    .click();
  const activeCorrection = page.getByRole("dialog", {
    name: "Correct acknowledged set 1",
  });
  await activeCorrection.getByLabel("Load", { exact: true }).fill("100");
  await activeCorrection
    .getByLabel("Why are you correcting this?")
    .selectOption("measurement_entry");
  await activeCorrection
    .getByRole("button", { name: "Review correction", exact: true })
    .click();
  await activeCorrection.getByRole("checkbox").check();
  await activeCorrection
    .getByRole("button", { name: "Save reviewed correction", exact: true })
    .click();
  await expect(page.getByText("Set correction acknowledged")).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(loggedSet).toContainText("100 lb");
  await page.getByRole("button", { name: "Friction log", exact: true }).click();
  const frictionLog = page.getByRole("dialog", {
    name: "Active-workout friction log",
  });
  await expect(frictionLog).toContainText("1 corrections");
  await frictionLog
    .getByRole("button", { name: "Clear friction log", exact: true })
    .click();
  await expect(frictionLog.getByText("No set measurements yet.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(frictionLog).toHaveCount(0);

  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await expect(finish).toBeVisible();
  const saveWorkout = finish.getByRole("button", {
    name: /^(?:Finish early|Save workout)$/,
  });
  const incompleteReason = finish.getByLabel(
    "Why are you finishing this workout early?",
  );
  await expect(incompleteReason).toHaveValue("");
  await expect(saveWorkout).toBeDisabled();
  await incompleteReason.selectOption("time_limit_reached");
  await expect(saveWorkout).toBeEnabled();
  await openNativeDetails(finish.locator("details", {
    hasText: "Optional note and fatigue",
  }));
  await finish
    .getByPlaceholder("Session note (optional) — how did it go?")
    .fill("Phase 1 browser verification");
  await finish.getByRole("button", { name: "3", exact: true }).click();
  await saveWorkout.click();

  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(page.getByText("Phase 1 browser verification")).toBeVisible();
  await expect(
    page.getByText("Completed with planned work remaining", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/retained reason is time limit reached/)).toBeVisible();
  await expect(page.getByText(/100 lb × 8/)).toBeVisible();
  await page.getByRole("button", { name: "Correct set", exact: true }).first().click();
  const correction = page.getByRole("dialog", { name: "Correct saved set 1" });
  await expect(correction).toContainText(
    "The original assertion remains in Edit history.",
  );
  await correction.getByLabel("Reps", { exact: true }).fill("9");
  await correction.getByLabel("Set note", { exact: true }).fill("Reviewed after the workout.");
  await correction
    .getByLabel("Why are you correcting this?")
    .selectOption("measurement_entry");
  await correction.getByRole("button", { name: "Review correction", exact: true }).click();
  await expect(correction).toContainText("Original");
  await expect(correction).toContainText("Corrected");
  await correction.getByRole("checkbox").check();
  await correction.getByRole("button", { name: "Save reviewed correction", exact: true }).click();
  await expect(page.getByText("Set correction acknowledged")).toBeVisible();
  await expect(page.getByText(/100 lb × 9/)).toBeVisible();
  const correctedSetDetails = page.locator("details").filter({
    hasText:
      /2 saved evidence changes · prior values retained in revision history/,
  });
  await openNativeDetails(correctedSetDetails);
  await expect(
    page.getByText(/2 saved evidence changes · prior values retained in revision history/),
  ).toBeVisible();
  await expect(
    page.getByText("Reviewed after the workout.", { exact: true }),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("keeps every active-workout route reachable with one scroll surface", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", {
      configurable: true,
      value: true,
    });
  });
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await signInAndStartWorkout(page);
  const evidenceDirectory = process.env.OPERABILITY_EVIDENCE_DIR
    ? resolve(process.env.OPERABILITY_EVIDENCE_DIR)
    : null;
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
  const currentCard = page.getByTestId("current-exercise-card");
  const statusBar = page.getByRole("complementary", { name: "Workout status" });
  const orientation = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });

  await expect(currentCard.getByRole("button", { name: "Log set", exact: true })).toBeVisible();
  await openNativeDetails(currentCard.locator("details", {
    hasText: "Extra sets",
  }));
  const addExtraSet = currentCard.getByRole("button", {
    name: "Add extra set",
    exact: true,
  });
  await expect(addExtraSet).toBeVisible();
  await expect(addExtraSet).toBeEnabled();
  await expect(currentCard).toContainText(
    "Adds ad-hoc work without changing the planned set order.",
  );
  await openNativeDetails(currentCard.locator("details", {
    hasText: "Optional effort and set note",
  }));
  await openNativeDetails(currentCard.locator("details", {
    hasText: "Set exceptions",
  }));
  await openNativeDetails(currentCard.locator("details", {
    hasText: "More for this exercise",
  }));
  await expect(currentCard.getByRole("button", { name: "Skip set", exact: true })).toBeVisible();
  await expect(currentCard.getByRole("button", { name: "Ask Coach", exact: true })).toBeVisible();
  await expect(currentCard.getByRole("button", { name: "Form guide", exact: true })).toBeVisible();
  const currentLabelId = await currentCard.getAttribute("aria-labelledby");
  expect(currentLabelId).toBeTruthy();
  await expect(page.locator(`#${currentLabelId}`)).toHaveText(/\S+/);
  expect(
    await currentCard.evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).borderTopWidth),
    ),
  ).toBeGreaterThanOrEqual(2);
  await expect(currentCard.getByRole("button", { name: "Add note", exact: true })).toBeVisible();
  await expect(currentCard.getByRole("button", { name: "Pain / no issue", exact: true })).toBeVisible();
  await expect(currentCard.getByRole("button", { name: "Skip exercise", exact: true })).toBeVisible();
  await expect(currentCard.getByRole("heading", {
    name: "Change exercise for this workout",
    exact: true,
  })).toBeVisible();
  await expect(currentCard.getByRole("button", { name: "View alternatives", exact: true })).toBeVisible();
  for (const shortcut of [
    "Easy — RPE 6",
    "OK — RPE 7",
    "Hard — RPE 8",
    "Grind — RPE 9.5",
  ]) {
    await expect(currentCard.getByRole("button", { name: new RegExp(`^${shortcut}`) })).toBeVisible();
  }
  await expect(statusBar.getByRole("button", { name: "Add training note", exact: true })).toBeVisible();
  await expect(statusBar.getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })).toBeVisible();
  await expect(orientation).not.toContainText("Next:");
  await expect(currentCard).toContainText("Next action");

  await expect(currentCard).toContainText(
    "Ask Coach gives guidance. It does not change the exercise.",
  );
  await expect(currentCard).toContainText(
    "Choose from reviewed alternatives.",
  );
  await expectMinimumWorkoutTouchTargets(currentCard);
  const grindShortcut = currentCard.getByRole("button", {
    name: /^Grind — RPE 9\.5;/,
  });
  await grindShortcut.focus();
  await page.keyboard.press("Enter");
  await expect(currentCard.getByText("Selected: Grind — RPE 9.5", {
    exact: true,
  })).toBeVisible();
  await currentCard
    .getByRole("button", { name: "Enter exact RPE instead", exact: true })
    .click();
  const exactRpe = currentCard.getByLabel("Exact RPE (1–10)", { exact: true });
  await exactRpe.fill("8.5");
  await expect(exactRpe).toHaveValue("8.5");

  for (const fontSize of ["compact", "default", "large", "extra-large"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.fontSize = value;
    }, fontSize);
    for (const width of [320, 375, 390, 440]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(statusBar).toBeVisible();
      await expect(currentCard.getByRole("button", { name: "Log set", exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      const fixedScrollers = await page.locator("body *").evaluateAll((elements) =>
        elements.filter((element) => {
          const style = getComputedStyle(element);
          return (
            style.position === "fixed" &&
            /(auto|scroll)/.test(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 1
          );
        }).length,
      );
      expect(fixedScrollers).toBe(0);
      const statusBox = await statusBar.boundingBox();
      const bottomNavBox = await page.locator("nav.fixed").boundingBox();
      expect(statusBox).not.toBeNull();
      expect(bottomNavBox).toBeNull();
      if (!statusBox) throw new Error("Fixed workout controls were not measurable.");
      const lowerBoundary = bottomNavBox?.y ?? 844;
      expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(
        lowerBoundary + 1,
      );
      const logSetButton = currentCard.getByRole("button", {
        name: "Log set",
        exact: true,
      });
      await logSetButton.evaluate((element) =>
        element.scrollIntoView({ block: "center" }),
      );
      const reachableLogBox = await logSetButton.boundingBox();
      const settledStatusBox = await statusBar.boundingBox();
      expect(reachableLogBox).not.toBeNull();
      expect(settledStatusBox).not.toBeNull();
      if (!reachableLogBox || !settledStatusBox) {
        throw new Error("The primary set action or status bar was not measurable.");
      }
      expect(reachableLogBox.y + reachableLogBox.height)
        .toBeLessThanOrEqual(settledStatusBox.y + 1);
      await testInfo.attach(`active-workout-${fontSize}-${width}px`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
      if (evidenceDirectory) {
        await page.screenshot({
          path: resolve(
            evidenceDirectory,
            `${testInfo.project.name || "default"}-${fontSize}-${width}px.png`,
          ),
          fullPage: false,
        });
      }
    }
  }

  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "extra-large";
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const plannedCard = page.locator('[id^="exercise-"]').first();
  const plannedExerciseName =
    await plannedCard.getByRole("heading", { level: 2 }).textContent();
  if (!plannedExerciseName) {
    throw new Error("The planned exercise name was not available.");
  }
  await expect(plannedCard.getByText("Set 1 of 3", { exact: true })).toBeVisible();
  for (let setNo = 1; setNo <= 3; setNo += 1) {
    await openNativeDetails(plannedCard.locator("details", {
      hasText: "Set exceptions",
    }));
    await plannedCard
      .getByRole("button", { name: "Skip set", exact: true })
      .click();
    const skipDialog = page.getByRole("dialog", {
      name: `Skip set ${setNo} of ${plannedExerciseName}?`,
    });
    await skipDialog.getByLabel("Reason").selectOption("time_limit_reached");
    await skipDialog
      .getByRole("button", { name: "Skip item", exact: true })
      .click();
    await expect(skipDialog).toHaveCount(0);
    if (setNo < 3) {
      await expect(
        plannedCard.getByText("skipped", { exact: true }),
      ).toHaveCount(setNo);
    }
  }
  await expect(
    page.getByTestId("current-exercise-card").getByRole("heading", { level: 2 }),
  ).not.toHaveText(plannedExerciseName);
  await plannedCard.getByTestId("exercise-swipe-surface").click();
  await expect(
    plannedCard.getByText("skipped", { exact: true }),
  ).toHaveCount(3);
  await openNativeDetails(plannedCard.locator("details", {
    hasText: "Extra sets",
  }));
  const addSet = plannedCard.getByRole("button", {
    name: "Add extra set",
    exact: true,
  });
  await expect(addSet).toBeEnabled();
  await waitForReactHandler(addSet);
  await addSet.focus();
  await expect(addSet).toBeFocused();
  await addSet.click();
  const addedSet = plannedCard.getByTestId("added-set-entry");
  await expect(addedSet).toContainText(
    "Extra set 1 · Added to this workout",
  );
  await expect(addedSet).toBeInViewport();
  await expect(addedSet.locator('input[inputmode="decimal"]').first()).toBeFocused();
  expect(await plannedCard.getByTestId("added-set-entry").count()).toBe(1);
  await expect
    .poll(async () => {
      const before = await page.evaluate(() => window.scrollY);
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => window.scrollY);
      return Math.abs(after - before);
    })
    .toBeLessThan(1);
  const plannedSetThree = plannedCard.getByText("Set 3", { exact: true });
  await expect(plannedSetThree).toBeVisible();
  const positions = await Promise.all([
    plannedSetThree.evaluate((element) => element.getBoundingClientRect().top),
    addedSet.evaluate((element) => element.getBoundingClientRect().top),
    addSet.evaluate((element) => element.getBoundingClientRect().top),
  ]);
  expect(positions[0]).toBeLessThan(positions[1]);
  expect(positions[1]).toBeLessThan(positions[2]);
  const addedWeight = await addedSet
    .locator('input[inputmode="decimal"]')
    .first()
    .inputValue();
  await addedSet
    .locator('input[inputmode="decimal"]')
    .first()
    .fill(String(Number(addedWeight) + 5));
  await addedSet.locator('input[inputmode="decimal"]').first().fill(addedWeight);
  const addedReps = await addedSet
    .locator('input[inputmode="numeric"]')
    .inputValue();
  await page.reload();
  await expect(
    page.getByTestId("current-exercise-card").getByRole("heading", { level: 2 }),
  ).not.toHaveText(plannedExerciseName);
  const refreshedCard = page.getByRole("region", {
    name: plannedExerciseName,
  });
  const refreshedCardToggle = refreshedCard.getByTestId("exercise-swipe-surface");
  await expect(refreshedCardToggle).toHaveAttribute("aria-expanded", "false");
  await refreshedCardToggle.click();
  await expect(refreshedCardToggle).toHaveAttribute("aria-expanded", "true");
  await expect(refreshedCard.getByTestId("added-set-entry")).toContainText(
    "Extra set 1 · Added to this workout",
  );
  await expect(
    refreshedCard
      .getByTestId("added-set-entry")
      .locator('input[inputmode="decimal"]')
      .first(),
  ).toHaveValue(addedWeight);
  await expect(
    refreshedCard
      .getByTestId("added-set-entry")
      .locator('input[inputmode="numeric"]'),
  ).toHaveValue(addedReps);
  await expect(
    refreshedCard.locator("details", {
      hasText: "Extra sets",
    }),
  ).not.toHaveAttribute("open", "");
  await openNativeDetails(refreshedCard.locator("details", {
    hasText: "Extra sets",
  }));
  await expect(
    refreshedCard.getByRole("button", {
      name: "Add extra set",
      exact: true,
    }),
  ).toBeDisabled();

  await statusBar.getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ }).click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await expect(finish.getByRole("button", { name: /^(?:Finish early|Save workout)$/ })).toBeVisible();
  await expect(finish.getByRole("button", { name: "Discard workout", exact: true })).toBeVisible();
  await finish.getByRole("button", { name: "Discard workout", exact: true }).click();
  const confirmDiscard = page.getByRole("dialog", { name: /Discard .*\?$/ });
  await expect(confirmDiscard).toContainText(
    "this active workout cannot be resumed afterward",
  );
  await confirmDiscard.getByRole("button", { name: "Keep workout", exact: true }).click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);

  await expect(finish).toBeVisible();
  await finish.getByRole("button", { name: "Discard workout", exact: true }).click();
  const finalDiscard = page.getByRole("dialog", { name: /Discard .*\?$/ });
  await finalDiscard.getByRole("button", { name: "Confirm discard", exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);

  expect(browserErrors.filter((message) => message !== "NEXT_REDIRECT")).toEqual([]);
});
test("keeps pain and substitution lineage reconstructable through History", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await signInAndStartWorkout(page);
  const nextSet = page.getByTestId("current-exercise-card");
  const workoutStatus = page.getByRole("complementary", { name: "Workout status" });
  const plannedExercise = (
    await nextSet.getByRole("heading", { level: 2 }).textContent()
  )?.trim();
  if (!plannedExercise) throw new Error("The planned exercise name was not visible.");

  const exerciseNote = "Shoulder-friendly setup on the substituted movement.";
  const painNote = "Sharp at the bottom before changing movements.";
  const setNote = "Comfortable range on the substituted movement.";

  await openNativeDetails(nextSet.locator("details", {
    hasText: "More for this exercise",
  }));
  await nextSet.getByRole("button", { name: "Pain / no issue", exact: true }).click();
  const pain = page.getByRole("dialog", { name: "Pain / no-issue evidence" });
  const severity = pain.getByRole("slider");
  await severity.focus();
  await severity.press("ArrowRight");
  await expect(severity).toHaveAttribute("aria-valuenow", "4");
  await severity.press("ArrowRight");
  await expect(severity).toHaveAttribute("aria-valuenow", "5");
  await expect(pain.getByText("Pain: shoulder 5/10", { exact: true })).toBeVisible();
  await pain.getByPlaceholder("What did it feel like? (optional)").fill(painNote);
  await expect(pain.getByText("Stop this movement today.")).toBeVisible();
  await expect(pain.getByText(/professional opinion, not a workaround/)).toBeVisible();
  await pain.getByRole("button", { name: "Save pain report", exact: true }).click();
  await expect(pain).toHaveCount(0);
  await nextSet.getByRole("button", { name: "View alternatives", exact: true }).click();
  const alternatives = page.getByRole("dialog", {
    name: "Use an alternative for this workout",
  });
  await alternatives.getByRole("button", { name: "Discomfort", exact: true }).click();
  await alternatives
    .getByRole("button", { name: "Browse alternatives", exact: true })
    .click();
  const picker = page.getByRole("dialog").last();
  const supportedAlternative = plannedExercise.includes("Squat")
    ? "Barbell Front Squat"
    : plannedExercise.includes("Deadlift")
      ? "Barbell Glute Bridge"
      : "Barbell Floor Press";
  await picker
    .getByLabel("Search exercise library")
    .fill(supportedAlternative);
  const candidate = picker.getByRole("button", {
    name: `View details for ${supportedAlternative}`,
    exact: true,
  });
  await expect(candidate).toBeVisible();
  const candidateLabel = await candidate.getAttribute("aria-label");
  const performedExercise = candidateLabel?.replace(/^View details for /, "").trim();
  if (!performedExercise) throw new Error("The performed alternative name was not available.");
  await candidate.click();
  await picker.getByRole("button", { name: "Use for this workout", exact: true }).click();
  await expect(nextSet.getByRole("heading", { name: performedExercise })).toBeVisible();
  await waitForEquipmentSelectionsToSettle(page);
  await nextSet.getByLabel("Total load").fill("45");

  await openNativeDetails(nextSet.locator("details", {
    hasText: "More for this exercise",
  }));
  await nextSet.getByRole("button", { name: "Add note", exact: true }).click();
  const noteDialog = page.getByRole("dialog", {
    name: new RegExp(`Add note for ${performedExercise}`),
  });
  await noteDialog.getByRole("textbox", { name: "Exercise note" }).fill(exerciseNote);
  await noteDialog.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByText("Exercise note saved", { exact: true })).toBeVisible();
  await expect(noteDialog).toHaveCount(0);

  await openNativeDetails(nextSet.locator("details", {
    hasText: "Optional effort and set note",
  }));
  await nextSet.getByLabel("Set note (optional)", { exact: true }).fill(setNote);
  await nextSet.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(workoutStatus).toContainText(/Resting|Next set/);
  await workoutStatus.getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ }).click();
  await page
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("user_choice");
  await page.getByRole("button", { name: /^(?:Finish early|Save workout)$/ }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);

  await expect(
    page.getByText(`Performed ${performedExercise} instead of ${plannedExercise}.`, {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText(/alternative · discomfort/i)).toBeVisible();
  await expect(
    page.getByText(`Exercise guidance: ${exerciseNote}`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(setNote, { exact: true })).toBeVisible();
  const painFlags = page.getByRole("heading", { name: "Pain / no-issue evidence" }).locator("..");
  await expect(painFlags).toContainText(plannedExercise);
  await expect(painFlags).toContainText("shoulder 5/10");
  await expect(painFlags).toContainText(painNote);
  expect(browserErrors.filter((message) => message !== "NEXT_REDIRECT")).toEqual([]);
});

test("keeps the final set acknowledgement visible through background return", async ({
  page,
  context,
}) => {
  await signInAndStartWorkout(page);
  const nextSet = page.getByTestId("current-exercise-card");
  const workoutStatus = page.getByRole("complementary", { name: "Workout status" });
  const firstName =
    (await nextSet.getByRole("heading", { level: 2 }).textContent())?.trim() ??
    "";

  for (let setNo = 1; setNo <= 2; setNo += 1) {
    await nextSet.getByRole("button", { name: "Log set", exact: true }).click();
    await expect(workoutStatus).toContainText(/Resting|Next set/);
    await expect(nextSet.getByText(new RegExp(`Set ${setNo + 1} of 3`))).toBeVisible();
  }

  let releaseFinal!: () => void;
  const finalMayFinish = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  let finalStarted = false;
  await page.route("**/session/**", async (route) => {
    if (
      !finalStarted &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      finalStarted = true;
      await finalMayFinish;
    }
    await route.continue();
  });
  await nextSet.getByRole("button", { name: "Log set", exact: true }).click();
  await expect.poll(() => finalStarted).toBe(true);
  await expect(nextSet.getByRole("heading", { level: 2 })).not.toHaveText(firstName);
  await expect(workoutStatus).toContainText("Resting");
  await expect(
    nextSet.getByRole("button", { name: "Log set", exact: true }),
  ).toBeEnabled();
  const pendingCompletedExercise = page.getByRole("region", { name: firstName });
  await expect(pendingCompletedExercise).toContainText("saving");
  const backgroundPage = await context.newPage();
  await backgroundPage.goto("about:blank");
  await backgroundPage.bringToFront();
  releaseFinal();
  await page.bringToFront();
  await expect(page).toHaveURL(/#workout-rest-status$/);
  await expect(workoutStatus).toContainText("Resting");
  const completedExercise = page.getByRole("region", { name: firstName });
  await completedExercise.getByTestId("exercise-swipe-surface").click();
  const acknowledgement = completedExercise.getByTestId("completed-sets");
  await expect(page.getByTestId("active-set-save-receipt")).toHaveCount(0);
  await expect(acknowledgement).toContainText("3 completed");
  await acknowledgement.locator(":scope > summary").click();
  await expect(acknowledgement).toContainText("Set 3");
  await expect(acknowledgement).toContainText("Acknowledged by Repbook");
  const correctionButtons = acknowledgement.getByRole("button", {
    name: "Correct set",
  });
  await expect(correctionButtons).toHaveCount(3);
  await expect(correctionButtons.last()).toBeVisible();
  await expect(acknowledgement).toBeInViewport();
  await backgroundPage.close();
  await page.unrouteAll({ behavior: "wait" });

  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  await confirmActiveWorkoutDiscard(page);
  await expect(page).toHaveURL(/\/today$/);
});

test("keeps unreadable device copies private until they are explicitly discarded", async ({
  page,
}) => {
  await signIn(page);
  await page.evaluate(() => {
    localStorage.setItem(
      "workout-tracker:workout-set-outbox:v1",
      JSON.stringify({
        version: 1,
        entries: [{ privateValue: "hidden-workout-copy" }],
      })
    );
    localStorage.setItem(
      "workout-tracker:live-coach-outbox:v1",
      JSON.stringify({
        version: 1,
        entries: [{ privateValue: "hidden-coach-copy" }],
      })
    );
    window.dispatchEvent(new Event("workout-set-outbox-change"));
    window.dispatchEvent(new Event("live-coach-outbox-change"));
  });

  await page.goto("/settings");
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await waitForReactHandler(signOut);
  await signOut.click();
  await expect(
    page.getByRole("heading", { name: "Unsaved work is on this device" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Discard this account’s copies and sign out",
    })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign out and keep copies" })
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(
    "Workout sets: 1 unreadable copy not safe for bulk discard."
  );
  await expect(page.getByRole("dialog")).toContainText(
    "Coach messages: 1 unreadable copy not safe for bulk discard."
  );
  await page.getByRole("button", { name: "Stay signed in" }).click();
  await page.goto("/today");

  const workoutQueue = page.getByRole("button", {
    name: "Open sets waiting to save",
  });
  await expect(workoutQueue).toBeVisible();
  await workoutQueue.click();
  await expect(page.getByText("Sets we couldn't read", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("hidden-workout-copy");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  const confirmWorkoutDiscard = page.getByRole("button", {
    name: "Discard saved copy",
    exact: true,
  });
  await expect(confirmWorkoutDiscard).toBeFocused();
  await page.getByRole("button", { name: "Keep it", exact: true }).click();
  const beginWorkoutDiscard = page.getByRole("button", {
    name: "Discard",
    exact: true,
  });
  await expect(beginWorkoutDiscard).toBeFocused();
  await beginWorkoutDiscard.click();
  await expect(confirmWorkoutDiscard).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(workoutQueue).toBeFocused();
  await workoutQueue.click();
  await expect(confirmWorkoutDiscard).toHaveCount(0);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(confirmWorkoutDiscard).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("workout-tracker:workout-set-outbox:v1")
      )
    )
    .toContain("hidden-workout-copy");
  await confirmWorkoutDiscard.click();
  await expect(workoutQueue).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("workout-tracker:workout-set-outbox:v1") ?? ""
      )
    )
    .not.toContain("hidden-workout-copy");

  const coachQueue = page.getByRole("button", {
    name: "Open Live Coach outbox",
  });
  await expect(coachQueue).toBeVisible();
  await coachQueue.click();
  await expect(
    page.getByText("Messages we couldn't read", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("hidden-coach-copy");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  const confirmCoachDiscard = page.getByRole("button", {
    name: "Discard saved copy",
    exact: true,
  });
  await expect(confirmCoachDiscard).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("workout-tracker:live-coach-outbox:v1")
      )
    )
    .toContain("hidden-coach-copy");
  await confirmCoachDiscard.click();
  await expect(coachQueue).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("workout-tracker:live-coach-outbox:v1") ?? ""
      )
    )
    .not.toContain("hidden-coach-copy");
});

test.describe("device timezone preference", () => {
  test.use({ timezoneId: "America/Vancouver" });

  test("saves the browser timezone as the native-workout default", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings");
    const useDeviceTimezone = page.getByRole("button", {
      name: "Use this device’s timezone",
      exact: true,
    });
    await waitForReactHandler(useDeviceTimezone);
    await useDeviceTimezone.click();
    await expect(page.getByText("Saved America/Vancouver.")).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Workout timezone:/)).toContainText(
      "America/Vancouver"
    );
  });
});

test("groups every saved equipment item into accessible family cards at all app sizes", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await signIn(page);
  await page.goto("/settings");

  const expectedFamilies = [
    "Bars & weight plates",
    "Dumbbells & handheld weights",
    "Racks, benches & stations",
    "Bands & suspension",
    "Conditioning machines",
    "Conditioning tools",
  ];
  for (const name of expectedFamilies) {
    await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  }

  const barsButton = page.getByRole("button", {
    name: /Bars & weight plates/,
  });
  await waitForReactHandler(barsButton);
  await expect(barsButton).toHaveAttribute("aria-expanded", "false");
  await barsButton.click();
  await expect(barsButton).toHaveAttribute("aria-expanded", "true");
  const barsRegion = page.getByRole("region", {
    name: "Bars & weight plates items",
  });
  await expect(barsRegion.getByText("Olympic barbell (45 lb)")).toBeVisible();
  await expect(barsRegion.getByText("EZ curl bar (18 lb)")).toBeVisible();
  await expect(barsRegion.getByText("Weight plates", { exact: true })).toBeVisible();
  await expect(barsRegion.getByText("Olympic plates", { exact: true })).toHaveCount(0);
  await expect(barsRegion.getByText("45 lb × 2", { exact: true })).toBeVisible();
  await expect(barsRegion.getByText("2.5 lb × 2", { exact: true })).toBeVisible();

  const bandsButton = page.getByRole("button", { name: /Bands & suspension/ });
  await bandsButton.click();
  const bandsRegion = page.getByRole("region", { name: "Bands & suspension items" });
  await expect(bandsRegion.getByText("Bodylastics resistance bands")).toBeVisible();
  await expect(bandsRegion.getByText("Brand: Bodylastics", { exact: true })).toBeVisible();

  await expect(page.getByText(/Bodyweight training is always available/)).toHaveCount(1);
  await expect(page.getByRole("button", { name: /No-equipment training/ })).toHaveCount(0);
  await expect(page.getByText("Bodyweight", { exact: true })).toHaveCount(0);

  const sizes = ["Compact", "Default", "Large", "Extra large"];
  const viewports = [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ];
  for (const size of sizes) {
    const radio = page.getByRole("radio", { name: new RegExp(`^${size}`) });
    await radio.click();
    await expect(radio).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(250);
      const layout = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
          .map((element) => ({ element, rect: element.getBoundingClientRect() }))
          .filter(
            ({ rect }) =>
              rect.width > 0 &&
              (rect.right > viewportWidth + 1 || rect.left < -1)
          )
          .slice(0, 8)
          .map(({ element, rect }) => ({
            tag: element.tagName,
            text: element.textContent?.trim().slice(0, 60),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            className: element.className,
          }));
        return {
          fits:
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1,
          offenders,
        };
      });
      expect(
        layout.fits,
        `${size} at ${viewport.width}px overflowed: ${JSON.stringify(layout.offenders)}`
      ).toBe(true);
      const familyButton = page.locator("[data-equipment-family] > button").first();
      const box = await familyButton.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  }

  for (const button of await page.locator("[data-equipment-family] > button").all()) {
    if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
      )
    )
    .toBe(true);
  expect(browserErrors).toEqual([]);
});

test("confirms one complete quick log and shows its stored units in History", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await signIn(page);
  await page
    .getByPlaceholder(/e\.g\. "Bench 135/)
    .fill("Barbell Back Squat 100kg x 8,7");
  await page.getByRole("button", { name: "Parse", exact: true }).click();
  await expect(page.getByText("Confirm before saving", { exact: true })).toBeVisible();
  await expect(page.getByText("→ Barbell Back Squat", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const quickLogInput = page.getByPlaceholder(/e\.g\. "Bench 135/);
  await expect(quickLogInput).toBeVisible();
  await expect(quickLogInput).toHaveValue("");

  await page.getByRole("link", { name: "View full history", exact: true }).click();
  const ownerDateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const ownerDate = Object.fromEntries(
    ownerDateParts.map((part) => [part.type, part.value]),
  );
  const ownerToday = page.locator(
    `[data-calendar-action][data-calendar-date="${ownerDate.year}-${ownerDate.month}-${ownerDate.day}"]`,
  );
  await expect(ownerToday).toHaveAttribute("aria-haspopup", "dialog");
  await ownerToday.click();
  const quickLog = page
    .getByRole("dialog", { name: "Choose a record" })
    .getByRole("link", { name: /Quick log/ })
    .first();
  await expect(quickLog).toBeVisible();
  await quickLog.click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+(?:\?.*)?$/);
  await expect(page.getByText(/100 kg × 8/)).toBeVisible();
  await expect(page.getByText(/100 kg × 7/)).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("clears AI history through Settings and restores Coach history from Archive", async ({
  page,
}, testInfo) => {
  const baseQuestion = "What should I focus on in my next workout?";
  const question =
    testInfo.repeatEachIndex === 0
      ? baseQuestion
      : `${baseQuestion} Repetition ${testInfo.repeatEachIndex + 1}.`;
  await signIn(page);
  await page.goto("/coach");
  await waitForReactHandler(
    page.getByRole("button", { name: "Create a fresh review", exact: true })
  );
  await page.getByRole("textbox", { name: "Question for Coach" }).fill(question);
  await page.getByRole("button", { name: "Ask Coach", exact: true }).click();
  await expect(page.getByText("Coach answered your question below.")).toBeVisible();
  await expect(page.getByText(question, { exact: true })).toBeVisible();

  await page.goto("/settings");
  const clearHistory = page.getByRole("button", {
    name: "Clear AI and Coach history",
    exact: true,
  });
  const clearHistoryHeading = page.getByRole("heading", {
    name: "Clear AI and Coach history?",
  });
  await waitForReactHandler(clearHistory);
  await clearHistory.click();
  await expect(clearHistoryHeading).toBeVisible();
  await expect(page.getByText(/[1-9]\d* Coach records?/)).toBeVisible();
  await page
    .getByRole("button", { name: "Create safety copy and clear", exact: true })
    .click();
  await expect(page.getByText("AI and Coach history cleared")).toBeVisible();

  await page.goto("/archive?type=ai");
  await expect(page.getByText("Archived AI and Coach history")).toBeVisible();
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await waitForReactHandler(restore);
  await restore.click();
  await expect(page.getByText("Record restored")).toBeVisible();
  await page.goto("/coach");
  await expect(page.getByText(question, { exact: true })).toBeVisible();
});

test("downloads one canonical full backup with intact workout relationships", async ({
  page,
}, testInfo) => {
  await installNextDevelopmentRefreshControl(page);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await signIn(page);
  await page.goto("/export");
  await page.waitForLoadState("networkidle");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^workout-tracker-backup-\d{4}-\d{2}-\d{2}\.json$/
  );
  const path = testInfo.outputPath("canonical-backup.json");
  await download.saveAs(path);
  const backup = JSON.parse(await readFile(path, "utf8")) as {
    format: string;
    schemaVersion: string;
    recordCounts: Record<string, number>;
    canonical: { tables: Record<string, Array<Record<string, unknown>>> };
  };
  expect(backup.format).toBe("workout-tracker-canonical-backup");
  expect(backup.schemaVersion).toBe("35");
  expect(backup.canonical.tables.users).toHaveLength(1);
  expect(backup.canonical.tables.workout_sessions.length).toBeGreaterThan(0);
  expect(backup.recordCounts.workout_sessions).toBe(
    backup.canonical.tables.workout_sessions.length
  );

  const sessionIds = new Set(
    backup.canonical.tables.workout_sessions.map(({ id }) => id)
  );
  const sessionExerciseIds = new Set(
    backup.canonical.tables.session_exercises.map(({ id }) => id)
  );
  expect(
    backup.canonical.tables.session_exercises.every(({ session_id }) =>
      sessionIds.has(session_id)
    )
  ).toBe(true);
  expect(
    backup.canonical.tables.completed_sets.every(({ session_exercise_id }) =>
      sessionExerciseIds.has(session_exercise_id)
    )
  ).toBe(true);
  expect(browserErrors).toEqual([]);
});

test("reviews and imports a complete Hevy CSV workout into History", async ({
  page,
}) => {
  await installNextDevelopmentRefreshControl(page);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await signIn(page);
  await page.goto("/program/import");
  const reviewFile = page.getByRole("button", {
    name: "Review file",
    exact: true,
  });
  await waitForReactHandler(reviewFile);
  // The import completion route opens the owner's current calendar month.
  // Keep this synthetic workout in that month so the test does not expire at
  // a calendar rollover while retaining a deterministic performed time.
  const now = new Date();
  const importDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(now);
  const calendarDateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
  const csv = [
    "title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_lbs,reps,distance_km,duration_seconds,rpe",
    `"E2E Hevy Workout","${importDate}, 12:00 AM","${importDate}, 12:30 AM","Browser-imported session","Barbell Bench Press","","Controlled rep",0,"normal",135,8,"","",8`,
    `"E2E Hevy Workout","${importDate}, 12:00 AM","${importDate}, 12:30 AM","Browser-imported session","Barbell Bench Press","","Controlled rep",1,"normal",145,6,"","",9`,
  ].join("\n");
  await page.getByLabel("Hevy CSV export").setInputFiles({
    name: "hevy-e2e.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await reviewFile.click();

  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("2", { exact: true }).first()).toBeVisible();
  const accept = page.getByRole("button", {
    name: "Accept 1 safe match",
    exact: true,
  });
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(
    page.getByText("Every exercise has a decision.", { exact: false })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import 1 workouts", exact: true })
    .click();

  await expect(page).toHaveURL(/\/history\?imported=1$/);
  const directImportedWorkout = page.getByRole("link", {
    name: /Open E2E Hevy Workout/,
  });
  const importDayChooser = page.getByRole("button", {
    name: new RegExp(
      `^${calendarDateLabel}: Choose from \\d+ records$`,
    ),
  });
  await expect
    .poll(
      async () =>
        (await directImportedWorkout.count()) +
        (await importDayChooser.count()),
    )
    .toBe(1);
  if ((await importDayChooser.count()) === 1) {
    await importDayChooser.click();
    const chooser = page.getByRole("dialog", { name: "Choose a record" });
    await expect(chooser).toBeVisible();
    const importedWorkout = chooser.getByRole("link", {
      name: /^E2E Hevy Workout\b/,
    });
    await expect(importedWorkout).toBeVisible();
    await importedWorkout.click();
  } else {
    await expect(directImportedWorkout).toBeVisible();
    await directImportedWorkout.click();
  }
  await expect(
    page
      .getByLabel("Workout evidence status")
      .getByText("Imported evidence", { exact: true }),
  ).toBeVisible();
  const sourceDetails = page.locator("details", {
    hasText: "Source and lineage details",
  });
  await openNativeDetails(sourceDetails);
  await expect(sourceDetails).toContainText("Import source");
  await expect(sourceDetails).toContainText("hevy");
  await expect(page.getByText(/135 lb × 8/)).toBeVisible();
  await expect(page.getByText(/145 lb × 6/)).toBeVisible();
  await expect(page.getByText("Browser-imported session", { exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("loads each History calendar window on demand", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await signIn(page);
  await page.goto(
    "/history?range=all&calendarView=month&calendarDate=2024-07-13"
  );
  await expect(
    page.getByText("Training calendar", { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "July 2024" })).toBeVisible();

  const previousMonth = page.getByRole("button", { name: "Previous month" });
  await waitForReactHandler(previousMonth);
  await previousMonth.click();
  await expect(page).toHaveURL(/calendarView=month&calendarDate=2024-06-01/);
  await expect(page.getByRole("heading", { name: "June 2024" })).toBeVisible();

  const yearView = page.getByRole("button", { name: "Year", exact: true });
  await waitForReactHandler(yearView);
  await yearView.click();
  await expect(page).toHaveURL(/calendarView=year&calendarDate=2024-06-01/);
  await expect(page.getByRole("heading", { name: "2024", exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("keeps an offline set visible while the next set stays available", async ({
  page,
  context,
}) => {
  const offlineSetNote = "Offline set note survives queue and replay.";
  await signInAndStartWorkout(page);
  const firstExercise = page.locator('[id^="exercise-"]').first();
  const nextSet = page.getByTestId("current-exercise-card");
  const workoutStatus = page.getByRole("complementary", { name: "Workout status" });
  const weight = nextSet.getByLabel("Total load");
  const reps = nextSet.getByRole("textbox", { name: "Reps", exact: true });
  await openNativeDetails(nextSet.locator("details", {
    hasText: "Optional effort and set note",
  }));
  const note = nextSet.getByLabel("Set note (optional)");
  await weight.fill("95");
  await reps.fill("8");
  await note.fill(offlineSetNote);

  await context.setOffline(true);
  await nextSet
    .getByRole("button", { name: "Log set", exact: true })
    .click();
  await expect(
    nextSet.getByText("Pending on this device", { exact: true })
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { entries?: Array<{ note?: unknown }> };
        return parsed.entries?.[0]?.note ?? null;
      })
    )
    .toBe(offlineSetNote);

  await expect(
    nextSet.getByRole("button", { name: "Log set", exact: true }),
  ).toBeEnabled();

  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  await expect(
    page.getByRole("button", { name: /^(?:Finish early|Save workout)$/ })
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    "1 set is still saving. Try again or remove it before finishing.",
  );
  await page.keyboard.press("Escape");

  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let actionRequests = 0;
  await page.route("**/session/**", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      actionRequests += 1;
      if (actionRequests === 1) await firstMayFinish;
    }
    await route.continue();
  });

  await context.setOffline(false);
  await expect.poll(() => actionRequests).toBe(1);
  await page.waitForTimeout(300);
  expect(actionRequests).toBe(1);
  releaseFirst();

  await expect(workoutStatus).toContainText(/Resting|Next set/);
  await expect.poll(() => actionRequests).toBe(1);

  await page.reload();
  await openNativeDetails(firstExercise.getByTestId("completed-sets"));
  const savedSet = firstExercise
    .locator('[id^="logged-set-"]')
    .filter({ hasText: "Set 1" })
    .first();
  await expect(savedSet).toBeVisible();
  await expect(savedSet).toContainText("95 lb");
  await firstExercise
    .getByRole("button", { name: "Correct set", exact: true })
    .first()
    .click();
  const savedCorrection = page.getByRole("dialog", {
    name: "Correct acknowledged set 1",
  });
  await expect(
    savedCorrection.getByRole("textbox", { name: "Set note", exact: true }),
  ).toHaveValue(offlineSetNote);
  await page.keyboard.press("Escape");
  await expect(savedCorrection).toHaveCount(0);

  const finishWorkout = page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", {
      name: /^(?:Review workout finish|Finish workout)$/,
    });
  await waitForReactHandler(finishWorkout);
  await finishWorkout.click();
  await page
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("user_choice");
  await page.getByRole("button", { name: /^(?:Finish early|Save workout)$/ }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(page.getByText(offlineSetNote, { exact: true })).toBeVisible();
});

test("retries a set automatically after one server 500 and still finishes", async ({
  page,
}) => {
  await signInAndStartWorkout(page);
  let actionRequests = 0;
  await page.route("**/session/**", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      actionRequests += 1;
      if (actionRequests === 1) {
        await route.fulfill({ status: 500, body: "Injected server failure" });
        return;
      }
    }
    await route.continue();
  });

  // Set entry and acknowledgement stay together in the exercise card.
  const nextSet = page.getByTestId("current-exercise-card");
  await nextSet.locator('input[inputmode="decimal"]').first().fill("95");
  await nextSet.locator('input[inputmode="numeric"]').first().fill("8");
  await nextSet.getByRole("button", { name: "Log set", exact: true }).click();

  await expect(nextSet.getByTestId("completed-sets"))
    .toContainText("Acknowledged by Repbook");
  expect(actionRequests).toBeGreaterThanOrEqual(2);
  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  await page
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("user_choice");
  await page
    .getByRole("button", { name: /^(?:Finish early|Save workout)$/ })
    .click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
});

test("a parked set pauses only its exercise while another exercise saves", async ({
  page,
}) => {
  await signInAndStartWorkout(page);
  const exercises = page.locator('[id^="exercise-"]');
  const firstExercise = exercises.first();
  const secondExercise = exercises.nth(1);
  const firstExerciseId = (await firstExercise.getAttribute("id"))!.replace(
    "exercise-",
    ""
  );
  let failedExerciseRequests = 0;
  await page.route("**/session/**", async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      request.postData()?.includes(firstExerciseId)
    ) {
      failedExerciseRequests += 1;
      await route.fulfill({ status: 500, body: "Injected persistent failure" });
      return;
    }
    await route.continue();
  });

  // Each expanded exercise owns its next exact pending occurrence.
  const nextSet = page.getByTestId("current-exercise-card");
  await nextSet.locator('input[inputmode="decimal"]').first().fill("95");
  await nextSet.locator('input[inputmode="numeric"]').first().fill("8");
  await nextSet.getByRole("button", { name: "Log set", exact: true }).click();
  await expect.poll(() => failedExerciseRequests).toBe(1);
  await page.evaluate((sessionExerciseId) => {
    const key = "workout-tracker:workout-set-outbox:v1";
    const envelope = JSON.parse(localStorage.getItem(key) ?? "null") as {
      entries: Array<Record<string, unknown>>;
    };
    const entry = envelope.entries.find(
      (candidate) => candidate.sessionExerciseId === sessionExerciseId
    );
    if (!entry) throw new Error("Queued E2E set was not found");
    entry.status = "queued";
    entry.attemptCount = 5;
    entry.nextAttemptAtISO = null;
    localStorage.setItem(key, JSON.stringify(envelope));
    window.dispatchEvent(new Event("workout-set-outbox-change"));
  }, firstExerciseId);
  await expect(firstExercise.getByText("Save failed", { exact: true })).toBeVisible();
  expect(failedExerciseRequests).toBeGreaterThanOrEqual(2);

  await secondExercise.getByTestId("exercise-swipe-surface").click();
  await secondExercise.locator('input[inputmode="decimal"]').first().fill("50");
  await secondExercise.locator('input[inputmode="numeric"]').first().fill("10");
  await secondExercise.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(secondExercise.getByTestId("exercise-swipe-surface")).toContainText(
    "1/3 planned performed",
  );
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    if (!raw) return [];
    const envelope = JSON.parse(raw) as {
      entries?: Array<{ sessionExerciseId?: string }>;
    };
    return (envelope.entries ?? []).map((entry) => entry.sessionExerciseId);
  })).toEqual([firstExerciseId]);

  const firstExerciseToggle = firstExercise.getByTestId("exercise-swipe-surface");
  if ((await firstExerciseToggle.getAttribute("aria-expanded")) !== "true") {
    await firstExerciseToggle.click();
  }
  const removeParkedSet = firstExercise.getByRole("button", {
    name: "Discard device copy",
    exact: true,
  });
  await removeParkedSet.evaluate((element) =>
    element.scrollIntoView({ block: "center" })
  );
  await removeParkedSet.click();
  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  await page
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("technical_app_issue");
  await page
    .getByRole("button", { name: /^(?:Finish early|Save workout)$/ })
    .click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
});

test("keeps a stale-tab rejection visible until the user resolves it", async ({
  page,
  context,
}) => {
  await installNextDevelopmentRefreshControl(page);
  await signInAndStartWorkout(page);
  const sessionUrl = page.url();
  const activeRefreshControl =
    await installNextDevelopmentRefreshControl(page);
  activeRefreshControl.freeze();
  const stalePage = await context.newPage();
  const staleRefreshControl =
    await installNextDevelopmentRefreshControl(stalePage);
  await stalePage.goto(sessionUrl);
  const staleNextSet = stalePage.getByTestId("current-exercise-card");
  await expect(staleNextSet).toBeVisible();
  await waitForReactHandler(
    staleNextSet.getByRole("button", { name: "Log set", exact: true })
  );
  staleRefreshControl.freeze();
  activeRefreshControl.resume();

  const activeNextSet = page.getByTestId("current-exercise-card");
  await waitForReactHandler(
    activeNextSet.getByRole("button", { name: "Log set", exact: true })
  );
  await activeNextSet.getByLabel("Total load").fill("95");
  await activeNextSet.getByRole("textbox", { name: "Reps", exact: true }).fill("8");
  await activeNextSet
    .getByRole("button", { name: "Log set", exact: true })
    .click();
  await expect(page.getByRole("complementary", { name: "Workout status" })).toContainText(/Resting|Next set/);
  const finishWorkout = page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", {
      name: /^(?:Review workout finish|Finish workout)$/,
    });
  await waitForReactHandler(finishWorkout);
  await finishWorkout.click();
  await page
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("user_choice");
  const saveWorkout = page.getByRole("button", {
    name: /^(?:Finish early|Save workout)$/,
  });
  await waitForReactHandler(saveWorkout);
  await saveWorkout.click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  staleRefreshControl.resume();

  const staleExercise = stalePage.locator('[id^="exercise-"]').first();
  await staleNextSet.getByLabel("Total load").fill("100");
  await staleNextSet.getByRole("textbox", { name: "Reps", exact: true }).fill("7");
  await staleNextSet
    .getByRole("button", { name: "Log set", exact: true })
    .click();
  await expect(staleNextSet.getByText(/Save failed/)).toBeVisible();
  await stalePage
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  await expect(
    stalePage.getByRole("button", { name: /^(?:Finish early|Save workout)$/ })
  ).toBeDisabled();
  await stalePage.keyboard.press("Escape");

  let releaseRetry!: () => void;
  const retryMayFinish = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let retryStarted = false;
  await context.route("**/*", async (route) => {
    if (
      !retryStarted &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      retryStarted = true;
      await retryMayFinish;
    }
    await route.continue();
  });
  const retryStaleSet = staleExercise.getByRole("button", {
    name: "Retry save",
    exact: true,
  });
  await waitForReactHandler(retryStaleSet);
  await retryStaleSet.click();
  await expect.poll(() => retryStarted).toBe(true);
  await expect(
    staleExercise.getByText("Retrying…", { exact: true })
  ).toBeVisible();
  releaseRetry();
  await expect(
    staleExercise.getByText("Save failed", { exact: true })
  ).toBeVisible();
  await context.unrouteAll({ behavior: "wait" });
  await staleExercise.getByRole("button", { name: "Discard device copy", exact: true }).click();
  await expect(staleExercise.getByText("Save failed", { exact: true })).toHaveCount(0);
  await stalePage.close();
});

test("keeps unsynced sets with their owner across sign-out and account changes", async ({
  page,
  context,
}) => {
  await signInAndStartWorkout(page);
  const nextSet = page.getByTestId("current-exercise-card");
  await nextSet.getByLabel("Total load").fill("95");
  await nextSet.getByRole("textbox", { name: "Reps", exact: true }).fill("8");

  await context.setOffline(true);
  await nextSet
    .getByRole("button", { name: "Log set", exact: true })
    .click();
  await expect(
    nextSet.getByText("Pending on this device", { exact: true })
  ).toBeVisible();

  const originalOwnerId = await page.evaluate(() => {
    const key = "workout-tracker:workout-set-outbox:v1";
    const envelope = JSON.parse(localStorage.getItem(key) ?? "null") as {
      version: number;
      entries: Array<{
        ownerId: string;
        status: string;
        attemptCount: number;
        nextAttemptAtISO: string | null;
        lastAttemptAtISO: string | null;
        lastError: string | null;
      }>;
    };
    const entry = envelope.entries[0];
    entry.status = "needs_attention";
    entry.attemptCount = 1;
    entry.nextAttemptAtISO = null;
    entry.lastAttemptAtISO = new Date().toISOString();
    entry.lastError = "E2E-held device copy";
    localStorage.setItem(key, JSON.stringify(envelope));
    window.dispatchEvent(new Event("workout-set-outbox-change"));
    return entry.ownerId;
  });
  await expect(
    page.getByRole("button", { name: "Open sets waiting to save" })
  ).toContainText("Sets need attention");

  await context.setOffline(false);
  await page.goto("/settings");
  let signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await waitForReactHandler(signOut);
  await signOut.click();
  await expect(
    page.getByRole("heading", {
      name: "Unsaved work is on this device",
      exact: true,
    })
  ).toBeVisible();
  await expect(
    page.getByText("Workout sets: 1 copy needing attention.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stay signed in", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Sign out and keep copies", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem(
          "workout-tracker:workout-set-outbox:v1"
        );
        return raw
          ? (JSON.parse(raw) as { entries: Array<{ ownerId: string }> }).entries
              .map((entry) => entry.ownerId)
          : [];
      })
    )
    .toEqual([originalOwnerId]);

  await signIn(
    page,
    "second.e2e@example.com",
    /\/setup\/profile$/
  );
  await expect(
    page.getByRole("button", { name: "Open sets waiting to save" })
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
      return raw
        ? (JSON.parse(raw) as { entries: Array<{ ownerId: string }> }).entries[0]
            ?.ownerId
        : null;
    })
  ).toBe(originalOwnerId);
  await page.goto("/settings");
  signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await waitForReactHandler(signOut);
  await signOut.click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(
    page.getByRole("heading", {
      name: "Unsaved work is on this device",
      exact: true,
    })
  ).toHaveCount(0);

  await signIn(page);
  await page.evaluate(() => {
    const workoutRaw = localStorage.getItem(
      "workout-tracker:workout-set-outbox:v1"
    );
    const ownerId = workoutRaw
      ? (JSON.parse(workoutRaw) as { entries: Array<{ ownerId: string }> })
          .entries[0]?.ownerId
      : null;
    if (!ownerId) throw new Error("Expected the retained workout owner.");
    localStorage.setItem(
      "workout-tracker:live-coach-outbox:v1",
      JSON.stringify({
        version: 1,
        entries: [
          {
            clientKey: crypto.randomUUID(),
            ownerId,
            sessionId: crypto.randomUUID(),
            sessionExerciseId: null,
            exerciseName: null,
            completedSetId: null,
            messageKind: "question",
            inputMode: "text",
            content: "Retained Coach question",
            activeRestTimerSeconds: null,
            createdAtISO: new Date().toISOString(),
            status: "needs_attention",
            attemptCount: 1,
            nextAttemptAtISO: null,
            lastAttemptAtISO: new Date().toISOString(),
            lastError: "E2E-held Coach copy",
          },
        ],
      })
    );
    window.dispatchEvent(new Event("live-coach-outbox-change"));
  });
  const attentionButton = page.getByRole("button", {
    name: "Open sets waiting to save",
  });
  await expect(attentionButton).toContainText("Sets need attention");
  await attentionButton.click();
  await expect(page.getByText("E2E-held device copy", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/settings");
  signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await waitForReactHandler(signOut);
  await signOut.click();
  await page
    .getByRole("button", {
      name: "Discard this account’s copies and sign out",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem(
          "workout-tracker:workout-set-outbox:v1"
        );
        return raw
          ? (JSON.parse(raw) as { entries: unknown[] }).entries.length
          : 0;
      })
    )
    .toBe(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem(
          "workout-tracker:live-coach-outbox:v1"
        );
        return raw
          ? (JSON.parse(raw) as { entries: unknown[] }).entries.length
          : 0;
      })
    )
    .toBe(0);
});

test("opens failed-set recovery from Settings at 145 percent on iPhone WebKit", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", {
      configurable: true,
      value: true,
    });
  });
  await signInAndStartWorkout(page);
  const sessionPath = new URL(page.url()).pathname;
  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForReactHandler(extraLarge);
  await extraLarge.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  await page.goto(sessionPath);

  const currentSet = page.getByTestId("current-exercise-card");
  const logSet = currentSet.getByRole("button", {
    name: "Log set",
    exact: true,
  });
  await waitForReactHandler(logSet);
  const totalLoad = currentSet.getByLabel("Total load");
  const reps = currentSet.getByRole("textbox", { name: "Reps", exact: true });
  await totalLoad.fill("80");
  await expect(totalLoad).toHaveValue("80");
  await reps.fill("10");
  await expect(reps).toHaveValue("10");
  await openNativeDetails(currentSet.locator("details", {
    hasText: "Optional effort and set note",
  }));
  await currentSet.getByRole("button", { name: /^Hard / }).click();
  await context.setOffline(true);
  await logSet.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem(
          "workout-tracker:workout-set-outbox:v1",
        );
        if (!raw) return 0;
        const envelope = JSON.parse(raw) as { entries?: unknown[] };
        return envelope.entries?.length ?? 0;
      }),
    )
    .toBe(1);
  const retained = await page.evaluate(() => {
    const key = "workout-tracker:workout-set-outbox:v1";
    const envelope = JSON.parse(localStorage.getItem(key) ?? "null") as {
      entries: Array<{
        clientKey: string;
        sessionId: string;
        sessionExerciseId: string;
        exerciseName: string;
        status: string;
        attemptCount: number;
        nextAttemptAtISO: string | null;
        lastAttemptAtISO: string | null;
        lastError: string | null;
      }>;
    } | null;
    if (!envelope?.entries[0]) {
      throw new Error("The offline workout set was not retained.");
    }
    const entry = envelope.entries[0];
    entry.status = "needs_attention";
    entry.attemptCount = 1;
    entry.nextAttemptAtISO = null;
    entry.lastAttemptAtISO = new Date().toISOString();
    entry.lastError =
      "No reviewed matching setup exists. The displayed load can be saved with setup unknown.";
    localStorage.setItem(key, JSON.stringify(envelope));
    window.dispatchEvent(new Event("workout-set-outbox-change"));
    return {
      clientKey: entry.clientKey,
      sessionId: entry.sessionId,
      sessionExerciseId: entry.sessionExerciseId,
      exerciseName: entry.exerciseName,
    };
  });

  await context.setOffline(false);
  const finishTrigger = page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", {
      name: /^(?:Review workout finish|Finish workout)$/,
    });
  await finishTrigger.click();
  const finishRecovery = page.getByRole("dialog", {
    name: "Finish workout",
  });
  await expect(finishRecovery).toBeVisible();
  await expect
    .poll(() =>
      finishRecovery.evaluate(
        (dialog) =>
          dialog.getBoundingClientRect().bottom <= window.innerHeight + 1,
      ),
    )
    .toBe(true);
  await expect(finishRecovery).toContainText(
    "1 set failed to save. Your recorded attempt is still on this device.",
  );
  await expect(finishRecovery).toContainText(retained.exerciseName);
  await expect(finishRecovery).toContainText("Set 1");
  await expect(finishRecovery).toContainText(
    "No reviewed matching setup exists. The displayed load can be saved with setup unknown.",
  );
  await expect(finishRecovery).toContainText(
    "Workout order currently requires",
  );
  await expect(
    finishRecovery.getByRole("button", { name: "Retry save" }),
  ).toBeVisible();
  await expect(
    finishRecovery.getByRole("button", { name: "Review device copy" }),
  ).toBeVisible();
  const finishRecoveryGeometry = await finishRecovery.evaluate((dialog) => {
    const footer = dialog.querySelector<HTMLElement>(
      '[data-slot="drawer-footer"]',
    );
    const scrollRegion = dialog.querySelector<HTMLElement>(
      '[data-testid="finish-workout-scroll"]',
    );
    if (!footer || !scrollRegion) {
      throw new Error("Finish recovery regions are missing.");
    }
    const footerRect = footer.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(scrollRegion).overflowY,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(finishRecoveryGeometry.overflowY).toBe("auto");
  expect(finishRecoveryGeometry.footerTop).toBeGreaterThanOrEqual(0);
  expect(finishRecoveryGeometry.footerBottom).toBeLessThanOrEqual(
    finishRecoveryGeometry.viewportHeight + 1,
  );
  await finishRecovery
    .getByRole("button", { name: "Review device copy" })
    .click();
  await expect(finishRecovery).toHaveCount(0);
  await expect(page).toHaveURL(
    new RegExp(`#exercise-${retained.sessionExerciseId}$`),
  );
  await expect(
    page.locator(`#exercise-${retained.sessionExerciseId}`),
  ).toBeInViewport();

  await expect
    .poll(() =>
      page.evaluate(() =>
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
      )
    )
    .toBeCloseTo(23.2, 4);
  const openRecovery = async (warning: Locator) => {
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
      await warning.tap();
      return;
    }
    await warning.click();
  };
  for (const path of ["/today", "/history", "/settings"]) {
    await page.goto(path);
    const routeWarning = page.getByRole("button", {
      name: "Open sets waiting to save",
    });
    await expect(routeWarning).toContainText("Sets need attention");
    await openRecovery(routeWarning);
    await expect(
      page.getByRole("dialog", { name: "Sets waiting to save" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
  const warning = page.getByRole("button", {
    name: "Open sets waiting to save",
  });
  await expect(warning).toContainText("Sets need attention");
  await openRecovery(warning);

  const recovery = page.getByRole("dialog", {
    name: "Sets waiting to save",
  });
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText(retained.exerciseName);
  await expect(recovery).toContainText("set 1");
  await expect(recovery).toContainText("80 lb × 10 reps");
  await expect(recovery).toContainText("Hard (RPE 8)");
  await expect(recovery).toContainText(
    "No reviewed matching setup exists. The displayed load can be saved with setup unknown.",
  );
  await expect(recovery.getByRole("button", { name: "Retry save" })).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Discard device copy" })).toBeVisible();
  await expect(
    recovery.getByRole("link", {
      name: `Return to ${retained.exerciseName} set 1`,
    }),
  ).toHaveAttribute(
    "href",
    `/session/${retained.sessionId}#exercise-${retained.sessionExerciseId}`,
  );
  await page.screenshot({
    path: testInfo.outputPath("failed-set-recovery-settings-145.png"),
    fullPage: true,
  });

  await recovery
    .getByRole("link", {
      name: `Return to ${retained.exerciseName} set 1`,
    })
    .click();
  await expect(page).toHaveURL(
    new RegExp(
      `/session/${retained.sessionId}#exercise-${retained.sessionExerciseId}$`,
    ),
  );
  await expect(
    page.locator(`#exercise-${retained.sessionExerciseId}`),
  ).toBeInViewport();
  await page.goto("/settings");
  await page.reload();
  await expect(warning).toContainText("Sets need attention");
  await page.evaluate((clientKey) => {
    const key = "workout-tracker:workout-set-outbox:v1";
    const envelope = JSON.parse(localStorage.getItem(key) ?? "null") as {
      entries: Array<{ clientKey: string }>;
    };
    envelope.entries = envelope.entries.filter(
      (entry) => entry.clientKey !== clientKey,
    );
    localStorage.setItem(key, JSON.stringify(envelope));
    window.dispatchEvent(new Event("workout-set-outbox-change"));
  }, retained.clientKey);
  await page.goto(`/session/${retained.sessionId}`);
  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  await confirmActiveWorkoutDiscard(page);
  await expect(page).toHaveURL(/\/today$/);
  workoutMayBeActive = false;
});

test("supports 145% app sizing throughout the narrow mobile navigation", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.setViewportSize({ width: 320, height: 700 });
  await signIn(page);
  await page.goto("/settings");

  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForReactHandler(extraLarge);
  await extraLarge.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        preference: document.documentElement.dataset.fontSize,
        innerWidth: window.innerWidth,
      }))
    )
    .toEqual({
      preference: "extra-large",
      innerWidth: 320,
    });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
      )
    )
    .toBeCloseTo(23.2, 4);

  const walkthrough = [
    { label: "Today", path: "/today", heading: "Today", title: "Today · Repbook" },
    { label: "History", path: "/history", heading: "History", title: "History · Repbook" },
    { label: "Review", path: "/coach", heading: "Review and decisions", title: "Review and decisions · Repbook" },
    { label: "Program", path: "/program", heading: null, title: "Program · Repbook" },
    { label: "Settings", path: "/settings", heading: "Settings", title: "Settings · Repbook" },
  ] as const;

  for (const step of walkthrough) {
    const bottomNavigation = page.getByRole("navigation", {
      name: "Primary navigation",
    });
    const link = bottomNavigation.getByRole("link", {
      name: step.label,
      exact: true,
    });
    await expect(link).toBeVisible();
    await link.focus();
    await expect(link).toBeFocused();
    await link.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${step.path}$`));
    await expect(page).toHaveTitle(step.title);
    await expect(link).toHaveAttribute("aria-current", "page");
    const linkMetrics = await link.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        clipped: element.scrollWidth > element.clientWidth + 1,
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      };
    });
    expect(linkMetrics.left).toBeGreaterThanOrEqual(0);
    expect(linkMetrics.right).toBeLessThanOrEqual(320);
    expect(linkMetrics.clipped).toBe(false);
    expect(linkMetrics.fontSize).toBeGreaterThanOrEqual(14);
    if (step.heading) {
      await expect(
        page.getByRole("heading", { name: step.heading, exact: true }).first()
      ).toBeVisible();
    } else {
      await expect(page.locator("main h1").first()).toBeVisible();
    }
    if (step.path === "/history") {
      await expect(
        page.getByRole("navigation", {
          name: "History time period",
        }),
      ).toHaveCount(0);
      await page.goto("/history?view=insights");
      const rangeNavigation = page.getByRole("navigation", {
        name: "History time period",
      });
      await expect(rangeNavigation.getByRole("link", { name: "All time" })).toBeVisible();
      await expect
        .poll(() =>
          rangeNavigation.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1
          )
        )
        .toBe(true);
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1
        )
      )
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.fontSize))
      .toBe("extra-large");
  }

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/today");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1
        )
      )
      .toBe(true);
    await expect(
      page.getByRole("navigation", {
        name: viewport.width >= 1024 ? "Main navigation" : "Primary navigation",
      })
    ).toBeVisible();
  }

  const desktopNavigation = page.getByRole("navigation", {
    name: "Main navigation",
  });
  await expect(page.getByRole("link", { name: "Repbook home" })).toBeVisible();
  await expect(page.getByText("Plan. Train. Review.", { exact: true })).toBeVisible();
  await expect(
    desktopNavigation.getByText("Recorded evidence", { exact: true })
  ).toBeVisible();
  await expect(
    desktopNavigation.getByText("Reviewed change", { exact: true })
  ).toBeVisible();
  await expect(
    desktopNavigation.getByText("Program intent", { exact: true })
  ).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      page.locator("aside").evaluate(
        (element) => getComputedStyle(element).transitionProperty
      )
    )
    .toBe("none");

  const contrast = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const optionalContext = canvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!optionalContext) throw new Error("Canvas color context unavailable");
    const context = optionalContext;
    const style = getComputedStyle(document.documentElement);

    function paint(colors: string[]) {
      context.clearRect(0, 0, 1, 1);
      for (const color of colors) {
        if (!CSS.supports("color", color)) {
          throw new Error(`${color} is not a supported color`);
        }
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
      }
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
    }

    function rgb(variable: string) {
      return paint([style.getPropertyValue(variable).trim()]);
    }

    function luminance(channels: number[]) {
      const [red, green, blue] = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    }

    function channelRatio(first: number[], second: number[]) {
      const firstLuminance = luminance(first);
      const secondLuminance = luminance(second);
      return (
        (Math.max(firstLuminance, secondLuminance) + 0.05) /
        (Math.min(firstLuminance, secondLuminance) + 0.05)
      );
    }

    function ratio(first: string, second: string) {
      return channelRatio(rgb(first), rgb(second));
    }

    const sidebar = document.querySelector("aside");
    const activeLink = document.querySelector(
      'nav[aria-label="Main navigation"] a[aria-current="page"]'
    );
    const activeText = activeLink?.querySelectorAll("span span");
    if (!sidebar || !activeLink || !activeText || activeText.length < 2) {
      throw new Error("Active shell contrast targets unavailable");
    }
    const sidebarColor = getComputedStyle(sidebar).backgroundColor;
    const activeSurface = getComputedStyle(activeLink).backgroundColor;
    const activeBackground = paint([sidebarColor, activeSurface]);
    const effectiveRatio = (element: Element) =>
      channelRatio(
        activeBackground,
        paint([
          sidebarColor,
          activeSurface,
          getComputedStyle(element).color,
        ])
      );

    return {
      primaryAction: ratio("--primary", "--primary-foreground"),
      supportingCopy: ratio("--muted-foreground", "--sidebar"),
      activeLabel: effectiveRatio(activeText[0]),
      activePurpose: effectiveRatio(activeText[1]),
    };
  });
  expect(contrast.primaryAction).toBeGreaterThanOrEqual(4.5);
  expect(contrast.supportingCopy).toBeGreaterThanOrEqual(4.5);
  expect(contrast.activeLabel).toBeGreaterThanOrEqual(4.5);
  expect(contrast.activePurpose).toBeGreaterThanOrEqual(4.5);

  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  await waitForReactHandler(collapse);
  await collapse.focus();
  await expect(collapse).toBeFocused();
  await collapse.press("Enter");
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Repbook home" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  expect(browserErrors).toEqual([]);
});

test("keeps first-time setup inside the same Repbook shell direction", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, "second.e2e@example.com", /\/setup\/profile$/);
  await expect(page).toHaveTitle("Set up your training record · Repbook");
  await expect(
    page.getByRole("link", { name: "Repbook setup home" })
  ).toBeVisible();
  await expect(page.getByText("Record setup", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Set equipment, constraints, and Program intent.", {
      exact: true,
    })
  ).toBeVisible();

  const setupNavigation = page.getByRole("navigation", {
    name: "Setup navigation",
  });
  await expect(setupNavigation).toBeVisible();
  const profileLink = setupNavigation.getByRole("link", {
    name: "Profile",
    exact: true,
  });
  await profileLink.focus();
  await expect(profileLink).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      profileLink.evaluate(
        (element) => getComputedStyle(element).transitionProperty
      )
    )
    .toBe("none");

  await page.setViewportSize({ width: 320, height: 700 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.innerWidth === 320 &&
          document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1
      )
    )
    .toBe(true);
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  expect(browserErrors).toEqual([]);
});
