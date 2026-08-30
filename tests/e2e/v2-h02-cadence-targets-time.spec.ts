import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";
import {
  V2_H02_EMAIL,
  V2_H02_IDS,
} from "../helpers/v2-h02-cadence-targets-time-constants";

const EXPECTED_FIXTURE_RSC_PATHS = new Set(["/activity/new"]);

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(V2_H02_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  await page.waitForLoadState("networkidle");
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
}

async function applyEnlargedText(page: Page, enabled: boolean) {
  if (!enabled) return;
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "extra-large";
  });
}

async function expectedCompleteWeekAverage(page: Page) {
  const weekday = await page.evaluate(() =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      weekday: "short",
    }).format(new Date()),
  );
  // A four-week range that begins on Monday contains four complete weeks.
  // Every other weekday has three complete Monday-Sunday weeks because the
  // partial first and current weeks remain excluded by the product contract.
  // Tuesday is distinct: the -23-day fixture session falls in the first
  // partial week and the -1-day session falls in the current partial week.
  const expectedByWeekday: Record<string, string> = {
    Mon: "1.25",
    Tue: "1",
    Wed: "1.33",
    Thu: "1.33",
    Fri: "1.33",
    Sat: "1.33",
    Sun: "1.33",
  };
  const expected = expectedByWeekday[weekday];
  if (!expected) throw new Error(`Unsupported Toronto weekday: ${weekday}`);
  return expected;
}

test("keeps calendar cadence and planned-set outcomes separate and trustworthy", async ({
  browserName,
  page,
}) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(
    page,
    browserName,
    [],
    EXPECTED_FIXTURE_RSC_PATHS,
  );
  const mutationRequests: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      mutationRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  const narrowMobile = (page.viewportSize()?.width ?? 0) <= 320;

  await page.goto("/history?view=insights&range=4w");
  await applyEnlargedText(page, narrowMobile);
  await expect(
    page.getByRole("link", { name: "Insights", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 3, name: "Current progress" })).toBeVisible();
  const reportMeasurements = page.locator("details").filter({
    hasText: "More report measurements",
  });
  await openNativeDetails(reportMeasurements);
  const expectedCadence = await expectedCompleteWeekAverage(page);
  await expect(page.getByText("Workouts per complete week").locator("..")).toContainText(expectedCadence);
  await expect(page.getByText("Median workout gap").locator("..")).toContainText("5.5 days");
  await expect(page.getByText("Current workout gap").locator("..")).toContainText("1 day");
  await expect(page.getByText(/Current preference: 3 sessions per week/)).toBeVisible();
  await expect(page.getByText(/not an adherence percentage/)).toBeVisible();
  await expect(page.getByText("Program-day exposure", { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({
    hasText: "Push renamed / Strength A",
  })).toBeVisible();
  await expect(page.getByRole("listitem").filter({
    hasText: "Strength B",
  })).toBeVisible();
  await expect(page.getByText(/2 completed workouts are not linked to a Program day/)).toBeVisible();

  await expect(page.getByRole("heading", { level: 3, name: "Planned set outcomes" })).toBeVisible();
  await expect(page.getByText("Below", { exact: true }).locator("..")).toContainText("1");
  await expect(page.getByText("At", { exact: true }).locator("..")).toContainText("2");
  await expect(page.getByText("Above", { exact: true }).locator("..")).toContainText("1");
  await expect(page.getByText("Unknown", { exact: true }).locator("..")).toContainText("1");
  await expect(
    page.getByText(/4 of 5 quantified outcomes were evaluable \(80%\)/),
  ).toBeVisible();
  await expect(
    page.getByText(/Within that subset, 75% were at or above target/),
  ).toBeVisible();
  if (narrowMobile) await expectNoHorizontalOverflow(page);

  await page.goto(`/history/${V2_H02_IDS.firstSession}`);
  await applyEnlargedText(page, narrowMobile);
  await expect(page.getByText(/1 at target · 1 below target/).first()).toBeVisible();
  await expect(page.getByText("Planned target: below", { exact: true })).toBeVisible();
  await expect(page.getByText("Planned target: at", { exact: true })).toBeVisible();
  if (narrowMobile) await expectNoHorizontalOverflow(page);

  await page.goto(`/history/${V2_H02_IDS.dateOnlySession}`);
  await applyEnlargedText(page, narrowMobile);
  await expect(page.getByText(/Time and duration unknown/)).toBeVisible();
  await expect(
    page.getByText(/1 planned outcome could not be compared safely/).first(),
  ).toBeVisible();
  await expect(page.getByText(/2 working sets/)).toBeVisible();
  await expect(page.getByText("Planned target: unknown", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/^Planned target:/)).toHaveCount(1);
  if (narrowMobile) await expectNoHorizontalOverflow(page);

  await page.goto("/coach");
  await applyEnlargedText(page, narrowMobile);
  await expect(
    page.getByText("Target-attainment coverage", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Coaching tools", { exact: true })).toBeVisible();

  if (narrowMobile) await expectNoHorizontalOverflow(page);

  expect(mutationRequests).toEqual([]);
  await pageErrors.expectNoUnexpected();
});
