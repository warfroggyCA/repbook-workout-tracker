import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const evidenceDirectory = resolve("output/playwright/history-workspace/final");
const ownerEmail = "owner@example.com";
const sparseEmail = "history-workspace-sparse.e2e@example.com";

async function waitForReactHandler(locator: Locator) {
  await expect
    .poll(async () =>
      locator.evaluate((element) =>
        Object.getOwnPropertyNames(element).some((name) =>
          name.startsWith("__reactProps$"),
        ),
      ),
    )
    .toBe(true);
}

async function signIn(page: Page, email = ownerEmail) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(email);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForReactHandler(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
}

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
});

test("History workspace preserves deep links, Back and Forward, and exact detail returns", async ({
  page,
}) => {
  const errors = observeErrors(page);
  const historyRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/history") {
      historyRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(
    "/history?range=all&calendarView=year&calendarDate=2026-07-10",
  );
  await page.waitForLoadState("networkidle");
  expect(
    historyRequests.filter(
      (request) =>
        request.includes("view=insights") ||
        request.includes("view=exercises") ||
        /range=(?:4w|12w|6m|1y)/.test(request),
    ),
  ).toEqual([]);

  await expect(
    page.getByRole("link", { name: "Calendar", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Calendar", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "History time period" }),
  ).toHaveCount(0);
  await expect(page.getByText("Training calendar", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Needs attention", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Five questions", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Exact-exercise progression",
      exact: true,
    }),
  ).toHaveCount(0);
  const desktopPageHeight = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  await page.screenshot({
    path: resolve(evidenceDirectory, "calendar-desktop.png"),
    fullPage: true,
  });
  await page.screenshot({
    path: resolve(evidenceDirectory, "calendar-desktop-viewport.png"),
  });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Expand sidebar" }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(evidenceDirectory, "calendar-desktop-review.png"),
  });
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.locator("main").screenshot({
    path: resolve(evidenceDirectory, "calendar-workspace-desktop.png"),
  });

  await page.getByRole("button", { name: "More History actions" }).click();
  await expect(
    page.getByText("History actions", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Prepare training brief", exact: true }),
  ).toHaveAttribute("href", "/export?briefRange=all#training-brief");
  await expect(
    page.getByRole("link", { name: "Downloads & backup", exact: true }),
  ).toHaveAttribute("href", "/export");
  await expect(
    page.getByRole("link", { name: "Open Archive", exact: true }),
  ).toHaveAttribute("href", "/archive");
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Insights", exact: true }).click();
  await expect(page).toHaveURL(
    "/history?range=all&view=insights&calendarView=year&calendarDate=2026-07-10",
  );
  await expect(
    page.getByRole("link", { name: "Insights", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Current progress", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Explore the evidence", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Evaluable and unknown outcomes stay separate.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Training calendar", { exact: true })).toHaveCount(
    0,
  );
  const rangeNavigation = page.getByRole("navigation", {
    name: "History time period",
  });
  await expect(rangeNavigation).toBeVisible();
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const stickyRangeBox = await rangeNavigation.boundingBox();
  expect(stickyRangeBox).not.toBeNull();
  expect(stickyRangeBox!.y).toBeGreaterThanOrEqual(0);
  expect(stickyRangeBox!.y).toBeLessThanOrEqual(16);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: resolve(evidenceDirectory, "insights-desktop.png"),
    fullPage: true,
  });
  await page.locator("main").screenshot({
    path: resolve(evidenceDirectory, "insights-workspace-desktop.png"),
  });

  const progressLink = page.getByRole("link", {
    name: "Open progress evidence",
    exact: true,
  });
  await progressLink.click();
  await expect(page).toHaveURL(
    "/history?range=all&view=insights&lens=progress&calendarView=year&calendarDate=2026-07-10",
  );
  const progressLens = page.getByRole("article", {
    name: "Progress",
    exact: true,
  });
  await expect(progressLens).toBeVisible();
  await expect(
    progressLens.getByRole("region", { name: "Supporting evidence" }),
  ).toBeVisible();
  await expect(
    progressLens.getByRole("region", {
      name: "Confidence and data limitation",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Program fit", exact: true }),
  ).toHaveCount(0);

  await progressLens
    .getByRole("link", { name: "Open supporting exercise evidence" })
    .click();
  const exercisesUrl =
    "/history?range=all&view=exercises&calendarView=year&calendarDate=2026-07-10";
  await expect(page).toHaveURL(exercisesUrl);
  await expect(
    page.getByRole("heading", {
      name: "Exact-exercise progression",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Best observed performances",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(evidenceDirectory, "exercises-desktop.png"),
    fullPage: true,
  });
  await page.locator("main").screenshot({
    path: resolve(evidenceDirectory, "exercises-workspace-desktop.png"),
  });

  const sourceLink = page.getByRole("link", { name: /First workout/ }).first();
  await sourceLink.click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?range=all&view=exercises/);
  await page.getByText("Back to history", { exact: true }).click();
  await expect(page).toHaveURL(exercisesUrl);

  await page.getByRole("link", { name: "Insights", exact: true }).click();
  await expect(page).toHaveURL(
    "/history?range=all&view=insights&calendarView=year&calendarDate=2026-07-10",
  );
  await page.goBack();
  await expect(page).toHaveURL(exercisesUrl);
  await expect(
    page.getByRole("heading", {
      name: "Exact-exercise progression",
      exact: true,
    }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Current progress", exact: true }),
  ).toBeVisible();

  await page.goto(
    "/history?range=all&view=insights&lens=work-capacity&calendarView=year&calendarDate=2026-07-10",
  );
  await expect(
    page.getByRole("article", { name: "Work capacity", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Weekly workload", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Independent health activities", { exact: true }),
  ).toBeVisible();

  await page.goto(
    "/history?range=invalid&view=report&lens=unknown&calendarView=agenda&calendarDate=2026-02-29",
  );
  await expect(
    page.getByRole("heading", { name: "Calendar", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Training calendar", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/history?range=all");
  await expect(page.getByText("Training calendar", { exact: true })).toBeVisible();
  const mobilePageHeight = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  await page.screenshot({
    path: resolve(evidenceDirectory, "calendar-mobile.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(evidenceDirectory, "page-length-reduction.json"),
    `${JSON.stringify(
      {
        baseline: {
          desktop: { viewport: "1440x900", pageHeight: 8472 },
          mobile: { viewport: "390x844", pageHeight: 15486 },
        },
        redesignedCalendar: {
          desktop: {
            viewport: "1440x900",
            pageHeight: desktopPageHeight,
            reductionPercent: Number(
              ((1 - desktopPageHeight / 8472) * 100).toFixed(1),
            ),
          },
          mobile: {
            viewport: "390x844",
            pageHeight: mobilePageHeight,
            reductionPercent: Number(
              ((1 - mobilePageHeight / 15486) * 100).toFixed(1),
            ),
          },
        },
      },
      null,
      2,
    )}\n`,
    { flag: "w" },
  );
  expect(errors).toEqual([]);
});

test("History has clear empty and sparse states without mixing activity into strength", async ({
  page,
}) => {
  const errors = observeErrors(page);
  await signIn(page, sparseEmail);
  await page.goto("/history?range=all");
  await expect(page.getByText("Training calendar", { exact: true })).toBeVisible();

  // The first workspace journey already verifies client-side tab navigation.
  // Open this independent empty-state case by its canonical URL so the broad
  // smoke suite tests the state itself without coupling it to a second copy of
  // the same transition.
  await page.goto("/history?range=all&view=insights");
  await expect(
    page.getByText("No independent activities were recorded in this period.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Current progress", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0", { exact: true }).first()).toBeVisible();

  await page.goto("/activity/new");
  await page.getByLabel("Title (optional)").fill("Sparse history walk");
  await page.getByLabel("Date", { exact: true }).fill("2026-07-20");
  await page.getByLabel("Start time", { exact: true }).fill("09:00");
  await page.getByLabel("Minutes", { exact: true }).fill("30");
  const save = page.getByRole("button", {
    name: "Record activity",
    exact: true,
  });
  await waitForReactHandler(save);
  await save.click();
  await expect(page).toHaveURL(/\/activity\/[0-9a-f-]+(?:\?.*)?$/);
  const activityPath = new URL(page.url()).pathname;

  const activityReturnUrl =
    "/history?range=all&view=insights&lens=work-capacity&calendarView=month&calendarDate=2026-07-20";
  await page.goto(
    `${activityPath}?range=all&view=insights&lens=work-capacity&calendarView=month&calendarDate=2026-07-20`,
  );
  await page.getByText("Back to history", { exact: true }).click();
  await expect(page).toHaveURL(activityReturnUrl);
  await expect(
    page.getByRole("article", { name: "Work capacity", exact: true }),
  ).toBeVisible();

  await page.goto(
    "/history?range=all&calendarView=month&calendarDate=2026-07-20",
  );
  await expect(page.getByText("Sparse history walk", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Exercises", exact: true }).click();
  await expect(
    page.getByText(
      "Complete workouts in this range to see exercise trends.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No eligible performance observations in this period.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("History remains operable at mobile widths and extra-large text", async ({
  page,
}) => {
  const errors = observeErrors(page);
  await signIn(page);
  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForReactHandler(extraLarge);
  await extraLarge.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("extra-large");

  const measurements: Record<string, unknown> = {};
  for (const viewport of [
    { name: "mobile", width: 320, height: 700 },
    { name: "large-mobile", width: 390, height: 844 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "desktop", width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    for (const path of [
      "/history?range=all",
      "/history?range=all&view=insights",
      "/history?range=all&view=exercises",
    ]) {
      await page.goto(path);
      await expectNoHorizontalOverflow(page);
      await expect(
        page.getByRole("navigation", { name: "History views" }),
      ).toBeVisible();
      const rangeNavigation = page.getByRole("navigation", {
        name: "History time period",
      });
      if (path === "/history?range=all") {
        await expect(rangeNavigation).toHaveCount(0);
      } else {
        await expect(rangeNavigation).toBeVisible();
      }
      if (path === "/history?range=all&view=insights") {
        const overviewActions = page.getByRole("link").filter({
          hasText: /^(Open progress evidence|View exact exercises)$/,
        });
        await expect(
          page.getByRole("heading", { name: "Current progress", exact: true }),
        ).toBeVisible();
        await expect(overviewActions).toHaveCount(2);
        expect(
          (await overviewActions.evaluateAll((links) =>
            links.map((link) => link.getBoundingClientRect().height),
          )).every((height) => height >= 44),
        ).toBe(true);
      }
      if (viewport.width >= 1024) {
        const [headingBox, sidebarBox] = await Promise.all([
          page.getByRole("heading", { name: "History", exact: true }).boundingBox(),
          page.locator("aside").boundingBox(),
        ]);
        expect(headingBox).not.toBeNull();
        expect(sidebarBox).not.toBeNull();
        expect(headingBox!.x).toBeGreaterThanOrEqual(
          sidebarBox!.x + sidebarBox!.width,
        );
      }
      const touchTargets = await page
        .getByRole("navigation", { name: "History views" })
        .getByRole("link")
        .evaluateAll((links) =>
          links.map((link) => link.getBoundingClientRect().height),
        );
      expect(touchTargets.every((height) => height >= 44)).toBe(true);
    }
    measurements[viewport.name] = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageHeight: document.documentElement.scrollHeight,
      overflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    }));
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/history?range=all");
  await page.screenshot({
    path: resolve(evidenceDirectory, "calendar-mobile-extra-large.png"),
    fullPage: true,
  });
  await page.goto("/history?range=all&view=insights");
  await page.screenshot({
    path: resolve(evidenceDirectory, "insights-mobile-extra-large.png"),
    fullPage: true,
  });
  await page.goto("/history?range=all&view=exercises");
  await page.screenshot({
    path: resolve(evidenceDirectory, "exercises-mobile-extra-large.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(evidenceDirectory, "measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
    { flag: "w" },
  );
  expect(errors).toEqual([]);
});
