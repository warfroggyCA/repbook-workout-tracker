import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";
import {
  V2_H01_HISTORY_EMAIL,
  V2_H01_HISTORY_IDS,
} from "../helpers/v2-h01-history";

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(V2_H01_HISTORY_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/settings\/setup$/);
  await page.waitForLoadState("networkidle");
}

test("shows exact, tiered, read-only exercise evidence with durable return context", async ({
  browserName,
  page,
}) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(page, browserName);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  const narrow = (page.viewportSize()?.width ?? 0) <= 320;

  await page.goto(
    `/history?view=exercises&range=all&exerciseId=${V2_H01_HISTORY_IDS.performedExercise}`,
  );
  if (narrow) {
    await page.evaluate(() => {
      document.documentElement.dataset.fontSize = "extra-large";
    });
  }
  await expect(
    page.getByRole("heading", { level: 3, name: "Exercise records" }),
  ).toBeVisible();
  await expect(
    page.getByText(`Exact ID: ${V2_H01_HISTORY_IDS.performedExercise}`),
  ).toBeVisible();
  await expect(
    page.getByText(
      /3 of 4 saved sets can be matched to the workout; 2 are included in progress calculations/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/Reviewed hevy mapping/)).toBeVisible();
  await expect(page.getByText(/Frozen source occurrence IDs:/)).toBeVisible();
  await expect(
    page.getByText("Edited records", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.getByText("Older records", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Saved for reference", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/Substitution kept separate:/).first(),
  ).toContainText(V2_H01_HISTORY_IDS.plannedExercise);
  await expect(page.getByText(/exercise-history-v1/)).toBeVisible();

  await page
    .getByRole("link", { name: "Older records", exact: true })
    .click();
  await expect(page).toHaveURL(/evidenceTier=legacy/);
  await page
    .getByRole("link", { name: "Source workout", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(
    new RegExp(
      `exerciseId=${V2_H01_HISTORY_IDS.performedExercise}.*evidenceTier=legacy|evidenceTier=legacy.*exerciseId=${V2_H01_HISTORY_IDS.performedExercise}`,
    ),
  );
  await page.locator("a", { hasText: "Back to history" }).click();
  await expect(page).toHaveURL(/view=exercises/);
  await expect(page).toHaveURL(/evidenceTier=legacy/);

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
