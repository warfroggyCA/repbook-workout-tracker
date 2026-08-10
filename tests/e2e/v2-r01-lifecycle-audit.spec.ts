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
  await expect(page.getByRole("heading", { name: "Export" })).toBeVisible();
  await expect(page.getByText("Versioned analysis package", { exact: true })).toBeVisible();
  await expect(page.getByText("Support bundle", { exact: true })).toBeVisible();
  await expect(page.getByText("Spreadsheet (CSV)", { exact: true })).toBeVisible();
  await expect(page.getByText("Full backup (JSON)", { exact: true })).toBeVisible();
  await expect(page.getByText(/never sends the package for you/i)).toBeVisible();
  await expect(page.getByText(/never uploaded automatically/i)).toBeVisible();

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
