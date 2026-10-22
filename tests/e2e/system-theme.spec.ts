import { expect, test, type Locator, type Page } from "@playwright/test";
import { FONT_SIZE_EVENT, FONT_SIZE_STORAGE_KEY } from "../../src/lib/font-size";

async function ready(control: Locator) {
  await expect.poll(() => control.evaluate(element =>
    Object.getOwnPropertyNames(element).some(key => key.startsWith("__reactProps$")),
  )).toBe(true);
}
async function login(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const button = page.getByRole("button", { name: "Dev login", exact: true });
  await ready(button);
  await button.click();
  await expect(page).toHaveURL(/\/today$/);
}
async function largeText(page: Page) {
  await page.evaluate(({ key, event }) => {
    document.documentElement.dataset.fontSize = "extra-large";
    localStorage.setItem(key, "extra-large");
    window.dispatchEvent(new Event(event));
  }, { key: FONT_SIZE_STORAGE_KEY, event: FONT_SIZE_EVENT });
}
async function mode(page: Page, value: "light" | "dark") {
  await page.emulateMedia({ colorScheme: value });
  await expect(page.locator("html")).toHaveCSS("color-scheme", value);
}
async function readable(locator: Locator, minimum = 4.5) {
  const contrast = await locator.evaluate(element => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    function rgba(css: string) {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].map(v => v / 255);
    }
    function over(fg: number[], bg: number[]) {
      return [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
    }
    function background(node: Element | null): number[] {
      if (!node) return [1, 1, 1, 1];
      const color = rgba(getComputedStyle(node).backgroundColor);
      return color[3] >= 1 ? color : over(color, background(node.parentElement));
    }
    function luminance(color: number[]) {
      return color.slice(0, 3).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    }
    const bg = background(element);
    const fg = over(rgba(getComputedStyle(element).color), bg);
    const a = luminance(fg), b = luminance(bg);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
  expect(contrast, await locator.textContent() ?? "visible text").toBeGreaterThanOrEqual(minimum);
}
async function popupPalette(page: Page, popup: Locator, hasHeading = true) {
  await expect(popup).toBeVisible();
  expect(await popup.evaluate(element => {
    const expected = document.createElement("div");
    expected.style.backgroundColor = "var(--popover)";
    document.body.append(expected);
    const result = getComputedStyle(element).backgroundColor === getComputedStyle(expected).backgroundColor;
    expected.remove();
    return result;
  })).toBe(true);
  if (hasHeading) await readable(popup.getByRole("heading").first());
}
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )).toBe(true);
  const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
  if (await navigation.isVisible()) {
    await expect.poll(() => navigation.evaluate(element => {
      const sidebar = element.closest("aside")!;
      const heading = document.querySelector("h1");
      return !heading || heading.getBoundingClientRect().left >= sidebar.getBoundingClientRect().right;
    })).toBe(true);
  }
}

test("system colors update live across all routes and native forms", async ({ page }, info) => {
  await login(page);
  for (const route of ["/today", "/history", "/history?view=insights", "/history?view=exercises", "/coach", "/program", "/settings", "/settings/setup", "/settings/setup/profile", "/settings/setup/equipment", "/settings/setup/constraints", "/settings/setup/coaching", "/program/import", "/archive", "/recovery", "/export", "/export/analysis", "/phase1-foundation"]) {
    await page.goto(route);
    await expect(page.locator("h1").first()).toBeVisible();
    for (const value of ["light", "dark"] as const) {
      await mode(page, value);
      await readable(page.locator("h1").first());
      await noOverflow(page);
      if (["/today", "/history", "/settings", "/phase1-foundation"].includes(route)) {
        await page.screenshot({ animations: "disabled", path: info.outputPath(route.slice(1) + "-" + value + ".png"), fullPage: true });
      }
    }
  }
  await page.goto("/settings");
  await mode(page, "light");
  const selectedSize = page.getByRole("radio", { name: /^Default/ });
  await readable(selectedSize);
  await readable(selectedSize.locator("span").last());
  await mode(page, "dark");
  await readable(selectedSize.locator("span").last());
});

test("calendar controls, its portaled dialog and History detail retain state across themes", async ({ page }, info) => {
  await login(page);
  await page.goto("/history");
  await largeText(page);
  const calendarViews = page.getByRole("group", { name: "Calendar view" });
  await calendarViews.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page).toHaveURL(/calendarView=month/);
  const monthURL = page.url();
  for (const value of ["light", "dark"] as const) {
    await mode(page, value);
    await expect(calendarViews.getByRole("button", { name: "Month", exact: true })).toHaveAttribute("aria-pressed", "true");
    await readable(calendarViews.getByRole("button", { name: "Month", exact: true }));
    await noOverflow(page);
    expect(page.url()).toBe(monthURL);
    await page.screenshot({ animations: "disabled", path: info.outputPath("calendar-large-" + value + ".png"), fullPage: true });
  }
  await page.getByRole("button", { name: /Add a workout or activity$/ }).first().click();
  const chooser = page.getByRole("dialog", { name: "Add to this day" });
  for (const value of ["light", "dark"] as const) {
    await mode(page, value);
    await popupPalette(page, chooser);
    await chooser.screenshot({ animations: "disabled", path: info.outputPath("calendar-dialog-" + value + ".png") });
  }
  await page.keyboard.press("Escape");
  await expect(chooser).not.toBeVisible();
  for (const value of ["Year", "Week", "Month"]) {
    const control = calendarViews.getByRole("button", { name: value, exact: true });
    await control.click();
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(new RegExp("calendarView=" + value.toLowerCase()));
  }
  const href = await page.locator('a[href^="/history/"]').evaluateAll(links =>
    links.map(link => link.getAttribute("href")).find(href => /^\/history\/[0-9a-f-]{36}(?:\?|$)/.test(href ?? "")),
  );
  expect(href).toBeTruthy();
  await page.goto(href!);
  const heading = page.locator("h1").first();
  const originalHeading = await heading.textContent();
  for (const value of ["light", "dark"] as const) {
    await mode(page, value);
    await expect(heading).toHaveText(originalHeading!);
    await readable(heading);
    await noOverflow(page);
    await page.screenshot({ animations: "disabled", path: info.outputPath("history-detail-" + value + ".png"), fullPage: true });
  }
});

test("the quick-log tray follows live theme changes without losing the draft", async ({ page }, info) => {
  await login(page);
  await largeText(page);
  await page.getByRole("button", { name: "Speak or type a quick log" }).click();
  const tray = page.getByRole("dialog", { name: "Quick log" });
  const text = tray.getByRole("textbox").first();
  const draft = "Barbell Bench Press 95 lb for 8 reps";
  await text.fill(draft);
  for (const value of ["light", "dark", "light"] as const) {
    await mode(page, value);
    await popupPalette(page, tray);
    await expect(text).toHaveValue(draft);
    await readable(text);
    await expect(text).toHaveCSS("color-scheme", value);
    await tray.screenshot({ animations: "disabled", path: info.outputPath("quick-log-tray-" + value + ".png") });
  }
  await tray.getByRole("button", { name: "Close", exact: true }).click();
  await expect(tray).not.toBeVisible();
});

test("equipment sheets and their portaled plate picker share the system palette", async ({ page }, info) => {
  await login(page);
  await page.goto("/settings");
  await largeText(page);
  const manage = page.getByRole("button", { name: "Manage equipment", exact: true });
  await ready(manage); await manage.click();
  await expect(page).toHaveURL(/\/settings\/equipment$/);
  const editPlates = page.getByRole("button", { name: "Edit weight plates", exact: true });
  await ready(editPlates); await editPlates.click();
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect(sheet).toBeVisible();
  const field = sheet.locator("input").first();
  const original = await field.inputValue();
  for (const value of ["light", "dark"] as const) {
    await mode(page, value);
    await popupPalette(page, sheet);
    await expect(field).toHaveValue(original);
    await readable(field);
    await sheet.screenshot({ animations: "disabled", path: info.outputPath("settings-sheet-" + value + ".png") });
  }
  await sheet.getByRole("combobox", { name: "Weight", exact: true }).click();
  const picker = page.locator('[data-slot="select-content"]');
  for (const value of ["light", "dark"] as const) {
    await mode(page, value);
    await popupPalette(page, picker, false);
    await readable(picker.getByRole("option").first());
    await picker.screenshot({ animations: "disabled", path: info.outputPath("plate-picker-" + value + ".png") });
  }
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(field).toHaveValue(original);
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet).not.toBeVisible();
});

test("focused logging, its equipment sheet and rest tray preserve entered and saved values", async ({ page }, info) => {
  await login(page);
  await largeText(page);
  const start = page.getByRole("button", { name: "Train as planned", exact: true });
  await ready(start); await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  const current = page.getByTestId("current-exercise-card");
  const load = current.getByRole("textbox", { name: "Total load", exact: true });
  const reps = current.getByRole("textbox", { name: "Reps", exact: true });
  await expect(load).toBeVisible();
  await load.fill("95"); await reps.fill("8");
  for (const value of ["light", "dark"] as const) {
    await reps.focus();
    await mode(page, value);
    await expect(reps).toBeFocused();
    await expect(load).toHaveValue("95"); await expect(reps).toHaveValue("8");
    await readable(current.getByRole("heading").first());
    await readable(load); await readable(reps);
    await noOverflow(page);
    await page.screenshot({ animations: "disabled", path: info.outputPath("focused-entry-" + value + ".png") });
  }
  await current.getByRole("button", { name: "Replace", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Replace exercise for this workout", exact: true });
  await expect(sheet).toBeVisible();
  for (const value of ["light", "dark"] as const) {
    await mode(page, value);
    await popupPalette(page, sheet);
    await sheet.screenshot({ animations: "disabled", path: info.outputPath("equipment-sheet-" + value + ".png") });
  }
  await page.keyboard.press("Escape");
  await expect(sheet).not.toBeVisible();
  await expect(reps).toHaveValue("8");
  const log = page.getByRole("complementary", { name: "Workout status" }).getByTestId("active-log-set");
  await ready(log); await log.click();
  const rest = page.getByTestId("rest-cockpit");
  await expect(rest).toHaveAttribute("data-rest-phase", "running");
  for (const value of ["light", "dark"] as const) {
    await mode(page, value);
    await expect(rest).toHaveAttribute("data-rest-phase", "running");
    await readable(rest.getByRole("button", { name: "Increase rest by 15 seconds" }));
    await rest.screenshot({ animations: "disabled", path: info.outputPath("rest-tray-" + value + ".png") });
  }
  await page.getByRole("button", { name: "Full workout", exact: true }).click();
  await expect(current.getByTestId("active-set-ledger").getByRole("listitem").first()).toContainText("95 lb × 8");
  await expect(current.getByTestId("active-set-ledger").getByRole("listitem").first()).toContainText("Saved");
  const details = current.getByTestId("active-exercise-details");
  if (await details.getAttribute("open") === null) {
    await details.locator("summary").first().click();
  }
  await current.getByRole("button", { name: "Archive set", exact: true }).first().click();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Set archived" }).first();
  await expect(toast).toBeVisible();
  for (const value of ["dark", "light"] as const) {
    await mode(page, value);
    await expect(page.locator("[data-sonner-toaster]").first()).toHaveAttribute("data-sonner-theme", value);
    await readable(toast);
    await toast.screenshot({ animations: "disabled", path: info.outputPath("undo-toast-" + value + ".png") });
  }
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(current.locator('[id^="logged-set-"]')).toHaveCount(1);
  await expect(current.locator('[id^="logged-set-"]')).toContainText("95 lb");
  await expect(current.locator('[id^="logged-set-"]')).toContainText("8 reps");
});
