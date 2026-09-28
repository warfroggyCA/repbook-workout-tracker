// Focused WCAG 2.4.11 check for the fixed active-workout dock (manual suite,
// not part of the protected browser groups). Starts a workout on the
// gauntlet-B fixture at extra-large app size, then checks that every control
// that fits above the dock is fully clear when focused, and that none is
// entirely hidden - once at workout start and once during rest. The projects
// share one fixture and each logs one set, so keep at most three projects.
import { expect, test, type Page } from "@playwright/test";
import { BA_WORKOUT_EMAIL } from "../fixtures/ba-workout-contract";

async function focusCheck(page: Page) {
  return page.evaluate(async () => {
    const dock = document.getElementById("workout-rest-status");
    const main = document.querySelector("main");
    if (!dock || !main) return { checked: 0, obscured: ["dock or main missing"], dock: 0 };
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const controls = [...main.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
      .filter((e) => !(e as HTMLButtonElement).disabled && !dock.contains(e) && !e.closest('[role="dialog"], [aria-hidden="true"], [inert]') && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden");
    const obscured: string[] = [];
    let checked = 0;
    for (const e of controls) {
      e.focus();
      await frame();
      if (document.activeElement !== e) continue;
      checked += 1;
      const t = e.getBoundingClientRect();
      const d = dock.getBoundingClientRect();
      const overlap = Math.min(t.bottom, d.bottom) - Math.max(t.top, d.top);
      // Match the browser's focus-scroll area, including the large top
      // margin reserved by the focusable superset panel.
      const style = getComputedStyle(e);
      const scrollAreaHeight = t.height +
        (Number.parseFloat(style.scrollMarginTop) || 0) +
        (Number.parseFloat(style.scrollMarginBottom) || 0);
      if ((scrollAreaHeight <= d.top && overlap > 0.5) || overlap >= t.height - 0.5) {
        obscured.push(`${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50)} (${Math.round(overlap)}px)`);
      }
    }
    (document.activeElement as HTMLElement | null)?.blur();
    return { checked, obscured, dock: Math.round(dock.getBoundingClientRect().height) };
  });
}

test("focused workout controls stay clear of the fixed dock", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await page.waitForLoadState("networkidle");
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  if (!(await extraLarge.isChecked())) await extraLarge.click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.fontSize)).toBe("extra-large");
  await page.goto("/today");
  await page.waitForLoadState("networkidle");
  const resume = page.getByRole("button", { name: "Resume workout", exact: true });
  const start = page.getByRole("button", { name: "Train as planned", exact: true });
  await (await resume.count() ? resume : start).click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+/);
  await page.waitForLoadState("networkidle");

  const atStart = await focusCheck(page);
  console.log(`[${test.info().project.name}] start: checked ${atStart.checked}, dock ${atStart.dock}px, obscured ${atStart.obscured.length}`);
  expect(atStart.checked).toBeGreaterThan(0);
  expect(atStart.obscured).toEqual([]);

  await page.getByTestId("active-log-set").click();
  await expect(page.getByTestId("rest-cockpit")).toBeVisible();
  const duringRest = await focusCheck(page);
  console.log(`[${test.info().project.name}] rest: checked ${duringRest.checked}, dock ${duringRest.dock}px, obscured ${duringRest.obscured.length}`);
  expect(duringRest.checked).toBeGreaterThan(0);
  expect(duringRest.obscured).toEqual([]);
});
