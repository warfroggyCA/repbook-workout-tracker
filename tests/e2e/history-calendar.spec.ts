import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  isCorrelatedWebKitRscPrefetchCancellation,
  isExpectedWebKitRscHistoryLinkCancellation,
  isExpectedWebKitRscLinkCancellation,
  observeNextRscPrefetches,
} from "../helpers/webkit-rsc-prefetch-errors";

const HISTORY_CALENDAR_EMAIL = "history-calendar.e2e@example.com";
const APP_SHELL_LINK_PATHS = new Set([
  "/today",
  "/history",
  "/coach",
  "/program",
  "/settings",
]);

async function waitForReactHandler(locator: Locator) {
  await expect
    .poll(async () =>
      locator.evaluate((element) =>
        Object.getOwnPropertyNames(element).some((name) =>
          name.startsWith("__reactProps$")
        )
      )
    )
    .toBe(true);
}

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(email);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForReactHandler(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function recordActivity(
  page: Page,
  title: string,
  localStart: string
) {
  await page.goto("/activity/new");
  await page.getByLabel("Title (optional)").fill(title);
  await page.getByLabel("Date and start time").fill(localStart);
  await page.getByLabel("Duration (minutes)").fill("30");
  const save = page.getByRole("button", {
    name: "Record activity",
    exact: true,
  });
  await waitForReactHandler(save);
  await save.click();
  await expect(page).toHaveURL(/\/activity\/[0-9a-f-]+$/);
}

function ownerLocalDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return ownerLocalDateFromKey(
    `${value.year}-${value.month}-${value.day}`,
    offsetDays
  );
}

function ownerLocalDateFromKey(key: string, offsetDays = 0) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return {
    key: date.toISOString().slice(0, 10),
    label: new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(date),
  };
}

test("calendar-first History opens a recoverable retrospective entry flow", async ({
  page,
  browserName,
}) => {
  const errors: string[] = [];
  const primaryDate = browserName === "webkit" ? "2020-01-06" : "2020-01-01";
  const primaryLabel =
    browserName === "webkit"
      ? "Monday, January 6, 2020"
      : "Wednesday, January 1, 2020";
  const nextDate = browserName === "webkit" ? "2020-01-07" : "2020-01-02";
  const prefetches = observeNextRscPrefetches(page, browserName);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await signIn(page, HISTORY_CALENDAR_EMAIL);
  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await extraLarge.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.fontSize))
    .toBe("extra-large");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `/history?range=all&calendarView=year&calendarDate=${primaryDate}`
  );
  await page.waitForLoadState("networkidle");
  await prefetches.settle();
  errors.length = 0;

  const viewHeading = page.getByRole("heading", {
    name: "Calendar",
    exact: true,
  });
  const calendarTitle = page.getByRole("heading", {
    name: "Training calendar",
    exact: true,
  });
  const attention = page.getByRole("heading", {
    name: "Needs attention",
    exact: true,
  });
  const [viewBox, calendarBox, attentionBox] = await Promise.all([
    viewHeading.boundingBox(),
    calendarTitle.boundingBox(),
    attention.boundingBox(),
  ]);
  expect(viewBox).not.toBeNull();
  expect(calendarBox).not.toBeNull();
  expect(attentionBox).not.toBeNull();
  expect(viewBox!.y).toBeLessThan(calendarBox!.y);
  expect(calendarBox!.y).toBeLessThan(attentionBox!.y);

  const selectedPastDate = page.getByRole("link", {
    name: `${primaryLabel}: Record a workout`,
    exact: true,
  });
  await expect(selectedPastDate).toBeVisible();
  await expect(page.locator("[data-calendar-action][tabindex='0']")).toHaveCount(
    1
  );
  await selectedPastDate.focus();
  await selectedPastDate.press("ArrowRight");
  await expect(
    page.locator(
      `[data-calendar-action][data-calendar-date="${nextDate}"]`,
    )
  ).toBeFocused();

  await selectedPastDate.click();
  await expect(page).toHaveURL(
    new RegExp(`/history/record\\?.*date=${primaryDate}`),
  );
  await expect(
    page.getByRole("heading", {
      name: `Record workout on ${primaryLabel}`,
    }),
  ).toBeVisible();
  await expect(page.getByText("Enter only facts you remember.")).toBeVisible();
  await page.getByRole("radio", { name: /Performed from Program/ }).click();
  await page.getByLabel("Program day", { exact: true }).selectOption({ index: 1 });
  await page
    .getByRole("button", { name: "Choose a performed substitution" })
    .click();
  const substitutionPicker = page.getByRole("dialog", {
    name: "Choose the performed exercise",
  });
  await substitutionPicker
    .getByLabel("Search exercise library")
    .fill("Overhead Cable Triceps Extension");
  await substitutionPicker
    .getByRole("button", {
      name: "View details for Overhead Cable Triceps Extension",
      exact: true,
    })
    .click();
  await substitutionPicker
    .getByRole("button", { name: "Use as performed exercise" })
    .click();
  await page.getByLabel("Substitution reason").selectOption("other");
  await page
    .getByLabel(/set 1 outcome/i)
    .selectOption("completed");
  await page.getByLabel("Weight (lb)").first().fill("45");
  await page.getByLabel("Repetitions").first().fill("8");
  await page.getByLabel(/Effort \(RPE/).first().fill("8");
  await page.getByRole("button", { name: "Add extra set" }).click();
  await page.getByLabel("Weight (lb)").last().fill("20");
  await page.getByLabel("Repetitions").last().fill("12");
  await expect(page.getByText("Program target:")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Recovered this browser’s draft")).toBeVisible();
  await expect(page.getByLabel("Weight (lb)").first()).toHaveValue("45");
  await expect(page.getByLabel("Repetitions").first()).toHaveValue("8");
  await expect(
    page.getByRole("button", {
      name: "Performed: Overhead Cable Triceps Extension",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Extra set 1 · Added to this workout"),
  ).toBeVisible();
  await expect(page.getByLabel("Weight (lb)").last()).toHaveValue("20");
  await expect(page.getByLabel("Repetitions").last()).toHaveValue("12");
  await page.getByRole("button", { name: "Review workout" }).click();
  await expect(page.getByText("2 completed")).toBeVisible();
  await expect(page.getByText("2 unknown")).toBeVisible();
  await expect(page.getByText("Date only — time and duration unknown")).toBeVisible();
  await expect(page.getByText(/Starter Program/)).toBeVisible();
  await expect(
    page.getByText(
      "Performed Overhead Cable Triceps Extension instead of Barbell Back Squat · Other",
    ),
  ).toBeVisible();
  await expect(page.getByText("Extra set 1: Completed")).toBeVisible();
  await page.getByRole("button", { name: "Save completed workout" }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?/);
  await expect(
    page
      .getByLabel("Workout evidence status")
      .getByText("Entered after the workout", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Linked to Program day")).toBeVisible();
  await expect(page.getByText(/Time and duration unknown/)).toBeVisible();
  await expect(
    page.getByText(
      /Performed Overhead Cable Triceps Extension instead of Barbell Back Squat/,
    ),
  ).toBeVisible();
  await expect(page.getByText("Extra set 1", { exact: true })).toBeVisible();
  await expect(page.getByText("20 lb × 12 reps", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to history" }).click();
  await expect(page).toHaveURL(/\/history\?/);
  await expect(
    page.getByRole("link", {
      name: new RegExp(`${primaryLabel}: Open`),
    }),
  ).toBeVisible();

  await page.goto(
    `/history/record?range=all&calendarView=year&calendarDate=${primaryDate}&date=${primaryDate}`,
  );
  await page.getByRole("radio", { name: /Performed from Program/ }).click();
  await page.getByLabel("Program day", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel(/set 1 outcome/i).selectOption("completed");
  await page.getByLabel("Weight (lb)").first().fill("45");
  await page.getByLabel("Repetitions").first().fill("8");
  await page.getByRole("button", { name: "Review workout" }).click();
  await page.getByRole("button", { name: "Save completed workout" }).click();
  await expect(
    page.getByText("Another workout is already recorded on this date"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save completed workout" }),
  ).toBeDisabled();
  await page
    .getByText("This is a separate workout on the same date")
    .click();
  await expect(
    page.getByRole("button", { name: "Save completed workout" }),
  ).toBeEnabled();

  await page.setViewportSize({ width: 320, height: 700 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
  await page.goBack();

  const targetDate = browserName === "webkit" ? "2020-01-03" : "2020-01-02";
  const targetLabel =
    browserName === "webkit"
      ? "Friday, January 3, 2020"
      : "Thursday, January 2, 2020";
  await recordActivity(
    page,
    `H1 ${browserName} first activity`,
    `${targetDate}T10:00`
  );
  await recordActivity(
    page,
    `H1 ${browserName} second activity`,
    `${targetDate}T16:00`
  );
  await page.goto(
    `/history?range=all&calendarView=year&calendarDate=${targetDate}`
  );
  const chooser = page.getByRole("dialog", { name: "Choose a record" });
  await expect(chooser).toContainText(targetLabel);
  await expect(chooser).toContainText(`H1 ${browserName} first activity`);
  await expect(chooser).toContainText(`H1 ${browserName} second activity`);
  await chooser
    .getByRole("button", { name: "Record another workout", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/history/record\\?.*date=${targetDate}`));
  await page.goBack();

  await page.setViewportSize({ width: 320, height: 700 });
  await expect(chooser).toBeVisible();
  const chooserBox = await chooser.boundingBox();
  expect(chooserBox).not.toBeNull();
  expect(chooserBox!.x).toBeGreaterThanOrEqual(0);
  expect(chooserBox!.x + chooserBox!.width).toBeLessThanOrEqual(320);
  await expect(
    chooser.getByRole("button", {
      name: "Record another workout",
      exact: true,
    })
  ).toBeVisible();
  await chooser.getByRole("button", { name: "Close" }).click();
  const undersizedDateActions = await page
    .locator("#history-calendar [data-calendar-action]")
    .evaluateAll((actions) =>
      actions
        .map((action) => {
          const box = action.getBoundingClientRect();
          return { date: action.getAttribute("data-calendar-date"), ...box.toJSON() };
        })
        .filter(({ width, height }) => width < 24 || height < 24)
    );
  expect(undersizedDateActions).toEqual([]);
  const calendarOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(calendarOverflow).toBe(false);
  await prefetches.settle();
  expect(
    errors.filter(
      (error) =>
        !(
          browserName === "webkit" &&
          /^\/127\.0\.0\.1:\d+\/history\/[0-9a-f-]+\?[^ ]*_rsc=[A-Za-z0-9_-]+ due to access control checks\.$/.test(
            error,
          )
        ) &&
        !isExpectedWebKitRscLinkCancellation(
          error,
          browserName,
          APP_SHELL_LINK_PATHS,
        ) &&
        !isExpectedWebKitRscHistoryLinkCancellation(error, browserName) &&
        !isCorrelatedWebKitRscPrefetchCancellation(
          error,
          browserName,
          prefetches.observedUrls,
        )
    )
  ).toEqual([]);
});

test("corrects completed workout timing with an explicit review", async ({
  page,
  browserName,
}) => {
  const sourceDate = browserName === "webkit" ? "2020-01-06" : "2020-01-01";
  const sourceLabel =
    browserName === "webkit"
      ? "Monday, January 6, 2020"
      : "Wednesday, January 1, 2020";
  const correctedDate =
    browserName === "webkit" ? "2020-01-05" : "2019-12-31";
  const correctedSummary =
    browserName === "webkit" ? "Sun, Jan 5" : "Tue, Dec 31";

  await signIn(page, HISTORY_CALENDAR_EMAIL);
  await page.goto(
    `/history?range=all&calendarView=year&calendarDate=${sourceDate}`,
  );
  const sourceWorkout = page.getByRole("link", {
    name: new RegExp(`${sourceLabel}: Open`),
  });
  await waitForReactHandler(sourceWorkout);
  await sourceWorkout.click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?/);
  await page
    .getByRole("button", { name: "Correct workout timing", exact: true })
    .click();
  await page.getByLabel("Workout date").fill(correctedDate);
  await page.getByText("Exact local start", { exact: true }).click();
  await page.getByLabel("Local start time").fill("09:30:00");
  await page.getByLabel("Duration (minutes, optional)").fill("60");
  await page
    .getByRole("button", { name: "Review timing correction", exact: true })
    .click();
  await expect(page.getByText("Unchanged evidence", { exact: true })).toBeVisible();
  await page
    .getByText(/I reviewed the original and corrected timing/)
    .click();
  await page
    .getByRole("button", {
      name: "Save reviewed timing correction",
      exact: true,
    })
    .click();

  await expect(
    page.getByText(new RegExp(`${correctedSummary} · 9:30`)),
  ).toBeVisible();
  await expect(page.getByText(/Timing corrected 1 time/)).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(new RegExp(`${correctedSummary} · 9:30`)),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Correct workout timing", exact: true })
    .click();
  await page
    .getByRole("radio", {
      name: "Date only — wall-clock start and elapsed span unknown",
    })
    .click();
  await page
    .getByRole("button", { name: "Review timing correction", exact: true })
    .click();
  await expect(
    page.getByText(/Date only · wall-clock start and elapsed span unknown/),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Active-duration evidence—and whether it is available for analytics—remains unchanged by this source-timing correction.",
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page
    .getByRole("button", { name: "Correct workout timing", exact: true })
    .click();
  await expect(
    page.getByRole("radio", { name: "Exact local start" }),
  ).toBeChecked();
  await page.getByLabel("Workout date").fill("2026-03-08");
  await page.getByLabel("Local start time").fill("02:30:00");
  await expect(
    page.getByText(/does not exist in America\/Toronto/),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("owner-local today uses Today and future empty dates stay inert", async ({
  page,
}) => {
  const navigationDate = ownerLocalDate();
  await signIn(page, HISTORY_CALENDAR_EMAIL);
  await page.goto(
    `/history?range=all&calendarView=month&calendarDate=${navigationDate.key}`
  );

  const today = page.locator(
    '[data-calendar-action][aria-label$=": Open Today to record a workout"]'
  );
  await expect(today).toHaveCount(1);
  await expect(today).toHaveAttribute("href", "/today");
  const renderedToday = await today.getAttribute("data-calendar-date");
  expect(renderedToday).not.toBeNull();
  const tomorrow = ownerLocalDateFromKey(renderedToday!, 1);
  const future = page.locator(`time[datetime="${tomorrow.key}"]`);
  await expect(future).toHaveCount(1);
  await expect(future).toHaveAttribute(
    "aria-label",
    `${tomorrow.label}: No history`
  );
  await expect(future).not.toHaveAttribute("href");
  await expect(future).not.toHaveAttribute("tabindex", "0");
});

test("an unconfirmed save keeps the exact draft and safely retries", async ({
  page,
  context,
  browserName,
}) => {
  const date = browserName === "webkit" ? "2018-02-02" : "2018-02-01";
  await signIn(page, HISTORY_CALENDAR_EMAIL);
  await page.goto(
    `/history/record?range=all&calendarView=month&calendarDate=${date}&date=${date}`,
  );
  await page.getByRole("button", { name: "Add performed exercise" }).click();
  const picker = page.getByRole("dialog", {
    name: "Choose the performed exercise",
  });
  await picker.getByLabel("Search exercise library").fill("Barbell Back Squat");
  await picker
    .getByRole("button", { name: "View details for Barbell Back Squat" })
    .click();
  await picker.getByRole("button", { name: "Add to workout" }).click();
  await page.getByLabel("Weight (lb)").first().fill("47.5");
  await page.getByLabel("Repetitions").first().fill("9");
  await page.getByRole("button", { name: "Review workout" }).click();

  await context.setOffline(true);
  await page.getByRole("button", { name: "Save completed workout" }).click();
  await expect(
    page.getByText("The save response could not be confirmed"),
  ).toBeVisible();
  await expect(page.getByText(/won't create a duplicate/)).toBeVisible();

  await context.setOffline(false);
  await page.getByRole("button", { name: "Save completed workout" }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?/);
  await expect(
    page
      .getByLabel("Workout evidence status")
      .getByText("Entered after the workout", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("47.5 lb × 9 reps", { exact: true })).toBeVisible();
});

test("exact local times refuse DST gaps and require an overlap choice", async ({
  page,
}) => {
  await signIn(page, HISTORY_CALENDAR_EMAIL);
  await page.goto(
    "/history/record?range=all&calendarView=month&calendarDate=2025-03-09&date=2025-03-09",
  );
  await page.getByRole("radio", { name: /Exact local start/ }).click();
  await page.getByLabel("Local start time").fill("02:30");
  await page.getByRole("radio", { name: /Performed from Program/ }).click();
  await page.getByLabel("Program day", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel(/set 1 outcome/i).selectOption("skipped");
  await page.getByLabel("Skip reason").selectOption("user_choice");
  await page.getByRole("button", { name: "Review workout" }).click();
  await expect(page.getByText(/does not exist in America\/Toronto/)).toBeVisible();

  await page.goto(
    "/history/record?range=all&calendarView=month&calendarDate=2025-11-02&date=2025-11-02",
  );
  await page.getByRole("radio", { name: /Exact local start/ }).click();
  await page.getByLabel("Local start time").fill("01:30");
  await expect(
    page.getByRole("group", { name: "Workout start time occurs twice" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Earlier time/i }).click();
  await expect(
    page.getByRole("radio", { name: /Earlier time/i }),
  ).toBeChecked();
});
