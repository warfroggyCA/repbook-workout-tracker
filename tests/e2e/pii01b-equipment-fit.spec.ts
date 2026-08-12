import { expect, test, type Page } from "@playwright/test";
import { waitForHydratedServerAction } from "../helpers/react-readiness";

async function signIn(page: Page, email = "owner@example.com") {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(email);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(
    email === "pii01b.setup@example.com" ? /\/setup\/review$/ : /\/today$/,
  );
}

test("records, changes, exports, and removes one stable exercise-item fit accessibly", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (
      error.message !== "Load failed"
      && !error.message.includes("due to access control checks")
    ) browserErrors.push(error.message);
  });
  page.on("console", (message) => {
    const text = message.text();
    const expectedWebKitPrefetchNoise =
      text.includes("due to access control checks") || text === "Load failed";
    if (
      message.type() === "error"
      && !text.startsWith("Failed to load resource:")
      && !expectedWebKitPrefetchNoise
    ) {
      browserErrors.push(message.text());
    }
  });

  await signIn(page);
  await page.goto("/settings");
  await page.getByRole("radio", { name: /Extra large/ }).click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe("extra-large");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/equipment");

  const section = page.locator("#movement-compatibility");
  await expect(section.getByRole("heading", { name: "Movement compatibility" })).toBeVisible();
  await expect(section.getByText(/broad type is never proof/)).toBeVisible();
  await expect(section.getByText(/existing Programs, active-session snapshots/)).toBeVisible();

  const form = section.getByRole("group", { name: "Record an exact pair" });
  const exerciseSearch = form.getByRole("searchbox", { name: "Search exercises" });
  const exercise = form.getByRole("combobox", { name: "Exercise", exact: true });
  const equipment = form.getByRole("combobox", { name: "Owned equipment item", exact: true });
  const verdict = form.getByRole("combobox", { name: "Does this exact pair work?", exact: true });
  await exerciseSearch.fill("Dumbbell Front Raise");
  await expect(form.locator("#movement-compatibility-search-status"))
    .toHaveText(/matching exercises?/);
  const dumbbellFrontRaiseValue = await exercise.locator("option").evaluateAll((options) =>
    options.find((option) => option.textContent?.trim() === "Dumbbell Front Raise")?.getAttribute("value")
      ?? null,
  );
  expect(dumbbellFrontRaiseValue).not.toBeNull();
  await exercise.selectOption(dumbbellFrontRaiseValue!);
  await expect(equipment).toContainText("Adjustable dumbbells");
  const adjustableDumbbellValue = await equipment.locator("option")
    .filter({ hasText: "Adjustable dumbbells" })
    .getAttribute("value");
  expect(adjustableDumbbellValue).not.toBeNull();
  await equipment.selectOption(adjustableDumbbellValue!);
  await verdict.selectOption("incompatible");
  await form.getByRole("combobox", { name: "Why does it not work?", exact: true })
    .selectOption("geometry_limit");
  await form.getByLabel(/Owner note/).fill("Handle geometry prevents the reviewed movement.");

  const save = form.getByRole("button", { name: "Save retained review", exact: true });
  await save.focus();
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");

  const retained = section.getByRole("article").filter({ hasText: "Dumbbell Front Raise" });
  await expect(retained).toContainText("Adjustable dumbbells");
  await expect(retained.getByText("Incompatible", { exact: true })).toBeVisible();
  await expect(retained).toContainText("Handle geometry prevents the reviewed movement.");
  await expect(retained).toContainText("Owner review · revision 1");

  const exportResponse = await page.request.get("/api/export/json");
  expect(exportResponse.ok()).toBe(true);
  const exportText = await exportResponse.text();
  expect(exportText).toContain("exercise_equipment_fit_assertions");
  expect(exportText).toContain("geometry_limit");

  const summary = retained.getByText("Change this review", { exact: true });
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  const editVerdict = retained.getByRole("combobox", {
    name: "Does this exact pair work?",
    exact: true,
  });
  await expect(editVerdict).toBeVisible();
  await editVerdict.selectOption("compatible");
  const editSave = retained.getByRole("button", { name: "Save review", exact: true });
  await editSave.focus();
  await page.keyboard.press("Enter");

  const changed = section.getByRole("article").filter({ hasText: "Dumbbell Front Raise" });
  await expect(changed.getByText("Compatible", { exact: true })).toBeVisible();
  await expect(changed).toContainText("revision 2");
  await expect(changed).not.toContainText("Handle geometry prevents the reviewed movement.");

  const controls = await section.locator(
    "button:enabled, input:not([type='hidden']), select, textarea, summary",
  ).evaluateAll(
    (elements) => elements
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          name:
            element.getAttribute("aria-label")
            ?? element.closest("label")?.textContent?.trim()
            ?? element.textContent?.trim()
            ?? element.tagName,
          height: bounds.height,
        };
      }),
  );
  expect(controls.every((control) => control.name.length > 0)).toBe(true);
  expect(controls.filter((control) => control.height < 44)).toEqual([]);
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.rootFontSize).toBeGreaterThan(20);

  const remove = changed.getByRole("button", { name: "Remove review", exact: true });
  await expect(remove).toBeVisible();
  await remove.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Remove this retained review?" });
  await expect(dialog).toContainText(/become unknown/);
  const confirm = dialog.getByRole("button", { name: "Remove review", exact: true });
  await confirm.focus();
  await page.keyboard.press("Enter");

  await expect(
    section.getByRole("article").filter({ hasText: "Dumbbell Front Raise" }),
  ).toHaveCount(0);
  const removeStatus = section.locator("#movement-compatibility-status");
  await expect(removeStatus).toHaveText(/unknown again, not compatible/);
  await expect(removeStatus).toBeFocused();
  expect(browserErrors).toEqual([]);
});

test("announces and focuses a stale guided-setup equipment review", async ({ page }) => {
  await signIn(page, "pii01b.setup@example.com");

  const review = page;
  const reviewCheckbox = review.getByRole("checkbox", {
    name: /I checked every equipment-required exercise/i,
  });
  await expect(reviewCheckbox).toBeVisible();

  const equipmentEditor = await page.context().newPage();
  await equipmentEditor.goto("/setup/equipment");
  const cableName = equipmentEditor.getByRole("textbox", {
    name: "Name for Cable equipment",
  });
  await expect(cableName).toHaveValue("Setup cable station");
  await cableName.fill("Setup cable station changed concurrently");
  await equipmentEditor.getByRole("button", { name: "Save & continue" }).click();
  await expect(equipmentEditor).toHaveURL(/\/setup\/constraints$/);
  await equipmentEditor.close();

  await reviewCheckbox.check();
  const activate = review.getByRole("button", { name: "Activate program" });
  await activate.focus();
  await review.keyboard.press("Enter");

  const alert = review.getByRole("alert").filter({
    hasText: /routine or equipment changed after your final review/i,
  });
  await expect(alert).toHaveText(/routine or equipment changed after your final review/i);
  await expect(alert).toBeFocused();
  await expect(review).toHaveURL(/\/setup\/review$/);
});
