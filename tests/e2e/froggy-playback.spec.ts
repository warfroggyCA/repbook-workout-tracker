import { expect, test } from "@playwright/test";
import { installNextDevelopmentRefreshControl, waitForHydratedServerAction } from "../helpers/react-readiness";

test.beforeEach(async ({ page }) => {
  await installNextDevelopmentRefreshControl(page);
});

test("plays one reduced-motion preview in isolation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.goto("/program");
  await page.getByRole("button", { name: "View Incline Dumbbell Curl form", exact: true }).click();
  const player = page.getByTestId("froggy-player");
  // Opening an exercise does not guarantee its video is in the viewport.
  // Offscreen previews intentionally pause, including with reduced motion.
  await player.scrollIntoViewIfNeeded();
  await expect(player.locator("[data-form-banner]")).toBeInViewport();
  await expect.poll(() => player.locator("video").evaluate((v: HTMLVideoElement) => ({
    readyState: v.readyState, networkState: v.networkState, time: v.currentTime, paused: v.paused,
    duration: v.duration, error: v.error?.message ?? null, source: v.currentSrc,
  })), { timeout: 30_000 }).toMatchObject({ readyState: 4, error: null, paused: false });
  await expect(player.locator("video")).toHaveAttribute("src", /steady\.mp4$/);
  await expect.poll(() => player.locator("[data-form-banner]").innerText(), { timeout: 30_000 }).toMatch(/^AVOID/);
});

test("cycles every supported form through Avoid and back to Do during natural playback", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.goto("/program");
  // Review one visible preview at a time, as in the normal form-viewing flow.
  // Keep CI media workload comparable to one-exercise viewing.
  await page.setViewportSize({ width: 1100, height: 900 });
  let reviewed = 0;
  for (let day = 1; day <= 6; day++) {
    await page.getByRole("tab", { name: `Day ${day}`, exact: true }).click();
    const triggers = page.getByRole("button", { name: /^View .+ form$/ });
    const names = await triggers.evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")!));
    for (const [index, name] of names.entries()) {
      await test.step(name, async () => {
        // Multiple catalog entries may share the same disclosed demonstration.
        await triggers.nth(index).click();
        const panel = page.getByTestId("froggy-inline-preview");
        await expect(panel).toHaveCount(1);
        await panel.scrollIntoViewIfNeeded();
        const banner = panel.locator("[data-form-banner]");
        await expect(banner, name).toBeVisible();
        // Preserve bounded synthetic playback evidence when CI alone stalls.
        // Keep the natural-playback assertions and their timeouts unchanged.
        const samples: unknown[] = [];
        const sampleCue = async () => {
          const sample = await panel.evaluate((element) => {
            const video = element.querySelector("video")!;
            const rect = video.getBoundingClientRect();
            return {
              cue: element.querySelector("[data-form-banner]")?.textContent?.trim() ?? "",
              time: video.currentTime, duration: video.duration,
              paused: video.paused, ended: video.ended, seeking: video.seeking,
              readyState: video.readyState, networkState: video.networkState,
              errorCode: video.error?.code ?? null,
              hidden: document.hidden,
              inViewport: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
            };
          });
          samples.push(sample);
          if (samples.length > 60) samples.shift();
          return sample.cue;
        };
        try {
          await expect.poll(sampleCue, { message: `${name}: Avoid`, timeout: 30_000 }).toMatch(/^AVOID/);
          await expect.poll(sampleCue, { message: `${name}: return to Do`, timeout: 20_000 }).toMatch(/^DO/);
        } catch (error) {
          console.error("Synthetic playback samples", name, JSON.stringify(samples));
          throw error;
        }
        await panel.getByRole("button", { name: "Close form preview", exact: true }).click();
        await expect(panel).toHaveCount(0);
      });
    }
    reviewed += names.length;
  }
  expect(reviewed).toBe(23);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Day 2", exact: true }).click();
  await page.getByRole("button", { name: "View Barbell Overhead Press form", exact: true }).click();
  await page.getByRole("button", { name: "Expand form preview", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Barbell Overhead Press · Form" });
  const banner = dialog.locator("[data-form-banner]");
  await expect.poll(() => banner.innerText(), { timeout: 30_000 }).toMatch(/^AVOID/);
  await dialog.getByRole("button", { name: "Pause form animation" }).click();
  const pausedCue = await banner.innerText();
  await page.waitForTimeout(1200);
  expect(await banner.innerText()).toBe(pausedCue);
  await dialog.getByRole("button", { name: "Resume form animation" }).click();
  await expect.poll(() => banner.innerText(), { timeout: 20_000 }).toMatch(/^DO/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `output/playwright/workout-field-fixes/overhead-${test.info().project.name}.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("scrubbing to the end preserves the tip and explicit pause before replay", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.goto("/program");
  await page.getByRole("button", { name: "View Incline Dumbbell Curl form", exact: true }).click();
  const player = page.getByTestId("froggy-player");
  await player.scrollIntoViewIfNeeded();
  const video = player.locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.1);
  await player.getByRole("button", { name: "Pause form animation", exact: true }).click();
  const banner = player.locator("[data-form-banner]");
  const tip = await banner.getAttribute("data-form-banner");
  await player.getByText("Playback options", { exact: true }).click();
  const position = player.getByRole("slider", { name: "Demonstration position" });
  await position.focus();
  await position.press("End");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(5.9);
  await page.waitForTimeout(1200);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(banner).toHaveAttribute("data-form-banner", tip!);
  await player.getByRole("button", { name: "Resume form animation", exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 5000 }).toBeLessThan(2);
  await expect(banner).toHaveAttribute("data-form-banner", tip!);
  // One complete replay, rather than the manual seek, advances the next tip.
  await expect(banner).not.toHaveAttribute("data-form-banner", tip!, { timeout: 10000 });
  await player.getByRole("button", { name: "Pause form animation", exact: true }).click();
  const pausedTime = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.waitForTimeout(1200);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(pausedTime, 1);
});
