import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

const EMAIL = "owner@example.com";

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

test("keeps portable facts, AI packages, support diagnostics, Review, and Coach visibly separate", async ({
  browserName,
  page,
}) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(page, browserName);
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (host !== "127.0.0.1") externalRequests.push(request.url());
  });

  await page.goto("/export");
  await expect(
    page.getByRole("heading", { name: "Downloads & backup" }),
  ).toBeVisible();
  await expect(page.getByText("Training Brief", { exact: true })).toBeVisible();
  await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Back up all Repbook data", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Versioned analysis package", { exact: true }),
  ).not.toBeVisible();
  await expect(page.getByText("Support bundle", { exact: true })).not.toBeVisible();
  await expect(
    page.getByText("Spreadsheet data (CSV)", { exact: true }),
  ).not.toBeVisible();
  await expect(page.getByText(/never sends it anywhere for you/i)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
  const trainingBriefDownload = page.getByRole("button", {
    name: "Download training brief",
    exact: true,
  });
  await trainingBriefDownload.scrollIntoViewIfNeeded();
  await trainingBriefDownload.click({ trial: true });

  const advanced = page.locator("details").filter({
    has: page.getByText("Advanced exports", { exact: true }),
  });
  await advanced.getByText("Advanced exports", { exact: true }).click();
  await expect(
    page.getByText("Versioned analysis package", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Support bundle", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Spreadsheet data (CSV)", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/never uploaded automatically/i)).toBeVisible();

  await page.goto("/history?range=all");
  await page.getByRole("button", { name: "More History actions" }).click();
  await page
    .getByRole("link", { name: "Prepare training brief", exact: true })
    .click();
  await expect(page).toHaveURL(/\/export\?briefRange=all#training-brief$/);
  await expect(page.getByLabel("Period to summarize")).toHaveValue("12");
  await expect(page.getByText(/History is showing all time/i)).toBeVisible();

  await page.goto("/export?briefRange=6m#training-brief");
  await expect(page.getByLabel("Period to summarize")).toHaveValue("26");
  await expect(page.getByText(/History is showing all time/i)).toHaveCount(0);
  const formValues = await page
    .locator('form[action="/api/export/markdown"]')
    .evaluate((form) =>
      Object.fromEntries(new FormData(form as HTMLFormElement)),
    );
  expect(formValues).toEqual({ weeks: "26", download: "1" });

  await advanced.getByText("Advanced exports", { exact: true }).click();

  await page.getByText("Prepare analysis package", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Analysis package" }),
  ).toBeVisible();
  await expect(page.getByText(/never sends it to an external service/i)).toBeVisible();

  await page.goto("/export/support");
  await expect(
    page.getByRole("heading", { name: "Support bundle" }),
  ).toBeVisible();
  await expect(page.getByText(/never sends the bundle for you/i)).toBeVisible();
  await expect(
    page.getByText(/makes no upload, API, AI, or persistence/i),
  ).toBeVisible();

  await page.goto("/coach");
  await expect(
    page.getByRole("heading", { name: "Review and decisions" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Review proposed Program changes, the evidence behind them/i),
  ).toBeVisible();
  await expect(page.getByText(/Live Coach stays with the workout/i)).toBeVisible();

  expect(externalRequests).toEqual([]);
  await pageErrors.expectNoUnexpected();
});
