import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";
import { V2_H01_HISTORY_IDS as h01 } from "../helpers/v2-h01-history";
import { V2_H04_PAIN_EMAIL } from "../helpers/v2-h04-pain-consistency";

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(V2_H04_PAIN_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/settings\/setup$/);
  await page.waitForLoadState("networkidle");
}

test("keeps pain, no-issue, exception identity, and proposals consistent", async ({
  browserName,
  page,
}) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(
    page,
    browserName,
    [],
    new Set([
      `/history/${h01.importedSession}`,
      `/history/${h01.finishedEarlySession}`,
    ]),
  );
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  const narrow = (page.viewportSize()?.width ?? 0) <= 320;

  await page.goto(`/session/${h01.activeSession}`);
  if (narrow) {
    await page.evaluate(() => {
      document.documentElement.dataset.fontSize = "extra-large";
    });
  }
  const currentCard = page.getByTestId("current-exercise-card");
  await currentCard
    .locator("details", { hasText: "More for this exercise" })
    .locator(":scope > summary")
    .click();
  await page.getByRole("button", { name: "Pain / no issue", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Pain / no-issue evidence" });
  const slider = drawer.getByRole("slider");
  await slider.focus();
  await slider.press("Home");
  await expect(drawer.getByText("No issue reported", { exact: true })).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Save no-issue report", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`/history/${h01.importedSession}`);
  const positive = page
    .getByRole("heading", { name: "Pain / no-issue evidence" })
    .locator("..");
  await expect(positive).toContainText("Pain: knee 4/10");
  await expect(positive).toContainText("H01 Bodyweight Bulgarian Split Squat · set 1");
  await expect(page.getByText(/Performed H01 Bodyweight Bulgarian Split Squat instead of/)).toBeVisible();
  await expect(page.getByText("Technique issue: Bracing", { exact: true })).toBeVisible();
  await expect(page.getByText("Limited by: Strength or fatigue", { exact: true })).toBeVisible();

  await page.goto(`/history/${h01.finishedEarlySession}`);
  const technicalRecord = page.locator("details#technical-record");
  const noIssue = technicalRecord
    .getByRole("heading", { name: "Pain / no-issue evidence" })
    .locator("..");
  await expect(technicalRecord).not.toHaveAttribute("open", "");
  await expect(noIssue).not.toBeVisible();
  await technicalRecord.locator(":scope > summary").click();
  await expect(technicalRecord).toHaveAttribute("open", "");
  await expect(noIssue).toContainText("Explicit no-issue report: knee 0/10");
  await expect(noIssue).not.toContainText("Pain not recorded (unknown)");

  await page.goto("/coach");
  const reviewEvidence = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Recent effort and issue context" }),
  }).first();
  await expect(reviewEvidence).toContainText("Pain: knee 4/10");
  await expect(reviewEvidence).toContainText(
    "Performed H01 Bodyweight Bulgarian Split Squat instead of Loaded Bulgarian Split Squat",
  );
  await expect(reviewEvidence).toContainText("Technique: Bracing");
  await expect(reviewEvidence).toContainText("Limited by: Strength or fatigue");

  if (narrow) {
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  expect(mutations).toEqual([]);
  await pageErrors.expectNoUnexpected();
});
