import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";
import {
  V2_H02_EMAIL,
  V2_H02_IDS,
} from "../helpers/v2-h02-cadence-targets-time-constants";

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

async function expectedCompleteWeekSummary(page: Page) {
  const weekday = await page.evaluate(() =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      weekday: "short",
    }).format(new Date()),
  );
  // A four-week range that begins on Monday contains four complete weeks.
  // Every other weekday has three complete Monday-Sunday weeks because the
  // partial first and current weeks remain excluded by the product contract.
  return weekday === "Mon"
    ? { average: "1.25", weeks: "4 complete Monday–Sunday weeks" }
    : { average: "1.33", weeks: "3 complete Monday–Sunday weeks" };
}

test("keeps calendar cadence and planned-set outcomes separate and trustworthy", async ({
  browserName,
  page,
}) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(page, browserName);
  const mutationRequests: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      mutationRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  const narrowMobile = (page.viewportSize()?.width ?? 0) <= 320;

  await page.goto("/history?view=insights&range=4w");
  await applyEnlargedText(page, narrowMobile);
  await expect(page.getByRole("heading", { level: 2, name: "Insights" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Training cadence" })).toBeVisible();
  const expectedCadence = await expectedCompleteWeekSummary(page);
  const cadenceSummary = page.getByText("Per complete week").locator("..");
  await expect(cadenceSummary).toContainText(expectedCadence.average);
  await expect(cadenceSummary).toContainText(expectedCadence.weeks);
  await expect(page.getByText("Median gap").locator("..")).toContainText("5.5 days");
  await expect(page.getByText("Current gap").locator("..")).toContainText("1 day");
  await expect(page.getByText(/Current preference: 3 sessions per week/)).toBeVisible();
  await expect(page.getByText(/not an adherence percentage/)).toBeVisible();
  await expect(page.getByText("Program-day exposure", { exact: true })).toBeVisible();
  await expect(page.getByText("Push renamed / Strength A", { exact: true })).toBeVisible();
  await expect(page.getByText("Strength B", { exact: true })).toBeVisible();
  await expect(page.getByText(/2 completed workouts were not linked to a Program day/)).toBeVisible();

  await expect(page.getByRole("heading", { level: 3, name: "Planned set outcomes" })).toBeVisible();
  await expect(page.getByText("Below", { exact: true }).locator("..")).toContainText("1");
  await expect(page.getByText("At", { exact: true }).locator("..")).toContainText("2");
  await expect(page.getByText("Above", { exact: true }).locator("..")).toContainText("1");
  await expect(page.getByText("Unknown", { exact: true }).locator("..")).toContainText("1");
  await expect(page.getByText(/75% of supported comparisons were at or above/)).toBeVisible();
  if (narrowMobile) await expectNoHorizontalOverflow(page);

  await page.goto(`/history/${V2_H02_IDS.firstSession}`);
  await applyEnlargedText(page, narrowMobile);
  await expect(page.getByText(/Planned targets: 1 below, 1 at, 0 above/)).toBeVisible();
  await expect(page.getByText("Planned target: below", { exact: true })).toBeVisible();
  await expect(page.getByText("Planned target: at", { exact: true })).toBeVisible();
  if (narrowMobile) await expectNoHorizontalOverflow(page);

  await page.goto(`/history/${V2_H02_IDS.dateOnlySession}`);
  await applyEnlargedText(page, narrowMobile);
  await expect(page.getByText(/Time and duration unknown/)).toBeVisible();
  await expect(page.getByText(/1 target outcome unknown/)).toBeVisible();
  await expect(page.getByText(/2 performed working sets/)).toBeVisible();
  await expect(page.getByText("Planned target: unknown", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/^Planned target:/)).toHaveCount(1);
  if (narrowMobile) await expectNoHorizontalOverflow(page);

  await page.goto("/coach");
  await applyEnlargedText(page, narrowMobile);
  await expect(page.getByText("Planned sets at or above", { exact: true })).toBeVisible();
  await expect(page.getByText("75%", { exact: true })).toBeVisible();

  if (narrowMobile) await expectNoHorizontalOverflow(page);

  expect(mutationRequests).toEqual([]);
  await pageErrors.expectNoUnexpected();
});
