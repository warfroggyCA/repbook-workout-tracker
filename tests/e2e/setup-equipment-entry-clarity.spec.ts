import { expect, test } from "@playwright/test";
import { installLocalAuthSession } from "../helpers/browser-security";

test("dumbbell setup explains pair quantity and exposes each repeated entry", async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The browser base URL is required.");
  await installLocalAuthSession(
    context,
    baseURL,
    "equipment-onboarding.e2e@example.com"
  );
  await page.setViewportSize({ width: 390, height: 844 });

  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/setup/equipment");
  const dumbbells = page.getByRole("region", { name: "Dumbbells" });

  await dumbbells.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dumbbells.getByText("1 entry", { exact: true })).toBeVisible();
  await expect(dumbbells.getByText("How many pairs", { exact: true })).toBeVisible();
  await expect(
    dumbbells.getByText(
      "Quantity 1 means one matched pair: two physical weights.",
      { exact: true }
    )
  ).toBeVisible();

  await dumbbells
    .getByRole("button", { name: "Add another", exact: true })
    .click();

  const names = dumbbells.getByLabel("Name for Dumbbell");
  await expect(names).toHaveCount(2);
  await expect(names.nth(1)).toHaveValue("Dumbbells 2");
  await expect(names.nth(1)).toBeFocused();
  await expect(dumbbells.getByText("2 entries", { exact: true })).toBeVisible();
  await expect(dumbbells.getByText("Entry 2 of 2", { exact: true })).toBeVisible();
  await expect(dumbbells.getByText("New", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Save & continue" }).click();
  await expect(page).toHaveURL(/\/setup\/constraints$/);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  expect(browserErrors).toEqual([]);
});
