import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedFormSubmit,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const runId =
  process.env.STAGE7_RUN_ID ?? "remediation-2026-07-22-stage7-r1";
const evidenceDirectory = resolve("output/playwright", runId, "evidence");
const stage7Port = Number.parseInt(process.env.STAGE7_PORT ?? "3117", 10);
const stage7Origin = `http://127.0.0.1:${stage7Port}`;

type FontMetric = {
  text: string;
  fontSize: number;
  lineHeight: number | null;
  clipped: boolean;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  box: { left: number; right: number; top: number; bottom: number };
};

type BrowserObservation = {
  consoleErrors: string[];
  pageErrors: string[];
  expectedRequestCancellations: string[];
  expectedHttpErrors: string[];
  unexpectedRequests: string[];
  allowedHttp: Set<string>;
};

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
});

async function writeEvidence(name: string, value: unknown) {
  await writeFile(
    resolve(evidenceDirectory, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { flag: "wx" },
  );
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: resolve(evidenceDirectory, name),
    fullPage: true,
  });
}

function observeBrowser(page: Page): BrowserObservation {
  const observation: BrowserObservation = {
    consoleErrors: [],
    pageErrors: [],
    expectedRequestCancellations: [],
    expectedHttpErrors: [],
    unexpectedRequests: [],
    allowedHttp: new Set(),
  };
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:") &&
      message.text() !== "NEXT_REDIRECT"
    ) {
      observation.consoleErrors.push(`${page.url()} — ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    if (error.message !== "NEXT_REDIRECT") {
      observation.pageErrors.push(`${page.url()} — ${error.message}`);
    }
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "unknown failure";
    const url = new URL(request.url());
    const exactRscCancellation =
      url.origin === stage7Origin &&
      request.method() === "GET" &&
      !request.isNavigationRequest() &&
      url.searchParams.has("_rsc") &&
      request.headers().rsc === "1" &&
      reason === "net::ERR_ABORTED";
    const exactActionCancellation =
      url.origin === stage7Origin &&
      request.method() === "POST" &&
      !request.isNavigationRequest() &&
      Boolean(request.headers()["next-action"]) &&
      reason === "net::ERR_ABORTED" &&
      ([
        "/sign-in",
        "/program",
        "/today",
        "/coach",
        "/history",
        "/settings",
        "/activity/new",
      ].includes(url.pathname) ||
        /^\/session\/[0-9a-f-]{36}$/.test(url.pathname));
    const exactLiveCoachStreamCancellation =
      url.origin === stage7Origin &&
      request.method() === "POST" &&
      !request.isNavigationRequest() &&
      url.pathname === "/api/live-coach/respond" &&
      request.headers()["content-type"] === "application/json" &&
      reason === "net::ERR_ABORTED";
    const description = `${request.method()} ${url.pathname}${url.search} — ${reason}`;
    if (
      exactRscCancellation ||
      exactActionCancellation ||
      exactLiveCoachStreamCancellation
    ) {
      observation.expectedRequestCancellations.push(description);
    } else {
      observation.unexpectedRequests.push(description);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    const description = `${response.status()} ${response.request().method()} ${url.pathname}`;
    if (
      observation.allowedHttp.has(description) ||
      description === "404 GET /api/program/draft"
    ) {
      observation.expectedHttpErrors.push(description);
    } else {
      observation.unexpectedRequests.push(description);
    }
  });
  return observation;
}

function expectCleanObservation(observation: BrowserObservation) {
  expect(observation.consoleErrors).toEqual([]);
  expect(observation.pageErrors).toEqual([]);
  expect(observation.unexpectedRequests).toEqual([]);
}

async function signIn(page: Page, email: string) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(email);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/(?:today|setup\/profile)$/);
  await page.waitForLoadState("networkidle");
}

async function switchAccount(page: Page, email: string) {
  await page.context().clearCookies();
  await signIn(page, email);
}

async function chooseAppSize(page: Page, name: RegExp) {
  await page.goto("/settings");
  const option = page.getByRole("radio", { name });
  if ((await option.getAttribute("aria-checked")) !== "true") {
    await waitForHydratedReactHandler(option);
    await option.click();
    await expect(
      page.getByText("Saved to your profile.", { exact: true }),
    ).toBeVisible();
  }
}

async function fontMetric(locator: Locator): Promise<FontMetric> {
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const parsedLineHeight = Number.parseFloat(style.lineHeight);
    return {
      text: element.textContent?.trim() ?? "",
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: Number.isFinite(parsedLineHeight) ? parsedLineHeight : null,
      clipped:
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      box: {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      },
    };
  });
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
  await expect.poll(() => page.evaluate(() => window.scrollX)).toBe(0);
}

async function headingSize(locator: Locator) {
  return locator.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
}

async function expectVisualHierarchy(
  page: Page,
  h1: Locator,
  h2: Locator,
  h3?: Locator,
) {
  await expect(h1).toBeVisible();
  await expect(h2).toBeVisible();
  const h1Size = await headingSize(h1);
  const h2Size = await headingSize(h2);
  expect(h1Size).toBeGreaterThan(h2Size);
  if (h3) {
    await expect(h3).toBeVisible();
    const h3Size = await headingSize(h3);
    expect(h2Size).toBeGreaterThanOrEqual(h3Size);
  }
  await expectNoHorizontalOverflow(page);
}

async function expectVisibleBoxesDoNotOverlap(locator: Locator) {
  const boxes = await locator.evaluateAll((elements) =>
    elements
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          text: element.textContent?.trim() ?? "",
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        };
      }),
  );
  for (let index = 1; index < boxes.length; index += 1) {
    const previous = boxes[index - 1];
    const current = boxes[index];
    const sameRow =
      Math.min(previous.bottom, current.bottom) -
        Math.max(previous.top, current.top) >
      1;
    if (sameRow && previous.text && current.text) {
      expect(current.left, `${previous.text} must not overlap ${current.text}`).toBeGreaterThanOrEqual(
        previous.right - 1,
      );
    }
  }
}

async function calibration(page: Page) {
  return page.evaluate(() => ({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: window.screen.width, height: window.screen.height },
    deviceScaleFactor: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    appSize: document.documentElement.dataset.fontSize,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
  }));
}

const supportedAppSizes = [
  { key: "compact", root: 16 },
  { key: "default", root: 18.4 },
  { key: "large", root: 20.8 },
  { key: "extra-large", root: 23.2 },
] as const;

async function measureConvertedSurface(
  page: Page,
  locators: Record<string, Locator>,
) {
  const measurements: Record<string, Record<string, FontMetric>> = {};
  for (const size of supportedAppSizes) {
    await page.evaluate((key) => {
      document.documentElement.dataset.fontSize = key;
    }, size.key);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        ),
      )
      .toBeCloseTo(size.root, 1);
    // Badge and other shared primitives use transition-all. Measure only after
    // the preference-driven type transition has reached its final value.
    await page.waitForTimeout(300);
    measurements[size.key] = {};
    for (const [name, locator] of Object.entries(locators)) {
      const metric = await fontMetric(locator);
      expect(
        metric.clipped,
        `${name} must not clip at ${size.key}: ${JSON.stringify(metric)}`,
      ).toBe(false);
      measurements[size.key][name] = metric;
    }
    await expectNoHorizontalOverflow(page);
  }

  for (const name of Object.keys(locators)) {
    let previous = 0;
    for (const size of supportedAppSizes) {
      const measured = measurements[size.key][name].fontSize;
      expect(
        measured,
        `${name} must not shrink at ${size.key}`,
      ).toBeGreaterThanOrEqual(previous - 0.1);
      previous = measured;
    }
    expect(
      measurements["extra-large"][name].fontSize /
        measurements.default[name].fontSize,
      `${name} must scale from default to extra large`,
    ).toBeGreaterThanOrEqual(1.24);
  }
  return measurements;
}

test("records populated Stage 7 hierarchy, keyboard, wrapping, and micro-label scaling", async ({
  page,
}) => {
  const observation = observeBrowser(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "owner@example.com");
  await chooseAppSize(page, /Default 115%/);

  const defaultMetrics: Record<string, FontMetric> = {};
  await page.goto("/program");
  defaultMetrics.programEyebrow = await fontMetric(
    page.getByText("Active program", { exact: true }).first(),
  );
  await page.goto("/today");
  defaultMetrics.todayDecision = await fontMetric(
    page
      .locator('[aria-label^="Program decision status"]')
      .locator("span")
      .filter({ hasText: /Program change/ })
      .first(),
  );
  await page.goto("/history");
  defaultMetrics.historyEyebrow = await fontMetric(
    page.getByText("Training history", { exact: true }),
  );
  defaultMetrics.historyCalendarWeekday = await fontMetric(
    page.locator("#history-calendar .grid.grid-cols-7.border-b > div").first(),
  );
  await page.goto("/history?view=insights&lens=progress");
  defaultMetrics.historyShortAnswer = await fontMetric(
    page.getByText("Short answer", { exact: true }).first(),
  );
  await page.goto("/history?view=insights&lens=work-capacity");
  const defaultWeekLabels = page.locator(
    '[title^="Week of "] > span:last-child',
  );
  if ((await defaultWeekLabels.count()) > 0) {
    defaultMetrics.historyWeekLabel = await fontMetric(
      defaultWeekLabels.first(),
    );
  }
  await page.goto("/settings");
  defaultMetrics.settingsEyebrow = await fontMetric(
    page.getByText("Preferences and safeguards", { exact: true }),
  );

  await chooseAppSize(page, /Extra large/);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        preference: document.documentElement.dataset.fontSize,
        root: getComputedStyle(document.documentElement).fontSize,
      })),
    )
    .toEqual({ preference: "extra-large", root: "23.2px" });

  const extraLargeMetrics: Record<string, FontMetric> = {};
  await page.goto("/program");
  extraLargeMetrics.programEyebrow = await fontMetric(
    page.getByText("Active program", { exact: true }).first(),
  );
  await expectVisualHierarchy(
    page,
    page.locator("main h1").first(),
    page.locator("main h2").first(),
    page.locator("main h3").first(),
  );
  const programRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/program") {
      programRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  const tabs = page.getByRole("tab");
  if ((await tabs.count()) > 1) {
    const selected = page.locator('[role="tab"][aria-selected="true"]');
    const selectedText = await selected.textContent();
    const first = tabs.first();
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const focusedText = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? "",
    );
    const focusedTab = page.getByRole("tab", { name: focusedText, exact: true });
    await expect(focusedTab).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(focusedTab).toHaveAttribute("aria-selected", "true");
    if (selectedText !== focusedText) {
      await expect(
        page.getByRole("tab", { name: selectedText ?? "", exact: true }),
      ).toHaveAttribute("aria-selected", "false");
    }
    expect(programRequests).toEqual([]);
  }
  await screenshot(page, "01-program-375-extra-large.png");

  const navSteps = [
    ["Today", "/today"],
    ["History", "/history"],
    ["Review", "/coach"],
    ["Settings", "/settings"],
    ["Program", "/program"],
  ] as const;
  for (const [label, route] of navSteps) {
    const navigation = page.getByRole("navigation", {
      name: "Primary navigation",
    });
    const link = navigation.getByRole("link", { name: label, exact: true });
    await link.focus();
    await expect(link).toBeFocused();
    await link.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${route.replace("/", "\\/")}$`));
    await expect(link).toHaveAttribute("aria-current", "page");
    await expectNoHorizontalOverflow(page);
  }

  await page.goto("/today");
  extraLargeMetrics.todayDecision = await fontMetric(
    page
      .locator('[aria-label^="Program decision status"]')
      .locator("span")
      .filter({ hasText: /Program change/ })
      .first(),
  );
  await expectVisualHierarchy(
    page,
    page.getByRole("heading", { name: "Today", exact: true }),
    page.locator("main h2").first(),
  );
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await start.focus();
  await expect(start).toBeFocused();
  await screenshot(page, "02-today-375-extra-large.png");

  await page.goto("/history");
  extraLargeMetrics.historyEyebrow = await fontMetric(
    page.getByText("Training history", { exact: true }),
  );
  extraLargeMetrics.historyCalendarWeekday = await fontMetric(
    page.locator("#history-calendar .grid.grid-cols-7.border-b > div").first(),
  );
  await expectVisibleBoxesDoNotOverlap(
    page.locator("#history-calendar .grid.grid-cols-7.border-b > div"),
  );
  await page.goto("/history?view=insights&lens=progress");
  extraLargeMetrics.historyShortAnswer = await fontMetric(
    page.getByText("Short answer", { exact: true }).first(),
  );
  await page.goto("/history?view=insights&lens=work-capacity");
  const extraLargeWeekLabels = page.locator(
    '[title^="Week of "] > span:last-child',
  );
  if ((await extraLargeWeekLabels.count()) > 0) {
    extraLargeMetrics.historyWeekLabel = await fontMetric(
      extraLargeWeekLabels.first(),
    );
    await expectVisibleBoxesDoNotOverlap(extraLargeWeekLabels);
  }
  await page.goto("/history?view=insights&lens=progress");
  await expectVisualHierarchy(
    page,
    page.getByRole("heading", { name: "History", exact: true }),
    page.getByRole("heading", {
      name: "Insights",
      exact: true,
    }),
    page.getByRole("heading", { name: "Progress", exact: true }),
  );
  await screenshot(page, "03-history-375-extra-large.png");

  await page.goto("/settings");
  extraLargeMetrics.settingsEyebrow = await fontMetric(
    page.getByText("Preferences and safeguards", { exact: true }),
  );
  await expectVisualHierarchy(
    page,
    page.getByRole("heading", { name: "Settings", exact: true }),
    page.getByRole("heading", { name: "App size", exact: true }),
  );
  await screenshot(page, "04-settings-375-extra-large.png");

  await switchAccount(page, "review-decisions.e2e@example.com");
  await chooseAppSize(page, /Default 115%/);
  await page.goto("/coach");
  defaultMetrics.reviewProposalLabel = await fontMetric(
    page.getByText(
      "These are proposed Program changes, not informational coaching.",
      { exact: true },
    ),
  );
  await chooseAppSize(page, /Extra large/);
  await page.goto("/coach");
  extraLargeMetrics.reviewProposalLabel = await fontMetric(
    page.getByText(
      "These are proposed Program changes, not informational coaching.",
      { exact: true },
    ),
  );
  const reviewHeadings = await page
    .getByRole("heading", { level: 2 })
    .allTextContents();
  const expectedOrder = [
    "Decisions needing review",
    "Recent decisions",
    "Outcomes ready to assess",
    "Live Coach stays with the workout",
    "Secondary coaching tools",
  ];
  expect(
    reviewHeadings.filter((heading) => expectedOrder.includes(heading)),
  ).toEqual(expectedOrder);
  const pending = page.getByRole("region", { name: "Decisions needing review" });
  const proposalBeforeTools = await pending.evaluate((element, secondaryId) => {
    const other = document.querySelector(secondaryId);
    return Boolean(
      other &&
        element.compareDocumentPosition(other) &
          Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }, '[aria-labelledby="secondary-tools-heading"]');
  expect(proposalBeforeTools).toBe(true);
  await expectVisualHierarchy(
    page,
    page.getByRole("heading", { name: "Review and decisions", exact: true }),
    page.getByRole("heading", { name: "Decisions needing review", exact: true }),
    pending.getByRole("heading", { name: "Barbell Back Squat", exact: true }),
  );
  const decrease = pending.getByRole("button", {
    name: "Decrease load",
    exact: true,
  }).first();
  await decrease.focus();
  await expect(decrease).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    pending.getByRole("button", { name: "Increase load", exact: true }).first(),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    pending.getByRole("button", { name: "Approve", exact: true }).first(),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    pending.getByRole("button", { name: "Reject", exact: true }).first(),
  ).toBeFocused();
  await screenshot(page, "05-review-proposal-hierarchy-375-extra-large.png");

  await page.setViewportSize({ width: 320, height: 700 });
  for (const [route, name] of [
    ["/program", "06-program-320-extra-large.png"],
    ["/coach", "07-review-320-extra-large.png"],
    ["/history", "08-history-320-extra-large.png"],
  ] as const) {
    await page.goto(route);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, name);
  }

  const evidence = {
    runId,
    calibration: await calibration(page),
    defaultRootFontSize: 18.4,
    extraLargeRootFontSize: 23.2,
    requiredScaleRatio: 1.24,
    defaultMetrics,
    extraLargeMetrics,
    expectedRequestCancellations: observation.expectedRequestCancellations,
    expectedHttpErrors: observation.expectedHttpErrors,
  };
  await writeEvidence("01-populated-surface-metrics.json", evidence);

  for (const key of Object.keys(defaultMetrics)) {
    const before = defaultMetrics[key];
    const after = extraLargeMetrics[key];
    expect(after, `${key} needs an extra-large measurement`).toBeDefined();
    if (!after) continue;
    expect.soft(after.clipped, `${key} must not clip`).toBe(false);
    expect
      .soft(
        after.fontSize / before.fontSize,
        `${key} must scale with the account app-size preference`,
      )
      .toBeGreaterThanOrEqual(1.24);
  }
  expectCleanObservation(observation);
});

test("checks every converted micro-label surface at all four app sizes", async ({
  page,
}) => {
  const observation = observeBrowser(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "owner@example.com");
  const surfaces: Record<string, unknown> = {};

  await page.goto("/activity/new");
  await page.getByLabel("Title (optional)").fill("Stage 7 scaling walk");
  await page.getByLabel("Minutes", { exact: true }).fill("45");
  await page.getByLabel("Distance (optional)").fill("3.5");
  const recordActivity = page.getByRole("button", {
    name: "Record activity",
    exact: true,
  });
  await waitForHydratedFormSubmit(recordActivity);
  await recordActivity.click();
  await expect(page).toHaveURL(/\/activity\/[0-9a-f-]+(?:\?.*)?$/);

  await page.goto("/coach");
  const activityContext = page.getByRole("region", {
    name: "Independent activity context",
  });
  surfaces.coachActivityContext = await measureConvertedSurface(page, {
    activityDetail: activityContext.getByText(/per week$/).first(),
  });

  await page.goto("/history?range=all&view=insights&lens=work-capacity");
  const historyActivity = page.locator(
    '[aria-labelledby="activity-summary-heading"]',
  );
  surfaces.historyInsights = await measureConvertedSurface(page, {
    activityDetail: historyActivity.getByText(/per week$/).first(),
    shortAnswer: page.getByText("Short answer", { exact: true }).first(),
    workloadWeek: page.locator('[title^="Week of "] > span:last-child').first(),
  });

  await page.goto("/history?range=all");
  surfaces.historyCalendar = await measureConvertedSurface(page, {
    calendarWeekday: page
      .locator("#history-calendar .grid.grid-cols-7.border-b > div")
      .first(),
  });
  await expectVisibleBoxesDoNotOverlap(
    page.locator("#history-calendar .grid.grid-cols-7.border-b > div"),
  );
  await screenshot(page, "17-history-all-sizes-final-extra-large.png");

  await page.goto("/program/import");
  await expect(
    page.getByText("Review before saving", { exact: true }),
  ).toBeVisible();
  surfaces.routineImport = await measureConvertedSurface(page, {
    matchBadge: page
      .locator('[data-slot="badge"]')
      .filter({ hasText: /^(?:✓ exact|✓ alias|~ fuzzy|\? unmapped)$/ })
      .first(),
    setsLabel: page.getByText("sets", { exact: true }).last(),
    exercisePicker: page.getByRole("button", {
      name: "Change Barbell Bench Press",
      exact: true,
    }),
    confirmAction: page.getByRole("button", {
      name: "Confirm intent & activate program",
      exact: true,
    }),
  });
  await screenshot(page, "18-routine-import-all-sizes-final-extra-large.png");

  const csv = [
    "title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_lbs,reps,distance_km,duration_seconds,rpe",
    '"Stage 7 Import","Jul 12, 2026, 6:00 PM","Jul 12, 2026, 7:00 PM","Sizing evidence","Barbell Bench Press","","Controlled rep",0,"normal",135,8,"","",8',
  ].join("\n");
  await page.getByLabel("Hevy CSV export").setInputFiles({
    name: "stage7-hevy.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  const reviewFile = page.getByRole("button", {
    name: "Review file",
    exact: true,
  });
  await waitForHydratedReactHandler(reviewFile);
  await reviewFile.click();
  const exerciseReview = page.locator("article").filter({
    hasText: "Barbell Bench Press",
  });
  await exerciseReview.locator("button").first().click();
  surfaces.hevyImport = await measureConvertedSurface(page, {
    statLabel: page.getByText("workouts", { exact: true }).first(),
    catalogDetail: exerciseReview.getByText(
      /The full catalog is searchable\./,
    ),
  });
  await screenshot(page, "19-hevy-import-all-sizes-final-extra-large.png");

  await page.goto("/today");
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  const nextSet = page.getByTestId("current-exercise-card");
  const askCoach = nextSet.getByRole("button", {
    name: "Ask Coach",
    exact: true,
  });
  await askCoach.click();
  const liveCoach = page.getByRole("dialog", { name: "Live Coach" });
  await liveCoach
    .getByLabel("Question for Live Coach")
    .fill("What should I focus on for this first set?");
  await liveCoach
    .getByRole("button", { name: "Save and ask", exact: true })
    .click();
  await expect(liveCoach.getByText(/^Coach · /)).toBeVisible();
  surfaces.liveCoach = await measureConvertedSurface(page, {
    userMetadata: liveCoach.getByText("You", { exact: true }).last(),
    coachMetadata: liveCoach.getByText(/^Coach · /),
  });
  await screenshot(page, "20-live-coach-all-sizes-final-extra-large.png");

  await writeEvidence("04-all-converted-surfaces.json", {
    runId,
    calibration: await calibration(page),
    supportedAppSizes,
    surfaces,
    expectedRequestCancellations: observation.expectedRequestCancellations,
    expectedHttpErrors: observation.expectedHttpErrors,
  });
  expectCleanObservation(observation);
});

test("records honest empty states at 320 px and 145 percent app text", async ({
  page,
}) => {
  const observation = observeBrowser(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await signIn(page, "today-empty.e2e@example.com");
  await chooseAppSize(page, /Extra large/);

  await page.goto("/today");
  await expect(
    page.getByRole("heading", { name: "No completed workouts yet", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Statistics and streaks will appear after your first completed workout.",
      { exact: true },
    ),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, "09-today-empty-320-extra-large.png");

  await page.goto("/coach");
  for (const message of [
    "0 pending",
    "No decisions have been proposed yet. Rule-based checks run from completed planned workouts and recorded pain evidence.",
    "No decision history yet. This list begins after you accept, edit, or reject a proposal, or when a proposal expires.",
    "No accepted decision has follow-up training to assess yet.",
    "No generated review yet",
    "No open-ended answers yet. Ask Coach above when a question does not belong to a pending Program decision or an active workout.",
  ]) {
    await expect(page.getByText(message, { exact: true })).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);
  await screenshot(page, "10-review-empty-320-extra-large.png");

  await page.goto("/history");
  for (const [article, message] of [
    ["Progress", "No strength-progress answer is available yet"],
    ["Program fit", "No Program-linked history is available"],
    ["Work capacity", "Not enough comparable completed strength work"],
    ["Records", "No eligible supported performance observations"],
  ] as const) {
    await expect(
      page.getByRole("article", { name: article, exact: true }),
    ).toContainText(message);
  }
  await expectNoHorizontalOverflow(page);
  await screenshot(page, "11-history-empty-320-extra-large.png");

  await page.goto("/settings");
  await expect(page.getByText("No equipment recorded.", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, "12-settings-empty-320-extra-large.png");
  await writeEvidence("02-empty-state-calibration.json", {
    runId,
    calibration: await calibration(page),
    surfaces: ["Today", "Review and decisions", "History", "Settings"],
    expectedRequestCancellations: observation.expectedRequestCancellations,
    expectedHttpErrors: observation.expectedHttpErrors,
  });
  expectCleanObservation(observation);
});

test("records deterministic Settings loading and Review loading, error, and recovery", async ({
  page,
}) => {
  const observation = observeBrowser(page);
  observation.allowedHttp.add("503 POST /coach");
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "today-empty.e2e@example.com");
  await chooseAppSize(page, /Default 115%/);

  let releaseSetting!: () => void;
  const settingGate = new Promise<void>((resolveGate) => {
    releaseSetting = resolveGate;
  });
  let settingStarted = false;
  await page.route("**/settings", async (route) => {
    if (
      !settingStarted &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      settingStarted = true;
      await settingGate;
    }
    await route.continue();
  });
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForHydratedReactHandler(extraLarge);
  await extraLarge.click();
  await expect.poll(() => settingStarted).toBe(true);
  await expect(
    page.getByText("Saving to your profile…", { exact: true }),
  ).toBeVisible();
  await expect(extraLarge).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, "13-settings-saving-375-extra-large.png");
  releaseSetting();
  await expect(
    page.getByText("Saved to your profile.", { exact: true }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });

  await page.goto("/coach");
  const secondary = page.getByRole("region", { name: "Secondary coaching tools" });
  let releaseReview!: () => void;
  const reviewGate = new Promise<void>((resolveGate) => {
    releaseReview = resolveGate;
  });
  let reviewStarted = false;
  await page.route("**/coach", async (route) => {
    if (
      !reviewStarted &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      reviewStarted = true;
      await reviewGate;
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Expected Stage 7 Coach failure",
      });
      return;
    }
    await route.continue();
  });
  const createReview = secondary.getByRole("button", {
    name: "Create a fresh review",
    exact: true,
  });
  await waitForHydratedReactHandler(createReview);
  await createReview.focus();
  await expect(createReview).toBeFocused();
  await createReview.click();
  await expect.poll(() => reviewStarted).toBe(true);
  const reviewing = secondary.getByRole("button", {
    name: "Reviewing your training…",
    exact: true,
  });
  await expect(reviewing).toBeVisible();
  await expect(reviewing).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, "14-review-loading-375-extra-large.png");
  releaseReview();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Coach could not finish that review. Please try again.",
    }),
  ).toBeVisible();
  await screenshot(page, "15-review-error-375-extra-large.png");
  await page.unrouteAll({ behavior: "wait" });

  const retry = secondary.getByRole("button", {
    name: "Create a fresh review",
    exact: true,
  });
  await waitForHydratedReactHandler(retry);
  await retry.click();
  await expect(
    page.getByText("Your new training review is ready below.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Latest training review", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, "16-review-recovered-375-extra-large.png");
  await writeEvidence("03-loading-error-recovery.json", {
    runId,
    calibration: await calibration(page),
    settings: "Delayed save showed a persistent loading label and disabled controls before success.",
    review:
      "Delayed deterministic Coach action showed loading, one expected HTTP 503 produced friendly recovery copy, and the next attempt succeeded.",
    expectedRequestCancellations: observation.expectedRequestCancellations,
    expectedHttpErrors: observation.expectedHttpErrors,
  });
  expect(observation.expectedHttpErrors).toEqual(["503 POST /coach"]);
  expectCleanObservation(observation);
});
